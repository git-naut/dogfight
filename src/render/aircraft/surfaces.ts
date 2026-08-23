import * as THREE from 'three'
import type { AircraftHinge, SurfaceChannel } from './model'

/**
 * 舵面をヒンジまわりに回す。
 *
 * ノードの原点は変換ツールがヒンジの位置へ移してある（`tools/ac3d-to-glb.mjs`）。
 * だから回転を代入するだけで舵が切れる。ヒンジの軸・舵角・指令の種類・符号は
 * FlightGear の定義から写した値で、glb の extras 経由で届く。
 *
 * 舵の向きは実機の約束に合わせる。機首上げでエレベータは後縁が上がる。
 * 右ロールで右のエルロンが上がり左が下がる。右ラダーで後縁が右へ振れる。
 *
 * **ここに機体別の表を持たない。**以前は node 名から指令と符号を引く表を
 * 置いていたが、F-16 を足したときに成立しなくなった。舵面の名前も枚数も
 * 符号も機体で違う（F-16 のラダーは 1 枚、水平尾翼は左右で符号が逆）。
 * 機体の性質は機体の定義が持つ。
 */

/** 1 枚の舵面。回す軸と、指令から角度への写し方を持つ */
interface Surface {
  node: THREE.Object3D
  axis: THREE.Vector3
  /** 指令 −1..1 に掛ける角度 rad。符号がそのまま舵の向きになる */
  scale: number
  /** どの指令を読むか */
  channel: SurfaceChannel
}

export interface ControlSurfaces {
  /** 舵面の位置 −1..1 を渡す。sim の AircraftSample の値をそのまま */
  update(elevator: number, aileron: number, rudder: number): void
  /** 動かせた舵面の枚数。読み込みの確認に使う */
  readonly count: number
}

const DEG = Math.PI / 180

export function createControlSurfaces(
  nodes: ReadonlyMap<string, THREE.Object3D>,
  hinges: readonly AircraftHinge[],
): ControlSurfaces {
  const surfaces: Surface[] = []

  for (const hinge of hinges) {
    const node = nodes.get(hinge.node)
    if (node === undefined) continue

    surfaces.push({
      node,
      axis: new THREE.Vector3(...hinge.axis).normalize(),
      scale: hinge.maxDeg * DEG * hinge.sign,
      channel: hinge.channel,
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
