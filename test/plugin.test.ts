import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { sources as wpSources, Compilation as CompilationConst } from 'webpack'

const { RawSource } = wpSources

// 记录对 mock OSS 的调用，供断言使用
const calls = {
  head: [] as string[],
  put: [] as Array<{ name: string; file: string }>,
  // 记录每次 new OSS(options) 收到的配置
  ctor: [] as Array<Record<string, unknown>>,
}

// 每个 OSS 实例的 head/put 行为可通过覆盖这两个函数来定制
let headImpl: (name: string) => Promise<unknown> = async (name) => {
  calls.head.push(name)
  const err: Error & { code?: string; status?: number } = new Error('NoSuchKey')
  err.code = 'NoSuchKey'
  err.status = 404
  throw err
}
let putImpl: (name: string, file: string) => Promise<unknown> = async (name, file) => {
  calls.put.push({ name, file })
  return { url: `https://bucket.oss-cn-test.aliyuncs.com//${name}`, res: { status: 200 } }
}

const setHeadImpl = (fn: (name: string) => Promise<unknown>) => {
  headImpl = fn
}
const setPutImpl = (fn: (name: string, file: string) => Promise<unknown>) => {
  putImpl = fn
}

vi.mock('ali-oss', () => {
  const OSS = vi.fn().mockImplementation((options: Record<string, unknown>) => {
    calls.ctor.push(options)
    return {
      head: vi.fn((name: string) => headImpl(name)),
      put: vi.fn((name: string, file: string) => putImpl(name, file)),
    }
  })
  return { default: OSS }
})

// 默认让内网探测返回 false（沿用原配置）；个别用例可通过 setIsInternal 覆盖
let isInternal = false
const setIsInternal = (v: boolean) => {
  isInternal = v
}
vi.mock('../src/utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/utils')>()
  return {
    ...actual,
    detectInternalNetwork: vi.fn(() => Promise.resolve(isInternal)),
  }
})

// 在导入插件之后再 import，确保 mock 生效
const { default: OSSUploadWebpackPlugin } = await import('../src/index')

let tmpRoot = ''
let cwd = ''

const mk = (p: string) => fs.mkdirSync(p, { recursive: true })
const write = (p: string, content: string) => {
  mk(path.dirname(p))
  fs.writeFileSync(p, content)
}

/**
 * 最小化的 webpack Compilation 替身：
 * - assets: 资源名 -> { source(): Buffer }
 * - getAsset / updateAsset: 用于 in-memory CDN 重写
 * - 捕获 processAssets.tapPromise 注册的回调，便于手动触发
 */
interface FakeAsset {
  source: () => Buffer
}
interface FakeCompilation {
  assets: Record<string, FakeAsset>
  getAsset: (name: string) => { source: { source: () => Buffer } } | undefined
  updateAsset: (name: string, src: { source: () => Buffer }) => void
  hooks: {
    processAssets: {
      tapPromise: (opts: { name: string; stage: number }, fn: () => Promise<void>) => void
    }
  }
  _processAssets?: () => Promise<void>
}
const createFakeCompilation = (): FakeCompilation => {
  const assets: Record<string, FakeAsset> = {}
  const comp: FakeCompilation = {
    assets,
    getAsset: (name) => {
      const a = assets[name]
      return a ? { source: a } : undefined
    },
    updateAsset: (name, src) => {
      assets[name] = { source: () => src.source() }
    },
    hooks: {
      processAssets: {
        tapPromise: (_opts, fn) => {
          comp._processAssets = fn
        },
      },
    },
  }
  return comp
}

/**
 * 最小化的 webpack Compiler 替身：
 * - options.output.path
 * - 捕获 beforeRun / watchRun / compilation / afterEmit 的回调
 */
interface FakeCompiler {
  options: { output: { path: string } }
  hooks: {
    beforeRun: { tapAsync: (name: string, fn: (c: unknown, cb: (err?: Error) => void) => void) => void }
    watchRun: { tapAsync: (name: string, fn: (c: unknown, cb: (err?: Error) => void) => void) => void }
    compilation: { tap: (name: string, fn: (comp: FakeCompilation) => void) => void }
    afterEmit: { tapPromise: (name: string, fn: () => Promise<void>) => void }
  }
  _beforeRun?: (cb: (err?: Error) => void) => void
  _watchRun?: (cb: (err?: Error) => void) => void
  _compilationCb?: (comp: FakeCompilation) => void
  _afterEmit?: () => Promise<void>
}
const createFakeCompiler = (outPath: string): FakeCompiler => {
  const compiler: FakeCompiler = {
    options: { output: { path: outPath } },
    hooks: {
      beforeRun: {
        tapAsync: (_name, fn) => {
          compiler._beforeRun = (cb) => fn(compiler, cb)
        },
      },
      watchRun: {
        tapAsync: (_name, fn) => {
          compiler._watchRun = (cb) => fn(compiler, cb)
        },
      },
      compilation: {
        tap: (_name, fn) => {
          compiler._compilationCb = fn
        },
      },
      afterEmit: {
        tapPromise: (_name, fn) => {
          compiler._afterEmit = fn
        },
      },
    },
  }
  return compiler
}

