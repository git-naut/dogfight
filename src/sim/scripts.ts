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
   * 捕捉に 0.7 秒かかるので 1 秒で撃つ。発射は押した瞬間だけ効くので、
   * 1 フレームだけ立てて戻す。
   *
   * **間合いは 1,200 m。**最初は 3,000 m に置いたが、命中まで 8.96 秒
   * かかった（うち飛行 7.96 秒）。撃ってから何も起きない時間が長すぎる。
   * ミサイルの物理は触らずに台本だけ寄せた。実機の交戦距離で 8 秒かかるのは
   * 正しい振る舞いで、見せ方の問題として分ける。
   *
   * 実測の飛行時間。800 m で 3.73 秒、1,500 m で 5.12 秒、2,500 m で 6.97 秒、
   * 4,000 m で 10.16 秒。距離が支配的で、1,200 m なら 4.5 秒前後。
   */
  'missile-shot': {
    name: 'missile-shot',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 0, -1200), speed: 240 }],
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

  /**
   * 正面から向かい合う。DLZ の帯が分かれる構図。
   *
   * 標的が反転して自機へ向かってくる（`heading` は台本では指定できないので、
   * 旋回率で半周させる）。**追う構図では rNe と rMax が一致してバーの帯が
   * 分かれない。**接近速度が上がると rMax だけ伸びるので、そこで初めて
   * 「届くが逃げられる」帯が見える。
   *
   * 旋回率 0.35 rad/s で 9 秒。半周してこちらへ向く。
   */
  'head-on': {
    name: 'head-on',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [{ offset: new Vec3(0, 40, -9000), speed: 240, turnRate: 0.35 }],
    keyframes: [],
  },

  /**
   * 武装がすべて同時に出ている構図。**計測専用。**
   *
   * `?sweep=1` で武装の GPU 時間の内訳を測るのに使う。標的 2 機・機銃を
   * 撃ちっぱなし・ミサイル発射済み（煙が伸びている）・爆発が起きている、
   * を 1 フレームに揃える。
   *
   * **どれか 1 つでも出ていないと、その列の差が 0 になる。**0 が出たときに
   * 「費用が無視できる」なのか「そもそも描かれていない」なのか区別が付かなく
   * なる。Phase 3.5 で遮蔽物を切ると裏のものが描かれる罠を踏んだのと同じで、
   * 引き算で測るときは何が出ているかを先に固定する。
   *
   * 1 秒でロックして撃ち、そのまま機銃を撃ち続ける。手前の標的は機銃で
   * 落ちて爆発し、奥の標的へミサイルが飛ぶ。
   */
  'weapons-load': {
    name: 'weapons-load',
    seed: 20260816,
    spawn: { altitude: 3000, speed: 250 },
    targets: [
      { offset: new Vec3(0, 11.1, -300), speed: 245 },
      { offset: new Vec3(400, 60, -2600), speed: 245 },
    ],
    keyframes: [
      { frame: 1 * SEC, input: { fireGun: true, fireMissile: true } },
      { frame: 1 * SEC + 1, input: { fireGun: true, fireMissile: false } },
    ],
  },
  /**
   * 敵機を正面に置く。F-16 が見えることの確認に使う。
   *
   * 間合いは 190 m。**標的機で実測した距離をそのまま使う。**追従カメラの
   * 垂直画角は速度 250 m/s で 66.4 度あり、900 m では機体が 10 × 7 画素に
   * しかならなかった。190 m で 28 × 10 画素。
   *
   * 敵は水平定常飛行のトリムで直進する。この段では AI を載せていないので、
   * 舵面は中立から動かない。速度を自機より遅くして詰まっていく構図にする。
   */
  'enemy-ahead': {
    name: 'enemy-ahead',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(35, 12, -190), speed: 240 }],
    keyframes: [],
  },

  /**
   * 敵機を右前方 45 m に並走させる。**機体の形と塗装を目で確かめる構図。**
   *
   * 190 m だと実測で 20 画素しかなく、単垂直尾翼が 1 本あることくらいしか
   * 分からない。45 m まで寄せると 100 画素を超える。速度をそろえて相対位置を
   * 保つので、フレームを変えても同じ大きさで写る。
   */
  'enemy-formation': {
    name: 'enemy-formation',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(38, 4, -25), speed: 250 }],
    keyframes: [],
  },

  /**
   * 敵機が正面から来る。舵面と塗装を近くで見るのに使う。
   *
   * 方位 π で自機と向き合う。接近速度は 250 + 240 = 490 m/s なので、
   * 3,000 m からだと 6.1 秒ですれ違う。**フレーム 600（5 秒）で残り
   * 550 m。**すれ違う直前を撮れる
   */
  'enemy-head-on': {
    name: 'enemy-head-on',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(0, 0, -3000), speed: 240, heading: Math.PI }],
    keyframes: [],
  },
  /**
   * 敵機が後方 3,000 m から追ってくる。**AI の追尾を見る。**
   *
   * 自機は直進。実測で 42.1 秒（フレーム 5,052）で距離 0 まで詰まる。
   * 途中の絵を撮るならフレーム 2,400（20 秒、距離 1,917 m）あたり。
   */
  'enemy-pursue': {
    name: 'enemy-pursue',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 240 },
    enemies: [{ offset: new Vec3(0, 0, 3000), speed: 250 }],
    keyframes: [],
  },

  /**
   * 敵機を低空・低速に置く。**立て直しが働くかを見る。**
   *
   * 対地 300 m を 140 m/s。立て直しの下限（水平飛行で 400 m）と速度の下限
   * （150 m/s）の両方を割っている。機首を上げて速度を回復するはず。
   */
  'enemy-recover': {
    name: 'enemy-recover',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(200, -2700, -600), speed: 140 }],
    keyframes: [],
  },

  /**
   * 敵機が後方 1,500 m から機銃で撃ってくる。**撃たれるところを見る。**
   *
   * 自機は直進。実測で 12 秒あたりから撃ち始め、40 秒で 456 発のうち 60 発が
   * 当たって撃墜される。曳光弾が後方から来る絵は、追従カメラの視野
   * （水平 98.6 度）に入る。
   *
   * **ミサイルは積まない。**Phase 6.5 で敵がミサイルを撃つようになったが、
   * 1 発で自機が落ちるので機銃の見張りにならない。実測で 5.2 秒で撃墜され、
   * 曳光弾が 1 発も出ないまま絵が変わった。ミサイルは `enemy-missile` で見る。
   */
  'enemy-attack': {
    name: 'enemy-attack',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(0, 0, 1500), speed: 250, missiles: 0 }],
    keyframes: [],
  },

  /**
   * 敵機が後方 2,500 m からミサイルを撃つ。**撃たれる側を見る。**
   *
   * 自機は直進。実測で発射は 0.0 秒、着弾は 7.1 秒。ミサイルは 1 発で
   * 自機を落とす（ダメージ 100 に対し耐久 60）。
   *
   * **フレアを出さなければ必ず落ちる。**それが警告を出す理由になる。
   */
  'enemy-missile': {
    name: 'enemy-missile',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(0, 0, 2500), speed: 250 }],
    keyframes: [],
  },

  /**
   * 自機が敵の後ろにつく。**回避に入るところを見る。**
   *
   * 敵は前方 220 m のやや右上。敵から見て自機は真後ろなので、回避の条件
   * （後方 60 度の円錐かつ 900 m 以内）を満たす。1 ステップで `evade` に
   * 入り、最短 5 秒続く。
   *
   * **間合いを 600 m から 220 m へ詰めた。**600 m では敵が 7 画素にしか
   * ならず、深いバンクが絵で読めない。220 m なら 17 画素。
   */
  'enemy-evade': {
    name: 'enemy-evade',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(30, 8, -220), speed: 250 }],
    keyframes: [],
  },

  /**
   * 1 対 1。**対等な初期条件で撃ち合う。**
   *
   * 正面 2,500 m から向かい合う。接近速度は 500 m/s なので 5 秒ですれ違い、
   * そこから旋回戦になる。自機は機銃を撃ち続ける。
   *
   * 長く回して墜落しないことを見るのにも使う。
   */
  'dogfight-1v1': {
    name: 'dogfight-1v1',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(0, 0, -2500), speed: 250, heading: Math.PI }],
    keyframes: [{ frame: 2 * SEC, input: { fireGun: true } }],
  },

  /**
   * 傷ついた敵が煙を引く。**煙と near 面の見張りを兼ねる。**
   *
   * 耐久を 12（2 割）で始める。煙の濃さは 0.8、舵の効きは 0.68 まで落ちて
   * いる状態。**撃って削るのは当てにならない。**実測で、後方 260 m から
   * 0.35 秒撃っても 1 発も当たらなかった（機首が迎角ぶん上を向くので弾が
   * 7 m 上を通る）。台本で初期の耐久を指定する形にした。
   *
   * 敵は自機を後方に見て回避へ入り、煙を引きながら横へ抜ける。自機は直進
   * するので、**敵が置いていった煙の中をカメラが通る。**翼端渦とミサイルの
   * 煙で 2 度踏んだ near 面の経路と同じ。
   */
  'damage-smoke': {
    name: 'damage-smoke',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [{ offset: new Vec3(0, 3, -260), speed: 250, integrity: 12 }],
    keyframes: [],
  },

  /**
   * 傷ついた敵とすれ違い、置いていった煙の中を通る。**near 面の見張り。**
   *
   * 敵は正面 2,000 m を耐久 12 で向かってくる。接近速度は 500 m/s なので
   * 4 秒（フレーム 480）ですれ違う。自機は直進するので、そこから先は敵が
   * 入ってくるあいだに置いていった煙の筋の中を通る。
   *
   * **測るフレームは深度から選ぶ。**リボンの古い端は先細りが効いているので、
   * 濃さが上限のままの中ほどがカメラに近づくフレームを探す。Phase 5 の
   * ミサイルの煙で、発射直後を測って「断面なし」と読み違えた。
   */
  'damage-smoke-near': {
    name: 'damage-smoke-near',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    // **ミサイルは積まない。**煙の絵を見る台本なので、撃ち合いが混ざると読めない
    enemies: [
      { offset: new Vec3(0, 0, -2000), speed: 250, heading: Math.PI, integrity: 12, missiles: 0 },
    ],
    keyframes: [],
  },

  /**
   * 敵機 8 機。**性能の計測に使う。**
   *
   * Phase 7 のミッション 01 が敵 8 機撃墜なので、器の上限（`MAX_TARGETS`）と
   * そろえた数を並べる。全機を画面に入れるため、前方 400〜1,100 m に横へ
   * 広げて置く。速度は自機とそろえて相対位置を保つ。
   *
   * F-16 は空中で 15,554 三角形・40 プリミティブを描く（実測）。8 機で
   * 124,432 三角形と 320 ドローコール。**地形の 45 万に対して三角形は軽いが、
   * ドローコールは基準の 85 に対して 4 倍近く増える。**どちらが効くかを
   * 実機で測る。
   */
  'enemy-eight': {
    name: 'enemy-eight',
    seed: 20260823,
    spawn: { altitude: 3000, speed: 250 },
    enemies: [
      { offset: new Vec3(-300, 20, -400), speed: 250 },
      { offset: new Vec3(-180, -30, -600), speed: 250 },
      { offset: new Vec3(-60, 40, -800), speed: 250 },
      { offset: new Vec3(60, -20, -500), speed: 250 },
      { offset: new Vec3(180, 30, -700), speed: 250 },
      { offset: new Vec3(300, -40, -900), speed: 250 },
      { offset: new Vec3(-420, 10, -1000), speed: 250 },
      { offset: new Vec3(420, 0, -1100), speed: 250 },
    ],
    keyframes: [],
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
