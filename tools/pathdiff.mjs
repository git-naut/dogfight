// 既定の 42 枚と node 経路の絵を突き合わせ、差分の台帳の材料を出す。
//
// **段 20b の前提。**計画は「差分の理由をあらかじめ台帳にする。理由の付かない
// 差分が 1 枚でも残っている間は撮り直さない」と書いている。撮り直す前に、
// どの枚がどれだけ動くかを数で出しておく。
//
// `tools/exact.mjs` は「1 画素も動いていないこと」を確かめる道具で、判定が
// 0 か 1 しかない。こちらは**動く前提**で、動きの量と場所を出す。
//
// 比べる相手は committed の基準画像。段 20b で置き換わるのがそれなので、
// 「撮り直したら何が変わるか」に直接答える。
//
// **並列は効かない（実測）。**8 枚を撮る時間を本数を振って測った。
//
// | 本数 | 所要 |
// |---|---|
// | 1 | 119.4 秒 / 150.4 秒（同じ設定を 2 回） |
// | 2 | 139.8 秒 |
// | 4 | 137.8 秒 |
//
// **同じ設定の 2 回が 119.4 と 150.4 秒（ばらつき 26%）**で、本数の差は
// その中に埋もれる。node 経路の 1 ページが既に機械を使い切っているため
// （SwiftShader の Vulkan は自分で複数のスレッドを使う）。`playwright.config.ts`
// の「芯数の半分が最適」は GLSL 経路で測った値で、node 経路には当たらない。
//
// 短縮できるのは**回数**のほう。`--against` は 1 枚につき 2 回撮るが、
// 素の側は原因を振っても同じなので `--cache` に置いて使い回す。原因 3 つを
// 測るなら 294 回が 168 回になる（43% 減）。
//
// 使い方:
//   node tools/pathdiff.mjs [--nobuild] [--port N] [-g 名前の一部]
//                           [--names a,b,c] [--out ledger.json]
//                           [--against smaa=0] [--workers N]
import { spawn, spawnSync } from 'node:child_process'
import { cpus } from 'node:os'
import { readFileSync, existsSync, writeFileSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { chromium } from '@playwright/test'
import { PNG } from 'pngjs'
import { SCENES, captureParams } from '../tests/e2e/scenes.mjs'
import { WEBGPU_ARGS, VIEWPORT, DEFAULT_PROJECT, snapshotSuffix } from '../tests/e2e/launch.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const SNAP = fileURLToPath(new URL('../tests/e2e/smoke.spec.ts-snapshots', import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const PORT = Number(arg('--port', 4413))
const FILTER = arg('-g', null)
const NAMES = arg('--names', null)?.split(',')
const OUT = arg('--out', null)
// **原因ごとの寄与を測る。**渡すと、node 経路の 2 通りを撮って
// 突き合わせる（基準画像とではなく）。1 つだけ振れば、その差はその原因の
// ぶんに限られる。`--against smaa=0` や `--against env=0` の形で使う
const AGAINST = arg('--against', null)
// **基準画像と比べる側にも振れるようにする。**`--extra smaa=0` を渡すと
// 「SMAA を外した node 経路」対「基準画像」になる。`--against smaa=0` は
// node 経路の中での SMAA の効き（node 対 node）で、両経路が SMAA を
// 掛けている以上、**経路差のうち SMAA に帰属するぶんはこちらでしか読めない**
const EXTRA = arg('--extra', null)
// 既定は 1 本。並列に意味が無いことを実測したので増やさない（本文の表）
const WORKERS = Math.max(1, Number(arg('--workers', '1')))
/** 素の絵の置き場。原因を振っても素の側は同じなので使い回す */
const CACHE = arg('--cache', null)
const BASE = `http://127.0.0.1:${PORT}/dogfight/`
// 基準画像は既定の project のもの。node 経路の絵をそれと比べる
const SUFFIX = snapshotSuffix(DEFAULT_PROJECT)

const scenes = SCENES.filter(
  (s) =>
    (NAMES === undefined || NAMES === null || NAMES.includes(s.name)) &&
    (FILTER === null || s.name.includes(FILTER)),
)

if (!argv.includes('--nobuild')) {
  const build = spawnSync('npm', ['run', 'build'], { cwd: ROOT, encoding: 'utf8' })
  if (build.status !== 0) {
    console.error(build.stdout.slice(-3000), build.stderr.slice(-2000))
    process.exit(1)
  }
}
const server = spawn(
  'npm',
  ['run', 'preview', '--', '--port', String(PORT), '--strictPort', '--host', '127.0.0.1'],
  { cwd: ROOT, stdio: 'ignore', detached: true },
)

// **WebGPU の起動引数が要る。**node 経路の場面は WebGL2 フォールバックでは
// 立たない（大気の構造体が GLSL のコンパイルで落ちる）
const browser = await chromium.launch({ args: [...WEBGPU_ARGS] })

/**
 * 2 枚の PNG の差を測る。
 *
 * **平均も出す。**画素数と最大階調だけでは「全面が薄く動いた」と
 * 「一部が大きく動いた」を区別できない。ライティングの置き換えは前者、
 * 影のフィルタの変更は後者になるはずで、そこが帰属の手掛かりになる。
 *
 * 上下の帯も分ける。空は上、地表と海面は下に出るので、どちらが動いたかで
 * 大気の変更とライティングの変更を切り分けられる。
 */
function measure(a, b) {
  if (a.width !== b.width || a.height !== b.height) {
    return { size: `${a.width}x${a.height} と ${b.width}x${b.height}` }
  }
  const half = Math.floor(a.height / 2)
  let differing = 0
  let worst = 0
  let sum = 0
  let topSum = 0
  let bottomSum = 0
  let topCount = 0
  let bottomCount = 0
  for (let i = 0; i < a.data.length; i += 4) {
    const d = Math.max(
      Math.abs(a.data[i] - b.data[i]),
      Math.abs(a.data[i + 1] - b.data[i + 1]),
      Math.abs(a.data[i + 2] - b.data[i + 2]),
      Math.abs(a.data[i + 3] - b.data[i + 3]),
    )
    if (d > 0) differing++
    if (d > worst) worst = d
    sum += d
    const y = (i >> 2) / a.width | 0
    if (y < half) {
      topSum += d
      topCount++
    } else {
      bottomSum += d
      bottomCount++
    }
  }
  const total = a.width * a.height
  return {
    differing,
    worst,
    total,
    mean: sum / total,
    topMean: topSum / topCount,
    bottomMean: bottomSum / bottomCount,
  }
}

const rows = []
try {
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(BASE)).ok) break
    } catch {}
    await new Promise((r) => setTimeout(r, 500))
  }
  const errors = []

  console.log(
    AGAINST === null
      ? `基準画像との差（?gpu=3${EXTRA === null ? '' : '&' + EXTRA} 対 committed）`
      : `原因の寄与（?gpu=3 対 ?gpu=3&${AGAINST}）`,
  )
  console.log(`${scenes.length} 枚を ${WORKERS} 本で撮る（芯 ${cpus().length}）`)
  console.log(
    '構図'.padEnd(22) + '差分画素'.padStart(12) + '最大'.padStart(6) +
      '平均'.padStart(8) + '上帯'.padStart(8) + '下帯'.padStart(8),
  )
  console.log('-'.repeat(66))

  const started = Date.now()
  /** 順番待ちの列。**取った者が撮る。**枚ごとの所要が 3 倍違うので静的に割らない */
  let next = 0
  const results = new Array(scenes.length)

  async function worker() {
    // **ページは 1 本につき 1 つ。**使い回すと goto の待ちが直列化する
    const page = await browser.newPage({ viewport: { ...VIEWPORT }, deviceScaleFactor: 1 })
    page.on('console', (m) => {
      if (m.type() === 'error') errors.push(m.text())
    })
    page.on('pageerror', (e) => errors.push(e.message))

    const shoot = async (scene, extra) => {
      const params = captureParams(scene)
      params.set('gpu', '3')
      if (extra !== null) {
        for (const pair of extra.split('&')) {
          const [k, v] = pair.split('=')
          params.set(k, v ?? '1')
        }
      }
      await page.goto(`${BASE}?${params.toString()}`, { timeout: 300000 })
      await page.waitForSelector('body[data-capture-ready="1"]', { timeout: 300000 })
      return PNG.sync.read(await page.locator('#viewport').screenshot())
    }

    for (;;) {
      const index = next++
      if (index >= scenes.length) break
      const scene = scenes[index]
      // **素の絵は原因を振っても同じ。**置いてあれば読む。
      // `--extra` を渡したときは素ではないので置き場を使わない
      const cached = CACHE === null || EXTRA !== null ? null : `${CACHE}/${scene.name}.png`
      let shot
      if (cached !== null && existsSync(cached)) {
        shot = PNG.sync.read(readFileSync(cached))
      } else {
        shot = await shoot(scene, EXTRA)
        if (cached !== null) writeFileSync(cached, PNG.sync.write(shot))
      }
      let other
      if (AGAINST !== null) {
        other = await shoot(scene, AGAINST)
      } else {
        const baseline = `${SNAP}/${scene.name}${SUFFIX}`
        if (!existsSync(baseline)) {
          results[index] = { name: scene.name, note: '基準画像なし' }
          continue
        }
        other = PNG.sync.read(readFileSync(baseline))
      }
      results[index] = { name: scene.name, ...measure(shot, other) }
    }
    await page.close()
  }

  await Promise.all(Array.from({ length: WORKERS }, () => worker()))
  const elapsed = (Date.now() - started) / 1000

  // **並列で撮っても報告は構図の順に出す。**順が揺れると前の実行と
  // 目で比べられない
  for (const r of results) {
    if (r === undefined) continue
    if (r.note !== undefined) {
      console.log(`${r.name.padEnd(22)} ${r.note}`)
      continue
    }
    if (r.size !== undefined) {
      console.log(`${r.name.padEnd(22)} 寸法が違う: ${r.size}`)
      continue
    }
    rows.push(r)
    const pct = ((100 * r.differing) / r.total).toFixed(2) + '%'
    console.log(
      r.name.padEnd(22) +
        pct.padStart(12) +
        String(r.worst).padStart(6) +
        r.mean.toFixed(2).padStart(8) +
        r.topMean.toFixed(2).padStart(8) +
        r.bottomMean.toFixed(2).padStart(8),
    )
  }

  if (rows.length > 0) {
    const all = (f) => rows.map(f)
    const min = (xs) => Math.min(...xs)
    const max = (xs) => Math.max(...xs)
    const avg = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
    console.log('-'.repeat(66))
    console.log(
      `${rows.length} 枚。差分画素の割合 ` +
        `${((100 * min(all((r) => r.differing / r.total)))).toFixed(2)}〜` +
        `${((100 * max(all((r) => r.differing / r.total)))).toFixed(2)}%、` +
        `最大階調 ${min(all((r) => r.worst))}〜${max(all((r) => r.worst))}、` +
        `平均 ${avg(all((r) => r.mean)).toFixed(2)}`,
    )
    console.log(
      `所要 ${elapsed.toFixed(1)} 秒（${WORKERS} 本、1 枚あたり ` +
        `${(elapsed / rows.length).toFixed(1)} 秒）`,
    )
    const still = rows.filter((r) => r.differing === 0).length
    if (AGAINST === null) {
      console.log(
        still === 0
          ? '**全枚が動いている。**計画の見込み（大気とポストで 42 枚）と一致する。'
          : `動いていない枚が ${still} ある。**理由が要る。**`,
      )
    } else {
      console.log(
        still === rows.length
          ? '**1 枚も動かない。**この原因は絵に効いていない。振れていない疑いを先に潰す。'
          : `動いた ${rows.length - still} 枚。これがこの原因の寄与。`,
      )
    }
  }
  if (errors.length > 0) {
    console.log(`\nコンソールに ${errors.length} 件:`)
    for (const e of errors.slice(0, 5)) console.log(`  ${e.slice(0, 160)}`)
  }
  if (OUT !== null) {
    writeFileSync(OUT, JSON.stringify(rows, null, 2))
    console.log(`\n${OUT} に書いた`)
  }
} finally {
  await browser.close()
  try {
    process.kill(-server.pid)
  } catch {}
}
