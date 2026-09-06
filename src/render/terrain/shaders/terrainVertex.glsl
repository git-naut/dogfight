// 地形パッチの頂点変位。頂点シェーダと突き合わせのプローブが同じ本体を読む。
//
// 理由は `terrainSurface.glsl` と同じ。**写しを 2 つ持たない。**
//
// 寄せる基準の位置は引数で受ける。**組み込みの `cameraPosition` を読まない。**
// 影を焼くパスでは three が光源のカメラを入れてくるので、基準が描くパスごとに
// 変わって裂け目が出る（`terrain.vert` の注記）。

/**
 * パッチの中の格子位置からワールドの XZ を出す。
 *
 * 親の格子は偶数番の頂点。奇数番をそこへ寄せると、1 段粗い隣と辺が繋がる。
 * これがないと T 字の裂け目が出て、カメラが動くたびに段差がちらつく。
 *
 * `patch` は GLSL の予約語なので `patchInfo` と綴る（`terrain.frag` が
 * 同じ罠を記録している。`tests/render/shaderReserved.test.ts` が走査する）。
 *
 * @param unitGrid   0..1 の格子座標
 * @param patchInfo  パッチの原点 xz、一辺 m、セル 1 つの大きさ m
 * @param morphRange 寄せ始める距離 m と、寄せ終わる距離 m
 * @param basis      寄せる量を決める基準の位置。主カメラのワールド位置
 * @param morph      寄せた量 0..1
 */
vec2 terrainPatchWorldXZ(
  vec2 unitGrid,
  vec4 patchInfo,
  vec2 morphRange,
  vec3 basis,
  out float morph
) {
  float cells = patchInfo.z / patchInfo.w;

  // 寄せる量は未モーフの位置から決める。モーフ後の位置から決めると
  // 循環参照になる。1 セル以内のずれなので寄せ量には影響しない
  vec2 unmorphed = patchInfo.xy + unitGrid * patchInfo.z;
  float distance2D = distance(basis.xz, unmorphed);
  morph = clamp(
    (distance2D - morphRange.x) / max(morphRange.y - morphRange.x, 1e-4),
    0.0,
    1.0
  );

  vec2 grid = unitGrid * cells;
  vec2 parent = floor(grid * 0.5) * 2.0;
  return patchInfo.xy + mix(grid, parent, morph) * patchInfo.w;
}
