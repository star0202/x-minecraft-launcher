import { AZURE_CDN, AZURE_MS_CDN, IS_DEV } from '@/constant'
import { DownloadTask } from '@xmcl/installer'
import { ChecksumNotMatchError, download } from '@xmcl/file-transfer'
import { BaseService, ServiceStateManager } from '@xmcl/runtime'
import { ReleaseInfo } from '@xmcl/runtime-api'
import { LauncherAppUpdater } from '@xmcl/runtime/lib/app/LauncherAppUpdater'
import { Logger } from '@xmcl/runtime/lib/util/log'
import { BaseTask, task, Task } from '@xmcl/task'
import { spawn } from 'child_process'
import { autoUpdater, CancellationToken, Provider, UpdateInfo, UpdaterSignal } from 'electron-updater'
import { stat, writeFile } from 'fs/promises'
import { closeSync, existsSync, open, rename, unlink } from 'original-fs'
import { platform } from 'os'
import { basename, dirname, join } from 'path'
import { SemVer } from 'semver'
import { request } from 'undici'
import { URL } from 'url'
import { promisify } from 'util'
import ElectronLauncherApp from '../ElectronLauncherApp'
import { DownloadAppInstallerTask } from './appinstaller'
import { checksum } from './fs'

/**
 * Only download asar file update.
 *
 * If the this update is not a full update but an incremental update,
 * you can call this to download asar update
 */
export class DownloadAsarUpdateTask extends DownloadTask {
  constructor(destination: string, version: string) {
    let sha256 = ''
    version = version.startsWith('v') ? version.substring(1) : version
    const pl = platform()
    const platformFlat = pl === 'win32' ? 'win' : pl === 'darwin' ? 'mac' : 'linux'
    super({
      url: [
        `${AZURE_CDN}/app-${version}-${platformFlat}.asar`,
        `${AZURE_MS_CDN}/app-${version}-${platformFlat}.asar`,
      ],
      destination,
      validator: {
        async validate(file, url) {
          const missed = await stat(file).then(s => s.size === 0, () => false)
          if (missed) {
            return
          }
          if (!sha256) {
            const response = await request(`${url}.sha256`, { throwOnError: true })
            sha256 = await response.body.text().catch(() => '')
          }
          if (!sha256 || sha256.length !== 64) {
            return
          }
          const expect = sha256
          const actual = await checksum(file, 'sha256')
          if (expect !== actual) {
            throw new ChecksumNotMatchError('sha256', expect, actual, file, url)
          }
        },
      },
    })
  }
}

/**
 * Download the full update. This size can be larger as it carry the whole electron thing...
 */
export class DownloadFullUpdateTask extends BaseTask<void> {
  private updateSignal = new UpdaterSignal(autoUpdater)

  private cancellationToken = new CancellationToken()

  protected async runTask(): Promise<void> {
    this.updateSignal.progress((info) => {
      this._progress = info.transferred
      this._total = info.total
      this.update(info.delta)
    })
    await autoUpdater.downloadUpdate(this.cancellationToken)
  }

  protected cancelTask(): Promise<void> {
    this.cancellationToken.cancel()
    return new Promise((resolve) => {
      autoUpdater.once('update-cancelled', resolve)
    })
  }

  protected async pauseTask(): Promise<void> {
    this.cancellationToken.cancel()
  }

  protected resumeTask(): Promise<void> {
    // this.runRunt()
    return Promise.resolve()
  }
}

export class ElectronUpdater implements LauncherAppUpdater {
  private logger: Logger

  constructor(private app: ElectronLauncherApp) {
    this.logger = app.logManager.getLogger('ElectronUpdater')
  }

