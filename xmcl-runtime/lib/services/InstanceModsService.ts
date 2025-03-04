import { InstanceModsService as IInstanceModsService, ResourceService as IResourceService, InstallModsOptions, InstanceModsServiceKey, InstanceModsState, Resource, ResourceDomain, isModResource } from '@xmcl/runtime-api'
import { FSWatcher, existsSync } from 'fs'
import { ensureDir } from 'fs-extra/esm'
import { rename, stat, unlink } from 'fs/promises'
import watch from 'node-watch'
import { dirname, join } from 'path'
import LauncherApp from '../app/LauncherApp'
import { LauncherAppKey } from '../app/utils'
import { shouldIgnoreFile } from '../resourceCore'
import { AggregateExecutor } from '../util/aggregator'
import { linkWithTimeoutOrCopy, readdirIfPresent } from '../util/fs'
import { Inject } from '../util/objectRegistry'
import { InstanceService } from './InstanceService'
import { ResourceService } from './ResourceService'
import { ExposeServiceKey, Lock, Singleton, StatefulService } from './Service'

/**
 * Provide the abilities to import mods and resource packs files to instance
 */
@ExposeServiceKey(InstanceModsServiceKey)
export class InstanceModsService extends StatefulService<InstanceModsState> implements IInstanceModsService {
  private modsWatcher: FSWatcher | undefined

  private updateMod = new AggregateExecutor<[Resource, boolean], [Resource, boolean][]>(v => v,
    (all) => {
      const toAdd = [] as Resource[]
      const toRemove = [] as Resource[]
      for (const [r, isAdd] of all) {
        if (isAdd) toAdd.push(r)
        else toRemove.push(r)
      }
      this.state.instanceModUpdates({ adds: toAdd, remove: toRemove })
    },
    500)

  constructor(@Inject(LauncherAppKey) app: LauncherApp,
    @Inject(ResourceService) private resourceService: ResourceService,
    @Inject(InstanceService) private instanceService: InstanceService,
  ) {
    super(app, () => new InstanceModsState())
    const listener = resourceService as IResourceService
    listener.on('resourceAdd', (res) => {
      const existed = this.state.mods.findIndex(m => m.hash === res.hash)
      if (existed !== -1) {
        this.state.instanceModUpdateExisted([res])
      }
    }).on('resourceUpdate', (res) => {
      const existed = this.state.mods.findIndex(m => m.hash === res.hash)
      if (existed !== -1) {
        this.state.instanceModUpdateExisted([res])
      }
    })

    this.storeManager.subscribe('instanceSelect', () => {
      this.refresh()
    })

    this.resourceService.registerInstaller(ResourceDomain.Mods, async (resource, instancePath) => {
      await this.install({
        mods: [resource],
        path: instancePath,
      })
    })
  }

  async showDirectory(): Promise<void> {
    await this.app.shell.openDirectory(join(this.instanceService.state.path, 'mods'))
  }

  private async scanMods(dir: string) {
    const files = await readdirIfPresent(dir)

    const fileArgs = files.filter((file) => !shouldIgnoreFile(file)).map((file) => join(dir, file))

    const resources = await this.resourceService.importResources(fileArgs.map(f => ({ path: f, domain: ResourceDomain.Mods })))
    return resources.map((r, i) => ({ ...r, path: fileArgs[i] }))
  }

  async dispose() {
    if (this.modsWatcher) {
      this.modsWatcher.close()
    }
  }

  @Singleton()
  async diagnoseMods() {
  }

  async refresh(force?: boolean): Promise<void> {
    const basePath = this.instanceService.state.path
    if (force || this.state.instance !== basePath || !this.modsWatcher) {
      await this.mount(basePath)
    }
  }

  @Lock('instance:mods')
  async mount(instancePath: string): Promise<void> {
    const basePath = join(instancePath, 'mods')
    if (this.modsWatcher) {
      this.modsWatcher.close()
    }
    await ensureDir(basePath)
    await this.resourceService.whenReady(ResourceDomain.Mods)
    this.state.instanceMods({ instance: instancePath, resources: await this.scanMods(basePath) })
    this.modsWatcher = watch(basePath, async (event, filePath) => {
      if (shouldIgnoreFile(filePath)) return
      if (event === 'update') {
        const [resource] = await this.resourceService.importResources([{ path: filePath, domain: ResourceDomain.Mods }])
        if (isModResource(resource)) {
          this.log(`Instance mod add ${filePath}`)
        } else {
          this.warn(`Non mod resource added in /mods directory! ${filePath}`)
        }
        this.updateMod.push([resource, true])
      } else {
        const target = this.state.mods.find(r => r.path === filePath)
        if (target) {
          this.log(`Instance mod remove ${filePath}`)
          this.updateMod.push([target, false])
        } else {
          this.warn(`Cannot remove the mod ${filePath} as it's not found in memory cache!`)
        }
      }
    })
    this.log(`Mounted on instance mods: ${basePath}`)
  }

