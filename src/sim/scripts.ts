import type { ReplayScript } from './replay'
import { Vec3 } from './vec3'

/**
 * 名前付きの入力スクリプト。
 *
 * リプレイ検証とスクリーンショット回帰の両方から参照する。同じスクリプトを
 * 使うので、テストが見ている状態と撮った絵が食い違わない。
 *
 * 1 秒は 120 フレーム。
 */
const SEC = 120

export const SCRIPTS = {
  /** 何もせず水平飛行を続ける。飛行モデルの基準線。 */
  level: {
    name: 'level',
    seed: 20260816,
    spawn: { altitude: 2000, speed: 250 },
    keyframes: [],
  },

  /** 左へバンクして旋回する。 */
  'bank-left': {
    name: 'bank-left',
    seed: 20260816,
    spawn: { altitude: 2500, speed: 260 },
    keyframes: [
      { frame: 0, input: { roll: -1 } },
      // 45 度あたりまで倒したらロールを止めて引く
      { frame: Math.round(0.28 * SEC), input: { roll: 0, pitch: 0.4 } },
    ],
  },

  /** 機首を上げて上昇する。 */
  'pull-up': {
    name: 'pull-up',
    seed: 20260816,
    spawn: { altitude: 1200, speed: 300 },
    keyframes: [{ frame: 0, input: { pitch: 0.8, throttle: 1 } }],
  },

  /** 低空を高速で通過する。高度感の確認用。 */
  'low-pass': {
    name: 'low-pass',
    seed: 20260816,
    spawn: { altitude: 220, speed: 320 },
    keyframes: [{ frame: 0, input: { throttle: 1 } }],
  },

  /**
   * 主峰へ向かって海上を走り、海岸を越えたところで引き起こして稜線を跨ぐ。
   *
   * スポーンは必ず原点（`replay.ts` の `spawnFromSpec`）で、機首は -Z。
   * 主峰は (1500, -11000) にあるので、まっすぐ飛べば正面に見えてくる。
   * 海岸までおよそ 4 km、山頂までおよそ 11 km。地形の撮影に使う。
   */
  'island-run': {
    name: 'island-run',
    seed: 20260816,
    spawn: { altitude: 800, speed: 320 },
    keyframes: [
      { frame: 0, input: { throttle: 1 } },
      { frame: 14 * SEC, input: { throttle: 1, pitch: 0.32 } },
      // 引いたままだと上昇が止まらない。押し戻して稜線の上で水平に戻す
      { frame: 20 * SEC, input: { throttle: 1, pitch: -0.2 } },
      { frame: 23 * SEC, input: { throttle: 1, pitch: 0 } },
    ],
  },
  /**
   * 急上昇して舵を戻す。翼端渦の長さを見るための台本。
   *
   * 渦は揚力係数が高いあいだだけ生まれる。引き起こしのあいだに濃い区間が
   * でき、舵を戻すとそこで生成が止まる。その区間が後方へ遠ざかっていく
   * ようすを撮る。**引き起こしを続ける台本では渦が画面の外へ抜けてしまい、
   * 長さが足りているかを判断できない。**
   */
  'zoom-climb': {
    name: 'zoom-climb',
    seed: 20260816,
    spawn: { altitude: 900, speed: 340 },
    keyframes: [
      { frame: 0, input: { pitch: 0.85, throttle: 1 } },
      // 2 秒引いて機首を起こしたら中立へ戻す。以降は惰性で上昇する
      { frame: 2 * SEC, input: { pitch: 0.02, throttle: 1 } },
    ],
  },
  /**
   * 水平飛行から急旋回へ入る。翼端渦の末端を見るための台本。
   *
   * 引き始める前の区間は水蒸気が出ていないので、そこに段差ができる。
   * 旋回を続けるとその段差が視界へ回り込む。**最初から旋回している台本では
   * 段差が履歴の先頭にあり、末端の見え方を確かめられない。**
   */
  'turn-in': {
    name: 'turn-in',
    seed: 20260816,
    spawn: { altitude: 2000, speed: 260 },
    keyframes: [
      { frame: 0, input: { throttle: 0.28 } },
      // 3 秒だけ水平に飛んでから、左へ倒して引く
      { frame: 3 * SEC, input: { roll: -1, throttle: 0.28 } },
      // ロールは 0.47 秒だけ。実測でバンク −95 度に収まる
      { frame: Math.round(3.47 * SEC), input: { roll: 0, pitch: 0.75, throttle: 0.28 } },
    ],
  },

  /**
   * 前方やや右に標的機が直進する。標的が見えることの確認用。
   *
   * **間合いは 320 m にした。**最初は 900 m に置いたが、追従カメラの水平画角は
   * 実測で 98.6 度（速度 250 m/s で垂直 66.4 度・アスペクト 16:9）あり、
   * 全長 17.8 m の機体は 900 m で 5 画素にしかならない。撮った絵でまったく
   * 判別できなかった。320 m なら 30 画素前後で機体だと分かる。機銃の射程でも
   * ある。
   *
   * **正面ではなく右上へ 60 m / 20 m ずらしてある。**真正面に置くと自機の
   * 機体に隠れる。追従カメラは機首の 60 m 先を見ているので、正面は機体の
   * すぐ向こう側になる。
   *
   * 自機 250 m/s に対し標的 245 m/s。5 m/s ずつ詰まるので、撮る位置を
   * 少し変えても構図が大きく崩れない。
   *
   * **高度 3,000 m は地形から決めた。**原点から -Z へまっすぐ飛ぶと主峰の
   * 上を通る。地図の最高点は実測で 2,224.5 m @ (800, -12600) で、それが
   * この回廊上にある。2,000 m だと 50 秒ほどで稜線に当たって止まる
   * （`level` の台本も同じ場所で墜落しているが、墜落後の高度が地形の高さに
   * なるので既存のテストは通ってしまう）。776 m の余裕を取る。
   */
  'target-ahead': {
    name: 'target-ahead',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(35, 12, -190), speed: 245 }],
    keyframes: [],
  },

  /**
   * 標的機が定常右旋回する。比例航法の検証に使う。
   *
   * 旋回率 0.06 rad/s は速度 240 m/s で半径 4,000 m・バンク 55.8 度。
   * **直進する的では視線の回転率がほぼ 0 になり、比例航法が「まっすぐ追う」
   * のと区別が付かない。**先回りが絵に出る構図をここで固定する。
   *
   * 間合いは 220 m。**バンクが絵で読める距離にした。**500 m だと実測で
   * 10 画素しかなく、55.8 度倒れていることが分からない。自機 260 m/s に
   * 対し標的 240 m/s なので詰まっていき、右へ抜けていく。
   */
  'target-turn': {
    name: 'target-turn',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 260 },
    targets: [{ offset: new Vec3(0, 25, -220), speed: 240, turnRate: 0.06 }],
    keyframes: [],
  },

  /**
   * 標的の後方から機銃を撃つ。
   *
   * 高さは実測で決めた。自機の機首はトリム迎角ぶん上を向くので、銃も同じ角度
   * だけ上を向く。速度 250 m/s・高度 3,000 m のトリム迎角は 2.22 度なので、
   * 300 m 先で機軸は 11.61 m 上。弾の落ちが 0.32 秒で 0.5 m あるので
   * 11.1 m の位置に標的を置く。
   *
   * **狙いを合わせないと当たらない。**最初に 10 m に置いたら 5 秒撃って
   * 命中 20 発（発射 500 発）しかなかった。
   */
  'gun-pass': {
    name: 'gun-pass',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 11.1, -300), speed: 245 }],
    keyframes: [{ frame: 0, input: { fireGun: true } }],
  },

  /**
   * ロックしてミサイルを撃ち、命中まで。
   *
   * 3,000 m 先を直進する相手。捕捉に 0.7 秒かかるので 1 秒で撃つ。発射は
   * 押した瞬間だけ効くので、1 フレームだけ立てて戻す。
   */
  'missile-shot': {
    name: 'missile-shot',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -3000), speed: 240 }],
    keyframes: [
      { frame: 1 * SEC, input: { fireMissile: true } },
      { frame: 1 * SEC + 1, input: { fireMissile: false } },
    ],
  },

  /**
   * 届かない距離で撃って外す。
   *
   * **有効射程は実測で決めた。**12,000 m までは当たり、15,000 m では寿命
   * 60 秒を使い切って 2,888 m 手前で落ちる。燃焼が終わると減速するので、
   * 遠いほど終端のマッハ数が下がる（12,000 m で 0.84）。
   */
  'missile-miss': {
    name: 'missile-miss',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -15000), speed: 240 }],
    keyframes: [
      { frame: 1 * SEC, input: { fireMissile: true } },
      { frame: 1 * SEC + 1, input: { fireMissile: false } },
    ],
  },

  /**
   * 自機が自分のミサイルの煙の筋に沿って飛ぶ構図。**near 面の見張り。**
   *
   * ミサイルは前方へ飛び、自機も同じ向きへ直進するので、**自機が煙の筋を
   * 追いかける形になる。**リボンの中ほど（濃さが上限のまま）がカメラの
   * すぐ脇を通る。
   *
   * **実測で撮るフレームを決めた。**煙の点の視線深度を計算すると、
   * 発射直後（f130）は 4.8 m まで近づくが、そこはリボンの古い端で
   * 先細りが効いている。中ほどが近づくのは f841 で、深度 0.1 m・濃さ 1。
   * **最初は f130〜f300 で測って「断面なし」と読み違えた。**
   *
   * f841 の A/B（`blunt2.mjs`、機体とミサイル本体を消して測った）。
   *
   * | | 輪郭 | 12 階調以上 | 最悪 |
   * | 終端あり | 461 px | 0 | 6 階調 |
   * | 終端なし | 1,886 px | 0 | 8 階調 |
   * | 参考: 翼端渦 | 1,335 px | 7 | 29 階調 |
   *
   * 終端は 28,375 画素・最大 21 階調ぶんの淡い広がりを消す。翼端渦のような
   * 鋭い切り口にはならない。煙は 1 層が淡く（0.16）広がりが大きい（6 倍）ので、
   * カメラ 0.1 m を通ると切り口ではなく画面全体の靄になるため。
   */
  'missile-near': {
    name: 'missile-near',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 30, -2500), speed: 245 }],
    keyframes: [
      { frame: 1 * SEC, input: { fireMissile: true } },
      { frame: 1 * SEC + 1, input: { fireMissile: false } },
    ],
  },
} as const satisfies Record<string, ReplayScript>

export type ScriptName = keyof typeof SCRIPTS

export const SCRIPT_NAMES = Object.keys(SCRIPTS) as ScriptName[]

export function isScriptName(value: string): value is ScriptName {
  return Object.prototype.hasOwnProperty.call(SCRIPTS, value)
}

export function getScript(name: string): ReplayScript {
  return isScriptName(name) ? SCRIPTS[name] : SCRIPTS.level
}
