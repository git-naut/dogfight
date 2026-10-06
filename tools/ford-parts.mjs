// 空母 Gerald R. Ford（CVN-78）の原本を、この作品の座標へ置く変換（Phase 9 の段 2）。
//
// 原本は Sketchfab の waelXcm 版（CC BY 4.0、`assets/upstream/ford/license.txt`）。
// **頂点は触らない。**`tools/ford-to-glb.mjs` はシーンの頂上に 1 つノードを挟み、この
// 行列を掛けるだけにする（F/A-18E の `tools/f18e-to-glb.mjs` と同じ方針）。変換の値は
// ここに 1 か所だけ置き、変換と検査（`tests/tools/fordParts.test.ts`）の両方が読む。
//
// ## 原本の座標（`readGltfParts` で測った。原本の上位ノードの変換を掛けたあとの値）
//
// | 部品 | 値 |
// |---|---|
// | 全体の外接箱 | X −1.74..1.50、Y 0.11..2.75、Z −6.09..6.00（長さ 12.09） |
// | 飛行甲板 `ship_deck` | X −1.545..1.460、上面 Y 1.214、Z −6.090..5.954 |
// | スクリュー `left_turbine` など | Z −4.9..−5.2（艦尾は −Z、艦首は +Z） |
// | 艦橋 `ship_bridge` | 中心 X −1.09 |
// | 船体の上下の分かれ目 | `ship_lower` の上端 Y 0.574、`ship_mid` の下端 Y 0.563 |
// | 艦底 | `ship_fins` の下端 Y 0.107 |
//
// ## この作品の座標へ
//
// 1. 飛行甲板の外接箱の中心の真下（X −0.0425、Z −0.068）を原点にし、水面を Y 0 にする
// 2. Y 軸まわりに 180 度回す。艦首 +Z が −Z（この作品の前）を向き、艦橋 X −1.09 が +X
//    （右舷）へ移る。実物の Ford の艦橋も右舷。**鏡映は使わない**（テクスチャの文字が裏返る）
// 3. 全長 12.09 を実物の全長 337 m に合わせる（27.874 倍）
//
// 甲板の幅は 3.005 × 27.874 = 83.8 m で、実物の飛行甲板（約 78 m）より 7% 広い。
// 長さ（335.7 m、実物 333 m）が合っているので、モデルの形の誤差として全長で縮尺を取る。
//
// ## 水面の高さ
//
// 実物の喫水 12 m で決める。艦底 Y 0.107 から 12 m（原本の 0.4305）上が水面。甲板は水面から
// (1.214 − 0.5375) × 27.874 = 18.86 m に来る。原本の船体は Y 0.57 で上下に分かれていて、
// 赤い船底の塗り分けと読める。そこを水面とすると喫水は 12.9 m で、1 m 以内で合う。
// **喫水 12 m の出典はまだ確かめていない。**段 4 の ADR 0017 で出典を書くか、推測と明記する。

/** 実物の全長 m */
export const LENGTH_OVERALL = 337

/**
 * 原本の測った値（`readGltfParts`、丸めない）。表の値はこれを丸めたもの。
 * **丸めた値で書くと全長が 336.98 m・艦底が −12.011 m にずれた**（段 2 の検査で気づいた）
 */
const MEASURED = {
  /** 全体の外接箱の Z（艦尾と艦首） */
  zMin: -6.089748488153591,
  zMax: 5.999574618135766,
  /** 飛行甲板 `ship_deck_ship_0` の外接箱 */
  deckXMin: -1.5452477804329916,
  deckXMax: 1.4599215436996449,
  deckTop: 1.2138971450760097,
  deckZMax: 5.954013828365754,
  /** 艦底（`ship_fins` の下端。全体の外接箱の最小の Y と同じ） */
  keel: 0.1065932532212894,
}

/** 原本の全長（外接箱の Z の幅） */
export const SOURCE_LENGTH = MEASURED.zMax - MEASURED.zMin

/** 原本からこの作品の m への倍率 */
export const SCALE = LENGTH_OVERALL / SOURCE_LENGTH

/** 実物の喫水 m */
export const DRAFT = 12

/** 原本の座標で、原点にする点（飛行甲板の外接箱の中心の XZ、水面の Y） */
export const SOURCE_ORIGIN = {
  x: (MEASURED.deckXMin + MEASURED.deckXMax) / 2,
  y: MEASURED.keel + DRAFT / SCALE,
  z: (MEASURED.zMin + MEASURED.deckZMax) / 2,
}

/** 原本の飛行甲板の上面の Y */
export const SOURCE_DECK_TOP = MEASURED.deckTop

/** この作品の座標での甲板の高さ m（水面から） */
export const DECK_HEIGHT = (SOURCE_DECK_TOP - SOURCE_ORIGIN.y) * SCALE

/**
 * 原本の座標（上位ノードの変換を掛けたあと）をこの作品の座標へ写す。
 * (x, y, z) → (−(x − ox), y − oy, −(z − oz)) × SCALE
 */
export function toWorld([x, y, z]) {
  return [
    -(x - SOURCE_ORIGIN.x) * SCALE,
    (y - SOURCE_ORIGIN.y) * SCALE,
    -(z - SOURCE_ORIGIN.z) * SCALE,
  ]
}

/**
 * `toWorld` と同じ変換を、行優先の 4×4 行列で返す。glTF の頂上のノードに掛ける
 */
export function worldMatrix() {
  const s = SCALE
  const o = SOURCE_ORIGIN
  // (−s, s, −s) の対角と、平行移動 (s·ox, −s·oy, s·oz)
  return [
    [-s, 0, 0, s * o.x],
    [0, s, 0, -s * o.y],
    [0, 0, -s, s * o.z],
    [0, 0, 0, 1],
  ]
}
