precision highp float;
precision highp sampler2D;

/**
 * 海面。
 *
 * 高度 0 の平らな板。CDLOD に載せる必要はないので、板 1 枚をカメラに
 * 追従させる。負荷はフラグメントだけ。
 *
 * 反射に平面反射パスは使わない。法線から大気の天空放射輝度をフレネルで
 * 反射させ、太陽のスペキュラを重ねる。追加のレンダーパスがゼロで済む。
 *
 * 波は正弦波数本で法線だけ揺らす。板は変位させない。位相は sim のフレーム
 * 番号から導くので、実時間に依存せず決定論が保たれる。
 *
 * **色の決め方はここに置かない。**`water_surface` のチャンクが正本で、
 * 突き合わせのプローブも同じ本体を読む。
 */

#include <terrain_heightfield>

uniform vec3 sunRadiance;
uniform vec3 skyRadiance;

#include <water_surface>

/** sim のフレーム番号から導いた秒。実時間を渡さないこと */
uniform float waveTime;
/** 太陽のスペキュラを乗せるか */
uniform bool waterSpecular;

in vec3 vWorld;

out vec4 fragColor;

void main() {
  vec4 branches;
  vec3 color = waterSurfaceColor(
    vWorld,
    cameraPosition,
    waveTime,
    waterSpecular,
    terrainAircraftShade(vWorld),
    branches
  );
  fragColor = vec4(color, 1.0);
}
