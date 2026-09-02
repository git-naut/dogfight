import { lightStepGrowth, stepGrowthScale } from './geometry'

/**
 * 雲のマーチを GLSL 版と TSL 版で突き合わせるための固定入力。
 *
 * **ここが唯一の定義。**両方の経路がこの値を読む。段 12 の雲影は GLSL 側が
 * 実際に焼いた入力を URL で渡す形にしたが、マーチはカメラ行列だけで 32 個の
 * 数になる。固定のカメラを両側で組み立てるほうが、写しも符号化も要らない。
 *
 * **three にも DOM にも依存しない。**行列は `THREE.PerspectiveCamera` を
 * 両側で同じ引数から作って導く。`three` と `three/webgpu` はコアクラスを
 * 共有しているので、同じ入力からは同じ行列が出る（段 9 で確かめた）。
 *
 * 遮蔽物は置かない。深度は 1.0（空）を渡すので、地形も海面も機体も
 * 場面の組み立ての差を持ち込まない。マーチそのものだけを比べる。
 */

/** 焼く大きさ。SwiftShader で回るところまで小さくする */
export const MARCH_PROBE_WIDTH = 128
export const MARCH_PROBE_HEIGHT = 72

/**
 * カメラ。雲層（1,200〜4,500 m）の内側からほぼ水平に見る。
 *
 * **枝を通すために内側に置く。**最初は雲底の下から見上げる構図にしたが、
 * 区画平均 16 個のうち 14 個が 0.000 で、歩数を使い切った画素も 0 だった。
 * 通っていない枝の移植は検査されない。内側なら区間が上限距離まで伸び、
 * 空振りの大股送りと戻し、光マーチ、打ち切りの全部を通る
 */
export const MARCH_PROBE_CAMERA = {
  positionX: 0,
  positionY: 2000,
  positionZ: 0,
  targetX: 0,
  targetY: 2150,
  targetZ: -5000,
  fov: 60,
  near: 1,
  far: 30_000,
} as const

/**
 * 太陽の向き。長さ 1 に近い値を直に置く。
 *
 * **正規化しない。**本番も JS 側で正規化したものを uniform で渡すので、
 * ここも数を直に置けば両側で同じ値になる
 */
export const MARCH_PROBE_SUN = { x: 0.6, y: 0.8, z: 0 } as const

/** 太陽光と天空光。実測（9 時）に近い値を置く。絵の比較にだけ効く */
export const MARCH_PROBE_SUN_COLOR = { x: 1.79, y: 1.45, z: 1.25 } as const
export const MARCH_PROBE_AMBIENT = { x: 0.28, y: 0.34, z: 0.42 } as const

/**
 * 雲量。**本番の既定（0.29）より上げる。**
 *
 * 0.29 は分布の裾に載っていて、視野に入る雲がまばらになる。検査は雲の中を
 * 歩く枝を通したいので、広く湧く値を選ぶ
 */
export const MARCH_PROBE_COVERAGE = 0.6
/** 雲の流れる時刻。フレーム 0 相当 */
export const MARCH_PROBE_CLOUD_TIME = 0

/**
 * ずらし。
 *
 * 開始位置は 0.5 を置いて Bayer のディザが効いていることを見えるようにする。
 * 画素内のずらしは 0。**ここが 0 でないと、両側で同じ画素を比べられているか
 * が分かりにくくなる**
 */
export const MARCH_PROBE_START_JITTER = 0.5
export const MARCH_PROBE_PIXEL_JITTER = { x: 0, y: 0 } as const

/**
 * 主マーチの歩数。**本番のプリセットの値ではなく、枝を両方通す値を選ぶ。**
 *
 * 実測（雲量 0.6、雲層の内側から水平）で、歩数を使い切った画素の数はこう動く。
 *
 * | 歩数 | 打ち切った画素 / 9,216 | 総サンプル |
 * |---|---|---|
 * | 96 | 0 | 933,244 |
 * | 64 | **150** | 850,720 |
 * | 48 | 8,758 | 474,390 |
 *
 * 96 では透過率が先に下限へ落ちて打ち切りの枝を 1 度も通らない。48 では
 * 逆に 95% が打ち切りになり、透過率で抜ける枝が薄くなる。64 が両方を通る
 */
export const MARCH_PROBE_MAX_STEPS = 64
export const MARCH_PROBE_LIGHT_STEPS = 6
export const MARCH_PROBE_MAX_DISTANCE = 26_000
export const MARCH_PROBE_USE_DETAIL = true

/** 光マーチの伸び率。段数から解く */
export const MARCH_PROBE_LIGHT_GROWTH = lightStepGrowth(MARCH_PROBE_LIGHT_STEPS)
/** 主マーチの伸び率の尺度。歩数と上限距離から解く */
export const MARCH_PROBE_STEP_GROWTH = stepGrowthScale(
  MARCH_PROBE_MAX_STEPS,
  MARCH_PROBE_MAX_DISTANCE,
)

/** 画面の縦横比。カメラの投影行列に効く */
export const MARCH_PROBE_ASPECT = MARCH_PROBE_WIDTH / MARCH_PROBE_HEIGHT

/**
 * 密度サンプル数の統計。
 *
 * `probeMode = 1` の絵は R と G に 16bit 整数を詰めてある。**整数なので、
 * 歩き方が同じなら GLSL 版と TSL 版で完全に一致するはず。**ここが移植で
 * 一番壊れやすいループと分岐を直に見張る
 */
export interface MarchSampleStats {
  /** 総和。整数 */
  total: number
  /** 1 画素あたりの最大 */
  max: number
  /** 0 でない画素の数。雲に当たった視線の本数 */
  hit: number
}

/** `probeMode = 1` の生バイトから統計を出す。両側が同じこの関数を通る */
export function marchSampleStats(bytes: ArrayLike<number>): MarchSampleStats {
  const count = Math.floor(bytes.length / 4)
  let total = 0
  let max = 0
  let hit = 0
  for (let i = 0; i < count; i++) {
    const c = bytes[i * 4]! * 256 + bytes[i * 4 + 1]!
    total += c
    if (c > max) max = c
    if (c > 0) hit++
  }
  return { total, max, hit }
}

/**
 * `probeMode = 2` の生バイトから、歩数を使い切った画素の数を数える。
 *
 * G チャンネルに 1 が入る。整数なので両側で完全に一致するはず
 */
export function marchExhaustedCount(bytes: ArrayLike<number>): number {
  const count = Math.floor(bytes.length / 4)
  let exhausted = 0
  for (let i = 0; i < count; i++) if (bytes[i * 4 + 1]! > 0) exhausted++
  return exhausted
}
