import { defineConfig } from 'vite'
import { fileURLToPath, URL } from 'node:url'

// GitHub Pages では https://git-naut.github.io/dogfight/ に出るため base を付ける。
//
// preview も command は 'serve' になるので、command だけで分岐すると
// ビルド済み HTML が参照する /dogfight/assets/... を preview サーバが
// ルートで配信してしまい 404 になる。isPreview を明示的に見る。
export default defineConfig(({ command, isPreview }) => ({
  base: command === 'build' || isPreview ? '/dogfight/' : '/',
  resolve: {
    alias: {
      '@sim': fileURLToPath(new URL('./src/sim', import.meta.url)),
      '@render': fileURLToPath(new URL('./src/render', import.meta.url)),
      '@hud': fileURLToPath(new URL('./src/hud', import.meta.url)),
      '@input': fileURLToPath(new URL('./src/input', import.meta.url)),
    },
  },
  build: {
    target: 'es2022',
    sourcemap: true,
    // アセットの取り込みしきい値。glTF や KTX2 はインライン化させない。
    assetsInlineLimit: 4096,
  },
  server: {
    port: 5173,
  },
}))
