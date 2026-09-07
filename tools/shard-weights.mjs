// E2E のシャードを所要で釣り合わせる重みを、CI のレポートから計算する。
//
// **`--shard` は本数で割る。**並びはプロジェクト順・ファイル順・行順なので、
// 重いものが特定の台へ寄る。実測（run 34056675131）で 8 台の E2E の段が
// 244〜631 秒に開いた。最長の台だけが上限 18 分に近づく。
//
// Playwright 1.62 の `PWTEST_SHARD_WEIGHTS` は、台ごとの**本数**を重みで
// 決める（`runner/index.js` の `filterForShard`）。並びは変わらないので、
// 連続する区間の分け方を所要で選べば釣り合う。
//
// 重みは「その台へ入れる本数」をそのまま書けばよい。合計を総本数に
// しておけば `floor(w * total / totalWeight)` がその数を返す。
//
// **この道具は自分の並びの読みを検算する。**現行の均等割りを再現して
// 観測したシャード番号と 1 本ずつ突き合わせ、合わなければ重みを出さない。
// 並びの読みが違ったまま重みを出すと、釣り合わせるつもりで崩す。
//
// 使い方:
//   GH_TOKEN="$(gh auth token --user git-naut)" \
//     gh run download <run id> --repo git-naut/dogfight -D /tmp/reports
//   node tools/shard-weights.mjs --dir /tmp/reports [--shards 8] [--factor 2]
//
// `--factor` は所要が何倍になった場合を併記するかの倍率（段 20 の見積り）。
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, URL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const DIR = arg('--dir', null)
const SHARDS = Number(arg('--shards', 8))
const FACTOR = Number(arg('--factor', 2))

if (DIR === null || !existsSync(DIR)) {
  console.error('--dir に `gh run download` で落としたレポートの置き場を渡す')
  process.exit(2)
}

// レポートは `index.html` の `<template>` に data URI の zip で入っている。
// 中央ディレクトリから引く（ローカルヘッダは大きさが 0 のことがある）
function unzip(buffer) {
  const eocd = (() => {
    for (let i = buffer.length - 22; i >= 0; i--) {
      if (buffer.readUInt32LE(i) === 0x06054b50) return i
    }
    throw new Error('zip の終端が見つからない')
  })()
  const count = buffer.readUInt16LE(eocd + 10)
  let p = buffer.readUInt32LE(eocd + 16)
  const files = new Map()
  for (let n = 0; n < count; n++) {
    if (buffer.readUInt32LE(p) !== 0x02014b50) throw new Error('中央ディレクトリが壊れている')
    const method = buffer.readUInt16LE(p + 10)
    const compressed = buffer.readUInt32LE(p + 20)
    const nameLen = buffer.readUInt16LE(p + 28)
    const extraLen = buffer.readUInt16LE(p + 30)
    const commentLen = buffer.readUInt16LE(p + 32)
    const offset = buffer.readUInt32LE(p + 42)
    const name = buffer.toString('utf8', p + 46, p + 46 + nameLen)
    const lNameLen = buffer.readUInt16LE(offset + 26)
    const lExtraLen = buffer.readUInt16LE(offset + 28)
    const start = offset + 30 + lNameLen + lExtraLen
    const raw = buffer.subarray(start, start + compressed)
    files.set(name, method === 0 ? raw : inflateRawSync(raw))
    p += 46 + nameLen + extraLen + commentLen
  }
  return files
}

const measured = new Map()
const observedShard = new Map()
const dirs = readdirSync(DIR)
  .filter((d) => /^playwright-report-\d+$/.test(d))
  .sort()
if (dirs.length === 0) {
  console.error(`${DIR} に playwright-report-N が無い`)
  process.exit(2)
}
for (const d of dirs) {
  const shard = Number(d.replace('playwright-report-', ''))
  const html = readFileSync(join(DIR, d, 'index.html'), 'utf8')
  const m =
    /<template id="playwrightReportBase64">data:application\/zip;base64,([^<]+)<\/template>/.exec(
      html,
    )
  if (m === null) throw new Error(`${d} に埋め込みのレポートが無い`)
  const zip = unzip(Buffer.from(m[1], 'base64'))
  const report = JSON.parse(zip.get('report.json').toString('utf8'))
  for (const file of report.files) {
    for (const t of file.tests) {
      const key = `${t.projectName} ${t.location.file} ${t.location.line} ${t.title}`
      measured.set(key, (measured.get(key) ?? 0) + t.duration)
      observedShard.set(key, shard)
    }
  }
}

