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
 */

#include <terrain_heightfield>

uniform vec3 sunRadiance;
uniform vec3 skyRadiance;
/** 近距離の凹凸を法線の摂動で出すか */
uniform bool detailNormals;

in vec3 vWorld;
in float vMorph;

out vec4 fragColor;

/** 標高の境目をばらつかせる。等高線に見えないようにするため */
const float BLEND_NOISE_SCALE = 900.0;
/** 法線の摂動が効く距離 m。これより遠いと解像できず折り返しノイズになる */
const float DETAIL_NEAR = 700.0;
const float DETAIL_FAR = 3000.0;
/** 摂動の周期 m。48 m テクセルより細かい凹凸をここで足す */
const float DETAIL_SCALE = 34.0;
/**
 * 摂動の強さ。
 *
 * 1.6 で試したら、傾きが最大 39 度も付いて lambert が 0 に落ちる区画が
 * できた。天空光だけが残るので紺色の丸い斑が地表いっぱいに並び、迷彩柄に
 * 見えた。0.22 なら傾きは 20 度以内に収まり、斑にはならない。
 */
const float DETAIL_STRENGTH = 0.22;

/** 座標から引ける整数ハッシュ。sin は使わない（実装ごとに結果が変わる） */
float hash21(vec2 p) {
  uvec2 u = uvec2(ivec2(floor(p)) + 8192);
  uint h = u.x * 1664525u + u.y * 1013904223u;
  h ^= h >> 16u;
  h *= 2246822519u;
  h ^= h >> 13u;
  return float(h) * (1.0 / 4294967296.0);
}

float valueNoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = p - i;
  vec2 w = f * f * (3.0 - 2.0 * f);
  float a = hash21(i);
  float b = hash21(i + vec2(1.0, 0.0));
  float c = hash21(i + vec2(0.0, 1.0));
  float d = hash21(i + vec2(1.0, 1.0));
  return mix(mix(a, b, w.x), mix(c, d, w.x), w.y);
}

void main() {
  vec3 normal = terrainNormal(vWorld.xz);

  float toCamera = distance(cameraPosition, vWorld);

  // 近距離だけ法線を揺らす。解像できない距離で細かい起伏を拾っても
  // 折り返しノイズにしかならない（雲のディテールノイズで学んだのと同じ）
  if (detailNormals) {
    float strength = 1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, toCamera);
    if (strength > 0.01) {
      vec2 p = vWorld.xz / DETAIL_SCALE;
      const float E = 0.5;
      float nx = valueNoise(p + vec2(E, 0.0)) - valueNoise(p - vec2(E, 0.0));
      float nz = valueNoise(p + vec2(0.0, E)) - valueNoise(p - vec2(0.0, E));
      // 二段目。周波数を上げて振幅を半分にする。1 段だと粒が揃って規則的に見える
      vec2 q = p * 2.7;
      nx += (valueNoise(q + vec2(E, 0.0)) - valueNoise(q - vec2(E, 0.0))) * 0.5;
      nz += (valueNoise(q + vec2(0.0, E)) - valueNoise(q - vec2(0.0, E))) * 0.5;
      normal = normalize(normal + vec3(nx, 0.0, nz) * DETAIL_STRENGTH * strength);
    }
  }

  float height = vWorld.y;
  // 傾斜。1 が平ら、0 が垂直
  float flatness = clamp(normal.y, 0.0, 1.0);

  // 境目をばらつかせる。まっすぐだと等高線に見える
  float wobble = (valueNoise(vWorld.xz / BLEND_NOISE_SCALE) - 0.5) * 190.0;
  float h = height + wobble;

  const vec3 SAND = vec3(0.62, 0.56, 0.42);
  const vec3 GRASS = vec3(0.20, 0.30, 0.15);
  // 0.31 だと夕方に岩肌が白っぽく飛んだ。露光を直したあとでも明るすぎた
  const vec3 ROCK = vec3(0.22, 0.21, 0.19);
  const vec3 SNOW = vec3(0.86, 0.88, 0.92);

  vec3 albedo = SAND;
  albedo = mix(albedo, GRASS, smoothstep(20.0, 140.0, h));
  albedo = mix(albedo, ROCK, smoothstep(700.0, 1400.0, h));
  // 主峰は 2,224 m。1,700 m から雪にすると上 4 分の 1 が白い帽子になり、
  // 岩肌の帯が消える。2,000 m から掛けて山頂の冠だけに絞る。
  //
  // 傾斜も条件に入れる。標高だけで決めると、境目をばらつかせるノイズが
  // 稜線の急斜面で 2,000 m を跨いで、白い点が散る。雪は緩い面に積もる
  float snow = smoothstep(2000.0, 2180.0, h) * smoothstep(0.62, 0.82, flatness);
  albedo = mix(albedo, SNOW, snow);

  // 急斜面は標高によらず岩。草木も雪も付かない
  albedo = mix(ROCK, albedo, smoothstep(0.52, 0.80, flatness));

  // 色そのものを少しばらつかせる。砂浜のような平らな面は陰影が付かないので、
  // 法線の摂動だけでは一様な塗りに見える
  // patch は GLSL の予約語。使うとコンパイルが黙って落ちる（half で同じ失敗をした）
  float mottle = valueNoise(vWorld.xz / 130.0) + valueNoise(vWorld.xz / 41.0) * 0.5;
  float mottleFade = 1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR * 2.0, toCamera);
  albedo *= 1.0 + (mottle / 1.5 - 0.5) * 0.22 * mottleFade;

  float shade = terrainCloudShade(vWorld);
  float lambert = max(dot(normal, sunDirectionWorld), 0.0);

  // 拡散反射は 1/pi。three の BRDF_Lambert と同じ式にする。掛け忘れると
  // 3.14 倍明るくなり、AgX を通しても地表が白く飛ぶ（実測で確認した）。
  // skyRadiance は atmosphere.ts の側で 0.28 倍してあり、そこに 1/pi 相当が
  // 入っているので二重に掛けない。
  const float RECIPROCAL_PI = 0.3183098861837907;
  vec3 color = albedo * (sunRadiance * lambert * shade * RECIPROCAL_PI + skyRadiance);

  // モーフの様子を見たいときはここを開ける（切り替わりの確認用）
  // color = mix(color, vec3(1.0, 0.0, 0.0), vMorph * 0.5);

  fragColor = vec4(color, 1.0);
}
