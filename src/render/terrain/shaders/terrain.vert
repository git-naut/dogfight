precision highp float;
precision highp sampler2D;

/**
 * 地形パッチの頂点変位。
 *
 * ジオメトリは 0..1 の正方格子 1 枚だけ。インスタンスごとにパッチの原点と
 * 大きさを持たせて、四分木で選んだ位置へ並べる。ドローコールは 1 回。
 *
 * **変位の式はここに置かない。**`terrain_vertex` のチャンクが正本で、
 * 突き合わせのプローブも同じ本体を読む。
 */

#include <terrain_heightfield>
#include <terrain_vertex>

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
  float morph;
  vec2 worldXZ = terrainPatchWorldXZ(
    position.xy,
    patchOrigin,
    patchMorph,
    morphOrigin,
    morph
  );

  vWorld = vec3(worldXZ.x, terrainHeight(worldXZ), worldXZ.y);
  vMorph = morph;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
