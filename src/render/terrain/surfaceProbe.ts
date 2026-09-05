/**
 * 地表と海面の突き合わせに使う固定入力。
 *
 * **three にも DOM にも依存しない。**`heightProbe.ts` と同じ作法で、
 * node 環境の単体テストと Playwright の spec から直に読める。GLSL を焼く
 * 側は `surfaceProbeGl.ts` にある（`?raw` を引くので Vite の外では読めない）。
 *
 * **ここが唯一の定義。**GPU の両側が同じ矩形・同じカメラ・同じ放射輝度を
 * 読む。`heightProbe.ts` と同じ作法で、点の並びを写しで持たない。
 *
 * 大気に触らせない。触ると node 経路の WebGL2 バックエンドで
 * `AtmosphereParameters` の syntax error に当たり（ADR 0010）、`?gpu=1` での
 * バイト一致が取れなくなる。**放射輝度は固定の値を渡す。**
 *
 * 矩形は総当たりではなく実測で選んだ。地形は主峰（2,224 m・world
 * (792, -12600)）を含む 5 km 角で、64x64 のうち標高 2,000 m 超が 511 点、
 * 傾斜 0.80 未満が 1,673 点ある。**平らな海底ばかりの区画では、雪も
 * 急斜面の岩も一度も通らない。**
 */

/** 標本の格子の一辺。64x64 で 4,096 画素・16,384 バイト */
export const SURFACE_PROBE_SIDE = 64

export interface SurfaceRegion {
  /** 矩形の左下 */
  readonly origin: { readonly x: number; readonly z: number }
  /** 一辺 m */
  readonly span: number
  /** カメラのワールド位置。距離で摂動と波の強さが決まる */
  readonly camera: { readonly x: number; readonly y: number; readonly z: number }
}

/**
 * 地表の矩形。主峰を中心にした 5 km 角。
 *
 * カメラは中心の 3,000 m 上。距離は 800〜4,724 m に広がるので、摂動が
 * 効く境目（`strength > 0.01`、およそ 2,850 m）を跨ぐ
 */
export const TERRAIN_PROBE_REGION: SurfaceRegion = {
  origin: { x: -1708, z: -15100 },
  span: 5000,
  camera: { x: 792, y: 3000, z: -12600 },
}

/**
 * 海面の矩形。2 つ置く。
 *
 * 1 つ目は主峰の島の南岸をまたぐ 6 km 角。実測で 1 タップの枝が 1,655 点、
 * 双三次の枝が 2,441 点、白波が 1,911 点。**片方の枝しか通らない矩形では、
 * もう片方の写し間違いが出てこない。**
 *
 * 2 つ目は外洋の 26 km 角。波の法線を落とす枝（距離 12 km 超）はここでしか
 * 通らない。実測で近距離 2,440 点・遠距離 1,656 点。
 *
 * **どちらも高さ場の定義域（±24,576 m）の内側に置く。**外へ出すと
 * `terrainTexelAt` が縁で止めて同じ値を返し続けるので、その領域では
 * 双三次を間違えても一致してしまう。縁で止める処理そのものは
 * `heightProbe.ts` の 2 つ目の区画が見ている
 */
export const WATER_PROBE_REGIONS: readonly SurfaceRegion[] = [
  {
    origin: { x: -1500, z: -9415 },
    span: 6000,
    camera: { x: 1500, y: 800, z: -6415 },
  },
  {
    origin: { x: -13000, z: -2000 },
    span: 26000,
    camera: { x: 0, y: 1500, z: 11000 },
  },
]

/** 太陽光の放射輝度。3 成分が別々に通ることを見るため等しくしない */
export const SURFACE_PROBE_SUN_RADIANCE = { x: 2.6, y: 2.1, z: 1.55 } as const
/** 天空光の放射輝度 */
export const SURFACE_PROBE_SKY_RADIANCE = { x: 0.052, y: 0.068, z: 0.098 } as const
/** 長さ 1 に揃える。半角ベクトルとランバートが意味を持つように */
function unit(x: number, y: number, z: number): {
  readonly x: number
  readonly y: number
  readonly z: number
} {
  const length = Math.sqrt(x * x + y * y + z * z)
  return { x: x / length, y: y / length, z: z / length }
}

