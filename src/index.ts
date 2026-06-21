import path from 'path'
import fsp from 'fs/promises'
import { glob } from 'glob'
import OSS from 'ali-oss'
import pc from 'picocolors'
import pLimit from 'p-limit'
import webpackDefault, { type Compiler, type Compilation } from 'webpack'

// webpack 是 CommonJS 包，ESM 下必须通过默认导入再解构，
// 否则 `import { sources } from 'webpack'` 会在运行时报
// "Named export 'sources' not found ... CommonJS module"。
const { Compilation: CompilationConst, sources: wpSources } =
  webpackDefault as unknown as typeof import('webpack')

import {
  defaultOption,
  DEFAULT_FILE_SUFFIX,
  type PluginOptions,
  type UploadStats,
} from './type'
import { cleanEmptyDir, detectInternalNetwork, escapeRegExp, normalize, resolveInternalHost, slash } from './utils'

const PLUGIN_NAME = 'webpack-plugin-oss-upload'
const { RawSource } = wpSources

const REQUIRED_OSS_KEYS: ReadonlyArray<keyof PluginOptions> = [
  'accessKeyId',
  'accessKeySecret',
  'bucket',
]

const log = {
  info: (msg: string) => console.log(pc.green(msg)),
  error: (msg: string) => console.log(pc.red(msg)),
  step: (msg: string) => console.log(pc.cyan(msg)),
}

/** 仅在 verbose 开启时输出日志 */
const makeDebug = (verbose: boolean) => (msg: string) => {
  if (verbose) console.log(msg)
}

/**
 * 校验配置项：
 * - `accessKeyId` / `accessKeySecret` / `bucket` 必填
 * - `region` 与 `endpoint` 至少传入一个（OSS 客户端要求二选一）
 * 返回错误信息数组（空数组表示通过）。
 */
const validateOptions = (options: PluginOptions): string[] => {
  const errors: string[] = []
  for (const key of REQUIRED_OSS_KEYS) {
    const v = options[key]
    if (v === undefined || v === null || v === '') {
      errors.push(String(key))
    }
  }
  const hasRegion = typeof options.region === 'string' && options.region.trim() !== ''
  const hasEndpoint = typeof options.endpoint === 'string' && options.endpoint.trim() !== ''
  if (!hasRegion && !hasEndpoint) {
    errors.push('region/endpoint（至少配置其一）')
  }
  return errors
}

/**
 * 默认的 OSS 路径生成：以构建输出目录为基准，截取相对路径作为 OSS key。
 * 适配 `outputDirectory`，不再硬编码 "dist"。
 */
const defaultSetOssPath =
  (outputDirectory: string) =>
  (filePath: string): string => {
    const idx = filePath.lastIndexOf(outputDirectory)
    const rel = idx >= 0 ? filePath.slice(idx + outputDirectory.length) : path.basename(filePath)
    return slash(rel).replace(/^\/+/, '')
  }

/**
 * 将打包好的资源文件上传到阿里云 OSS，并把产物中资源引用替换为 CDN 地址的 Webpack 5+ 插件。
 *
 * - 上传在 `afterEmit` 钩子执行（产物已落盘）
 * - CDN 引用改写在 `processAssets`（REPORT 阶段，内存中操作 `compilation.assets`）
 * - 内网探测在 `beforeRun` / `watchRun`（仅探测一次）
 */
class OSSUploadWebpackPlugin {
  /** 插件名，供 webpack 识别与日志展示 */
  readonly name = PLUGIN_NAME
  private readonly options: PluginOptions

  private readonly from: string
  private readonly dist: string
  private readonly deleteOrigin: boolean
  private readonly deleteEmptyDir: boolean
  private readonly setOssPath: PluginOptions['setOssPath']
  private readonly timeout: number
  private readonly verbose: boolean
  private readonly test: boolean
  private readonly overwrite: boolean
  private readonly version: string
  private readonly setVersion: PluginOptions['setVersion']
  private readonly assetsDirectory: string
  private readonly outputDirectory: string
  private readonly fileSuffix: string[]
  private readonly resolveOssPath: (filePath: string) => string
  private readonly limit: ReturnType<typeof pLimit>
  private readonly debug: (msg: string) => void
  private readonly quitWpOnError: boolean

