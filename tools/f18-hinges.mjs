/**
 * F/A-18C の舵面のヒンジ。
 *
 * 値は FlightGear の `assets/upstream/f18/f18.xml` の rotate アニメーションから
 * そのまま写した。推測は入っていない。
 *
 * 座標系の対応は `fg-coords.mjs` にまとめてある。この機体の AileronLeft から
 * 確定させた。検査は `tests/tools/ac3d.test.ts` が、舵面の境界とヒンジの位置を
 * 突き合わせて行う。
 *
 * `channel` と `sign` は舵の向き。**左右で `sign` を反転させるかどうかは、
 * ヒンジの軸がどちらを向いているかで決まる。**この機体はエルロンの軸が左右で
 * 逆を向いている（左が −X、右が +X）ので、同じ符号を与えれば回転が自動的に
 * 逆になる。エレベータは軸が左右で同じ向きなので、同じ符号で一緒に動く。
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

/** XML 座標のまま持つ。変換は xmlToWorld で 1 回だけ掛ける */
export const F18_HINGES = [
  {
    node: 'AileronLeft',
    objects: ['AileronLeft'],
    from: [2.67178, -3.74241, 0.470943],
    to: [2.67178, -5.42703, 0.470943],
    maxDeg: 30,
    channel: 'aileron',
    sign: -1,
  },
  {
    node: 'AileronRight',
    objects: ['AileronRight'],
    from: [2.67178, 3.74241, 0.470943],
    to: [2.67178, 5.42703, 0.470943],
    maxDeg: 30,
    channel: 'aileron',
    sign: -1,
  },
  {
    node: 'RudderLeft',
    objects: ['RudderLeft'],
    from: [4.46901, -1.03207, 0.670875],
    to: [4.84972, -1.39064, 1.71914],
    maxDeg: 30,
    channel: 'rudder',
    sign: 1,
  },
  {
    node: 'RudderRight',
    objects: ['RudderRight'],
    from: [4.46901, 1.03207, 0.670875],
    to: [4.84972, 1.39064, 1.71914],
    maxDeg: 30,
    channel: 'rudder',
    sign: 1,
  },
  // エレベータは XML が center と axis で与える。左右で同じ中心を使う。
  // 回転軸が翼幅方向なので、翼幅方向の位置は結果に影響しない
  {
    node: 'ElevatorLeft',
    objects: ['ElevatorLeft'],
    from: [5.22371, 0, -0.0314742],
    axis: [0, 1, 0],
    maxDeg: 25,
    channel: 'elevator',
    sign: -1,
  },
  {
    node: 'ElevatorRight',
    objects: ['ElevatorRight'],
    from: [5.22371, 0, -0.0314742],
    axis: [0, 1, 0],
    maxDeg: 25,
    channel: 'elevator',
    sign: -1,
  },
]

export { xmlToWorld, xmlToAc } from './fg-coords.mjs'