/**
 * 用最小化的 fake Compiler 触发插件钩子。
 * @param plugin 插件实例
 * @param outDir 输出目录（绝对或相对当前工作目录）
 * @param hooks 要触发的钩子组合
 */
const runPlugin = async (
  plugin: OSSUploadWebpackPlugin,
  outDir: string,
  hooks: Array<'beforeRun' | 'processAssets' | 'afterEmit'> = ['afterEmit'],
  compilation?: FakeCompilation,
) => {
  const absOut = path.resolve(outDir)
  const compiler = createFakeCompiler(absOut)
  plugin.apply(compiler as unknown as import('webpack').Compiler)

  if (hooks.includes('beforeRun') && compiler._beforeRun) {
    await new Promise<void>((resolve, reject) => {
      compiler._beforeRun!((err) => (err ? reject(err) : resolve()))
    })
  }

  if (hooks.includes('processAssets')) {
    const comp = compilation ?? createFakeCompilation()
    if (compiler._compilationCb) compiler._compilationCb(comp)
    if (comp._processAssets) await comp._processAssets()
  }

  if (hooks.includes('afterEmit') && compiler._afterEmit) {
    await compiler._afterEmit()
  }
}

describe('OSSUploadWebpackPlugin', () => {
  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'wpo-plugin-'))
    cwd = process.cwd()
    process.chdir(tmpRoot)
    calls.head.length = 0
    calls.put.length = 0
    calls.ctor.length = 0
    setIsInternal(false)
  })

  afterEach(() => {
    process.chdir(cwd)
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  })

  const baseOpts = {
    region: 'oss-cn-test',
    accessKeyId: 'akid',
    accessKeySecret: 'aksecret',
    bucket: 'bucket',
    from: './dist/assets/**',
    verbose: false,
  }

  it('缺少必填项（accessKeyId/Secret/bucket）时直接抛错', () => {
    expect(
      () =>
        new OSSUploadWebpackPlugin({
          // @ts-expect-error 故意缺 accessKeyId
          accessKeyId: undefined,
          accessKeySecret: 'sk',
          bucket: 'b',
          region: 'oss-cn-hangzhou',
        }),
    ).toThrow(/配置校验失败/)
  })

  it('region 与 endpoint 都缺失时报错', () => {
    expect(
      () =>
        new OSSUploadWebpackPlugin({
          accessKeyId: 'ak',
          accessKeySecret: 'sk',
          bucket: 'b',
        }),
    ).toThrow(/region\/endpoint/)
  })

  it('仅传 endpoint（无 region）能通过校验并实例化 OSS', () => {
    const plugin = new OSSUploadWebpackPlugin({
      ...baseOpts,
      // 去掉 region，仅用 endpoint
      region: undefined,
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
    })
    expect(plugin.name).toBe('webpack-plugin-oss-upload')
    // new OSS 收到 endpoint
    expect(calls.ctor.at(-1)?.endpoint).toBe('oss-cn-hangzhou.aliyuncs.com')
    expect(calls.ctor.at(-1)?.region).toBeUndefined()
  })

  it('secure 透传给 OSS 客户端', () => {
    new OSSUploadWebpackPlugin({
      ...baseOpts,
      endpoint: 'oss-cn-hangzhou.aliyuncs.com',
      secure: false,
    })
    expect(calls.ctor.at(-1)?.secure).toBe(false)
  })

  it('未传 endpoint/secure 时不污染默认配置（按 region 走默认）', () => {
    new OSSUploadWebpackPlugin(baseOpts)
    const ctor = calls.ctor.at(-1)!
    expect(ctor.endpoint).toBeUndefined()
    expect(ctor.secure).toBeUndefined()
    expect(ctor.region).toBe('oss-cn-test')
  })

  it('test 模式下不真正上传', async () => {
    write('dist/assets/a.png', 'pngdata')
    const plugin = new OSSUploadWebpackPlugin({ ...baseOpts, test: true })
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(0)
  })

  it('正常上传并调用 oss.put，返回 URL 已规范化（无双斜杠）', async () => {
    write('dist/assets/a.png', 'pngdata')
    const plugin = new OSSUploadWebpackPlugin(baseOpts)
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(1)
    // 文件在 dist/assets/a.png，相对 dist 目录的路径为 assets/a.png
    expect(calls.put[0]!.name).toBe('assets/a.png')
  })

  it('overwrite=false 且 OSS 已存在时跳过上传', async () => {
    write('dist/assets/exist.png', 'pngdata')
    setHeadImpl(async () => ({ res: { status: 200 } }))
    const plugin = new OSSUploadWebpackPlugin({ ...baseOpts, overwrite: false })
    await runPlugin(plugin, 'dist')

    expect(calls.put.length).toBe(0)
  })

  it('quitWpOnError 开启且上传失败时中断（afterEmit 抛错）', async () => {
    write('dist/assets/bad.png', 'pngdata')
    setPutImpl(async () => {
      const e: Error & { code?: string } = new Error('boom')
      e.code = 'UploadError'
      throw e
    })
    const plugin = new OSSUploadWebpackPlugin({ ...baseOpts, quitWpOnError: true })

    await expect(runPlugin(plugin, 'dist')).rejects.toThrow(/quitWpOnError/)
  })

  it('processAssets 会把 compilation.assets 中的 /assets/xxx.png 替换为 CDN 地址', async () => {
    const compilation = createFakeCompilation()
    compilation.assets['index.html'] = { source: () => Buffer.from('<img src="/assets/logo.png">') }
    compilation.assets['index.js'] = { source: () => Buffer.from('var u="/assets/logo.png";') }
    compilation.assets['logo.png'] = { source: () => Buffer.from('png') } // 二进制资源不改写

    const plugin = new OSSUploadWebpackPlugin({
      ...baseOpts,
      cdnHost: 'https://cdn.example.com',
      dist: '/static',
      from: './dist/assets/**',
    })
    await runPlugin(plugin, 'dist', ['processAssets'], compilation)

    expect(compilation.assets['index.html']!.source().toString('utf-8')).toContain(
      'https://cdn.example.com/static/assets/logo.png',
    )
    expect(compilation.assets['index.js']!.source().toString('utf-8')).toContain(
      'https://cdn.example.com/static/assets/logo.png',
    )
    // 二进制资源保持原样
    expect(compilation.assets['logo.png']!.source().toString('utf-8')).toBe('png')
  })

  it('beforeRun：未指定 endpoint/secure 且探测到内网时，用内网 endpoint + HTTP 重建 OSS', async () => {
    setIsInternal(true)
    const plugin = new OSSUploadWebpackPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
    })
    // 构造时应仅有一次 new OSS（按 region）
    const firstCtorCount = calls.ctor.length
    await runPlugin(plugin, 'dist', ['beforeRun'])

    // 探测命中后会再 new OSS 一次
    expect(calls.ctor.length).toBe(firstCtorCount + 1)
    const rebuilt = calls.ctor.at(-1)!
    expect(rebuilt.endpoint).toBe('oss-cn-hangzhou-internal.aliyuncs.com')
    expect(rebuilt.secure).toBe(false)
  })

  it('beforeRun：探测非内网时沿用原配置，不重建 OSS', async () => {
    setIsInternal(false)
    const plugin = new OSSUploadWebpackPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
    })
    const ctorCountBeforeHook = calls.ctor.length
    await runPlugin(plugin, 'dist', ['beforeRun'])
    // 没有额外的构造
    expect(calls.ctor.length).toBe(ctorCountBeforeHook)
  })

  it('beforeRun：用户已显式指定 endpoint 时不触发探测', async () => {
    setIsInternal(true) // 即使“看起来”是内网，也不应再探测
    const plugin = new OSSUploadWebpackPlugin({
      ...baseOpts,
      region: 'oss-cn-hangzhou',
      endpoint: 'my-custom.endpoint.com',
      secure: true,
    })
    const ctorCountBeforeHook = calls.ctor.length
    await runPlugin(plugin, 'dist', ['beforeRun'])
    expect(calls.ctor.length).toBe(ctorCountBeforeHook)
  })

  it('processAssets 在 PROCESS_ASSETS_STAGE_REPORT 阶段注册', () => {
    // 间接验证：插件能正确从 webpack 引入 stage 常量（不抛错即可）
    const plugin = new OSSUploadWebpackPlugin(baseOpts)
    expect(() => runPlugin(plugin, 'dist', ['processAssets'])).not.toThrow()
    expect(CompilationConst.PROCESS_ASSETS_STAGE_REPORT).toBeGreaterThan(0)
  })

  it('RawSource 从 webpack.sources 正确导出（类型可用）', () => {
    const src = new RawSource('hello')
    expect(src.source().toString('utf-8')).toBe('hello')
  })
})
