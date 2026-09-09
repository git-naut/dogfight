import { describe, expect, it } from 'vitest'
import type { Renderer } from 'three/webgpu'
import { advanceNodeFrame } from '@render/pipeline/nodeBuild'

/**
 * ノードのフレーム番号を進める部分。
 *
 * **手で `render()` を回すと `FRAME` 型の更新が 1 度しか走らない。**
 * `NodeFrame` が `frameId` で重複を潰すので、番号が進まないと場面の
 * `PassNode` も雲のパスも 2 枚目以降は飛ぶ。**絵は出る**（レンダー
 * ターゲットに前の中身が残る）ので、絵を見ても気づけない。実測で
 * 1 枚目が 167 描画呼び出し・458,486 三角形、2 枚目以降が 2 呼び出し・
 * 3 三角形だった。
 *
 * **`nodeFrame.update()` を呼んではいけない。**あれは `performance.now()`
 * から `deltaTime` と `time` を進めるので、実時間が描画へ入る。この repo は
 * `CLAUDE.md` の決定論の規則でそれを禁じている。ここで固定するのは
 * 「番号は進む」と「実時間の口は触らない」の 2 つ。
 */
interface FakeNodeFrame {
  frameId: number
  updates: number
  deltaTime: number
  time: number
}

function scripted(): { renderer: Renderer; frame: FakeNodeFrame } {
  const frame: FakeNodeFrame = { frameId: 0, updates: 0, deltaTime: 0, time: 0 }
  const nodeFrame = {
    get frameId() {
      return frame.frameId
    },
    set frameId(value: number) {
      frame.frameId = value
    },
    update() {
      frame.updates++
      frame.deltaTime = 0.016
      frame.time += 0.016
    },
  }
  const renderer = { _nodes: { nodeFrame } }
  return { renderer: renderer as unknown as Renderer, frame }
}

describe('ノードのフレーム番号', () => {
  it('1 回で 1 つ進む', () => {
    const { renderer, frame } = scripted()
    advanceNodeFrame(renderer)
    expect(frame.frameId).toBe(1)
    advanceNodeFrame(renderer)
    expect(frame.frameId).toBe(2)
  })

  it('進めた回数だけ増える', () => {
    const { renderer, frame } = scripted()
    for (let i = 0; i < 8; i++) advanceNodeFrame(renderer)
    // 8 枚描いたら 8 つ進む。飛ばすと `FRAME` の更新が重複と見なされる
    expect(frame.frameId).toBe(8)
  })

  it('実時間の口を触らない', () => {
    // **`nodeFrame.update()` は `performance.now()` を読む。**呼ぶと
    // 実時間が描画へ入り、同じフレーム数でも実行ごとに絵が変わりうる
    const { renderer, frame } = scripted()
    for (let i = 0; i < 4; i++) advanceNodeFrame(renderer)
    expect(frame.updates, '`update()` が呼ばれている').toBe(0)
    expect(frame.deltaTime).toBe(0)
    expect(frame.time).toBe(0)
  })
})
