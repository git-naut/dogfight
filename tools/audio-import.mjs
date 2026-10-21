// 実録音の効果音を取り込む（Phase 10 の段 B11a、ADR 0037）。
//
// 元のファイルは Freesound の CC0 の録音で、ユーザーが 2026-10-05 にダウンロードへ落とした
// （ページの長さと 10 ms 以内で一致することを 2026-10-22 に確かめた）。元のファイルは合わせて 約 58 MB
// あるのでリポジトリに入れず、ここで区間を切り出して `public/audio/` に Opus（.ogg）で書き出す。
// 書き出したファイルはコミットする。CI には ffmpeg が無いので、作り直すときは手元でこれを流す。
//
//   FFMPEG=/path/to/ffmpeg SOURCE_DIR=/mnt/c/Users/naut8/Downloads node tools/audio-import.mjs
//
// 1. 元のファイルを 48 kHz・1 チャンネルの float に読む（立体の振り分けは Web Audio が行う）
// 2. 区間を切り出す。ループは区間の終わりのあと `crossfade` 秒を頭へ等パワーで重ね、継ぎ目の段差を消す
//    （頭の `crossfade` 秒は、区間のすぐ後ろの音から元の音へ移るので、末尾から頭へ切れ目なく続く）。
//    1 回鳴らす音は頭 5 ms と終わり 30 ms を薄めて、プツッと鳴らないようにする
// 3. 大きさをそろえる。ループは RMS −18 dBFS、1 回鳴らす音はピーク −1 dBFS。どちらもピークは −1 dBFS
//    を超えない
// 4. Opus 64 kbps で書き出し、読み戻して長さと継ぎ目を確かめる
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FFMPEG = process.env.FFMPEG
const SOURCE_DIR = process.env.SOURCE_DIR
if (!FFMPEG || !SOURCE_DIR) {
  console.error('FFMPEG（ffmpeg の実行ファイル）と SOURCE_DIR（元のファイルの置き場所）を渡す')
  process.exit(2)
}

const RATE = 48000
const OUT_DIR = 'public/audio'

/** 元のファイル。`assets/CREDITS.md` の効果音の表と対になる */
export const SOURCES = {
  turbine: '205581__qubodup__jet-turbine-noise.flac',
  idle: '187734__qubodup__idle-f-22-jet-plane.flac',
  burner: '104883__stoneyj__afterburner-sound.wav',
  burnerLight: '162242__surrey_film__eurofighter-afterburner-woomph.aiff',
  flyby: '135495__freqman__f-18-hornet-pass-01.wav',
  gun: '611449__seidhepriest__m61a2-minigun.wav',
  missile: '162368__qubodup__agm-114-hellfire-rocket-missile-launch.flac',
}

/**
 * 切り出す区間（秒）。区間は大きさと音色（周波数の重心）を 0.5 秒・0.1 秒ごとに測って決めた
 * （`~/.claude/plans/dogfight-ac7-ref/measure/b11_sources.txt`）
 */
export const CLIPS = [
  // タービンの持続音。12〜56 秒が −6 dB・重心 3.0〜3.3 kHz で安定
  { name: 'engine-turbine', source: 'turbine', start: 30, end: 40, crossfade: 0.25 },
  // F-22 のアイドル。全体が −9 dB・重心 2.0〜2.8 kHz で安定
  { name: 'engine-idle', source: 'idle', start: 4, end: 14, crossfade: 0.25 },
  // アフターバーナーの轟音。21〜31 秒が −16 dB・重心 0.4〜0.6 kHz で安定
  { name: 'engine-burner', source: 'burner', start: 22, end: 30, crossfade: 0.25 },
  // アフターバーナーの点火。9〜13 秒に −4 dB の山
  { name: 'burner-light', source: 'burnerLight', start: 8.5, end: 13 },
  // F-18 の通過。22.5 秒前後が山
  { name: 'flyby', source: 'flyby', start: 15, end: 35 },
  // 機銃の連射。0.8〜3.0 秒が −8 dB で安定。止めたあとは 3.0〜4.5 秒の余韻
  { name: 'gun-loop', source: 'gun', start: 1.0, end: 2.9, crossfade: 0.1 },
  { name: 'gun-tail', source: 'gun', start: 3.0, end: 4.5 },
  // ミサイルの発射。2.3 秒で途切れる（その先は無音）
  { name: 'missile-launch', source: 'missile', start: 0, end: 2.3 },
]

const LOOP_RMS_DB = -18
const PEAK_DB = -1
const FADE_IN = 0.005
const FADE_OUT = 0.03

