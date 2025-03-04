/* eslint-disable quotes */
import { DownloadTask } from '@xmcl/installer'
import {
  LoginOptions,
  SaveSkinOptions, UploadSkinOptions,
  UserProfile,
  UserSchema,
  UserService as IUserService,
  UserServiceKey,
  UserState,
} from '@xmcl/runtime-api'
import { Pool } from 'undici'
import { UserAccountSystem } from '../accountSystems/AccountSystem'
import { YggdrasilAccountSystem } from '../accountSystems/YggdrasilAccountSystem'
import LauncherApp from '../app/LauncherApp'
import { LauncherAppKey } from '../app/utils'
import { loadYggdrasilApiProfile } from '../entities/user'
import { kUserTokenStorage, UserTokenStorage } from '../entities/userTokenStore'
import { requireObject, requireString } from '../util/object'
import { Inject } from '../util/objectRegistry'
import { createSafeFile } from '../util/persistance'
import { ensureLauncherProfile, preprocessUserData } from '../util/userData'
import { ExposeServiceKey, Lock, Singleton, StatefulService } from './Service'

@ExposeServiceKey(UserServiceKey)
export class UserService extends StatefulService<UserState> implements IUserService {
  private userFile = createSafeFile(this.getAppDataPath('user.json'), UserSchema, this, [this.getPath('user.json')])

  private loginController: AbortController | undefined
  private refreshController: AbortController | undefined
  private setSkinController: AbortController | undefined
  private accountSystems: Record<string, UserAccountSystem | undefined> = {}

  readonly yggdrasilAccountSystem: YggdrasilAccountSystem

  constructor(@Inject(LauncherAppKey) app: LauncherApp,
    @Inject(kUserTokenStorage) private tokenStorage: UserTokenStorage) {
    super(app, () => new UserState(), async () => {
      const data = await this.userFile.read()
      const userData: UserSchema = {
        users: {},
        selectedUser: {
          id: '',
        },
        clientToken: '',
        yggdrasilServices: [],
      }

      // This will fill the user data
      await preprocessUserData(userData, data, this.getMinecraftPath('launcher_profiles.json'), tokenStorage)
      // Ensure the launcher profile
      await ensureLauncherProfile(this.getPath())

      this.log(`Load ${Object.keys(userData.users).length} users`)

      this.state.userData(userData)

      if (userData.yggdrasilServices.length === 0) {
        // Initialize the data
        Promise.all([
          loadYggdrasilApiProfile('https://littleskin.cn/api/yggdrasil').then(api => {
            this.state.userYggdrasilServicePut(api)
          }),
          loadYggdrasilApiProfile('https://authserver.ely.by/api/authlib-injector').then(api => {
            this.state.userYggdrasilServicePut(api)
          })]).then(() => {
            this.refreshUser()
            if (this.state.selectedUser.id === '' && Object.keys(this.state.users).length > 0) {
              const [userId, user] = Object.entries(this.state.users)[0]
              this.selectUser(userId)
            }
          })
      } else {
        this.refreshUser()
        if (this.state.selectedUser.id === '' && Object.keys(this.state.users).length > 0) {
          const [userId, user] = Object.entries(this.state.users)[0]
          this.selectUser(userId)
        }
      }
    })

    const dispatcher = this.networkManager.registerAPIFactoryInterceptor((origin, options) => {
      const hosts = this.state.yggdrasilServices.map(v => new URL(v.url).hostname)
      if (hosts.indexOf(origin.hostname) !== -1) {
        return new Pool(origin, {
          ...options,
          pipelining: 1,
          connections: 6,
          keepAliveMaxTimeout: 60_000,
        })
      }
    })

    this.yggdrasilAccountSystem = new YggdrasilAccountSystem(
      this,
      dispatcher,
      this.state,
      tokenStorage,
    )

    this.storeManager.subscribeAll([
      'userProfile',
      'userProfileRemove',
      'userGameProfileSelect',
      'userYggdrasilServices',
      'userYggdrasilServicePut',
    ], async () => {
      const userData: UserSchema = {
        users: this.state.users,
        selectedUser: this.state.selectedUser,
        clientToken: this.state.clientToken,
        yggdrasilServices: this.state.yggdrasilServices,
      }
      await this.userFile.write(userData)
    })

    app.protocol.registerHandler('authlib-injector', ({ request, response }) => {
      this.addYggdrasilAccountSystem(request.url.pathname)
    })
  }