  private async getUpdateFromSelfHost(): Promise<ReleaseInfo> {
    const app = this.app
    app.log('Try get update from selfhost')
    const { allowPrerelease, locale } = app.serviceManager.get(BaseService).state
    const url = `https://api.xmcl.app/latest?version=v${app.version}&prerelease=${allowPrerelease || false}`
    const response = await request(url, {
      headers: {
        'Accept-Language': locale,
      },
      throwOnError: true,
    }).catch(() => request('https://xmcl.blob.core.windows.net/releases/latest_version.json'))
    const result = await response.body.json()
    const updateInfo: ReleaseInfo = {
      name: result.tag_name,
      body: result.body,
      date: result.published_at,
      files: result.assets.map((a: any) => ({ url: a.browser_download_url, name: a.name })),
      newUpdate: true,
      useAutoUpdater: false,
      incremental: true,
    }
    updateInfo.newUpdate = `v${app.version}` !== updateInfo.name
    const platformString = app.platform.name === 'windows' ? 'win' : app.platform.name === 'osx' ? 'mac' : 'linux'
    const version = updateInfo.name.startsWith('v') ? updateInfo.name.substring(1) : updateInfo.name
    updateInfo.incremental = updateInfo.files.some(f => f.name === `app-${version}-${platformString}.asar`)
    app.log(`Got incremental=${updateInfo.incremental} update from selfhost`)

    return updateInfo
  }

  private async quitAndInstallAsar() {
    const appAsarPath = dirname(__dirname)
    const updateAsarPath = join(this.app.appDataPath, 'pending_update')

    this.logger.log(`Install asar on ${this.app.platform.name} ${appAsarPath}`)
    if (this.app.platform.name === 'windows') {
      const elevatePath = await ensureElevateExe(this.app.appDataPath)

      if (!existsSync(updateAsarPath)) {
        throw new Error(`No update found: ${updateAsarPath}`)
      }
      const psPath = join(this.app.appDataPath, 'AutoUpdate.ps1')
      let hasWriteAccess = await new Promise((resolve) => {
        open(appAsarPath, 'a', (e, fd) => {
          if (e) {
            resolve(false)
          } else {
            closeSync(fd)
            resolve(true)
          }
        })
      })

      // force elevation for now
      hasWriteAccess = false

      this.logger.log(hasWriteAccess ? `Process has write access to ${appAsarPath}` : `Process does not have write access to ${appAsarPath}`)
      let startProcessCmd = `Start-Process -FilePath "${process.argv[0]}"`
      if (process.argv.slice(1).length > 0) {
        startProcessCmd += ` -ArgumentList ${process.argv.slice(1).map((s) => `"${s}"`).join(', ')}`
      }
      startProcessCmd += ` -WorkingDirectory ${process.cwd()}`
      await writeFile(psPath, [
        'Start-Sleep -s 1',
        `Copy-Item -Path "${updateAsarPath}" -Destination "${appAsarPath}"`,
        `Remove-Item -Path "${updateAsarPath}"`,
        startProcessCmd,
      ].join('\r\n'))

      const args = [
        'powershell.exe',
        '-ExecutionPolicy',
        'RemoteSigned',
        '-File',
        `"${psPath}"`,
      ]
      if (!hasWriteAccess) {
        args.unshift(elevatePath)
      }
      this.logger.log(`Install from windows: ${args.join(' ')}`)
      this.logger.log(`Relaunch the process by: ${startProcessCmd}`)

      spawn(args[0], args.slice(1), {
        detached: true,
      }).on('error', (e) => {
        this.logger.error(e)
      }).on('exit', (code, s) => {
        this.logger.log(`Update process exit ${code}`)
      }).unref()
      this.app.quit()
    } else {
      await promisify(rename)(appAsarPath, appAsarPath + '.bk').catch(() => { })
      try {
        await promisify(rename)(updateAsarPath, appAsarPath)
        await promisify(unlink)(appAsarPath + '.bk').catch(() => { })
        this.app.relaunch()
      } catch (e) {
        this.logger.error(new Error(`Fail to rename update the file: ${appAsarPath}`, { cause: e }))
        await promisify(rename)(appAsarPath + '.bk', appAsarPath)
      }
    }
  }

