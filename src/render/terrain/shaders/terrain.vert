precision highp float;
precision highp sampler2D;

/**
 * 地形パッチの頂点変位。
 *
 * ジオメトリは 0..1 の正方格子 1 枚だけ。インスタンスごとにパッチの原点と
 * 大きさを持たせて、四分木で選んだ位置へ並べる。ドローコールは 1 回。
 */

#include <terrain_heightfield>

/** パッチの原点 xz、一辺 m、セル 1 つの大きさ m */
in vec4 patchOrigin;
/** 親の格子へ寄せ始める距離 m と、寄せ終わる距離 m */
in vec2 patchMorph;

/**
 * 寄せる量を決める基準の位置。
 *
 * **組み込みの `cameraPosition` を使わない。**影を焼くパスでは three が
 * 光源のカメラを入れてくるので、基準が描くパスごとに変わる。
 * 主カメラの位置を明示的に渡す
 */
uniform vec3 morphOrigin;

out vec3 vWorld;
out float vMorph;

void main() {
  vec2 unitGrid = position.xy;
  float cells = patchOrigin.z / patchOrigin.w;

  // 寄せる量は未モーフの位置から決める。モーフ後の位置から決めると
  // 循環参照になる。1 セル以内のずれなので寄せ量には影響しない
  vec2 unmorphed = patchOrigin.xy + unitGrid * patchOrigin.z;
  float distance2D = distance(morphOrigin.xz, unmorphed);
  float morph = clamp(
    (distance2D - patchMorph.x) / max(patchMorph.y - patchMorph.x, 1e-4),
    0.0,
    1.0
  );

  // 親の格子は偶数番の頂点。奇数番をそこへ寄せると、1 段粗い隣と辺が繋がる。
  // これがないと T 字の裂け目が出て、カメラが動くたびに段差がちらつく
  vec2 grid = unitGrid * cells;
  vec2 parent = floor(grid * 0.5) * 2.0;
  vec2 worldXZ = patchOrigin.xy + mix(grid, parent, morph) * patchOrigin.w;

  float height = terrainHeight(worldXZ);

  vWorld = vec3(worldXZ.x, height, worldXZ.y);
  vMorph = morph;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
