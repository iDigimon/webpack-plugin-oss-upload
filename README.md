# webpack-plugin-oss-upload

一个可以将打包好的资源文件上传到阿里云 OSS，并把产物中资源引用替换为 CDN 地址的 Webpack 5+ 插件。

## 特性

- 🚀 打包完成后自动上传资源文件到阿里云 OSS
- 🔁 自动重写构建产物中的资源引用为 CDN 地址（基于 `compilation.assets`，在内存中改写）
- ✏️ 支持通过 `rewriteQueryString` 自定义（新增 / 改写 / 去除）资源引用的 querystring
- ⚡ 并发上传（可配置），支持大文件批量场景
- 🧪 支持 `test` 模式预演，不真正上传
- 🗑️ 可选删除本地原文件与空目录
- 🔐 支持从环境变量读取凭据，避免硬编码

## 安装

```bash
npm i webpack-plugin-oss-upload -D
# 或
pnpm add webpack-plugin-oss-upload -D
```

> 要求 Node.js >= 18，webpack >= 5（`webpack` 作为 peerDependency 由宿主项目提供）。

## 配置参数

### 必填

| 参数 | 说明 |
| --- | --- |
| `accessKeyId` | 阿里云授权 accessKeyId |
| `accessKeySecret` | 阿里云授权 accessKeySecret |
| `bucket` | 上传到哪个 bucket |
| `region` / `endpoint` | 二者至少配置其一。`region` 为区域如 `oss-cn-hangzhou`；`endpoint` 为完整访问域名（含内网域名，如 `oss-cn-hangzhou-internal.aliyuncs.com`），传入后优先于 `region` 生效 |

### 可选

| 参数 | 说明 | 默认值 |
| --- | --- | --- |
| `cdnHost` | 上传后用于替换的资源文件 CDN 域名，留空则跳过 CDN 重写 | `''` |
| `from` | glob 字符串，指定要上传的文件 | `./dist/assets/**` |
| `dist` | 上传到 OSS 的目录前缀 | `''`（根目录） |
| `timeout` | OSS 单次请求超时（毫秒） | `30000` |
| `overwrite` | 是否覆盖 OSS 同名文件 | `true` |
| `verbose` | 是否打印上传日志 | `true` |
| `test` | 测试模式：只打印不真正上传 | `false` |
| `deleteOrigin` | 上传后是否删除本地原文件 | `false` |
| `deleteEmptyDir` | 目录清空后是否删除空目录（需 `deleteOrigin: true`） | `false` |
| `quitWpOnError` | 出错时是否中断打包 | `false` |
| `version` | 版本号，配合 `setVersion` 使用 | `''` |
| `setVersion` | 上传成功后的回调（一般用于上报版本号） | — |
| `fileSuffix` | 需要上传的资源后缀 | `['jpg','jpeg','png','gif','svg','webp','ico','bmp','webm','avi','mp4','mp3','flv','mov']` |
| `assetsDirectory` | 资源目录名，用于 CDN 路径替换 | `assets` |
| `outputDirectory` | 打包输出目录 | `dist` |
| `setOssPath` | 自定义 OSS 路径生成函数 | 以 `outputDirectory` 为基准的相对路径 |
| `rewriteQueryString` | 改写资源引用的 querystring，签名 `(path, query) => string`。`path` 为 CDN 替换前的原始资源路径；`query` 入参与返回值**都包含 `?`**（如 `?v=1`），无查询串时为 `''`；返回值不以 `?` 开头时会自动补齐 `?`，返回 `''` 表示去掉查询串 | — |
| `concurrency` | 并发上传数 | `5` |
| `secure` | 是否使用 HTTPS（`true`）/ HTTP（`false`）。默认随 OSS 客户端自动判断 | — |

### 内网自动探测

当**未显式配置 `endpoint` 且未显式配置 `secure`** 时，插件会在 webpack 编译开始前（`beforeRun` 钩子，watch 模式下为 `watchRun`）通过 TCP 端口探测判断当前是否处于阿里云内网环境（探测 `<region>-internal.aliyuncs.com` 的 80 端口）：

- **探测命中（内网）**：自动切换为内网 endpoint，并使用 HTTP（`secure: false`），提升上传速度、避免公网带宽。
- **探测失败 / 超时**：视为非内网，沿用用户原有配置（region + 默认 HTTPS），**不会中断构建**。

> 该机制对 CI、无外网等环境安全：任何探测异常都静默回退，不抛错。
> 若需完全跳过自动探测，显式设置 `endpoint` 或 `secure` 即可。

### 改写资源引用的 querystring