// 並びの正本を取る。プロジェクトはコンフィグの順、ファイルは走査の順、
// テストは行の順。群は 1 テストずつになる（`fullyParallel` かつ
// beforeAll/afterAll が無いので `filterForShard` が 1 本単位で切る）
const listed = spawnSync('npx', ['playwright', 'test', '--list', '--reporter=json'], {
  cwd: ROOT,
  encoding: 'utf8',
  maxBuffer: 64 * 1024 * 1024,
})
if (listed.stdout === '') {
  console.error('playwright test --list が何も返さなかった')
  process.exit(2)
}
const list = JSON.parse(listed.stdout)
const order = []
for (const project of list.config.projects) {
  for (const fileSuite of list.suites) {
    const walk = (suite) => {
      for (const spec of suite.specs ?? []) {
        for (const t of spec.tests) {
          if (t.projectName !== project.name) continue
          order.push({
            key: `${t.projectName} ${fileSuite.file} ${spec.line} ${spec.title}`,
            label: `${project.name} ${fileSuite.file}:${spec.line}`,
          })
        }
      }
      for (const child of suite.suites ?? []) walk(child)
    }
    walk(fileSuite)
  }
}

function equalSizes(total, shards) {
  const base = Math.floor(total / shards)
  const sizes = Array.from({ length: shards }, () => base)
  for (let i = 0; i < total - base * shards; i++) sizes[i % shards]++
  return sizes
}

// 現行の均等割りを再現して、観測したシャード番号と突き合わせる
const observedShards = new Set(observedShard.values()).size
if (order.length !== measured.size) {
  console.error(`本数が合わない。並び ${order.length} 本、レポート ${measured.size} 本`)
  process.exit(2)
}
{
  const sizes = equalSizes(order.length, observedShards)
  let pos = 0
  for (let s = 1; s <= observedShards; s++) {
    for (const item of order.slice(pos, pos + sizes[s - 1])) {
      if (observedShard.get(item.key) !== s) {
        console.error(
          `並びの読みが違う。${item.label} は ${s} 番のはずが ${observedShard.get(item.key)} 番`,
        )
        process.exit(2)
      }
    }
    pos += sizes[s - 1]
  }
  console.log(`並びの検算: ${order.length} 本すべて ${observedShards} 台の観測と一致した`)
}

const ms = order.map((o) => measured.get(o.key) ?? 0)
const total = ms.reduce((a, b) => a + b, 0)

// 連続する区間で最大を最小にする。上限を二分探索して詰める
function partition(shards) {
  const fits = (cap) => {
    const sizes = []
    let cur = 0
    let count = 0
    for (const v of ms) {
      if (count > 0 && cur + v > cap) {
        sizes.push(count)
        cur = 0
        count = 0
        if (sizes.length >= shards) return null
      }
      cur += v
      count++
    }
    sizes.push(count)
    return sizes.length <= shards ? sizes : null
  }
  let lo = Math.max(...ms)
  let hi = total
  let best = null
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2)
    const got = fits(mid)
    if (got === null) lo = mid + 1
    else {
      best = got
      hi = mid - 1
    }
  }
  // 台を空にはできない。本数の多いところから 1 本ずつ回す
  while (best.length < shards) {
    const i = best.indexOf(Math.max(...best))
    best[i]--
    best.splice(i + 1, 0, 1)
  }
  return best
}

/** 台ごとのテスト秒 */
function spans(sizes) {
  const out = []
  let pos = 0
  for (const n of sizes) {
    out.push(ms.slice(pos, pos + n).reduce((a, b) => a + b, 0))
    pos += n
  }
  return out
}

// 段の所要は実測に合わせた式。ワーカー 2 本で割り、器の起動に 20 秒。
// run 34056675131 の 8 台で残差 16〜24 秒（テスト秒 451〜1221 に対して）
const stepMs = (testMs, factor = 1) => (testMs * factor) / 2 + 20_000

const eq = spans(equalSizes(order.length, SHARDS))
const weights = partition(SHARDS)
const wt = spans(weights)

console.log(
  `\n総テスト秒 ${(total / 1000).toFixed(0)} 秒、1 本の最長 ${(Math.max(...ms) / 1000).toFixed(1)} 秒\n`,
)
console.log(`| ${SHARDS} 分割 | 最大テスト秒 | 段の所要 | ${FACTOR} 倍のとき |`)
console.log('|---|---|---|---|')
for (const [label, arr] of [
  ['均等（いま）', eq],
  ['重み', wt],
]) {
  const mx = Math.max(...arr)
  console.log(
    `| ${label} | ${(mx / 1000).toFixed(0)} 秒 | ${(stepMs(mx) / 60_000).toFixed(1)} 分 | ${(stepMs(mx, FACTOR) / 60_000).toFixed(1)} 分 |`,
  )
}
console.log(`\n台ごとのテスト秒（重み）: ${wt.map((v) => (v / 1000).toFixed(0)).join(' / ')}`)
console.log(`\nPWTEST_SHARD_WEIGHTS: ${weights.join(':')}`)
