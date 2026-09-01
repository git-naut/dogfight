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