  async addYggdrasilAccountSystem(url: string): Promise<void> {
    if (url.startsWith('authlib-injector:')) url = url.substring('authlib-injector:'.length)
    if (url.startsWith('yggdrasil-server:')) url = url.substring('yggdrasil-server:'.length)
    url = decodeURIComponent(url)
    const parsed = new URL(url)
    const domain = parsed.host

    this.log(`Add ${url} as yggdrasil (authlib-injector) api service ${domain}`)

    const api = await loadYggdrasilApiProfile(url)
    this.state.userYggdrasilServicePut(api)
  }

  async removeYggdrasilAccountSystem(url: string): Promise<void> {
    const all = this.state.yggdrasilServices
    this.state.userYggdrasilServices(all.filter(a => a.url !== url))
  }

  @Lock('login')
  async login(options: LoginOptions): Promise<UserProfile> {
    const system = this.accountSystems[options.service] || this.yggdrasilAccountSystem

    this.loginController = new AbortController()

    const profile = await system.login(options, this.loginController.signal)
      .finally(() => { this.loginController = undefined })

    this.state.userProfile(profile)
    this.state.userSelect(profile.id)
    return profile
  }

  async setUserProfile(userProfile: UserProfile): Promise<void> {
    this.state.userProfile(userProfile)
  }

  registerAccountSystem(name: string, system: UserAccountSystem) {
    this.accountSystems[name] = system
  }

  @Lock('uploadSkin')
  async uploadSkin(options: UploadSkinOptions) {
    requireObject(options)

    const {
      gameProfileId,
      userId = this.state.selectedUser.id,
      skin,
    } = options
    const user = this.state.users[userId]
    const gameProfile = user.profiles[gameProfileId || user.selectedProfile]

    const sys = this.accountSystems[user.authService] || this.yggdrasilAccountSystem

    if (skin) {
      if (typeof skin.slim !== 'boolean') skin.slim = false
    }

    this.log(`Upload texture ${gameProfile.name}(${gameProfile.id})`)

    this.setSkinController = new AbortController()
    const data = await sys.setSkin(user, gameProfile, options, this.setSkinController.signal).finally(() => {
      this.setSkinController = undefined
    })
    this.state.userProfile(data)
  }

  /**
   * Save the skin to the disk.
   */
  async saveSkin(options: SaveSkinOptions) {
    requireObject(options)
    requireString(options.url)
    requireString(options.path)
    const { path, url } = options
    await new DownloadTask({ url, destination: path, ...this.networkManager.getDownloadBaseOptions() }).startAndWait()
  }

  /**
   * Refresh the current user login status
   */
  @Lock('refreshUser')
  async refreshUser() {
    const user = this.state.user

    if (!user) {
      this.log('Skip refresh user status as the user is empty.')
      return
    }

    const system = this.accountSystems[user.authService] || this.yggdrasilAccountSystem
    this.refreshController = new AbortController()

    const newUser = await system.refresh(user, this.refreshController.signal).finally(() => {
      this.refreshController = undefined
    })

    this.state.userProfile(newUser)
  }

  /**
  * Switch user account.
  */
  @Lock('selectUser')
  async selectUser(userId: string) {
    requireString(userId)

    if (userId === this.state.selectedUser.id) {
      return
    }

    this.log(`Switch game profile ${this.state.selectedUser.id}->${userId}`)
    this.state.userSelect(userId)
    await this.refreshUser()
  }

  @Lock('selectGameProfile')
  async selectGameProfile(profileId: string) {
    requireString(profileId)

    const user = this.state.user
    if (!user) {
      this.warn(`No valid user`)
      return
    }

    this.state.userGameProfileSelect({ userId: this.state.selectedUser.id, profileId })
  }

  @Singleton(id => id)
  async removeUserProfile(userId: string) {
    requireString(userId)
    if (this.state.selectedUser.id === userId) {
      const user = Object.values(this.state.users).find((u) => !!u.selectedProfile)
      if (!user) {
        this.warn(`No valid user after remove user profile ${userId}!`)
      } else {
        const userId = user.id
        this.log(`Switch game profile ${userId}`)
        this.state.userSelect(userId)
      }
    }
    this.state.userProfileRemove(userId)
  }

  async getOfficialUserProfile(): Promise<(UserProfile & { accessToken: string | undefined }) | undefined> {
    const official = Object.values(this.state.users).find(u => u.authService === 'microsoft')
    if (official) {
      const controller = new AbortController()
      await this.accountSystems.microsoft?.refresh(official, controller.signal)
      const accessToken = await this.tokenStorage.get(official)
      return { ...official, accessToken }
    }
    return undefined
  }

  async abortLogin(): Promise<void> {
    this.loginController?.abort()
  }

  async abortRefresh() {
    this.refreshController?.abort()
  }

  getAccountSystem(service: string) {
    return this.accountSystems[service]
  }
}