  private oss: OSS
  // 内网探测只执行一次（watch 模式下避免每次 rebuild 都探测）
  private detectOnce = false

  constructor(rawOptions: PluginOptions) {
    // 合并默认值，避免污染 defaultOption（不使用 Object.assign(defaultOption, options)）
    const options: PluginOptions = { ...defaultOption, ...rawOptions }
    const errors = validateOptions(options)
    if (errors.length > 0) {
      throw new Error(
        `[${PLUGIN_NAME}] 配置校验失败，请检查以下配置项: ${errors.join(', ')}。`,
      )
    }
    this.options = options

    this.quitWpOnError = options.quitWpOnError ?? false
    const concurrency = options.concurrency
    this.from = options.from ?? defaultOption.from
    this.dist = options.dist ?? defaultOption.dist
    this.deleteOrigin = options.deleteOrigin ?? defaultOption.deleteOrigin
    this.deleteEmptyDir = options.deleteEmptyDir ?? defaultOption.deleteEmptyDir
    this.setOssPath = options.setOssPath
    this.timeout = options.timeout ?? defaultOption.timeout
    this.verbose = options.verbose ?? defaultOption.verbose
    this.test = options.test ?? defaultOption.test
    this.overwrite = options.overwrite ?? defaultOption.overwrite
    this.version = options.version ?? defaultOption.version
    this.setVersion = options.setVersion
    this.assetsDirectory = options.assetsDirectory ?? defaultOption.assetsDirectory
    this.outputDirectory = options.outputDirectory ?? defaultOption.outputDirectory

    this.fileSuffix = options.fileSuffix ?? [...DEFAULT_FILE_SUFFIX]
    // 仅在用户未自定义 setOssPath 时启用默认实现
    this.resolveOssPath = this.setOssPath ?? defaultSetOssPath(this.outputDirectory)
    this.limit = pLimit(Math.max(1, concurrency ?? 5))
    this.debug = makeDebug(this.verbose)

    this.oss = this.createOSS()
  }

  /**
   * 根据最终的 region / endpoint / secure 创建 OSS 客户端。
   * 提取为方法，便于在 beforeRun 探测内网后重建客户端。
   */
  private createOSS = (override?: {
    region?: string
    endpoint?: string
    secure?: boolean
  }): OSS => {
    const options = this.options
    return new OSS({
      ...(override?.region ?? options.region ? { region: override?.region ?? options.region } : {}),
      ...(override?.endpoint ?? options.endpoint
        ? { endpoint: override?.endpoint ?? options.endpoint }
        : {}),
      ...(override?.secure !== undefined
        ? { secure: override.secure }
        : options.secure !== undefined
          ? { secure: options.secure }
          : {}),
      accessKeyId: options.accessKeyId,
      accessKeySecret: options.accessKeySecret,
      bucket: options.bucket,
    })
  }

  /**
   * 使用 HEAD 判断 OSS 中是否存在该文件。
   * 只对 "文件确实不存在"（NoSuchKey / 404）返回 false，
   * 其它错误（鉴权失败、网络异常等）向上抛出，避免被静默吞没。
   */
  private getFileExists = async (filepath: string): Promise<boolean> => {
    try {
      await this.oss.head(filepath)
      return true
    } catch (e: unknown) {
      const err = e as { code?: string; status?: number }
      if (err.code === 'NoSuchKey' || err.status === 404) return false
      throw e
    }
  }

