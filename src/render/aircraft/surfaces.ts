import * as THREE from 'three'
import type { AircraftHinge } from './model'

/**
 * 舵面をヒンジまわりに回す。
 *
 * ノードの原点は変換ツールがヒンジの位置へ移してある（`tools/ac3d-to-glb.mjs`）。
 * だから回転を代入するだけで舵が切れる。ヒンジの軸と舵角は FlightGear の
 * `f18.xml` の値で、glb の extras 経由で届く。
 *
 * 舵の向きは実機の約束に合わせる。機首上げでエレベータは後縁が上がる。
 * 右ロールで右のエルロンが上がり左が下がる。右ラダーで後縁が右へ振れる。
 */

/** 1 枚の舵面。回す軸と、指令から角度への写し方を持つ */
interface Surface {
  node: THREE.Object3D
  axis: THREE.Vector3
  /** 指令 −1..1 に掛ける角度 rad。符号がそのまま舵の向きになる */
  scale: number
  /** どの指令を読むか */
  channel: 'elevator' | 'aileron' | 'rudder'
}

export interface ControlSurfaces {
  /** 舵面の位置 −1..1 を渡す。sim の AircraftSample の値をそのまま */
  update(elevator: number, aileron: number, rudder: number): void
  /** 動かせた舵面の枚数。読み込みの確認に使う */
  readonly count: number
}

/**
 * 指令から舵面への割り当て。
 *
 * 左右で符号を反転させてはいけない。ヒンジの軸そのものが左右で逆を向いて
 * いる（左エルロンは −X、右エルロンは +X）ので、同じ符号を与えれば回転は
 * 自動的に逆になる。符号も反転させると二重に反転して、左右のエルロンが
 * 揃って上がる。最初にそう書いていて、後縁の点がどちらへ動くかを手で
 * 計算して気づいた。tests/render/aircraftSurfaces.test.ts がその計算を
 * テストにしてある。
 *
 * 符号の決め方は次のとおり。
 *
 * エルロンは −1。左ロール（指令が負）で左のエルロンが上がり、右が下がる。
 * 上がった側の翼は揚力が減って下がるので、これで左へ倒れる。
 *
 * エレベータは −1。機首上げ（指令が正）で後縁が上がる。水平尾翼が下向きの
 * 力を出して機首を持ち上げる。
 *
 * ラダーは +1。右ヨー（指令が正）で後縁が右へ振れる。
 */
const ASSIGNMENT: Record<string, { channel: Surface['channel']; sign: number }> = {
  ElevatorLeft: { channel: 'elevator', sign: -1 },
  ElevatorRight: { channel: 'elevator', sign: -1 },
  AileronLeft: { channel: 'aileron', sign: -1 },
  AileronRight: { channel: 'aileron', sign: -1 },
  RudderLeft: { channel: 'rudder', sign: 1 },
  RudderRight: { channel: 'rudder', sign: 1 },
}

const DEG = Math.PI / 180

export function createControlSurfaces(
  nodes: ReadonlyMap<string, THREE.Object3D>,
  hinges: readonly AircraftHinge[],
): ControlSurfaces {
  const surfaces: Surface[] = []

  for (const hinge of hinges) {
    const node = nodes.get(hinge.node)
    const assignment = ASSIGNMENT[hinge.node]
    if (node === undefined || assignment === undefined) continue

    surfaces.push({
      node,
      axis: new THREE.Vector3(...hinge.axis).normalize(),
      scale: hinge.maxDeg * DEG * assignment.sign,
      channel: assignment.channel,
    })
  }

  // 使い回す。毎フレーム作るとゴミが増える
  const quaternion = new THREE.Quaternion()

  return {
    count: surfaces.length,

    update(elevator, aileron, rudder) {
      const commands = { elevator, aileron, rudder }
      for (const surface of surfaces) {
        const command = Math.min(1, Math.max(-1, commands[surface.channel]))
        quaternion.setFromAxisAngle(surface.axis, command * surface.scale)
        surface.node.quaternion.copy(quaternion)
      }
    },
  }
}
