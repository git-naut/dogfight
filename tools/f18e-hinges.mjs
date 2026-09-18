// F/A-18E のヒンジ軸を bbox から導く。
//
// **FlightGear の XML が無い。**F/A-18C は `assets/upstream/f18/f18.xml` が
// ヒンジの 2 点を持っていたが、Sketchfab のモデルには何も付いていない。
// 舵面の bbox から軸を組み立てる。
//
// ## ヒンジの置き方
//
// | 舵面 | 位置 | 軸 |
// |---|---|---|
// | エルロン | 前縁（機首寄りの辺） | 翼幅方向 |
// | スタビレータ | 翼弦の 30%（**全遊動**なので前縁ではない） | 翼幅方向 |
// | ラダー | 前縁 | 垂直方向 |
//
// スタビレータの 30% は実機のピボット位置。前縁に置くと、舵角を付けたときに
// 後縁が大きく振れて尾部を突き抜ける。
//
// **垂直尾翼は傾いているが軸は鉛直にする。**F/A-18 の垂直尾翼は外側へ約 20 度
// 傾いている。厳密には傾いた軸で回すが、舵角が最大 30 度なので見た目の差は
// 小さい。傾けると軸の定義が 2 点では済まなくなる。
import { identifyParts, SCALE } from './f18e-parts.mjs'

/**
 * 舵角の上限 deg。F/A-18C（`tools/f18-hinges.mjs`）の値を流用する。
 *
 * **E/F の NATOPS の値は取れなかった。**C 型と E/F で舵面の大きさは違うが、
 * 舵角の上限は飛行制御の設計で決まる量で、同系の機体なら大きく変わらない。
 * 実機の値が手に入ったら差し替える。
 */
export const MAX_DEG = {
  aileron: 30,
  stabilator: 24,
  rudder: 30,
}

/**
 * 舵の向き。指令に掛ける符号。
 *
 * 目標の動きは `tools/f18-hinges.mjs` と同じ。左ロール（指令が負）で左の
 * エルロンが上がって右が下がる。機首上げ（指令が正）で水平尾翼の後縁が
 * 上がる。右ヨー（指令が正）でラダーの後縁が右へ振れる。
 *
 * **符号は C 型から写せない。**C 型は FlightGear の XML がヒンジの 2 点を
 * 持っていて、その向きに合わせた値だった。こちらは bbox から軸を組むので
 * 向きが別に決まる。エルロンとスタビレータは実測でどちらも反転した
 * （エルロンは −1 で左の後縁が −0.500、スタビレータは −1 で −0.407）。
 *
 * **確かめるのは変換後の座標。**`tests/render/aircraftSurfaces.test.ts` が
 * glb の extras を読んで、左右を名指しして見張る。
 */
export const SIGN = {
  aileron: 1,
  stabilator: 1,
  rudder: 1,
}

/** スタビレータのピボットの位置。前縁から翼弦の何割か */
const STABILATOR_PIVOT = 0.3

/**
 * ヒンジの定義を作る。
 *
 * 返す座標は**モデルの元の軸**（X 前後で機首が負、Y 上下、Z 翼幅）で、
 * 単位は m。座標系の変換は `tools/f18e-to-glb.mjs` が最後に 1 回だけ掛ける。
 * **ここで回すと、回した後の値をもう 1 度回す事故が起きる。**
 */
export function buildHinges(gltfPath) {
  const { matched } = identifyParts(gltfPath)
  const hinges = []

  for (const m of matched) {
    const lo = m.part.raw.min.map((v) => v * SCALE)
    const hi = m.part.raw.max.map((v) => v * SCALE)
    const mid = (k) => (lo[k] + hi[k]) / 2

    let from
    let to
    if (m.role === 'rudder') {
      // 前縁（機首寄り）に鉛直の軸
      const x = lo[0]
      const z = mid(2)
      from = [x, lo[1], z]
      to = [x, hi[1], z]
    } else if (m.role === 'stabilator') {
      // 翼弦の 30%。全遊動なので前縁ではない
      // **スタビレータは左右同じ方向に動く**（機首上げで両方の後縁が上がる）
      // ので、軸は左右で同じ向きに揃える
      const x = lo[0] + (hi[0] - lo[0]) * STABILATOR_PIVOT
      const y = mid(1)
      from = [x, y, lo[2]]
      to = [x, y, hi[2]]
    } else {
      // エルロン。前縁に翼幅方向の軸。
      //
      // **軸の向きを左右で逆にする。**bbox の min→max で作ると両方が +Z を
      // 向き、同じ符号を与えたときに左右が同じ方向へ動く。エルロンは逆に
      // 動かないとロールしない。外側→内側の向きに揃えると、左（+Z 側）が
      // −Z・右（−Z 側）が +Z になって符号 1 つで逆向きになる
      // （`tools/f18-hinges.mjs` が F-16 について書いているのと同じ形）
      const x = lo[0]
      const y = mid(1)
      from = m.side === 'left' ? [x, y, hi[2]] : [x, y, lo[2]]
      to = m.side === 'left' ? [x, y, lo[2]] : [x, y, hi[2]]
    }

    hinges.push({
      node: m.name,
      sourceNode: m.node,
      role: m.role,
      side: m.side,
      from,
      to,
      maxDeg: MAX_DEG[m.role],
      // `SurfaceChannel` は 'elevator' | 'aileron' | 'rudder' の 3 つ。
      // 全遊動の水平尾翼はピッチの指令を読むので elevator へ寄せる
      channel: m.role === 'stabilator' ? 'elevator' : m.role,
      sign: SIGN[m.role],
    })
  }
  return hinges
}
