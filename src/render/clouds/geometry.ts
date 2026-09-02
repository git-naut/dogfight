/**
 * 雲のレイマーチに使う幾何計算。
 *
 * 雲は高度 1,200 m から 4,500 m の平板スラブとして扱う。30 km 先でも地球の
 * 丸みによるずれは 70 m しかないので、大気のように楕円体で扱う必要はない。
 *
 * three にも DOM にも依存しない純粋な計算なので node 環境のテストで検証できる。
 * シェーダ側にも同じ式を書くが、符号や境界条件をここで先に確定させておく。
 */

/** 雲底の高度 m */
export const CLOUD_BOTTOM = 1200
/** 雲頂の高度 m */
export const CLOUD_TOP = 4500

/** マーチする区間。start から end までの距離 m */
export interface MarchRange {
  /** 交差したか。false なら start と end は意味を持たない */
  hit: boolean
  /** レイ原点からの開始距離 m */
  start: number
  /** レイ原点からの終了距離 m */
  end: number
}

const MISS: MarchRange = { hit: false, start: 0, end: 0 }

/**
 * 水平なスラブとレイの交差。
 *
 * @param originY レイ原点の高度 m
 * @param dirY レイ方向の Y 成分（正規化済みベクトルの成分）
 * @param maxDistance この距離より先は見ない m。深度バッファで地形の手前を切る用途
 * @param bottom スラブの下端 m
 * @param top スラブの上端 m
 *
 * 扱う場合は5つ。スラブの下から見上げる、上から見下ろす、内側にいる、
 * 水平に飛んで交差しない、そして地形に遮られる。
 */
export function intersectSlab(
  originY: number,
  dirY: number,
  maxDistance: number,
  bottom: number = CLOUD_BOTTOM,
  top: number = CLOUD_TOP,
): MarchRange {
  if (maxDistance <= 0) return MISS

  const inside = originY >= bottom && originY <= top

  // ほぼ水平。分母がゼロに近く距離が発散するので、内外だけで決める
  if (Math.abs(dirY) < 1e-6) {
    return inside ? { hit: true, start: 0, end: maxDistance } : MISS
  }

  const toBottom = (bottom - originY) / dirY
  const toTop = (top - originY) / dirY

  let start = Math.min(toBottom, toTop)
  let end = Math.max(toBottom, toTop)

  // 原点が内側なら、後方の交点は捨てて原点から始める
  if (start < 0) start = 0
  if (end > maxDistance) end = maxDistance

  if (end <= start) return MISS
  return { hit: true, start, end }
}

/**
 * スラブ内の高さを 0 から 1 に正規化する。
 *
 * 雲底で 0、雲頂で 1。密度の高度勾配を作るのに使う。
 */
export function heightFraction(
  altitude: number,
  bottom: number = CLOUD_BOTTOM,
  top: number = CLOUD_TOP,
): number {
  return clamp((altitude - bottom) / (top - bottom), 0, 1)
}

/**
 * 積雲らしい高度方向の密度勾配。
 *
 * 雲底で急に立ち上がり、中ほどで最大になり、雲頂へ向けてなだらかに減る。
 * これがないとスラブ全体が一様に埋まって板のように見える。
 */
export function densityGradient(fraction: number): number {
  const bottomRamp = smoothstep(0, 0.12, fraction)
  const topFalloff = smoothstep(1, 0.35, fraction)
  return bottomRamp * topFalloff
}

/**
 * マーチの歩幅。
 *
 * 密度ゼロの区間を細かく刻んでも時間の無駄になる。区間長とステップ数の上限から
 * 基準の歩幅を決め、空振り中はその数倍で進む。
 */
export function baseStepSize(range: MarchRange, maxSteps: number): number {
  if (!range.hit || maxSteps <= 0) return 0
  return (range.end - range.start) / maxSteps
}