/**
 * 太陽の向き。
 *
 * **y を 0.05 より大きくする。**雲影の足元へのずらしは
 * `sunDirectionWorld.y > 0.05` の枝でしか通らない。
 *
 * **正規化して持つ。**手で書いた 3 つ組は長さ 0.9992 だった。海面の
 * 半角ベクトルは単位長を前提にしている
 */
export const SURFACE_PROBE_SUN_DIRECTION = unit(0.42, 0.63, -0.65)

/** 波の位相。0 だと cos が 1 に揃って 3 本の波を取り違えても差が出ない */
export const SURFACE_PROBE_WAVE_TIME = 3.7

/** 雲影マップの一辺。本番と同じ 256 */
export const SURFACE_PROBE_SHADOW_SIZE = 256
/** 雲影マップが覆う世界の一辺 m。本番と同じ */
export const SURFACE_PROBE_SHADOW_EXTENT = 30_000
/** 雲影マップの中心 */
export const SURFACE_PROBE_SHADOW_CENTER = { x: 600, z: -9000 } as const

/**
 * 雲影マップの代わりの中身。
 *
 * **`DataTexture` にする。**レンダーターゲットにすると node 経路が v を
 * 裏返して読むので、向きの違いが移植の欠陥に見える。焼き込みの向きは
 * 別の検査（段 12 の雲影のヒストグラムと区画平均）が見ている。
 *
 * 値は座標から決める。一様だと雲影の式を間違えても一致してしまう
 */
export function surfaceProbeShadowData(): Uint8Array {
  const size = SURFACE_PROBE_SHADOW_SIZE
  const data = new Uint8Array(size * size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 斜めの縞と粗い格子を重ねる。0 と 255 の両端まで使い切る
      const stripe = Math.sin((x * 3 + y * 5) * 0.07) * 0.5 + 0.5
      const blocks = ((x >> 5) + (y >> 5)) % 2 === 0 ? 1 : 0.35
      data[y * size + x] = Math.round(Math.min(1, stripe * blocks) * 255)
    }
  }
  return data
}

/**
 * 標本の位置からワールド座標を出す。GPU 側も同じ式で導く。
 *
 * 列と行の中心を取る。`heightProbe.ts` と同じく行が先、列があと
 */
export function surfaceProbePoint(
  region: SurfaceRegion,
  col: number,
  row: number,
): { x: number; z: number } {
  const side = SURFACE_PROBE_SIDE
  return {
    x: region.origin.x + ((col + 0.5) / side) * region.span,
    z: region.origin.z + ((row + 0.5) / side) * region.span,
  }
}

/**
 * 枝の絵から、枝ごとに通った画素数を数える。
 *
 * 各成分が 0 か 255 で返る。**どちらでもない値を別に数える。**中間の値が
 * あれば枝の書き分けそのものが壊れている
 */
export function surfaceBranchCounts(bytes: ArrayLike<number>): {
  r: number
  g: number
  b: number
  a: number
  other: number
} {
  let r = 0
  let g = 0
  let b = 0
  let a = 0
  let other = 0
  for (let i = 0; i < bytes.length / 4; i++) {
    for (let c = 0; c < 4; c++) {
      const v = bytes[i * 4 + c]!
      if (v === 255) {
        if (c === 0) r++
        else if (c === 1) g++
        else if (c === 2) b++
        else a++
      } else if (v !== 0) other++
    }
  }
  return { r, g, b, a, other }
}

/** 焼いた絵が階調を使い切っているか。R 成分の相異なる値の数 */
export function surfaceLevels(bytes: ArrayLike<number>): number {
  const seen = new Set<number>()
  for (let i = 0; i < bytes.length / 4; i++) seen.add(bytes[i * 4]!)
  return seen.size
}

