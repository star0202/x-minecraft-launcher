import { InjectionKey, Ref } from 'vue'
import { BaseServiceKey, Instance, InstanceServiceKey, RuntimeVersions } from '@xmcl/runtime-api'
import { useService } from '@/composables'

export const InstanceEditInjectionKey: InjectionKey<ReturnType<typeof useInstanceEdit>> = Symbol('InstanceEdit')

/**
 * Edit the instance data model.
 *
 * @param instance The instance to edit
 * @returns The instance edit data
 */
export function useInstanceEdit(instance: Ref<Instance | undefined>) {
  const { editInstance: edit } = useService(InstanceServiceKey)
  const { state: baseState } = useService(BaseServiceKey)

  const data = reactive({
    name: instance.value?.name ?? '',

    host: '', // mc.hypixel.com
    port: '', // 25565

    author: '',
    description: '',
    url: '',
    fileServerApi: '',

    vmOptions: instance.value?.vmOptions?.join(' '),
    mcOptions: instance.value?.mcOptions?.join(' '),
    maxMemory: instance.value?.maxMemory,
    minMemory: instance.value?.minMemory,

    runtime: {
      minecraft: '',
      forge: instance.value?.runtime.forge,
      fabricLoader: instance.value?.runtime.fabricLoader,
      quiltLoader: instance.value?.runtime.quiltLoader,
      optifine: instance.value?.runtime.optifine,
      liteloader: instance.value?.runtime.liteloader,
    } as RuntimeVersions,
    version: '',

    fastLaunch: instance.value?.fastLaunch,
    hideLauncher: instance.value?.hideLauncher,
    showLog: instance.value?.showLog,

    assignMemory: instance.value?.assignMemory,

    javaPath: instance.value?.java,

    icon: instance.value?.icon,

    loading: true,
  })

  const isGlobalAssignMemory = computed(() => data.assignMemory === undefined)
  const isGlobalMinMemory = computed(() => data.minMemory === undefined)
  const isGlobalMaxMemory = computed(() => data.maxMemory === undefined)
  const isGlobalVmOptions = computed(() => !data.vmOptions)
  const isGlobalMcOptions = computed(() => !data.mcOptions)
  const isGlobalFastLaunch = computed(() => data.fastLaunch === undefined)
  const isGlobalHideLauncher = computed(() => data.hideLauncher === undefined)
  const isGlobalShowLog = computed(() => data.showLog === undefined)
  const resetAssignMemory = () => {
    data.assignMemory = undefined
    data.minMemory = undefined
    data.maxMemory = undefined
  }
  const resetVmOptions = () => {
    data.vmOptions = undefined
  }
  const resetMcOptions = () => {
    data.mcOptions = undefined
  }
  const resetFastLaunch = () => {
    data.fastLaunch = undefined
  }
  const resetHideLauncher = () => {
    data.hideLauncher = undefined
  }
  const resetShowLog = () => {
    data.showLog = undefined
  }

  const assignMemory = computed({
    get: () => data.assignMemory ?? baseState.globalAssignMemory,
    set: (v) => { data.assignMemory = v },
  })
  const minMemory = computed({
    get: () => data.minMemory ?? baseState.globalMinMemory,
    set: (v) => { data.minMemory = v },
  })
  const maxMemory = computed({
    get: () => data.maxMemory ?? baseState.globalMaxMemory,
    set: (v) => { data.maxMemory = v },
  })
  const vmOptions = computed({
    get: () => data.vmOptions || baseState.globalVmOptions.join(' '),
    set: (v) => { data.vmOptions = v },
  })
  const mcOptions = computed({
    get: () => data.mcOptions || baseState.globalMcOptions.join(' '),
    set: (v) => { data.mcOptions = v },
  })
  const fastLaunch = computed({
    get: () => data.fastLaunch || baseState.globalFastLaunch,
    set: (v) => { data.fastLaunch = v },
  })
  const hideLauncher = computed({
    get: () => data.hideLauncher || baseState.globalHideLauncher,
    set: (v) => { data.hideLauncher = v },
  })
  const showLog = computed({
    get: () => data.showLog || baseState.globalShowLog,
    set: (v) => { data.showLog = v },
  })

  const isModified = computed(() => {
    const current = instance.value
    if (!current) {
      return true
    }
    if (current.name !== data.name) {
      return true
    }
    if (current.url !== data.url) {
      return true
    }
    if (current.fileApi !== data.fileServerApi) {
      return true
    }
    if (current.minMemory !== data.minMemory) {
      return true
    }
    if (current.maxMemory !== data.maxMemory) {
      return true
    }
    if (current.vmOptions?.join(' ') !== data.vmOptions) {
      return true
    }
    if (current.mcOptions?.join(' ') !== data.mcOptions) {
      return true
    }
    if (current.assignMemory !== data.assignMemory) {
      return true
    }
    if (current.version !== data.version) {
      return true
    }

    if (current.runtime.minecraft !== data.runtime.minecraft) {
      return true
    }
    if (current.runtime.forge !== data.runtime.forge) {
      return true
    }
    if (current.runtime.fabricLoader !== data.runtime.fabricLoader) {
      return true
    }
    if (current.runtime.quiltLoader !== data.runtime.quiltLoader) {
      return true
    }
    if (current.runtime.optifine !== data.runtime.optifine) {
      return true
    }

    if (current.fastLaunch !== data.fastLaunch) {
      return true
    }
    if (current.showLog !== data.showLog) {
      return true
    }
    if (current.hideLauncher !== data.hideLauncher) {
      return true
    }
    if (current.java !== data.javaPath) {
      return true
    }
    if (current.icon !== data.icon) {
      return true
    }
    if (current.server?.host && current.server?.host !== data.host) {
      return true
    }
    if (current.server?.port && current.server?.port !== Number.parseInt(data.port, 10)) {
      return true
    }
    return false
  })

  async function save() {
    const payload = {
      name: data.name,
      url: data.url,
      fileApi: data.fileServerApi,
      minMemory: data.minMemory,
      maxMemory: data.maxMemory,
      vmOptions: data.vmOptions?.split(' ').filter(v => v.length !== 0) || [],
      mcOptions: data.mcOptions?.split(' ').filter(v => v.length !== 0) || [],
      assignMemory: data.assignMemory,
      version: data.version,
      runtime: data.runtime,
      fastLaunch: data.fastLaunch,
      showLog: data.showLog,
      hideLauncher: data.hideLauncher,
      java: data.javaPath,
      icon: data.icon,
    }
    if (!instance.value?.server) {
      await edit({
        ...payload,
        author: data.author,
        description: data.description,
      })
    } else {
      await edit({
        ...payload,
        server: {
          host: data.host,
          port: Number.parseInt(data.port, 10),
        },
      })
    }
    data.icon = instance.value?.icon
  }
  function load() {
    data.loading = false
    const current = instance.value
    if (current) {
      data.name = current.name
      data.hideLauncher = current.hideLauncher
      data.url = current.url
      data.showLog = current.showLog
      data.author = current.author
      data.fileServerApi = current.fileApi
      data.description = current.description || ''
      data.runtime.fabricLoader = current.runtime.fabricLoader
      data.runtime.forge = current.runtime.forge
      data.runtime.minecraft = current.runtime.minecraft
      data.runtime.optifine = current.runtime.optifine
      data.runtime.quiltLoader = current.runtime.quiltLoader
      data.version = current.version
      data.icon = current.icon

      if (current.server) {
        data.host = current.server.host
        data.port = current.server.port?.toString() || ''
      }

      data.maxMemory = current.maxMemory
      data.minMemory = current.minMemory
      data.vmOptions = current.vmOptions?.join(' ') || ''
      data.mcOptions = current.mcOptions?.join(' ') || ''
      data.javaPath = current.java
      data.assignMemory = current.assignMemory
      data.fastLaunch = current.fastLaunch
    }
  }

  return {
    isModified,
    isGlobalAssignMemory,
    isGlobalMinMemory,
    isGlobalMaxMemory,
    isGlobalVmOptions,
    isGlobalMcOptions,
    isGlobalFastLaunch,
    isGlobalHideLauncher,
    isGlobalShowLog,
    assignMemory,
    fastLaunch,
    hideLauncher,
    showLog,
    resetAssignMemory,
    resetVmOptions,
    resetMcOptions,
    resetFastLaunch,
    resetHideLauncher,
    resetShowLog,
    minMemory,
    maxMemory,
    mcOptions,
    vmOptions,
    data,
    save,
    load,
  }
}
