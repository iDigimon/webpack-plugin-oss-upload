/** 阿里云 OSS 鉴权与 Bucket 配置 */
export type OSSOptions = {
  /** 阿里云上传区域，如 `oss-cn-hangzhou`。当传入 `endpoint` 时可省略 */
  region?: string
  /**
   * OSS 访问域名（不含 bucket 前缀），如 `oss-cn-hangzhou.aliyuncs.com`
   * 或内网域名 `oss-cn-hangzhou-internal.aliyuncs.com`。
   * 传入后优先于 `region` 生效。
   */
  endpoint?: string
  /**
   * 是否使用 HTTPS（true）或 HTTP（false）。
   * 默认随 `endpoint`/`region` 自动判断：自定义 `endpoint` 时需显式指定。
   */
  secure?: boolean
  /** 阿里云的授权 accessKeyId */
  accessKeyId: string
  /** 阿里云的授权 accessKeySecret */
  accessKeySecret: string
  /** 上传到哪个 bucket */
  bucket: string
}

/** 单个文件的上传路径生成函数：入参为文件本地绝对路径，返回 OSS 上的相对路径 */
export type SetOssPath = (filePath: string) => string

/**
 * CDN 重写时自定义资源引用 querystring 的函数。
 *
 * @param path 命中的资源路径，如 `/assets/logo.png`
 * @param query 原始 querystring，**包含 `?`**，如 `?v=1`；无 query 时为空字符串 `''`
 * @returns 重写后的 querystring。返回值会被原样拼到 CDN 地址后面：
 *   - 以 `?` 开头时直接使用（如 `?v=2`）；
 *   - 不以 `?` 开头时会自动补齐 `?`（如 `v=2` → `?v=2`）；
 *   - 返回 `''` 表示去掉查询串。
 */
export type RewriteQueryString = (path: string, query: string) => string

/** 版本号上报回调 */
export type SetVersion = (data: { version: string }) => unknown | Promise<unknown>

/** 上传过程的统计信息 */
export interface UploadStats {
  /** 已上传成功的文件路径 */
  uploaded: string[]
  /** 因 OSS 已存在且不覆盖而跳过的文件路径 */
  ignored: string[]
  /** 上传失败的文件及错误信息 */
  errors: Array<{ file: string; err: { code?: string; message?: string; name?: string } }>
}

export type OptionalOptions = {
  /**
   * 上传后要替换的资源文件 CDN 域名，如 `https://cdn.xxx.com`。
   * 不传或为空字符串时跳过代码中资源路径的 CDN 替换。
   */
  cdnHost?: string
  /**
   * 上传哪些文件，glob 字符串，如 `./dist/assets/**`。默认 `./dist/assets/**`。
   */
  from?: string
  /**
   * 测试模式：仅打印将要上传的文件与目标路径，不真正上传。默认 `false`。
   */
  test?: boolean
  /**
   * 是否显示上传日志。默认 `true`。
   */
  verbose?: boolean
  /**
   * 上传到 OSS 的哪个目录（路径前缀）。默认为 OSS 根目录（空字符串）。
   */
  dist?: string
  /**
   * 构建目录名（用于非 Webpack 场景的基准路径解析）。默认 `.`。
   */
  buildRoot?: string
  /**
   * 上传完成后是否删除本地原文件。默认 `false`。
   */
  deleteOrigin?: boolean
  /**
   * 若某个目录中的文件全部上传/删除完成，是否删除该空目录。仅在 `deleteOrigin` 为 `true` 时生效。默认 `false`。
   */
  deleteEmptyDir?: boolean
  /**
   * OSS 单次请求超时（毫秒）。默认 `30000`。
   */
  timeout?: number
  /**
   * 自定义每个文件上传到 OSS 的路径。不传或返回 falsy 值时按默认规则计算。
   */
  setOssPath?: SetOssPath
  /**
   * 自定义 CDN 重写时的资源引用 querystring。
   * 入参 `(path, query)`：`path` 为命中的资源路径（如 `/assets/logo.png`），
   * `query` 为原始 querystring（**包含 `?`**，如 `?v=1`，无 query 时为 `''`）。
   * 返回值作为最终的 querystring 拼到 CDN 地址后：以 `?` 开头直接使用，不以 `?`
   * 开头时自动补齐（如 `v=2` → `?v=2`），返回 `''` 表示去掉 query。
   * 不传时原样保留原始 querystring。
   */
  rewriteQueryString?: RewriteQueryString
  /**
   * 是否覆盖 OSS 上的同名文件。默认 `true`。
   */
  overwrite?: boolean
  /**
   * 上传过程中出现错误时是否中断打包。默认 `false`。
   */
  quitWpOnError?: boolean
  /**
   * 版本号。配合 `setVersion` 使用。默认 `''`。
   */
  version?: string
  /**
   * 上传成功后回调（一般用于向业务后端上报版本号）。需同时配置 `version`。
   */
  setVersion?: SetVersion
  /**
   * 需要上传的资源文件后缀（不含 `.`）。覆盖默认列表。
   */
  fileSuffix?: string[]
  /**
   * 资源文件所在目录名，用于 CDN 路径替换。默认 `assets`。
   */
  assetsDirectory?: string
  /**
   * 项目打包后的输出目录。默认 `dist`。
   */
  outputDirectory?: string
  /**
   * 并发上传数。默认 `5`。
   */
  concurrency?: number
}

export type PluginOptions = OSSOptions & OptionalOptions

/** 默认的可选配置项。冻结以避免被 `Object.assign` 意外修改。 */
export const DEFAULT_FILE_SUFFIX = [
  'jpg', 'jpeg', 'png', 'gif', 'svg', 'webp', 'ico', 'bmp',
  'webm', 'avi', 'mp4', 'mp3', 'flv', 'mov',
] as const

export const defaultOption = {
  cdnHost: '',
  test: false,
  verbose: true,
  dist: '',
  from: './dist/assets/**',
  buildRoot: '.',
  deleteOrigin: false,
  deleteEmptyDir: false,
  timeout: 30 * 1000,
  overwrite: true,
  quitWpOnError: false,
  version: '',
  assetsDirectory: 'assets',
  outputDirectory: 'dist',
  concurrency: 5,
  fileSuffix: [...DEFAULT_FILE_SUFFIX],
} satisfies OptionalOptions

export type DefaultOption = typeof defaultOption
