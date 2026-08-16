import { FIXED_DT } from './loop'
import { Rng } from './rng'
import { Quat } from './quat'
import { Vec3 } from './vec3'
import { Aircraft, type AircraftSample, type StepOptions } from './aircraft'
import { ReplayPlayer, spawnFromSpec, type ReplayScript } from './replay'
import type { InputState } from './input'

export type { InputState } from './input'
export { neutralInput, makeInput } from './input'

export interface WorldOptions {
  /** 乱数シード。同じシードと同じ入力からは常に同じ結果が出る。 */
  seed: number
  /** 自機の初期状態。省略すると高度 1500 m を 250 m/s で水平飛行 */
  aircraft?: {
    position?: Vec3
    velocity?: Vec3
    orientation?: Quat
    throttle?: number
  }
  step?: StepOptions
}

/** 既定の初期条件。高度 1500 m、真北（-Z）へ 250 m/s。 */
export const DEFAULT_SPAWN = {
  altitude: 1500,
  speed: 250,
} as const

/**
 * シミュレーション世界。
 *
 * Phase 1 の時点では自機 1 機のみ。敵機とミサイルは後続の Phase で
 * ここにぶら下げる。
 */
export class World {
  readonly rng: Rng
  readonly seed: number
  readonly player: Aircraft

  private readonly stepOptions: StepOptions
  private _frame = 0

  constructor(options: WorldOptions) {
    this.seed = options.seed
    this.rng = new Rng(options.seed)
    this.stepOptions = options.step ?? {}

    const spawn = options.aircraft ?? {}
    this.player = new Aircraft({
      position: spawn.position ?? new Vec3(0, DEFAULT_SPAWN.altitude, 0),
      velocity: spawn.velocity ?? new Vec3(0, 0, -DEFAULT_SPAWN.speed),
      ...(spawn.orientation ? { orientation: spawn.orientation } : {}),
      ...(spawn.throttle !== undefined ? { throttle: spawn.throttle } : {}),
    })
  }

  get frame(): number {
    return this._frame
  }

  /**
   * シム内の経過秒。
   *
   * time += dt と積算せず、毎回 frame から計算し直す。浮動小数点の
   * 加算を何万回も繰り返すと誤差が蓄積して、同じフレーム数でも実行ごとに
   * 時刻がずれる。掛け算1回なら誤差は乗らない。
   */
  get time(): number {
    return this._frame * FIXED_DT
  }

  /** 1ステップ進める。呼び出しは必ず FixedStepDriver 経由にする。 */
  step(input: InputState): void {
    this.player.step(input, FIXED_DT, this.stepOptions)
    this._frame++
  }

  /** 描画用に補間した自機の状態を書き込む。 */
  samplePlayer(alpha: number, out: AircraftSample): AircraftSample {
    return this.player.sample(alpha, out)
  }
}

/** 入力スクリプトの初期条件から World を作り、再生器と組にして返す。 */
export function createWorldFromScript(script: ReplayScript): {
  world: World
  player: ReplayPlayer
} {
  const spawn = spawnFromSpec(script.spawn)
  const world = new World({
    seed: script.seed,
    aircraft: {
      position: spawn.position,
      velocity: spawn.velocity,
      orientation: spawn.orientation,
      throttle: spawn.throttle,
    },
  })
  return { world, player: new ReplayPlayer(script) }
}

/**
 * スクリプトを指定フレーム数だけ再生した World を返す。
 *
 * 実時間を使わないので、テストからもキャプチャモードからも同じ結果になる。
 */
export function runScript(script: ReplayScript, frames: number): World {
  const { world, player } = createWorldFromScript(script)
  for (let i = 0; i < frames; i++) {
    world.step(player.at(i))
  }
  return world
}
