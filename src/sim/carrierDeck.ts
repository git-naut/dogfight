import { Vec3 } from './vec3'
import type { LaunchSpec } from './launch'
import { FORD_CATAPULTS, FORD_DECK_HEIGHT } from './fordDeck'

/**
 * 空母の甲板と射出。
 *
 * 空母は Gerald R. Ford（Phase 9 の段 4 で Nimitz から替えた。ADR 0017）。甲板の値は
 * `fordDeck.ts` が持ち、原本のテクスチャの標識から測ったもの。座標は空母の座標
 * （艦首 −Z、右舷 +X、上 +Y、水面 Y 0）で、モデルの glb と同じ。
 *
 * **カタパルトの帯は艦の軸と平行ではない**（cat-1 4.03 度、cat-2 2.21 度、cat-3 4.37 度、
 * cat-4 0.04 度）。機体は帯に沿って走る。ミッションの台本は軸と平行な cat-4 を使う
 * （ユーザーの判断、2026-10-06）。
 */

/** カタパルトの名前 */
export type CatapultName = keyof typeof FORD_CATAPULTS

/** 4 基のカタパルト。start が艦尾側（射出の始点）、end が艦首側。(x, z) m */
export const CATAPULTS = FORD_CATAPULTS

/** 飛行甲板の高さ m（水面から） */
export const DECK_HEIGHT = FORD_DECK_HEIGHT

/**
 * 空母の配置とカタパルトの名前から射出の諸元を作る。
 *
 * `heading` は艦首の向き rad。0 で −Z（当方の機首方向）、右回りが正
 * （`headingOf` と同じ。描画の `placeCarrier` も同じ約束）。
 *
 * 射出の開始位置は**帯の後端ではない。**終点から行程ぶん手前に取る。
 * EMALS の行程（91.44 m）は帯（103.5〜108.6 m）より短いので、帯の内側に収まる（`launch.ts`）。
 */
export function catapultLaunch(
  carrier: { readonly x: number; readonly z: number; readonly heading: number },
  name: CatapultName | string,
  distance: number,
): LaunchSpec {
  const line = (CATAPULTS as Readonly<Record<string, (typeof CATAPULTS)[CatapultName]>>)[name]
  if (line === undefined) {
    throw new Error(`知らないカタパルト ${name}。あるのは ${Object.keys(CATAPULTS).join(', ')}`)
  }

  const [fromX, fromZ] = line.start
  const [toX, toZ] = line.end

  // 射出の向き（船の座標系）
  const dx = toX - fromX
  const dz = toZ - fromZ
  const length = Math.hypot(dx, dz)
  const ux = dx / length
  const uz = dz / length

  // 終点から行程ぶん手前が開始位置
  const startX = toX - ux * distance
  const startZ = toZ - uz * distance

  // 船の向きで回してから位置を足す。右回りが正なので、前 (0, −1) は (sin h, −cos h) へ写る。
  // **Phase 9 の段 1 までは逆向き**（three の Ry と同じ左回り）で、レーダーと食い違っていた
  const cos = Math.cos(carrier.heading)
  const sin = Math.sin(carrier.heading)
  const rotate = (x: number, z: number): [number, number] => [
    x * cos - z * sin,
    x * sin + z * cos,
  ]
  const [px, pz] = rotate(startX, startZ)
  const [dxw, dzw] = rotate(ux, uz)

  return {
    from: new Vec3(carrier.x + px, DECK_HEIGHT, carrier.z + pz),
    direction: new Vec3(dxw, 0, dzw),
  }
}