`rewriteQueryString` 允许你在 CDN 路径替换时，自定义资源引用后面的 querystring（例如统一打版本号、缓存破坏标识等）。

```ts
rewriteQueryString?: (path: string, query: string) => string
```

- `path`：CDN 替换**前**的原始资源路径，如 `/assets/logo.png`，仅用于识别资源；
- `query`：原 querystring，**包含前导 `?`**（如 `?v=1`）；若原引用没有查询串则为 `''`；
- **返回值**：作为新的 querystring 拼接到 CDN 地址之后 —— 以 `?` 开头时直接使用（如 `?v=2`），不以 `?` 开头时会自动补齐 `?`（如 `v=2` → `?v=2`）；返回 `''` 则**去掉**查询串。

> 不配置 `rewriteQueryString` 时，保持原 querystring 不变。

示例：

```javascript
new OSSUploadWebpackPlugin({
  cdnHost: 'https://cdn.xxx.com',
  // ...其它配置
  // 统一把所有资源引用的查询串替换为构建版本号（带不带 `?` 都行）
  rewriteQueryString: (_path, _query) => `?v=${process.env.BUILD_VERSION}`,
})
```

转换效果：

| 原引用 | `rewriteQueryString` 返回值 | 替换后 |
| --- | --- | --- |
| `/assets/logo.png?v=1` | `?v=2` | `https://cdn.xxx.com/static/assets/logo.png?v=2` |
| `/assets/logo.png` | `cache=bust` | `https://cdn.xxx.com/static/assets/logo.png?cache=bust` |
| `/assets/logo.png?v=1` | `''` | `https://cdn.xxx.com/static/assets/logo.png` |

> ⚠️ **安全提醒**：`accessKeyId` / `accessKeySecret` 非常敏感，请通过环境变量读取，切勿硬编码到提交到仓库的配置文件中。

## 使用示例

> 本插件以 **ESM** 形式发布（依赖 `ali-oss` / `p-limit@6` / `glob@11` 均为纯 ESM 包，
> 不提供 CJS 产物）。请使用 ESM 的 `import` 引入：
>
> - `webpack.config.mjs` / `.ts`（推荐，webpack 5 原生支持）
> - 或在 CommonJS 配置中改用 `webpack.config.js` + 顶层 `await import(...)`，
>   或借助 `esbuild-register` / `tsx` 等加载器。

```javascript
// webpack.config.mjs
import path from 'node:path'
import OSSUploadWebpackPlugin from 'webpack-plugin-oss-upload'

const prod = process.env.NODE_ENV === 'production'

export default {
  // ...其余 webpack 配置
  output: {
    path: path.resolve('dist'),
    // ...
  },
  plugins: [
    prod &&
      new OSSUploadWebpackPlugin({
        cdnHost: 'https://cdn.xxx.com',
        from: './dist/assets/**', // 上传哪些文件
        dist: '/static', // 上传到 OSS 的目录前缀
        // 方式一：使用 region
        region: process.env.OSS_REGION,
        // 方式二：使用自定义 endpoint（如内网域名），优先级高于 region
        // endpoint: 'oss-cn-hangzhou-internal.aliyuncs.com',
        // secure: false, // 内网时可关闭 HTTPS
        accessKeyId: process.env.OSS_ACCESS_KEY_ID,
        accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
        bucket: process.env.OSS_BUCKET,
        overwrite: true,
        quitWpOnError: true,
        // 改写资源引用的 querystring：入参与返回值均以 `?` 开头
        // 用于统一打版本号 / 缓存破坏标识，返回 `''` 可去掉查询串
        rewriteQueryString: (_path, _query) => `?v=${process.env.BUILD_VERSION ?? '1'}`,
      }),
  ].filter(Boolean),
}
```

> 该插件是一个带有 `apply(compiler)` 的类，放在 `plugins` 数组里用 `new` 实例化即可。
> 上传逻辑在 `afterEmit` 钩子执行，开启 `quitWpOnError` 时上传失败会把错误回传给 webpack，从而中断/失败本次构建。

对应 `.env`（请加入 `.gitignore`）：

```bash
OSS_REGION=oss-cn-hangzhou
OSS_ACCESS_KEY_ID=xxxxxxxx
OSS_ACCESS_KEY_SECRET=xxxxxxxx
OSS_BUCKET=my-bucket
```

## 开发

```bash
pnpm install
pnpm build       # 构建产物（dist）
pnpm test        # 运行单元测试
pnpm test:watch  # 监听模式
pnpm lint        # 代码检查
pnpm typecheck   # 类型检查
```

## License

MIT
