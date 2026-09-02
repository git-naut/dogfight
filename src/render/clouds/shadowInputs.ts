/**
 * 雲影マップを決める入力。
 *
 * **GLSL 版と TSL 版へ同じ値を渡すための器。**片方が別の入力で焼いたものを
 * 比べても、一致しなかったときに移植の欠陥なのか入力の違いなのかが分から
 * ない。器を 1 つにして、並びの定義もここだけに置く。
 *
 * GLSL 側は生きているシムから決まる（機体位置と時刻）。TSL 側は
 * `?gpu=2&shadowinputs=...` で同じ値を受け取る。並べ方を写しで持つと、
 * 片方だけ直したときに黙ってずれる。
 *
 * **three にも DOM にも依存しない純関数。**node 環境の単体テストで回る。
 */
export interface ShadowInputs {
  /** sim のフレーム番号から導いた秒。実時間ではない */
  cloudTime: number
  /** 雲量 0..1 */
  coverage: number
  /** 太陽へ向かうワールド座標の向き。正規化済み */
  sunX: number
  sunY: number
  sunZ: number
  /** 影マップが受け持つ正方形の中心のワールド XZ */
  centerX: number
  centerZ: number
}

/** URL へ載せる並び。ここが唯一の定義 */
const ORDER = [
  'cloudTime',
  'coverage',
  'sunX',
  'sunY',
  'sunZ',
  'centerX',
  'centerZ',
] as const satisfies readonly (keyof ShadowInputs)[]

/** 数の個数。読む側が長さを検査するのに使う */
export const SHADOW_INPUT_COUNT = ORDER.length

export function encodeShadowInputs(inputs: ShadowInputs): string {
  return ORDER.map((key) => inputs[key]).join(',')
}

/**
 * `?shadowinputs=` を読む。
 *
 * **数が揃わなければ null を返す。**足りない値を 0 で埋めると、太陽が
 * 地平線の下にいることになって影マップが真っ白になり、**ヒストグラムは
 * それでも比較できてしまう。**黙って通る形を作らない
 */
export function decodeShadowInputs(text: string | null): ShadowInputs | null {
  if (text === null || text === '') return null
  const parts = text.split(',')
  if (parts.length !== SHADOW_INPUT_COUNT) return null
  // **空の欄を弾く。**`Number('')` は 0 を返すので、`0,0.3,0,1,0,0,` の
  // ような末尾の欠けが「中心 Z が 0」として黙って通る
  if (parts.some((p) => p.trim() === '')) return null
  const values = parts.map(Number)
  if (values.some((v) => !Number.isFinite(v))) return null

  const out = {} as ShadowInputs
  ORDER.forEach((key, i) => {
    out[key] = values[i]!
  })
  return out
}
