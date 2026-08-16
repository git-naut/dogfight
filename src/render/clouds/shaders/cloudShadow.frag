precision highp float;
precision highp int;
precision highp sampler3D;

/**
 * 雲影マップ。
 *
 * 真上から見た正方形の領域について、地表の各点から太陽方向へマーチし、
 * 雲層を抜けるまでの光学的厚みを積む。出力は透過率で、1 なら日向、
 * 0 に近いほど雲の影。
 *
 * 地面シェーダがこれを参照する。飛行ゲームでは地面を流れる雲影が高度感を
 * 作るので、平らな地面でも効果が大きい。
 *
 * 密度の定義は density.glsl を共有している。影と見た目がずれないため。
 */

#include <cloud_density>

uniform vec2 shadowCenter;   // 領域の中心のワールド XZ
uniform float shadowExtent;  // 領域の一辺 m
uniform vec3 sunDirection;   // ワールド座標。太陽へ向かう向き

in vec2 vUv;
out vec4 fragColor;

/** 影マップのステップ数。本体のマーチより粗くてよい */
const int SHADOW_STEPS = 10;

void main() {
  // テクセルの中心が受け持つ地表の点
  vec2 worldXZ = shadowCenter + (vUv - 0.5) * shadowExtent;
  vec3 groundPoint = vec3(worldXZ.x, 0.0, worldXZ.y);

  // 太陽が地平線より下なら影を論じる意味がない
  if (sunDirection.y <= 0.02) {
    fragColor = vec4(1.0);
    return;
  }

  // 地表から雲層へ入るまで一気に進み、そこから雲頂まで刻む
  float toBottom = (CLOUD_BOTTOM - groundPoint.y) / sunDirection.y;
  float toTop = (CLOUD_TOP - groundPoint.y) / sunDirection.y;
  float span = toTop - toBottom;
  float stepSize = span / float(SHADOW_STEPS);

  float totalDensity = 0.0;
  for (int i = 0; i < SHADOW_STEPS; i++) {
    float t = toBottom + stepSize * (float(i) + 0.5);
    vec3 p = groundPoint + sunDirection * t;
    // 影ではディテールを見ない。輪郭の細かさは地面では判別できない
    totalDensity += sampleCloudDensity(p, 0.0) * stepSize;
  }

  float transmittance = exp(-totalDensity * EXTINCTION);
  fragColor = vec4(vec3(transmittance), 1.0);
}
