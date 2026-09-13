import { describe, it, expect } from 'vitest'
import { struct } from 'three/tsl'
import { StructTypeNode } from 'three/webgpu'

/**
 * takram が前提にしている three の形を縛る。
 *
 * `@takram/three-atmosphere@0.19.1` は `struct()` の戻り値に `.layout` が
 * あることを前提に書かれている。atmosphere 側に 5 件、geospatial 側に 3 件。
 * geospatial の判定は `'layout' in s && s.layout instanceof StructTypeNode`
 * という形で、**プロパティの存在そのものを見る。**
 *
 * three は 0.185.0 でここを変えた。0.184 までは
 * `struct.layout = structLayout; return struct` だったものが、0.185 で
 * `return nodeProxyConstructor(struct, structType)` になった。Proxy は
 * `get` と `set` しかトラップせず、`StructTypeNode` 自身は `layout` という
 * 名前のプロパティを持たない（`membersLayout` / `name` / `isStructTypeNode`）
 * ので、`struct().layout` は undefined になる。
 *
 * **0.186 でも形は戻っていない。**takram が 0.19.1（2026-05-06）で止まって
 * いる一方、three は 0.186（2026-09-08）まで進んだので、噛み合わせは
 * `tools/patch-three.mjs` が `postinstall` で作る。`get` と `has` の 2 つを
 * 足して 0.184 までの `.layout` を代理させる。
 *
 * **この検査はパッチが効いていることの見張りである。**three を上げて
 * パッチが当たらなくなれば `tools/patch-three.mjs` 自身が落ちるが、
 * 当たったのに意味を失う形（`.layout` の読み方が takram 側で変わる等）は
 * こちらが捕まえる。
 */
describe('takram と three の噛み合わせ', () => {
  it('struct() の戻り値が layout を持つ', () => {
    const probe = struct({ value: 'float' }, 'CompatProbe')
    expect(
      'layout' in probe,
      'パッチの has トラップが効いていない。tools/patch-three.mjs を見ること',
    ).toBe(true)
  })

  it('layout が StructTypeNode を返す', () => {
    // geospatial は `s.layout instanceof StructTypeNode` で見るので、
    // 名前が引けるだけでは足りない。**クラスは build 経由で取る。**
    // `three/src/...` から直接取ると別のクラスオブジェクトになり、
    // instanceof が常に false になる（切り分けの道具が壊れる形）
    const probe = struct({ value: 'float' }, 'CompatProbe')
    const layout = (probe as unknown as { layout: unknown }).layout
    expect(layout).toBeInstanceOf(StructTypeNode)
  })

  it('layout.name が構造体の名前を返す', () => {
    // takram は入れ子の構造体の型名をここから取る
    const probe = struct({ value: 'float' }, 'CompatProbe')
    const layout = (probe as unknown as { layout: { name: string } }).layout
    expect(layout.name).toBe('CompatProbe')
  })

  it('geospatial の判定と同じ式が通る', () => {
    // `@takram/three-geospatial` の build にある形をそのまま写す。
    // 片方だけ通っても意味がないので、2 条件を組で見る
    const probe = struct({ value: 'float' }, 'CompatProbe') as unknown as {
      layout: unknown
    }
    const accepted = 'layout' in probe && probe.layout instanceof StructTypeNode
    expect(accepted).toBe(true)
  })

  it('atmosphere の webgpu を実際に読み込める', async () => {
    // **形だけ見ても足りない。**0.185 で踏んだときは `?gpu=2` を立てるまで
    // 気づかなかった。atmosphere の build は先頭で `.layout.name` を
    // トップレベル評価するので、読み込めるかどうかが最も直接的な見張りになる
    const atmosphere = await import('@takram/three-atmosphere/webgpu')
    expect(Object.keys(atmosphere).length).toBeGreaterThan(0)
    expect(atmosphere).toHaveProperty('AtmosphereContext')
  })

  it('検査そのものが働くことを、パッチ前の Proxy を模した形で確かめる', () => {
    // 0.185〜0.186 の素の `nodeProxyConstructor` と同じく get / set だけを持つ
    const inner = { name: 'CompatProbe' }
    const proxied = new Proxy(() => undefined, {
      get: (_target, prop) => Reflect.get(inner, prop),
    })
    expect('layout' in proxied).toBe(false)
    expect((proxied as unknown as { layout: unknown }).layout).toBeUndefined()
  })
})