  async install({ mods: resources, path = this.state.instance }: InstallModsOptions) {
    const promises: Promise<void>[] = []
    if (!path) {
      path = this.state.instance
    }
    this.log(`Install ${resources.length} to ${path}/mods`)
    for (const res of resources) {
      if (res.domain !== ResourceDomain.Mods) {
        this.warn(`Install non mod resource ${res.name} as it's not a mod`)
      }
      const src = join(res.path)
      const dest = join(path, ResourceDomain.Mods, res.fileName)
      const [srcStat, destStat] = await Promise.all([stat(src), stat(dest).catch(() => undefined)])

      let promise: Promise<void> | undefined
      if (!destStat) {
        promise = linkWithTimeoutOrCopy(src, dest)
      } else if (srcStat.ino !== destStat.ino) {
        promise = unlink(dest).then(() => linkWithTimeoutOrCopy(src, dest))
      }
      if (promise) {
        promises.push(promise.catch((e) => {
          this.error(new Error(`Cannot deploy the resource from ${src} to ${dest}`, { cause: e }))
          throw e
        }))
      }
    }
    if (promises.length > 0) {
      await Promise.all(promises)
    }
  }

  async enable({ mods, path = this.state.instance }: InstallModsOptions): Promise<void> {
    this.log(`Enable ${mods.length} mods from ${path}`)
    const promises: Promise<void>[] = []
    const instanceModsDir = join(path, ResourceDomain.Mods)
    for (const resource of mods) {
      if (dirname(resource.path) !== instanceModsDir) {
        this.warn(`Skip to enable unmanaged mod file on ${resource.path}!`)
      } else if (!resource.path.endsWith('.disabled')) {
        this.warn(`Skip to enable enabled mod file on ${resource.path}!`)
      } else {
        promises.push(rename(resource.path, resource.path.substring(0, resource.path.length - '.disabled'.length)).catch(e => {
          if (e.code === 'ENOENT') {
            // Force remove
            this.state.instanceModRemove([resource])
          }
        }))
      }
    }
    await Promise.all(promises)
  }

  async disable({ mods, path = this.state.instance }: InstallModsOptions) {
    this.log(`Disable ${mods.length} mods from ${path}`)
    const promises: Promise<void>[] = []
    const instanceModsDir = join(path, ResourceDomain.Mods)
    for (const resource of mods) {
      if (dirname(resource.path) !== instanceModsDir) {
        this.warn(`Skip to disable unmanaged mod file on ${resource.path}!`)
      } else if (resource.path.endsWith('.disabled')) {
        this.warn(`Skip to disable disabled mod file on ${resource.path}!`)
      } else {
        promises.push(rename(resource.path, resource.path + '.disabled').catch(e => {
          if (e.code === 'ENOENT') {
            // Force remove
            this.state.instanceModRemove([resource])
          }
        }))
      }
    }
    await Promise.all(promises)
  }

  async uninstall(options: InstallModsOptions) {
    const { mods, path = this.state.instance } = options
    this.log(`Uninstall ${mods.length} mods from ${path}`)
    const promises: Promise<void>[] = []
    const instanceModsDir = join(path, ResourceDomain.Mods)
    for (const resource of mods) {
      if (dirname(resource.path) !== instanceModsDir) {
        const founded = this.state.mods.find(m => m.ino === resource.ino) ??
          this.state.mods.find(m => m.hash === resource.hash)
        if (founded && founded.path !== resource.path) {
          const realPath = join(instanceModsDir, founded.fileName)
          if (existsSync(realPath)) {
            promises.push(unlink(realPath))
          } else {
            this.warn(`Skip to uninstall unmanaged mod file on ${resource.path}!`)
          }
        } else {
          this.warn(`Skip to uninstall unmanaged mod file on ${resource.path}!`)
        }
      } else {
        promises.push(unlink(resource.path).catch(e => {
          if (e.code === 'ENOENT') {
            // Force remove
            this.state.instanceModRemove([resource])
          }
        }))
      }
    }
    await Promise.all(promises)
    this.log(`Finish to uninstall ${mods.length} from ${path}`)
  }
}