function decode(file) {
  const r = spawnSync(FFMPEG, ['-v', 'error', '-i', file, '-ac', '1', '-ar', String(RATE), '-f', 'f32le', '-'], {
    maxBuffer: 1 << 30,
  })
  if (r.status !== 0) throw new Error(`${file} を読めない: ${r.stderr}`)
  return new Float32Array(r.stdout.buffer, r.stdout.byteOffset, r.stdout.byteLength / 4)
}

function db(x) {
  return 20 * Math.log10(x + 1e-12)
}

function rmsOf(x) {
  let s = 0
  for (const v of x) s += v * v
  return Math.sqrt(s / x.length)
}

function peakOf(x) {
  let p = 0
  for (const v of x) p = Math.max(p, Math.abs(v))
  return p
}

/**
 * 継ぎ目の段差。末尾から頭へ飛ぶ差を、ふだんの隣り合うサンプルの差（中央値）で割った比。
 * 1 前後なら段差がない
 */
export function seamRatio(x) {
  const diffs = []
  for (let i = 1; i < x.length; i++) diffs.push(Math.abs(x[i] - x[i - 1]))
  diffs.sort((a, b) => a - b)
  const median = diffs[diffs.length >> 1] || 1e-9
  return Math.abs(x[0] - x[x.length - 1]) / median
}

function cut(all, clip) {
  const a = Math.round(clip.start * RATE)
  const b = Math.round(clip.end * RATE)
  if (clip.crossfade) {
    const n = b - a
    const xf = Math.round(clip.crossfade * RATE)
    if (b + xf > all.length) throw new Error(`${clip.name}: 重ねる尾が元のファイルの外に出る`)
    const out = new Float32Array(n)
    for (let i = 0; i < n; i++) out[i] = all[a + i]
    // 頭の xf を、区間のすぐ後ろ（b..b+xf）から元の音（a..a+xf）へ等パワーで移す
    for (let i = 0; i < xf; i++) {
      const t = i / xf
      out[i] = all[a + i] * Math.sin((t * Math.PI) / 2) + all[b + i] * Math.cos((t * Math.PI) / 2)
    }
    return out
  }
  const out = all.slice(a, b)
  const fi = Math.round(FADE_IN * RATE)
  const fo = Math.round(FADE_OUT * RATE)
  for (let i = 0; i < fi; i++) out[i] *= i / fi
  for (let i = 0; i < fo; i++) out[out.length - 1 - i] *= i / fo
  return out
}

function normalize(x, loop) {
  const gainRms = loop ? 10 ** (LOOP_RMS_DB / 20) / rmsOf(x) : Infinity
  const gainPeak = 10 ** (PEAK_DB / 20) / peakOf(x)
  const g = Math.min(gainRms, gainPeak)
  for (let i = 0; i < x.length; i++) x[i] *= g
  return x
}

function encode(x, path) {
  const r = spawnSync(
    FFMPEG,
    ['-v', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '1', '-i', '-', '-c:a', 'libopus', '-b:a', '64k', path],
    { input: Buffer.from(x.buffer, x.byteOffset, x.byteLength) },
  )
  if (r.status !== 0) throw new Error(`${path} を書けない: ${r.stderr}`)
}

mkdirSync(OUT_DIR, { recursive: true })
const cache = new Map()
const manifest = []
let total = 0
for (const clip of CLIPS) {
  const file = join(SOURCE_DIR, SOURCES[clip.source])
  if (!cache.has(file)) cache.set(file, decode(file))
  const x = normalize(cut(cache.get(file), clip), Boolean(clip.crossfade))
  const path = join(OUT_DIR, `${clip.name}.ogg`)
  encode(x, path)
  const back = decode(path)
  const bytes = statSync(path).size
  total += bytes
  const entry = {
    name: clip.name,
    loop: Boolean(clip.crossfade),
    seconds: x.length / RATE,
    decodedSeconds: back.length / RATE,
    rmsDb: Number(db(rmsOf(x)).toFixed(1)),
    peakDb: Number(db(peakOf(x)).toFixed(1)),
    bytes,
  }
  if (entry.loop) {
    entry.seamBefore = Number(seamRatio(x).toFixed(2))
    entry.seamDecoded = Number(seamRatio(back).toFixed(2))
  }
  manifest.push(entry)
  console.log(JSON.stringify(entry))
}
console.log(`合計 ${total} バイト（${(total / 1024).toFixed(0)} KB）`)
writeFileSync(join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