export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** GLSL の smoothstep と同じ挙動。edge0 > edge1 でも動く */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/**
 * Beer-Lambert 則による透過率。
 *
 * 光学的厚みが増えるほど指数的に暗くなる。雲の内部を進むほど光が届かなくなる、
 * という当たり前の現象がこの1行で出る。
 */
export function beerTransmittance(density: number, distance: number, extinction: number): number {
  return Math.exp(-density * distance * extinction)
}

/**
 * Henyey-Greenstein 位相関数。
 *
 * 散乱の向きの偏りを表す。g が正なら前方散乱が強く、負なら後方へ返る。
 * 雲は前方散乱が支配的で、これが逆光で縁が明るく光る理由になる。
 *
 * @param cosTheta 視線方向と光方向の内積
 * @param g 非対称パラメータ -1 から 1
 */
export function henyeyGreenstein(cosTheta: number, g: number): number {
  const g2 = g * g
  const denom = 1 + g2 - 2 * g * cosTheta
  return (1 - g2) / (4 * Math.PI * Math.max(denom, 1e-6) ** 1.5)
}

/**
 * 前方散乱と後方散乱を混ぜた二重位相関数。
 *
 * 単一の Henyey-Greenstein では逆光の輝きと順光の柔らかさを両立できない。
 * 前方に強く尖った成分と、後方へ緩く返る成分を混ぜる。
 */
export function dualPhase(cosTheta: number, forwardG = 0.8, backwardG = -0.2, blend = 0.7): number {
  return (
    blend * henyeyGreenstein(cosTheta, forwardG) +
    (1 - blend) * henyeyGreenstein(cosTheta, backwardG)
  )
}

/**
 * Powder 項。
 *
 * Beer-Lambert だけだと、順光で見た雲の縁が明るくなりすぎる。実際の雲は
 * 密度の低い縁ほど光が奥へ散って暗く見える。その効果を近似する補正。
 */
export function powder(density: number, distance: number): number {
  return 1 - Math.exp(-2 * density * distance)
}

/**
 * 雲の流れる時刻。
 *
 * 実時間ではなく sim のフレーム番号から導く。これで同じフレームからは
 * 常に同じ雲が出る。キャプチャモードの決定論はここに依存している。
 */
export function cloudTime(frame: number, fixedDt: number): number {
  return frame * fixedDt
}

/** 手前の歩幅 m。clouds.frag の NEAR_STEP と揃える */
export const NEAR_STEP = 45

/**
 * 歩幅の伸び率の尺度を歩数から解く。
 *
 * 歩幅を s(t) = NEAR_STEP * (1 + t / G) とすると、k 歩目の距離は
 * t(k) = G * (exp(NEAR_STEP * k / G) - 1) になる。t(maxSteps) が上限距離に
 * なる G を二分法で求める。これで到達距離が歩数から保証され、マーチが
 * 途中で止まらない。止まると位置がカメラの移動で前後し、遠くの雲が
 * 現れたり消えたりする。
 */
export function stepGrowthScale(maxSteps: number, maxDistance: number): number {
  let low = 10
  let high = 1e6
  for (let i = 0; i < 60; i++) {
    const g = (low + high) / 2
    const reach = g * (Math.exp((NEAR_STEP * maxSteps) / g) - 1)
    if (reach > maxDistance) low = g
    else high = g
  }
  return (low + high) / 2
}

/**
 * 光マーチが太陽方向へ見る距離の、初歩に対する比。
 *
 * 初歩 40 m の 26.3 倍で約 1,050 m。積雲を横切るのに要る距離としてこの
 * あたりが妥当で、段数を変えてもここは保つ。
 */
const LIGHT_REACH_RATIO = 26.3

/**
 * 等比数列の和が LIGHT_REACH_RATIO になる公比を返す。
 *
 * 段数を減らしても太陽方向を見る距離が変わらないようにする。
 */