  /**
   * 上传文件（并发受 `concurrency` 控制）。
   *
   * @param files 所有需要上传的文件路径列表
   * @param outputPath 构建输出目录的绝对路径
   */
  private upload = async (files: string[], outputPath: string): Promise<UploadStats> => {
    if (this.test) {
      log.info(`\n Currently running in test mode, your files won't really be uploaded.\n`)
    } else {
      log.info(`\n Your files will be uploaded very soon.\n`)
    }

    const stats: UploadStats = { uploaded: [], ignored: [], errors: [] }
    const fileCount = files.length
    let index = 0

    const tasks = files.map((file) =>
      this.limit(async () => {
        const n = ++index
        const fullPath = path.resolve(file)
        // OSS 目标路径
        const relativePath = this.resolveOssPath(fullPath) || (outputPath ? fullPath.split(outputPath)[1] : '')
        const ossFilePath = slash(path.join(this.dist, relativePath)).replace(/^\/+/, '')

        try {
          // 用 HEAD 而非 GET 检查存在性，避免下载文件内容
          const exists = await this.getFileExists(ossFilePath)
          this.debug(`oss中 ${pc.underline(ossFilePath)} ${exists ? '已存在' : '不存在'}`)

          if (exists && !this.overwrite) {
            stats.ignored.push(fullPath)
            return
          }

          if (this.test) {
            console.log(pc.blue(file), `is ready to upload to ${pc.green(ossFilePath)}\n`)
            return
          }

          this.debug(`\n ${n}/${fileCount} ${pc.underline(file)} uploading...`)

          const result = await this.oss.put(ossFilePath, fullPath, {
            timeout: this.timeout,
            // 覆盖时设置长期缓存；不覆盖时禁止覆盖写入
            headers: this.overwrite
              ? { 'Cache-Control': 'max-age=31536000' }
              : { 'Cache-Control': 'max-age=31536000', 'x-oss-forbid-overwrite': true },
          })

          const url = normalize(result.url || '')
          stats.uploaded.push(file)
          this.debug(
            `\n ${n}/${fileCount} ${pc.blue(pc.underline(file))} successfully uploaded, oss url =>  ${pc.green(pc.underline(url))}`,
          )

          if (this.deleteOrigin) {
            await fsp.unlink(fullPath).catch(() => {})
            if (this.deleteEmptyDir) {
              cleanEmptyDir(fullPath, outputPath || undefined)
            }
          }
        } catch (err: unknown) {
          const e = err as { code?: string; message?: string; name?: string }
          stats.errors.push({ file, err: { code: e.code, message: e.message, name: e.name } })
          log.error(`\n Failed to upload ${pc.underline(file)}: ${e.name}-${e.code}: ${e.message}`)
        }
      }),
    )

    await Promise.all(tasks)

    // 版本号上报（失败不阻断主流程）
    try {
      if (this.setVersion && this.version && !this.test) {
        await this.setVersion({ version: this.version })
        log.step('版本号已更新')
      }
    } catch (err: unknown) {
      const e = err as { message?: string }
      log.error(`更新版本号出错了: ${e?.message ?? err}`)
    }

    return stats
  }

  /**
   * 替换构建产物中的资源引用为 CDN 地址（在内存中改写 `compilation.assets`）。
   * 仅替换形如 `/assets/xxx.<ext>` 的引用（前面通常是引号、等号、括号或空白），
   * 并排除已是完整 URL（http(s)://）的情况。
   */
  private rewriteAssetUrls = async (compilation: Compilation): Promise<void> => {
    if (!this.options.cdnHost) return

    const base = new URL(this.dist || '', this.options.cdnHost).href
    const cdnBaseUrl = normalize(base).replace(/\/$/, '')

    const dirPattern = escapeRegExp(this.assetsDirectory)
    const suffixPattern = this.fileSuffix.map(escapeRegExp).join('|')
    // $1 = 前导分隔符（引号/等号/括号/空白/行首），原样保留
    // $2 = /assets/xxx.<ext>，被替换为 ${cdnBaseUrl}$2
    const regExp = new RegExp(
      `(^|[\\s'"=()])((?:\\/${dirPattern})\\/[\\w.\\-/]+\\.(${suffixPattern}))(?![\\w])`,
      'ig',
    )

    // 仅处理文本类资源
    const isTextAsset = (name: string) => /\.(js|css|html?)$/i.test(name)

    for (const name of Object.keys(compilation.assets)) {
      if (!isTextAsset(name)) continue
      const asset = compilation.getAsset(name)
      if (!asset) continue
      const content = asset.source.source().toString('utf-8')
      const next = content.replace(regExp, `$1${cdnBaseUrl}$2`)
      if (next !== content) {
        compilation.updateAsset(name, new RawSource(next))
      }
    }
  }

