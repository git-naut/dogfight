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
 */

#include <terrain_heightfield>

uniform vec3 sunRadiance;
uniform vec3 skyRadiance;
/** sim のフレーム番号から導いた秒。実時間を渡さないこと */
uniform float waveTime;
/** 太陽のスペキュラを乗せるか */
uniform bool waterSpecular;

in vec3 vWorld;

out vec4 fragColor;

/** 深い海の色。散乱で青緑に見える */
const vec3 DEEP_WATER = vec3(0.015, 0.055, 0.085);
/** 浅瀬の色。海岸線に帯ができて島の輪郭が読める */
const vec3 SHALLOW_WATER = vec3(0.08, 0.22, 0.24);
/** 浅瀬と見なす深さ m */
const float SHALLOW_DEPTH = 90.0;
/**
 * 白波が立つ深さ m。
 *
 * これを入れる前は、砂浜と海が階段状の硬い線で接していた。SMAA はトーン
 * マッピングの前に入っているので、この境界を拾い切れない。白波で境界を
 * ぼかすと、絵として海岸線が読めるようになる。
 */
const float FOAM_DEPTH = 16.0;

/** 波の法線。遠くでは細かい波を解像できないので落とす */
vec3 waveNormal(vec2 world, float toCamera) {
  float strength = 1.0 - smoothstep(2000.0, 12000.0, toCamera);
  if (strength < 0.01) return vec3(0.0, 1.0, 0.0);

  // 波長と向きの違う 3 本。同じ向きだと縞に見える
  vec2 a = vec2(0.86, 0.51);
  vec2 b = vec2(-0.42, 0.91);
  vec2 c = vec2(0.62, -0.78);

  float pa = dot(world, a) / 47.0 + waveTime * 0.9;
  float pb = dot(world, b) / 29.0 + waveTime * 1.31;
  float pc = dot(world, c) / 71.0 - waveTime * 0.6;

  vec2 slope =
    a * cos(pa) * 0.030 +
    b * cos(pb) * 0.022 +
    c * cos(pc) * 0.016;

  return normalize(vec3(-slope.x * strength, 1.0, -slope.y * strength));
}

void main() {
  float toCamera = distance(cameraPosition, vWorld);
  vec3 normal = waveNormal(vWorld.xz, toCamera);

  // 海底の深さで色を変える。定義域の外は海底へクランプされるので外洋の色になる。
  //
  // まず 1 タップで粗く見て、浅瀬にも白波にも掛からない深さなら双三次を
  // 引かない。海面の板は水平線まで覆うので、ここを 16 タップで払うと
  // 画面のほとんどでその費用が乗る。閾値の余裕は実測で決めた。最近傍が
  // -250 m を下回る領域では、双三次との差は最大 9.5 m しかない。
  float coarse = terrainHeightNearest(vWorld.xz);
  float depth;
  if (coarse < -(SHALLOW_DEPTH + 160.0)) {
    depth = -coarse;
  } else {
    depth = max(-terrainHeight(vWorld.xz), 0.0);
  }
  vec3 body = mix(SHALLOW_WATER, DEEP_WATER, smoothstep(0.0, SHALLOW_DEPTH, depth));

  vec3 view = normalize(cameraPosition - vWorld);
  // Schlick 近似。水の垂直入射反射率は 0.02
  float cosTheta = max(dot(view, normal), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - cosTheta, 5.0);

  float shade = terrainCloudShade(vWorld);

  // 空の反射。天空光をそのまま使う。水平線へ向かうほど強く反射する
  vec3 reflected = skyRadiance * 3.0;

  vec3 color = mix(body * (skyRadiance + sunRadiance * 0.12 * shade), reflected, fresnel);

  // 白波。深さで強さを決め、波の位相で濃淡を付ける。一定にすると
  // 海岸に沿った白い縁取りに見える
  float foam = 1.0 - smoothstep(0.0, FOAM_DEPTH, depth);
  if (foam > 0.0) {
    float band = 0.5 + 0.5 * sin(dot(vWorld.xz, vec2(0.86, 0.51)) / 23.0 + waveTime * 1.7);
    float amount = foam * foam * (0.30 + 0.70 * band);
    vec3 foamColor = (sunRadiance * 0.30 * shade + skyRadiance * 3.0);
    color = mix(color, foamColor, amount * 0.85);
  }

  if (waterSpecular) {
    // 太陽の映り込み。海面の高度感を作る要素なので落とさない
    vec3 halfway = normalize(view + sunDirectionWorld);
    float specular = pow(max(dot(normal, halfway), 0.0), 900.0);
    // 2.5 だと低空で真下が白く飛んだ。太陽の映り込みは広い面積に出るので
    // 係数を落とす
    color += sunRadiance * specular * 0.9 * shade;
  }

  fragColor = vec4(color, 1.0);
}
