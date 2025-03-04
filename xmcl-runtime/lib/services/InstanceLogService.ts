import { InstanceLogService as IInstanceLogService, InstanceLogServiceKey } from '@xmcl/runtime-api'
import { unlink, readFile } from 'fs/promises'
import { isAbsolute, join } from 'path'
import { LauncherApp } from '../app/LauncherApp'
import { LauncherAppKey } from '../app/utils'
import { EncodingWorker, kEncodingWorker } from '../entities/encodingWorker'
import { UTF8 } from '../util/encoding'
import { readdirIfPresent } from '../util/fs'
import { Inject } from '../util/objectRegistry'
import { gunzip } from '../util/zip'
import { InstanceService } from './InstanceService'
import { AbstractService, ExposeServiceKey, Singleton } from './Service'

/**
 * Provide the ability to list/read/remove log and crash reports of a instance.
 */
@ExposeServiceKey(InstanceLogServiceKey)
export class InstanceLogService extends AbstractService implements IInstanceLogService {
  constructor(@Inject(LauncherAppKey) app: LauncherApp,
    @Inject(InstanceService) private instanceService: InstanceService,
    @Inject(kEncodingWorker) private encoder: EncodingWorker,
  ) {
    super(app)
  }

  /**
   * List the log in current instances
   */
  @Singleton()
  async listLogs() {
    const files = await readdirIfPresent(join(this.instanceService.state.path, 'logs'))
    return files.filter(f => f.endsWith('.gz') || f.endsWith('.txt') || f.endsWith('.log'))
  }

  /**
   * Remove a log from disk
   * @param name The log file name
   */
  @Singleton(name => name)
  async removeLog(name: string) {
    const filePath = join(this.instanceService.state.path, 'logs', name)
    this.log(`Remove log ${filePath}`)
    await unlink(filePath)
  }

  /**
   * Get the log content.
   * @param name The log file name
   */
  @Singleton(name => name)
  async getLogContent(name: string) {
    try {
      const filePath = join(this.instanceService.state.path, 'logs', name)
      let buf = await readFile(filePath)
      if (name.endsWith('.gz')) {
        buf = await gunzip(buf)
      }
      const encoding = await this.encoder.guessEncodingByBuffer(buf).catch(e => undefined)
      const result = await this.encoder.decode(buf, encoding || UTF8)
      return result
    } catch (e) {
      this.error(new Error(`Fail to get log content "${name}"`, { cause: e }))
      return ''
    }
  }

  /**
   * List crash reports in current instance
   */
  @Singleton()
  async listCrashReports() {
    const files = await readdirIfPresent(join(this.instanceService.state.path, 'crash-reports'))
    return files.filter(f => f.endsWith('.gz') || f.endsWith('.txt'))
  }

  /**
   * Remove a crash report from disk
   * @param name The crash report file name
   */
  @Singleton((name) => name)
  async removeCrashReport(name: string) {
    const filePath = join(this.instanceService.state.path, 'crash-reports', name)
    this.log(`Remove crash report ${filePath}`)
    await unlink(filePath)
  }

  /**
   * Get the crash report content
   * @param name The name of crash report
   */
  @Singleton((name) => name)
  async getCrashReportContent(name: string) {
    let filePath: string
    if (isAbsolute(name)) {
      filePath = name
    } else {
      filePath = join(this.instanceService.state.path, 'crash-reports', name)
    }
    let buf = await readFile(filePath.trim())
    if (name.endsWith('.gz')) {
      buf = await gunzip(buf)
    }
    const encoding = await this.encoder.guessEncodingByBuffer(buf).catch(() => undefined)
    const result = await this.encoder.decode(buf, encoding || UTF8)
    return result
  }

  /**
   * Show the log file on disk. This will open a file explorer.
   * @param name The log file name
   */
  showLog(name: string) {
    const filePath = join(this.instanceService.state.path, 'logs', name)
    this.app.shell.showItemInFolder(filePath)
  }

  /**
   * Show a crash report on disk. This will open a file explorer.
   * @param name The crash report file name
   */
  showCrash(name: string) {
    const filePath = join(this.instanceService.state.path, 'crash-reports', name)
    this.app.shell.showItemInFolder(filePath)
  }
}
