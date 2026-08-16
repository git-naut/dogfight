// @takram/three-atmosphere に同梱された事前計算テクスチャを public/ へ複製する。
//
// 散乱 LUT を実行時に GPU で計算する方式は、CI のソフトウェアレンダラで
// 通るか読めないうえ、毎回の起動にも時間がかかる。パッケージが計算済みの
// EXR を持っているので、それを自前で配信する。
//
// npm run dev と npm run build の前段で走る。node_modules から読むだけなので
// 出力は再現可能で、生成物は .gitignore で除外している。

import { copyFile, mkdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'node_modules/@takram/three-atmosphere/assets')
const destination = join(root, 'public/atmosphere')

/**
 * PrecomputedTexturesLoader が要求するファイル。
 *
 * combinedScattering を有効にすると単一ミー散乱は散乱テクスチャに畳まれるので
 * single_mie_scattering.exr は要らない。higherOrderScattering を切ると
 * さらに 3.58 MB 減る。品質と転送量の兼ね合いは docs/decisions/0002 を参照。
 */
const FILES = [
  'transmittance.exr',
  'scattering.exr',
  'irradiance.exr',
]

async function main() {
  await mkdir(destination, { recursive: true })

  let total = 0
  for (const name of FILES) {
    const from = join(source, name)
    const to = join(destination, name)

    const info = await stat(from).catch(() => null)
    if (info === null) {
      console.error(`[atmosphere] 見つからない: ${from}`)
      console.error('[atmosphere] npm install を先に実行してください')
      process.exitCode = 1
      return
    }

    await copyFile(from, to)
    total += info.size
    console.log(`[atmosphere] ${name} (${(info.size / 1e6).toFixed(2)} MB)`)
  }

  console.log(`[atmosphere] 合計 ${(total / 1e6).toFixed(2)} MB を public/atmosphere/ へ複製`)
}

await main()
