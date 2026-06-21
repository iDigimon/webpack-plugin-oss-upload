import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  // 仅输出 ESM：
  // 运行时依赖（ali-oss / p-limit@6 / glob@11 / picocolors）均为纯 ESM 包，
  // 打成 CJS 时 tsup 会落入 require()，而 Node 禁止在 CJS 中 require ESM 模块，
  // 导致 require('webpack-plugin-oss-upload') 直接崩溃。
  // webpack 5+ 已原生支持 ESM 配置与 ESM 插件，故只保留 ESM 产物。
  format: ['esm'],
  target: 'es2020',
  outDir: 'dist',
  dts: true,
  splitting: false,
  sourcemap: false,
  clean: true,
  treeshake: true,
})