  /**
   * 执行上传：glob 出待上传文件 → 过滤 → 调 `upload`。
   * `quitWpOnError` 开启且存在失败时抛错，让 webpack 把本次构建标记为失败。
   */
  private runUpload = async (outputPath: string): Promise<void> => {
    const all = await glob(this.from)
    console.log('\n')
    if (all.length > 0) {
      console.log(pc.underline(`需要上传的文件目录 ${all[0]}`))
    }

    const regExp = new RegExp(`\\.(${this.fileSuffix.map(escapeRegExp).join('|')})$`, 'i')
    // 过滤出真实文件且后缀匹配的条目（异步 stat）
    const files: string[] = []
    await Promise.all(
      all.map(async (file) => {
        try {
          const stats = await fsp.stat(file)
          if (stats.isFile() && regExp.test(file)) files.push(file)
        } catch {
          /* ignore */
        }
      }),
    )

    if (files.length === 0) {
      if (this.verbose) log.error('no files to be uploaded')
      return
    }

    let shouldThrow = false
    try {
      const stats = await this.upload(files, outputPath)
      // quitWpOnError 触发条件：有上传失败且开启了中断
      if (this.quitWpOnError && stats.errors.length > 0) {
        shouldThrow = true
      }
    } catch (err: unknown) {
      log.error(String(err))
      if (this.quitWpOnError) shouldThrow = true
    }
    if (shouldThrow) {
      throw new Error(`[${PLUGIN_NAME}] 因 quitWpOnError 开启且存在上传失败，已中断打包。`)
    }
  }

  /**
   * 内网探测：仅当用户未显式指定 endpoint 与 secure 时执行。
   * 命中 → 使用内网 endpoint + HTTP 重建 OSS 客户端；失败 → 沿用原配置，不中断构建。
   */
  private detectInternal = async (): Promise<void> => {
    if (this.detectOnce) return
    this.detectOnce = true

    const options = this.options
    const userSpecifiedEndpoint = typeof options.endpoint === 'string' && options.endpoint.trim() !== ''
    const userSpecifiedSecure = options.secure !== undefined
    if (userSpecifiedEndpoint || userSpecifiedSecure) return

    const internalHost = resolveInternalHost(options.region, options.endpoint)
    if (!internalHost) return

    let internal = false
    try {
      internal = await detectInternalNetwork(internalHost)
    } catch {
      internal = false
    }
    if (internal) {
      this.oss = this.createOSS({ endpoint: internalHost, secure: false })
      this.debug(`检测到内网环境，已切换为内网 endpoint (${internalHost}) + HTTP`)
    }
  }

  apply(compiler: Compiler): void {
    const outputPath = compiler.options.output.path
      ? path.resolve(slash(compiler.options.output.path))
      : path.resolve(slash(this.outputDirectory))

    // beforeRun / watchRun：内网探测（仅一次）。两个钩子都注册，分别覆盖单次构建与 watch。
    const detectHook = (cb: (err?: Error) => void) => {
      this.detectInternal().then(() => cb(), (err) => cb(err as Error))
    }
    compiler.hooks.beforeRun.tapAsync(PLUGIN_NAME, (_compiler, cb) => detectHook(cb))
    compiler.hooks.watchRun.tapAsync(PLUGIN_NAME, (_compiler, cb) => detectHook(cb))

    // processAssets：基于 compilation.assets 在内存中重写 CDN 引用
    compiler.hooks.compilation.tap(PLUGIN_NAME, (compilation) => {
      compilation.hooks.processAssets.tapPromise(
        {
          name: PLUGIN_NAME,
          stage: CompilationConst.PROCESS_ASSETS_STAGE_REPORT,
        },
        () => this.rewriteAssetUrls(compilation),
      )
    })

    // afterEmit：产物已落盘，执行上传
    compiler.hooks.afterEmit.tapPromise(PLUGIN_NAME, () => this.runUpload(outputPath))
  }
}

export default OSSUploadWebpackPlugin
export { OSSUploadWebpackPlugin }
export type { PluginOptions, UploadStats } from './type'