export function lightStepGrowth(steps: number): number {
  if (steps <= 1) return 1
  let low = 1.001
  let high = 64
  for (let i = 0; i < 40; i++) {
    const g = (low + high) / 2
    const sum = (Math.pow(g, steps) - 1) / (g - 1)
    if (sum < LIGHT_REACH_RATIO) low = g
    else high = g
  }
  return (low + high) / 2
}

/**
 * 密度の定数。`shaders/density.glsl` と同じ値を持つ。
 *
 * **GLSL は TS を import できないので写しになる。**段 12 で TSL へ移すあいだ、
 * 同じ密度の定義が GLSL と TSL の 2 つ並ぶ。どちらかだけ直すと影の形と
 * 見えている雲の形がずれ、しかも誰も気づかない。
 * `tests/render/densityConstants.test.ts` が GLSL の本文から読んで突き合わせる
 */

/** 形状ノイズが 1 周する世界の大きさ m。積雲の塊の大きさを決める */
export const SHAPE_SCALE = 4200
/** ディテールノイズの周期 m。最小の起伏を 22 m まで上げる値 */
export const DETAIL_SCALE = 700
/** 気象マップの周期 m。雲の配置が変わる間隔 */
export const WEATHER_SCALE = 42000
/** 消散係数 1/m */
export const EXTINCTION = 0.016
/** 風。ゆっくり流す */
export const WIND = { x: 9, y: 0, z: 3 } as const
/** 雲量のしきい値の幅。`smoothstep(threshold, threshold + この値, weather.r)` */
export const COVER_BAND = 0.22
/** 影マップのステップ数。本体のマーチより粗くてよい */
export const SHADOW_STEPS = 10

/**
 * 雲影マップの一辺。地面に落ちる影なのでこの程度で足りる。
 *
 * **GLSL 版と TSL 版が同じ値を使う。**写しを持つと、片方だけ直したときに
 * ヒストグラムの比較が別の解像度どうしの比較になる
 */
export const SHADOW_SIZE = 256

/**
 * マーチ本体の定数。`shaders/clouds.frag` と同じ値を持つ。
 *
 * 密度の定数と同じ理由で写しになる。**GLSL は TS を import できない。**
 * `tests/render/densityConstants.test.ts` が `clouds.frag` の本文から読んで
 * 突き合わせる
 */

/** 散乱アルベド。水滴はほとんど吸収せず散乱する */
export const SCATTER_ALBEDO = 0.9
/** 開始位置のずらし幅。1 歩に対する比 */
export const START_AMP = 1.0
/** ディテールノイズを効かせる距離 m */
export const DETAIL_NEAR = 2500
export const DETAIL_FAR = 7000
/** 積むのをやめる透過率。0.01 が膝 */
export const EXIT_TRANSMITTANCE = 0.01
/** 光マーチの段数を落とし始める距離 m */
export const LIGHT_FULL_DISTANCE = 4000
export const LIGHT_HALF_DISTANCE = 10000
/** 空振り区間の大股送りの倍率。8 が上限 */
export const EMPTY_SKIP = 8.0
/**
 * 円周率。**`Math.PI` ではない。**
 *
 * GLSL 側が `3.14159265` と桁を切って書いてあるので、そのまま写す。
 * `Math.PI` に置き換えると位相関数の値が下位ビットでずれる
 */
export const TAU_PI = 3.14159265
/**
 * 主マーチのループ上限。`maxSteps` より大きくしておく。
 *
 * 等しいと `i >= maxSteps` に達する前にループが終わり、打ち切りの検出が
 * 働かない
 */
export const MARCH_LOOP_LIMIT = 512
/** 光マーチのループ上限 */
export const LIGHT_MARCH_LIMIT = 8
/** 光マーチの最初の歩幅 m */
export const LIGHT_STEP_BASE = 40
/** 多重散乱を重ねるオクターブ数 */
export const MULTI_SCATTER_OCTAVES = 3

/** 雲影マップのヒストグラムのビン数 */
export const SHADOW_HISTOGRAM_BINS = 16

