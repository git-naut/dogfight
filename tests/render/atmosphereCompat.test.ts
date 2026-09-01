import { describe, it, expect } from 'vitest'
import { struct } from 'three/tsl'

/**
 * takram が前提にしている three の形を縛る。
 *
 * `@takram/three-atmosphere@0.19.1`（2026-09-01 時点の最新）は
 * `struct()` の戻り値に `.layout` があることを前提に書かれている。
 * atmosphere 側に 5 件、geospatial 側に 3 件。`geospatial` の
 * 判定は `'layout' in s && s.layout instanceof StructTypeNode` という形で、
 * **プロパティの存在そのものを見る。**
 *
 * three は 0.185.0 でここを変えた。0.184 までは
 * `struct.layout = structLayout; return struct` だったものが、0.185 で
 * `return nodeProxyConstructor(struct, structType)` になった。Proxy は
 * `get` と `set` しかトラップしないので、`'layout' in s` が false になる。
 *
 * **npm では気づけない。**takram の peer は `three: '>=0.170.0'` で上限が
 * 無い。段 10 で `?gpu=2` を立てたとき、モジュール評価の時点で
 * `Cannot read properties of undefined (reading 'name')` で落ちて分かった。
 *
 * この検査は 18 秒の単体テストで回る。three を上げた瞬間にここが落ちる。
 */
describe('takram と three の噛み合わせ', () => {
  it('struct() の戻り値が layout を持つ', () => {
    const probe = struct({ value: 'float' }, 'CompatProbe')
    expect('layout' in probe, 'three 0.185 以降は Proxy になり in が false になる').toBe(
      true,
    )
  })

  it('layout.name が構造体の名前を返す', () => {
    // takram は入れ子の構造体の型名をここから取る
    const probe = struct({ value: 'float' }, 'CompatProbe')
    const layout = (probe as unknown as { layout: { name: string } }).layout
    expect(layout.name).toBe('CompatProbe')
  })

  it('検査そのものが働くことを、Proxy を模した形で確かめる', () => {
    // 0.185 の `nodeProxyConstructor` と同じく get / set だけを持つ Proxy
    const inner = { name: 'CompatProbe' }
    const proxied = new Proxy(() => undefined, {
      get: (_target, prop) => Reflect.get(inner, prop),
    })
    expect('layout' in proxied).toBe(false)
  })
})