  checkUpdateTask(): Task<ReleaseInfo> {
    return task('checkUpdate', async () => {
      try {
        if (this.app.env === 'appx') {
          return this.getUpdateFromSelfHost()
        }

        let newUpdate = false
        autoUpdater.once('update-available', () => {
          this.logger.log('Update available and set status to pending')
          if (release) {
            release.newUpdate = true
          } else {
            newUpdate = true
          }
        })
        this.logger.log(`Check update via ${autoUpdater.getFeedURL()}`)
        const info = await autoUpdater.checkForUpdates()
        if (this.app.networkManager.isInGFW && !injectedUpdate) {
          injectedUpdate = true
          const provider: Provider<UpdateInfo> = (await (autoUpdater as any).clientPromise)
          const originalResolve = provider.resolveFiles
          provider.resolveFiles = function (this: Provider<UpdateInfo>, inf: UpdateInfo) {
            const result = originalResolve.bind(provider)(inf)
            result.forEach((i) => {
              const pathname = i.url.pathname;
              (i as any).url = new URL(`${AZURE_CDN}/${basename(pathname)}`)
            })
            return result
          }
        }

        const currentVersion = autoUpdater.currentVersion
        const newVersion = new SemVer(info.updateInfo.version)

        const release = {
          name: info.updateInfo.version,
          body: (info.updateInfo.releaseNotes ?? '') as string,
          date: info.updateInfo.releaseDate,
          files: info.updateInfo.files.map(f => ({ name: basename(f.url), url: f.url })),
          useAutoUpdater: true,
          newUpdate,
          incremental: newVersion.major === currentVersion.major,
        }

        release.incremental = release.files.some(f => f.name.endsWith('.asar'))

        return release
      } catch (e) {
        return this.getUpdateFromSelfHost()
      }
    })
  }

  downloadUpdateTask(updateInfo: ReleaseInfo): Task<void> {
    if (this.app.env === 'appx') {
      return new DownloadAppInstallerTask(this.app)
    }
    if (updateInfo.incremental && this.app.env === 'raw') {
      const updatePath = join(this.app.appDataPath, 'pending_update')
      return new DownloadAsarUpdateTask(updatePath, updateInfo.name)
        .map(() => undefined)
    }
    return new DownloadFullUpdateTask()
  }

  async installUpdateAndQuit(updateInfo: ReleaseInfo): Promise<void> {
    if (IS_DEV) {
      this.logger.log('Currently is development environment. Skip to install update')
      return
    }
    if (updateInfo.incremental) {
      await this.quitAndInstallAsar()
    } else {
      autoUpdater.quitAndInstall()
    }
  }
}

async function ensureElevateExe(appDataPath: string) {
  const elevate = join(appDataPath, 'elevate.exe')
  await download({
    url: [
      `${AZURE_CDN}/elevate.exe`,
      `${AZURE_MS_CDN}/elevate.exe`,
    ],
    validator: {
      algorithm: 'sha1',
      hash: 'd8d449b92de20a57df722df46435ba4553ecc802',
    },
    destination: elevate,
  })
  return elevate
}

let injectedUpdate = false

export function setup(storeManager: ServiceStateManager) {
  storeManager.subscribe('autoInstallOnAppQuitSet', (value) => {
    autoUpdater.autoInstallOnAppQuit = value
  }).subscribe('allowPrereleaseSet', (value) => {
    autoUpdater.allowPrerelease = value
  }).subscribe('autoDownloadSet', (value) => {
    autoUpdater.autoDownload = value
  }).subscribe('config', (config) => {
    autoUpdater.autoInstallOnAppQuit = config.autoInstallOnAppQuit
    autoUpdater.allowPrerelease = config.allowPrerelease
    autoUpdater.autoDownload = config.autoDownload
  })
}
