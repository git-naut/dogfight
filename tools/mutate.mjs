// 歯型を当てる。わざと壊して、落ちるべき検査が落ちることを確かめる。
//
// **テストが通ることと、テストが守っていることは別。**表は
// `tools/bite-marks.mjs`。1 件でも「生存」（壊したのに落ちない）が出たら
// exit 1 で赤くする。
//
// リポジトリ本体は絶対に書き換えない。作業ツリーが汚れていたら拒否し、
// 複製したサンドボックスの中だけで壊す。
//
// 使い方:
//   node tools/mutate.mjs [--only id1,id2] [-g 名前の一部] [--keep]
import { spawnSync } from 'node:child_process'
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, symlinkSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
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

// サンドボックスを 1 度だけ作る。変異ごとに作り直すと複製が支配的になる
const sandbox = mkdtempSync(join(tmpdir(), 'dogfight-mutate-'))
const SNAPSHOTS = 'tests/e2e/smoke.spec.ts-snapshots'
try {
  for (const dir of ['src', 'tests', 'docs', 'tools']) {
    cpSync(join(ROOT, dir), join(sandbox, dir), {
      recursive: true,
      // 基準画像 42 枚（10 MB）は複製しない。読むだけなので後で symlink する
      filter: (src) => !src.includes(SNAPSHOTS),
    })
  }
  for (const file of ['tsconfig.json', 'vitest.config.ts', 'package.json']) {
    cpSync(join(ROOT, file), join(sandbox, file))
  }
  symlinkSync(join(ROOT, 'node_modules'), join(sandbox, 'node_modules'), 'dir')
  symlinkSync(join(ROOT, SNAPSHOTS), join(sandbox, SNAPSHOTS), 'dir')

  const rows = []
  for (const mark of marks) {
    const target = join(sandbox, mark.file)
    if (!existsSync(target)) {
      rows.push({ mark, verdict: '対象なし', detail: mark.file })
      continue
    }
    const original = readFileSync(target, 'utf8')
    const occurrences = original.split(mark.find).length - 1
    if (occurrences !== 1) {
      rows.push({ mark, verdict: '当たらない', detail: `${occurrences} 箇所` })
      continue
    }
    writeFileSync(target, original.replace(mark.find, mark.replace), 'utf8')
    const started = Date.now()
    const run = spawnSync(
      'npx',
      ['vitest', 'run', '--root', sandbox, '--reporter=dot', mark.expect],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const seconds = ((Date.now() - started) / 1000).toFixed(1)
    writeFileSync(target, original, 'utf8')

    // vitest は 1 件でも落ちれば 0 以外を返す。**落ちてほしい**
    if (run.status === 0) {
      rows.push({ mark, verdict: '生存', detail: `${seconds} 秒` })
    } else if (run.status === 1) {
      rows.push({ mark, verdict: '発火', detail: `${seconds} 秒` })
    } else {
      // 型エラーや読み込み失敗。落ちてはいるが理由が違うので分けて出す
      rows.push({ mark, verdict: '別の理由で失敗', detail: `exit ${run.status}` })
    }
  }

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
    console.log(`\nサンドボックスを残した: ${sandbox}`)
  } else {
    rmSync(sandbox, { recursive: true, force: true })
  }
}
