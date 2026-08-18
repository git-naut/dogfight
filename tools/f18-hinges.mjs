/**
 * F/A-18C の舵面のヒンジ。
 *
 * 値は FlightGear の `assets/upstream/f18/f18.xml` の rotate アニメーションから
 * そのまま写した。推測は入っていない。
 *
 * XML の座標系は 後方 +X、右 +Y、上 +Z で、`.ac` とも当方の系とも違う。
 * `.ac` の AileronLeft が Z +3.742..+5.436 にあり、XML のヒンジが
 * y1=−3.74241、y2=−5.42703 であることから `xml(x, y, z) = ac(x, −z, y)` と
 * 確定した。当方の系（機首 −Z、上 +Y、右 +X）へは次で移る。
 *
 *   our(x, y, z) = xml(y, z, x)
 *
 * この対応は tests/tools/ac3d.test.ts が、舵面の境界とヒンジの位置を
 * 突き合わせて検査する。
 */

/** XML 座標のまま持つ。変換は xmlToWorld で 1 回だけ掛ける */
export const F18_HINGES = [
  {
    node: 'AileronLeft',
    from: [2.67178, -3.74241, 0.470943],
    to: [2.67178, -5.42703, 0.470943],
    maxDeg: 30,
  },
  {
    node: 'AileronRight',
    from: [2.67178, 3.74241, 0.470943],
    to: [2.67178, 5.42703, 0.470943],
    maxDeg: 30,
  },
  {
    node: 'RudderLeft',
    from: [4.46901, -1.03207, 0.670875],
    to: [4.84972, -1.39064, 1.71914],
    maxDeg: 30,
  },
  {
    node: 'RudderRight',
    from: [4.46901, 1.03207, 0.670875],
    to: [4.84972, 1.39064, 1.71914],
    maxDeg: 30,
  },
  // エレベータは XML が center と axis で与える。左右で同じ中心を使う。
  // 回転軸が翼幅方向なので、翼幅方向の位置は結果に影響しない
  {
    node: 'ElevatorLeft',
    from: [5.22371, 0, -0.0314742],
    to: [5.22371, 1, -0.0314742],
    maxDeg: 25,
  },
  {
    node: 'ElevatorRight',
    from: [5.22371, 0, -0.0314742],
    to: [5.22371, 1, -0.0314742],
    maxDeg: 25,
  },
]

/** XML 座標を当方の座標へ */
export function xmlToWorld(v) {
  return [v[1], v[2], v[0]]
}

/** XML 座標を .ac の座標へ。テストが舵面の境界と突き合わせるのに使う */
export function xmlToAc(v) {
  return [v[0], v[2], -v[1]]
}
