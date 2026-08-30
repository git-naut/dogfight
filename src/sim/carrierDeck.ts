import { Vec3 } from './vec3'
import type { LaunchSpec } from './launch'

/**
 * 空母の甲板の座標。
 *
 * **原本（`assets/upstream/nimitz/nimitz.ac`）から読んだ値を写してある。**
 * 生成物ではなく手で写した定数だが、`tests/tools/ac3d.test.ts` が原本の
 * 側を読んで突き合わせるので、片方だけ動くと落ちる。
 *
 * `cat-1`〜`cat-4` は三角形を持たない線分で、FlightGear が射出の始点と
 * 終点として読む。`nimitz.xml` は `interaction-type` を割り当てるだけで
 * 向きを持たないので、艦首が −X であること（`Stern` が X 214.2..217.1 に
 * ある）から +X 側を開始点とした。
 *
 * 座標は原本の `.ac` のまま（艦首 −X、上 +Y、左 +Z）。当方の座標へ移すのは
 * `catapultLaunch` が行う。
 */

/** カタパルトの帯。原本の 2 点 */
export interface CatapultLine {
  /** +X 側。射出の開始 */
  readonly start: readonly [number, number, number]
  /** −X 側。艦首方向 */
  readonly end: readonly [number, number, number]
}

/**
 * 4 基のカタパルト。
 *
 * `cat-1` と `cat-2` が艦首、`cat-3` と `cat-4` が斜め甲板側。
 * 帯の長さは 115〜117 m で、実際の行程（C-13 の公表値 94 m）より長い。
 * 余裕を含むため。
 */
export const CATAPULTS: Readonly<Record<string, CatapultLine>> = {
  'cat-1': { start: [9.28, 20.0, -16.17], end: [-105.41, 20.0, -8.16] },
  'cat-2': { start: [16.89, 20.0, 4.26], end: [-100.38, 20.0, 6.4] },
  'cat-3': { start: [106.55, 20.0, 19.28], end: [-8.48, 20.0, 27.37] },
  'cat-4': { start: [124.65, 20.0, 29.64], end: [7.99, 20.0, 29.62] },
}

/**
 * 原本の `.ac` 座標を当方の座標へ移す。
 *
 * `.ac` は 艦首 −X、上 +Y、左 +Z。当方は 艦首 −Z、上 +Y、右 +X。
 * `tools/ac3d.mjs` の `toWorld` と同じ変換。**モデルと同じ式でないと
 * カタパルトの帯と射出の軌跡がずれる。**
 */
export function deckToWorld(p: readonly [number, number, number]): Vec3 {
  return new Vec3(-p[2], p[1], p[0])
}

/**
 * 空母の配置とカタパルトの名前から射出の諸元を作る。
 *
 * `heading` は艦首の向き rad。0 で −Z（当方の機首方向）。
 *
 * 射出の開始位置は**帯の後端ではない。**終点から行程ぶん手前に取る。
 * C-13 の公表値（終端速度 150 kt、行程 94 m）を 2 つとも守ると加速度が
 * 公表値どおりになり、しかも帯の内側に収まる（`launch.ts`）。
 */
export function catapultLaunch(
  carrier: { readonly x: number; readonly z: number; readonly heading: number },
  name: keyof typeof CATAPULTS | string,
  distance: number,
): LaunchSpec {
  const line = CATAPULTS[name]
  if (line === undefined) {
    throw new Error(`知らないカタパルト ${name}。あるのは ${Object.keys(CATAPULTS).join(', ')}`)
  }

  const from = deckToWorld(line.start)
  const to = deckToWorld(line.end)

  // 射出の向き（船の座標系）
  const dx = to.x - from.x
  const dz = to.z - from.z
  const length = Math.hypot(dx, dz)
  const ux = dx / length
  const uz = dz / length

  // 終点から行程ぶん手前が開始位置
  const startX = to.x - ux * distance
  const startZ = to.z - uz * distance

  // 船の向きで回してから位置を足す
  const cos = Math.cos(carrier.heading)
  const sin = Math.sin(carrier.heading)
  const rotate = (x: number, z: number): [number, number] => [
    x * cos + z * sin,
    -x * sin + z * cos,
  ]
  const [px, pz] = rotate(startX, startZ)
  const [dxw, dzw] = rotate(ux, uz)

  return {
    from: new Vec3(carrier.x + px, from.y, carrier.z + pz),
    direction: new Vec3(dxw, 0, dzw),
  }
}
