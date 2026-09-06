import { describe, expect, it } from 'vitest'
import type { Renderer } from 'three/webgpu'
import { createNodeTimer } from '@render/pipeline/nodeTimer'

/**
 * node 経路の GPU タイマー。
 *
 * **three の解決は器が 1 つしかない。**走っている最中にもう一度呼ぶと、
 * 解決を走らせずに前の値を返す（WebGL は `lastValue`、WebGPU は走っている
 * promise そのもの）。`lastValue` の初期値は 0 なので、重ねた回は 0 か
 * 「別の回の値」になる。代表値を最小値で取ると 0 がそのまま出る。
 *
 * 実際に踏んだ。E2E を 1 本だけ回すと 8 枚とも解決が間に合って通り、
 * 265 本を並列で回すと解決が枚をまたいで `gpuFrameMs` が 0 になった。
 * 競合に依存するので E2E では再現を固定できない。**ここで固定する。**
 */

interface Deferred {
  promise: Promise<number | undefined>
  settle: (value: number | undefined) => void
  fail: () => void
}

function deferred(): Deferred {
  let settle!: (value: number | undefined) => void
  let fail!: () => void
  const promise = new Promise<number | undefined>((resolve, reject) => {
    settle = resolve
    fail = () => {
      reject(new Error('解決に失敗'))
    }
  })
  return { promise, settle, fail }
}

/** 解決の返り値を 1 回ずつ台本どおりに返すレンダラ */
function scripted(queue: Deferred[]): { renderer: Renderer; readonly calls: number } {
  let calls = 0
  const renderer = {
    resolveTimestampsAsync(): Promise<number | undefined> {
      const item = queue[calls++]
      if (item === undefined) throw new Error(`台本より多く呼ばれた（${calls} 回目）`)
      return item.promise
    },
  }
  return {
    renderer: renderer as unknown as Renderer,
    get calls() {
      return calls
    },
  }
}

/** then と finally が走り切るまで待つ */
async function flush(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0))
}

describe('node 経路の GPU タイマー', () => {
  it('解決した ms を札つきで拾う', async () => {
    const d = deferred()
    const fake = scripted([d])
    const timer = createNodeTimer(fake.renderer)

    expect(timer.supported).toBe(true)
    timer.begin(3)
    timer.end()
    expect(timer.inflight).toBe(1)

    d.settle(2.5)
    await flush()

    expect(timer.inflight).toBe(0)
    expect(timer.collect()).toEqual([{ id: 3, ms: 2.5 }])
    expect(timer.dropped).toBe(0)
  })

  it('0 は測れていないので捨てる', async () => {
    const d = deferred()
    const timer = createNodeTimer(scripted([d]).renderer)

    timer.begin(0)
    timer.end()
    d.settle(0)
    await flush()

    // **ここが本体。**0 を混ぜると `Math.min` がそのまま 0 になる
    expect(timer.collect()).toEqual([])
    expect(timer.dropped).toBe(1)
  })

  it('undefined も捨てる。`timestamp-query` が無い機械では毎回これになる', async () => {
    const d = deferred()
    const timer = createNodeTimer(scripted([d]).renderer)

    timer.begin(0)
    timer.end()
    d.settle(undefined)
    await flush()

    expect(timer.collect()).toEqual([])
    expect(timer.dropped).toBe(1)
  })

  it('拒否された回も捨てて、待ちを残さない', async () => {
    const d = deferred()
    const timer = createNodeTimer(scripted([d]).renderer)

    timer.begin(0)
    timer.end()
    d.fail()
    await flush()

    expect(timer.collect()).toEqual([])
    expect(timer.dropped).toBe(1)
    expect(timer.inflight).toBe(0)
  })

  it('決着する前に重ねても投げ直さない。札と中身がずれないこと', async () => {
    const first = deferred()
    const second = deferred()
    const fake = scripted([first, second])
    const timer = createNodeTimer(fake.renderer)

    timer.begin(0)
    timer.end()
    expect(fake.calls).toBe(1)

    // 決着前の 2 枚目。ここで投げると three は前の値を返す
    timer.begin(1)
    timer.end()
    expect(fake.calls).toBe(1)
    expect(timer.dropped).toBe(1)

    first.settle(4)
    await flush()
    // **札 1 の値は作らない。**作れば 4 ms が 2 枚目の値として残る
    expect(timer.collect()).toEqual([{ id: 0, ms: 4 }])

    // 決着したので次は投げる
    timer.begin(2)
    timer.end()
    expect(fake.calls).toBe(2)
    second.settle(5)
    await flush()
    expect(timer.collect()).toEqual([{ id: 2, ms: 5 }])
  })

  it('`begin` していない `end` は何も投げない', () => {
    const fake = scripted([])
    const timer = createNodeTimer(fake.renderer)

    timer.end()
    expect(fake.calls).toBe(0)
    expect(timer.dropped).toBe(0)
  })

  it('解決の口が無いレンダラでは測らない', () => {
    const timer = createNodeTimer({} as unknown as Renderer)
    expect(timer.supported).toBe(false)
    expect(timer.dropped).toBe(0)
  })
})
