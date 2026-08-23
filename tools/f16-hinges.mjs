/**
 * F-16 の舵面のヒンジ。
 *
 * 値は FlightGear の `assets/upstream/f16/F-16.xml` と
 * `assets/upstream/f16/jsb-controls.xml` から写した。推測は入っていない。
 * 座標系の対応は `fg-coords.mjs`。
 *
 * F/A-18C とは 3 つ違う。
 *
 * **1 枚の舵面が複数のオブジェクトに割れている。**上面と下面が別、ラダーは
 * 6 分割。だから `objects` で束ねて 1 ノードへまとめる。
 *
 * **エルロンだけ rotate アニメーションが無い。**この機体はエルロンとフラップを
 * シェーダ側で回している（`effect` の `rotation-rad` と `rotation-x1..z2`）。
 * ヒンジの 2 点はそこに書いてある。取り込んだ版ではエルロンの `effect` が
 * コメントアウトされているが、座標そのものは残っている。
 *
 * **軸の向きが左右対称に置かれている。**エレベータ（水平尾翼）の軸が左右で
 * 逆を向いているので、同じ符号では差動尾翼になってしまう。だから `sign` を
 * 左右で分ける。FlightGear 側も左右で別のプロパティを食わせて同じことを
 * している（Left は surface-positions/elevator-pos-norm、Right は
 * sim/multiplay/generic/float[4]）。
 *
 * 舵角の上限は JSBSim の飛行制御が持っている。`kinematic` の `clipto` から
 * 読んだ。
 *
 * | 舵面 | 上限 | 出どころ |
 * | 水平尾翼 | ±25 度 | `fcs/fly-by-wire/pitch/horz-tail-{left,right}-deflection-deg` の clipto。説明文にも「defl. limit = 25, rate limit = 60 deg/s」とある |
 * | ラダー | ±30 度 | `fcs/fly-by-wire/yaw/rudder-deflection-deg` の clipto。`F-16.xml` の rotate も factor 30 |
 * | フラッペロン | −23..+20 度 | `fcs/fly-by-wire/roll/flaperon-{left,right}-deflection-deg` の clipto |
 *
 * フラッペロンは上下で非対称だが、こちらは 1 つの上限しか持たない。**狭い側の
 * 20 度を採る。**広い側を採ると下げ舵で舵面が翼から抜ける。
 *
 * 水平尾翼について `F-16.xml` の rotate は factor 57.3 を持つが、これは
 * 正規化された −1..1 のプロパティに掛かるので、そのまま読むと ±57.3 度に
 * なる。実機の可動域とも JSBSim の clipto とも合わないので採らない。
 */

/**
 * XML 座標のまま持つ。変換は xmlToWorld で 1 回だけ掛ける。
 *
 * 軸の与え方は原典に合わせて 2 通り。**2 点で書いてあるものは `to`、
 * 中心と方向で書いてあるものは `axis`。**足し算を手でやると、打ち間違いが
 * 黙って通って軸がわずかに傾く。原典の形をそのまま持たせる。
 */
export const F16_HINGES = [
  // エルロン。effect の rotation-x1..z2 が 2 点を与える。外側から内側へ
  // 並んでいるので、軸は左が +X（右）を向く。F/A-18C とは逆なので符号も逆
  {
    node: 'AileronLeft',
    objects: ['LeftUpperAileron', 'LeftLowerAileron'],
    from: [1.71989, -3.5817, 0.073898],
    to: [1.3266, -1.0652, 0.170853],
    maxDeg: 20,
    channel: 'aileron',
    sign: 1,
  },
  {
    node: 'AileronRight',
    objects: ['RightUpperAileron', 'RightLowerAileron'],
    from: [1.71989, 3.5817, 0.073898],
    to: [1.3266, 1.0652, 0.170853],
    maxDeg: 20,
    channel: 'aileron',
    sign: 1,
  },
  // 水平尾翼。rotate が center と axis で与える。軸が左右で逆を向くので
  // 符号を分ける。これでピッチとして一緒に動く
  {
    node: 'ElevatorLeft',
    objects: ['LeftUpperHorizonTail', 'LeftLowerHorizonTail'],
    from: [4.36, -1.965, -0.1],
    axis: [0, -0.981645, -0.190720],
    maxDeg: 25,
    channel: 'elevator',
    sign: 1,
  },
  {
    node: 'ElevatorRight',
    objects: ['RightUpperHorizonTail', 'RightLowerHorizonTail'],
    from: [4.36, 1.965, -0.1],
    axis: [0, 0.981645, -0.190720],
    maxDeg: 25,
    channel: 'elevator',
    sign: -1,
  },
  // ラダーは 1 枚。原本では 7 つのオブジェクトに割れている。垂直尾翼の
  // 帯（塗装）も同じ回転に乗るので束ねる
  {
    node: 'Rudder',
    objects: [
      // 原本に 'Rudder' という名のオブジェクトは無い。XML の rotate は
      // 挙げているが、この .ac には入っていない。**テストが捕まえた**
      'Rudder.001',
      'Rudder.002',
      'Rudder.003',
      'Rudder.004',
      'Rudder.005',
      'Rudder.006',
      'VstabBandLeftAft',
      'VstabBandRightAft',
    ],
    from: [4.915, 0, 2.095],
    axis: [0.547371, 0, 0.836890],
    maxDeg: 30,
    channel: 'rudder',
    sign: 1,
  },
]

export { xmlToWorld, xmlToAc } from './fg-coords.mjs'
