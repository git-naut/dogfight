import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'

/**
 * E2E のシャードの重み。
 *
 * **`PWTEST_SHARD_WEIGHTS` の個数が台数と違うと、Playwright は全台で
 * 即座に落ちる**（`filterForShard` が `number of weights must match the
 * shard total` を投げる）。8 台ぶんの CI が一斉に赤くなってから気づくのは
 * 遅いので、`matrix.shard` と重みの数が噛み合っていることを 18 秒の単体
 * テストで守る。歯型表の健全性を `mutate.test.ts` が守るのと同じ作法。
 *
 * 重みそのものが正しい（釣り合っている）かどうかは、CI の実測が要るので
 * ここでは見ない。計算し直す道具は `tools/shard-weights.mjs`。
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
const workflow = readFileSync(`${ROOT}.github/workflows/e2e.yml`, 'utf8')

/** `shard: [1, 2, 3]` から台数を読む */
function shardMatrix(): number[] {
  const m = /^\s*shard:\s*\[([^\]]+)\]/m.exec(workflow)
  expect(m, 'e2e.yml に shard の matrix がない').not.toBeNull()
  return m![1]!.split(',').map((s) => Number(s.trim()))
}

/** `PWTEST_SHARD_WEIGHTS: 1:2:3` から重みを読む */
function shardWeights(): number[] {
  const m = /^\s*PWTEST_SHARD_WEIGHTS:\s*([\d:]+)\s*$/m.exec(workflow)
  expect(m, 'e2e.yml に PWTEST_SHARD_WEIGHTS がない').not.toBeNull()
  return m![1]!.split(':').map((s) => Number(s))
}

describe('E2E のシャードの重み', () => {
  it('台数と重みの数が合う', () => {
    const shards = shardMatrix()
    const weights = shardWeights()
    expect(weights.length, `台 ${shards.length} 個に対して重み ${weights.length} 個`).toBe(
      shards.length,
    )
  })

  it('台の番号が 1 から連番になっている', () => {
    // 抜けがあると `strategy.job-total` と `--shard=N/total` がずれる
    expect(shardMatrix()).toEqual(
      Array.from({ length: shardMatrix().length }, (_, i) => i + 1),
    )
  })

  it('重みはすべて 1 以上の整数', () => {
    for (const [i, w] of shardWeights().entries()) {
      // 0 を置くとその台が 1 本も走らない。落ちずに検査が消える
      expect(Number.isInteger(w), `${i + 1} 番目の重み ${w}`).toBe(true)
      expect(w, `${i + 1} 番目の重み`).toBeGreaterThanOrEqual(1)
    }
  })

  it('分割数はワークフローの台数から導いている', () => {
    // `--shard=N/8` と書くと matrix を増やしたときにずれる
    expect(workflow).toContain('--shard=${{ matrix.shard }}/${{ strategy.job-total }}')
  })

  it('計算し直す道具がある', () => {
    // 重みは腐る。**計算し直す手が消えていたら値を直せない**
    expect(existsSync(`${ROOT}tools/shard-weights.mjs`)).toBe(true)
  })

  it('抽出そのものが働く', () => {
    // 検査が空振りしていないことを既知の値で確かめる。
    // `mutate.test.ts` の「抽出そのものが働く」と同じ作法
    expect(shardMatrix().length).toBeGreaterThanOrEqual(2)
    expect(shardWeights().reduce((a, b) => a + b, 0)).toBeGreaterThan(0)
    expect(/^\s*PWTEST_SHARD_WEIGHTS:\s*([\d:]+)\s*$/m.exec('この文字列は存在しない')).toBeNull()
  })
})
