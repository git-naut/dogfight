// 歯型を当てる。わざと壊して、落ちるべき検査が落ちることを確かめる。
//
// **テストが通ることと、テストが守っていることは別。**表は
// `tools/bite-marks.mjs`。1 件でも「生存」（壊したのに落ちない）が出たら
// exit 1 で赤くする。
//
// リポジトリ本体は絶対に書き換えない。作業ツリーが汚れていたら拒否し、
// 複製したサンドボックスの中だけで壊す。
//
// **変異ごとの vitest を並列に回す。**サンドボックスを台数ぶん作り、
// 歯型を配って同時に走らせる。実測（45 件、8 コア）。
//
// | 台数 | 総所要 | 直列比 |
// |---|---|---|
// | 1 | 186 秒 | — |
// | 2 | 88 秒 | 2.11 倍 |
// | 4 | 53 秒 | 3.51 倍 |
// | 8 | **42 秒** | 4.43 倍 |
//
// 直列 186 秒の内訳は vitest が 45 件 × 3.3 秒 = 149 秒、残り 37 秒が
// サンドボックスの複製と起動。**8 割が vitest なので台数で割れる。**
// 45 件すべて発火は 4 条件とも保たれた。
//
// **既定は 4 にする。8 が最速だが 1.26 倍しか変わらない。**この repo は
// 「SwiftShader は CPU 律速なので詰め込むと取り合いになる」を
// `playwright.config.ts` で実測している（8 コア 8 本は 4 本より 24% 遅い）。
// 歯型はブラウザを立てないのでそこには当たらないが、E2E と同時に回すこと
// があるので半分に留める。急ぐときは `--workers 8`。
//
// 複製は `/mnt/c` 越しなので台数ぶん増える。2 台で 2.11 倍、4 台で
// 3.51 倍、8 台で 4.43 倍と鈍るのはそのぶん。
//
// 使い方:
//   node tools/mutate.mjs [--only id1,id2] [-g 名前の一部] [--keep]
//                         [--workers N]
import { spawn, spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { cpus, tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath, URL } from 'node:url'
import { BITE_MARKS } from './bite-marks.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))

const argv = process.argv.slice(2)
const arg = (name, fallback) => {
  const i = argv.indexOf(name)
  return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : fallback
}
const ONLY = arg('--only', null)?.split(',')
const FILTER = arg('-g', null)
const KEEP = argv.includes('--keep')
const WORKERS = Math.max(1, Number(arg('--workers', Math.max(1, Math.floor(cpus().length / 2)))))

const marks = BITE_MARKS.filter(
  (m) =>
    (ONLY === undefined || ONLY === null || ONLY.includes(m.id)) &&
    (FILTER === null || m.id.includes(FILTER)),
)
if (marks.length === 0) {
  console.error('当てる歯型がない')
  process.exit(2)
}

// **リポジトリ本体を守る。**汚れた作業ツリーの上で走らせると、
// 復元に失敗したときに何が自分の変更で何が変異なのか分からなくなる
const status = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' })
if (status.status !== 0) {
  console.error('git status が失敗した')
  process.exit(2)
}
if (status.stdout.trim() !== '') {
  console.error('作業ツリーが汚れている。コミットするか stash してから走らせる。')
  console.error(status.stdout.trim().split('\n').slice(0, 10).join('\n'))
  process.exit(2)
}

const SNAPSHOTS = 'tests/e2e/smoke.spec.ts-snapshots'

/** サンドボックスを 1 つ作る。**変異ごとに作り直すと複製が支配的になる** */
function makeSandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'dogfight-mutate-'))
  for (const d of ['src', 'tests', 'docs', 'tools']) {
    cpSync(join(ROOT, d), join(dir, d), {
      recursive: true,
      // 基準画像 42 枚（10 MB）は複製しない。読むだけなので後で symlink する
      filter: (src) => !src.includes(SNAPSHOTS),
    })
  }
  for (const file of ['tsconfig.json', 'vitest.config.ts', 'package.json']) {
    cpSync(join(ROOT, file), join(dir, file))
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir')
  symlinkSync(join(ROOT, SNAPSHOTS), join(dir, SNAPSHOTS), 'dir')
  return dir
}

/** 1 件の変異を当てて vitest を回す。**落ちてほしい** */
function runMark(sandbox, mark) {
  const target = join(sandbox, mark.file)
  if (!existsSync(target)) {
    return Promise.resolve({ mark, verdict: '対象なし', detail: mark.file })
  }
  const original = readFileSync(target, 'utf8')
  const occurrences = original.split(mark.find).length - 1
  if (occurrences !== 1) {
    return Promise.resolve({ mark, verdict: '当たらない', detail: `${occurrences} 箇所` })
  }
  writeFileSync(target, original.replace(mark.find, mark.replace), 'utf8')
  const started = Date.now()
  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['vitest', 'run', '--root', sandbox, '--reporter=dot', mark.expect],
      { cwd: ROOT, stdio: 'ignore' },
    )
    child.on('close', (code) => {
      const seconds = ((Date.now() - started) / 1000).toFixed(1)
      // **必ず戻す。**戻さないと同じサンドボックスの次の変異が二重になる
      writeFileSync(target, original, 'utf8')
      if (code === 0) resolve({ mark, verdict: '生存', detail: `${seconds} 秒` })
      else if (code === 1) resolve({ mark, verdict: '発火', detail: `${seconds} 秒` })
      // 型エラーや読み込み失敗。落ちてはいるが理由が違うので分けて出す
      else resolve({ mark, verdict: '別の理由で失敗', detail: `exit ${code}` })
    })
  })
}

const lanes = Math.min(WORKERS, marks.length)
const sandboxes = Array.from({ length: lanes }, () => makeSandbox())
try {
  // **同じファイルを触る歯型を同じ台へ寄せない**必要はない。台ごとに
  // サンドボックスが別なので、配り方は所要だけで決めればよい。1 件あたりが
  // ほぼ同じなので順に配る
  const queue = marks.map((mark, index) => ({ mark, index }))
  const collected = []
  await Promise.all(
    sandboxes.map(async (dir) => {
      for (;;) {
        const next = queue.shift()
        if (next === undefined) return
        collected.push({ ...(await runMark(dir, next.mark)), index: next.index })
      }
    }),
  )
  // 表の並びは `bite-marks.mjs` の順に戻す。**台の割り当てで並びを変えない**
  const rows = collected.sort((a, b) => a.index - b.index)

  const width = Math.max(...marks.map((m) => m.id.length))
  console.log('')
  for (const { mark, verdict, detail } of rows) {
    const flag = verdict === '発火' ? ' ' : '!'
    console.log(`${flag} ${mark.id.padEnd(width)}  ${verdict.padEnd(8)}  ${mark.kind}  ${detail}`)
  }
  const survived = rows.filter((r) => r.verdict !== '発火')
  console.log('')
  if (survived.length === 0) {
    console.log(`歯型 ${rows.length} 件がすべて発火した。壊せば落ちる。`)
  } else {
    console.log(`**${survived.length} 件が発火しなかった。**壊しても落ちない検査がある。`)
    for (const { mark, verdict } of survived) {
      console.log(`  ${mark.id}: ${verdict}。${mark.expect} が ${mark.file} の変更を見ていない`)
    }
  }
  process.exitCode = survived.length === 0 ? 0 : 1
} finally {
  if (KEEP) {
    console.log(`\nサンドボックスを残した: ${sandboxes.join(' ')}`)
  } else {
    for (const dir of sandboxes) rmSync(dir, { recursive: true, force: true })
  }
}
