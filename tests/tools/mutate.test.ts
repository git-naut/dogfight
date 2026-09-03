import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { BITE_MARKS } from '../../tools/bite-marks.mjs'

/**
 * 歯型表そのものの健全性。
 *
 * **表は腐る。**定数をリネームすれば `find` が当たらなくなり、テストを
 * 消せば `expect` が指す先が消える。どちらも、変異を 1 度も走らせなければ
 * 気づけない。`npm run mutate` はサンドボックスの複製と vitest の起動を
 * 伴うので毎回は回せない。
 *
 * そこで**表が現在のソースと噛み合っていることだけを 18 秒の単体テストで
 * 守る。**当てて確かめるのは段の終わりでよいが、表が腐っていないことは
 * 常に分かる。
 *
 * `tests/input/controlHelp.test.ts` が「抽出が機能している」を下限で
 * 固定しているのと同じ作法。
 */
const ROOT = fileURLToPath(new URL('../../', import.meta.url))
type BiteKind = (typeof BITE_MARKS)[number]['kind']
const KINDS = new Set<BiteKind>([
  '定数の摂動',
  '比較の反転',
  '条件の固定',
  '文の削除',
  '表の行の削除',
  '符号の反転',
])

describe('歯型表', () => {
  it('行がある', () => {
    // 表が空になったら落ちる。`controlHelp.test.ts` の下限と同じ作法
    expect(BITE_MARKS.length).toBeGreaterThanOrEqual(8)
  })

  it('id が重複しない', () => {
    expect(new Set(BITE_MARKS.map((m) => m.id)).size).toBe(BITE_MARKS.length)
  })

  it('変異の型が 6 つのどれか', () => {
    for (const m of BITE_MARKS) {
      expect(KINDS.has(m.kind), `${m.id} の kind: ${m.kind}`).toBe(true)
    }
  })

  it('6 つの型をすべて 1 つ以上使っている', () => {
    // **型を絞った意味を保つ。**使わない型があるなら、その壊し方を
    // 誰も試していない
    const used = new Set(BITE_MARKS.map((m) => m.kind))
    const unused = [...KINDS].filter((k) => !used.has(k))
    // 段 4 で符号の反転が埋まり、6 つ全部を使うようになった
    expect(unused).toEqual([])
  })

  it('find が対象ファイルにちょうど 1 回だけ現れる', () => {
    for (const m of BITE_MARKS) {
      const path = `${ROOT}${m.file}`
      expect(existsSync(path), `${m.id}: ${m.file} がない`).toBe(true)
      const source = readFileSync(path, 'utf8')
      const count = source.split(m.find).length - 1
      // 0 なら表が腐っている。2 以上なら意図しない場所も書き換える
      expect(count, `${m.id}: ${m.file} に ${count} 箇所`).toBe(1)
    }
  })

  it('replace が find と違う', () => {
    for (const m of BITE_MARKS) {
      expect(m.replace, m.id).not.toBe(m.find)
    }
  })

  it('expect のテストが実在する', () => {
    for (const m of BITE_MARKS) {
      expect(existsSync(`${ROOT}${m.expect}`), `${m.id}: ${m.expect} がない`).toBe(true)
    }
  })

  it('lesson か why のどちらかを持つ', () => {
    for (const m of BITE_MARKS) {
      const has = (m.lesson ?? '') !== '' || (m.why ?? '') !== ''
      expect(has, `${m.id} に理由がない`).toBe(true)
    }
  })

  it('lesson が docs/lessons.md に実在する', () => {
    const lessons = readFileSync(`${ROOT}docs/lessons.md`, 'utf8')
    for (const m of BITE_MARKS) {
      if (m.lesson === undefined) continue
      expect(lessons.includes(m.lesson), `${m.id} の教訓が lessons.md にない: ${m.lesson}`).toBe(
        true,
      )
    }
  })

  it('抽出そのものが働く', () => {
    // 検査が空振りしていないことを、既知の値で確かめる。
    // `tests/render/testHook.test.ts:76` と同じ作法
    const keyboard = readFileSync(`${ROOT}src/input/keyboard.ts`, 'utf8')
    expect(keyboard.split("{ keys: 'F', action: 'ミサイル', codes: ['KeyF'] },").length - 1).toBe(1)
    expect(keyboard.split('この文字列は存在しない').length - 1).toBe(0)
  })
})

/**
 * 教訓の側から見た検査。
 *
 * `docs/lessons.md` は 3 列を持つ。3 列目に検査のパスを書いた行は、その
 * パスが実在しなければ嘘になる。**教訓が守られていると書いてあるのに
 * 守るものが消えている**状態を止める。
 */
describe('docs/lessons.md', () => {
  const lessons = readFileSync(`${ROOT}docs/lessons.md`, 'utf8')

  it('3 列目に書いたテストが実在する', () => {
    const paths = [...lessons.matchAll(/`(tests\/[\w/.]+\.ts|tools\/[\w/.]+\.mjs)`/g)].map(
      (m) => m[1] as string,
    )
    expect(paths.length, '検査のパスが 1 つも書かれていない').toBeGreaterThan(3)
    for (const p of new Set(paths)) {
      expect(existsSync(`${ROOT}${p}`), `lessons.md が指す ${p} がない`).toBe(true)
    }
  })

  it('穴の数を数えられる', () => {
    // 「未対応」の行は教訓ではなく穴。**数が見えていることが大事。**
    // 減ったらここを下げる。増えたら理由を書く
    const holes = (lessons.match(/未対応/g) ?? []).length
    // 段 1 で 7、段 2 で 6 へ減り、CI の上限に当たって 7、段 5 で 8。
    //
    // 増やした理由は 2 つとも E2E の所要にある。`--shard` が本数で割るので
    // 重いものが 1 台へ寄ること。その遅さの正体が SwiftShader の競合だと
    // 分かったが、ワーカー数と分割数で薄めているだけであること。どちらも
    // 所要を見た分配が要る。
    //
    // 段 12 の前半で 9 へ増やし、後半で 8 へ戻した。3D のレンダーターゲット
    // から直に層を読み戻せない件は、整数フェッチで 2D へ落とす道に替えて
    // 塞いだ（`src/render/clouds/volume.ts`）。
    //
    // 段 15 で 9 へ。WebGPU 経路で `shadowMap.enabled` を立てると、投げ手が
    // 無くても描くパスが 1 つ増える。影マップの回数は「投げ手あり」と
    // 「投げ手なし」の差で数えて回避しているが、**増える 1 つの正体は
    // 分かっていない。**段 17 で場面を組むときに追う。
    // **減らしたときは下げる。増やすときは理由を書く。**
    expect(holes).toBeLessThanOrEqual(9)
  })
})