/** 雲影マップを区切って平均を取る格子の一辺 */
export const SHADOW_TILES = 4

/**
 * 雲影マップの分布を数える。
 *
 * **256² の生バイトをそのまま持ち回らない。**26 万個をフックへ載せると
 * 読み出しだけで重くなる。透過率の分布が一致していれば、影の形が一致して
 * いることの十分な証拠になる。
 *
 * R チャンネルだけ見る（雲影は灰色なので 3 成分とも同じ）。返すのは
 * 合計 1 に正規化した割合。GLSL 版と TSL 版の突き合わせに使うので、
 * **両方が同じこの関数を通ること**が要点
 */
export function shadowHistogram(
  bytes: ArrayLike<number>,
  bins = SHADOW_HISTOGRAM_BINS,
): number[] {
  const out = new Array<number>(bins).fill(0)
  const count = Math.floor(bytes.length / 4)
  if (count === 0) return out
  for (let i = 0; i < count; i++) {
    const v = bytes[i * 4]!
    // 255 がちょうど最後のビンへ入るように上限を丸める
    const bin = Math.min(bins - 1, Math.floor((v / 256) * bins))
    out[bin]! += 1
  }
  for (let i = 0; i < bins; i++) out[i]! /= count
  return out
}

/**
 * 雲影マップを格子に区切って各区画の平均透過率を返す。
 *
 * **ヒストグラムは配置を見ない。**実測で、ノイズの体積を上下反転しても
 * 気象マップを上下反転しても、16 ビンの分布は 0.01 の内側に収まった。
 * 分布が合っていることは、影が同じ場所にあることを意味しない。
 *
 * 区画ごとの平均なら配置が効く。浮動小数の演算順序の違いには鈍いので、
 * GLSL 版と TSL 版の突き合わせに使える。
 *
 * 行の並びは「uv の v = 0 の側が先頭」で両側そろえること。返すのは 0..1。
 * 長さが合わなければ空を返す。**黙って 0 で埋めない**
 */
export function shadowTileMeans(
  bytes: ArrayLike<number>,
  side: number,
  tiles = SHADOW_TILES,
): number[] {
  return tileMeans(bytes, side, side, tiles)
}

/**
 * 正方形でない絵にも使える版。雲のマーチ（128x72）の突き合わせに使う。
 *
 * 行の並びは「uv の v = 0 の側が先頭」で両側そろえること
 */
export function tileMeans(
  bytes: ArrayLike<number>,
  width: number,
  height: number,
  tiles = SHADOW_TILES,
): number[] {
  if (bytes.length < width * height * 4) return []
  const sums = new Array<number>(tiles * tiles).fill(0)
  const counts = new Array<number>(tiles * tiles).fill(0)
  for (let y = 0; y < height; y++) {
    const row = Math.min(tiles - 1, Math.floor((y / height) * tiles))
    for (let x = 0; x < width; x++) {
      const col = Math.min(tiles - 1, Math.floor((x / width) * tiles))
      const t = row * tiles + col
      sums[t]! += bytes[(y * width + x) * 4]!
      counts[t]! += 1
    }
  }
  return sums.map((v, i) => (counts[i] === 0 ? 0 : v / counts[i]! / 255))
}

/**
 * 区画ごとの平均どうしの最大のずれ。
 *
 * L1 の総和だと区画の数で薄まる。1 区画でも動いたら見えるように最大で取る
 */
export function maxAbsDifference(a: readonly number[], b: readonly number[]): number {
  if (a.length === 0 || a.length !== b.length) return Number.POSITIVE_INFINITY
  let worst = 0
  for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs(a[i]! - b[i]!))
  return worst
}

/**
 * ヒストグラムどうしの L1 距離。
 *
 * 合計 1 に正規化してあるので、値域は 0 から 2。段 12 の合格条件は 0.01 未満
 */
export function histogramL1(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) return Number.POSITIVE_INFINITY
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum
}
