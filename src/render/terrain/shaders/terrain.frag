precision highp float;
precision highp sampler2D;

/**
 * 地表の色。
 *
 * 標高と傾斜から色を決める。テクスチャは取り込まない（手続き生成のみという
 * 決定）。近距離の凹凸は法線の摂動で出し、ジオメトリは変位させない。
 * 変位させると sim の高さ場と食い違い、当たり判定と見た目がずれる。
 *
 * ライティングは自前で組む。MeshStandardMaterial を使わないので three の
 * ライトは効かない。代わりに大気ライブラリが出す太陽と天空の放射輝度を
 * そのまま使う。時刻を変えれば地形の色も一貫して変わる。
 *
 * **色の決め方はここに置かない。**`terrain_surface` のチャンクが正本で、
 * 突き合わせのプローブも同じ本体を読む。ここは varying と組み込みの
 * `cameraPosition` を渡すだけ。
 */

#include <terrain_heightfield>

uniform vec3 sunRadiance;
uniform vec3 skyRadiance;

#include <terrain_surface>

/** 近距離の凹凸を法線の摂動で出すか */
uniform bool detailNormals;

in vec3 vWorld;
in float vMorph;

out vec4 fragColor;

void main() {
  vec3 branches;
  vec3 color = terrainSurfaceColor(
    vWorld,
    cameraPosition,
    detailNormals,
    terrainAircraftShade(vWorld),
    branches
  );

  // モーフの様子を見たいときはここを開ける（切り替わりの確認用）
  // color = mix(color, vec3(1.0, 0.0, 0.0), vMorph * 0.5);

  fragColor = vec4(color, 1.0);
}
