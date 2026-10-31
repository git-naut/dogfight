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

/**
 * 解決の返り値を 1 回ずつ台本どおりに返すレンダラ。台本は描画（`'render'`）の解決の分で、
 * コンピュート（`'compute'`）の解決は `compute` を返す（既定は記録の無い場面の `undefined`）
 */
function scripted(
  queue: Deferred[],
  compute: () => Promise<number | undefined> = () => Promise.resolve(undefined),
): { renderer: Renderer; readonly calls: number } {
  let calls = 0
  const renderer = {
    resolveTimestampsAsync(type?: string): Promise<number | undefined> {
      if (type === 'compute') return compute()
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

  it('コンピュートの時刻も合計と内訳に入る（段 S3）', async () => {
    // FFT の海の計算は three のコンピュートの記録に入る。描画だけを解決していたので、
    // 実機の計測に 1 本も入らなかった
    const d = deferred()
    const fake = scripted([d], () => Promise.resolve(0.75))
    const render = new Map<string, number>()
    const compute = new Map<string, number>()
    ;(fake.renderer as unknown as { backend: unknown }).backend = {
      timestampQueryPool: { render: { timestamps: render }, compute: { timestamps: compute } },
    }
    const timer = createNodeTimer(fake.renderer, (uid) =>
      uid.startsWith('c:') ? { scene: 'Ocean [ Evolve ]', target: '' } : { scene: 'Scene', target: 'output' },
    )
    timer.begin(1)
    timer.end()
    render.set('r:1:3:f7', 2)
    compute.set('c:1:5:f7', 0.75)
    d.settle(2)
    await flush()

    const [sample] = timer.collect()
    expect(sample!.ms).toBe(2.75)
    expect(sample!.passes!.totalMs).toBe(2.75)
    expect(sample!.passes!.passes.map((p) => p.group).sort()).toEqual(['場面', '海'])
  })

  it('描画とコンピュートの最後のフレームが違う回は測らない（段 S4b）', async () => {
    // 起動直後、コンピュートの記録には海の初期化のフレームしか無い。three はそれぞれの最後の
    // フレームの合計を返すので、足した値はどのフレームの値でもない
    const d = deferred()
    const fake = scripted([d], () => Promise.resolve(6))
    ;(fake.renderer as unknown as { backend: unknown }).backend = {
      timestampQueryPool: {
        render: { timestamps: new Map([['r:1:3:f142', 2]]), frames: [3, 142] },
        compute: { timestamps: new Map([['c:1:5:f64', 6]]), frames: [64] },
      },
    }
    const timer = createNodeTimer(fake.renderer, () => ({ scene: 'Scene', target: 'output' }))
    timer.begin(1)
    timer.end()
    d.settle(2)
    await flush()
    expect(timer.collect()).toEqual([])
    expect(timer.dropped).toBe(1)
  })

  it('コンピュートの古いフレームが後ろに並んでも、内訳は最新のフレーム（段 S4b の実測の形）', async () => {
    // 実機（SwiftShader）の記録: 描画 [3, 142, 189, 191]、コンピュート [64, 191]。
    // 内訳を並び順で選ぶと初期化のフレーム 64 になり、合計（フレーム 191）と食い違った
    const d = deferred()
    const fake = scripted([d], () => Promise.resolve(1))
    const render = new Map([['r:1:3:f142', 4], ['r:2:3:f191', 3]])
    const compute = new Map([['c:1:5:f64', 9], ['c:2:5:f191', 1]])
    ;(fake.renderer as unknown as { backend: unknown }).backend = {
      timestampQueryPool: {
        render: { timestamps: render, frames: [142, 191] },
        compute: { timestamps: compute, frames: [64, 191] },
      },
    }
    const timer = createNodeTimer(fake.renderer, () => ({ scene: 'Scene', target: 'output' }))
    timer.begin(1)
    timer.end()
    d.settle(3)
    await flush()
    const [sample] = timer.collect()
    expect(sample!.ms).toBe(4)
    expect(sample!.passes!.frame).toBe(191)
    expect(sample!.passes!.totalMs).toBe(4)
  })

  it('内訳を同じ解決の Map から読み、名札を付ける（段 S0a）', async () => {
    // **次の解決で Map は消される。**決着したその場で読まないと、別の回の
    // 内訳が合計に付く
    const d = deferred()
    const fake = scripted([d])
    const timestamps = new Map<string, number>()
    ;(fake.renderer as unknown as { backend: unknown }).backend = {
      timestampQueryPool: { render: { timestamps } },
    }
    const timer = createNodeTimer(fake.renderer, (uid) =>
      uid === 'r:1:3:f7' ? { scene: 'Scene', target: 'output' } : undefined,
    )
    timer.begin(1)
    timer.end()
    timestamps.set('r:1:3:f7', 2)
    timestamps.set('r:2:4:f7', 0.5)
    d.settle(2.5)
    await flush()

    const [sample] = timer.collect()
    expect(sample!.ms).toBe(2.5)
    expect(sample!.passes!.totalMs).toBe(2.5)
    expect(sample!.passes!.passes.map((p) => p.group)).toEqual(['場面', '不明'])
    expect(sample!.passes!.unlabeled).toBe(1)
    // 解決に 1 フレームしか入っていなければ、全フレームの列も 1 つ
    expect(sample!.frames!.map((f) => f.frame)).toEqual([7])
  })

  it('名札の口を渡さなければ内訳を作らない', async () => {
    const d = deferred()
    const fake = scripted([d])
    ;(fake.renderer as unknown as { backend: unknown }).backend = {
      timestampQueryPool: { render: { timestamps: new Map([['r:1:3:f7', 2]]) } },
    }
    const timer = createNodeTimer(fake.renderer)
    timer.begin(1)
    timer.end()
    d.settle(2)
    await flush()
    expect(timer.collect()).toEqual([{ id: 1, ms: 2 }])
  })

  it('解決の口が無いレンダラでは測らない', () => {
    const timer = createNodeTimer({} as unknown as Renderer)
    expect(timer.supported).toBe(false)
    expect(timer.dropped).toBe(0)
  })
})
