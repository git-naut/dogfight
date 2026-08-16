// 雲の密度。本体のレイマーチと影マップの両方から使う。
//
// 定義が2箇所に分かれると、影の形と見えている雲の形がずれる。ずれても
// 誰も気づかないまま残るので、三.js の ShaderChunk に登録して共有する。

uniform sampler3D shapeNoise;
uniform sampler3D detailNoise;
uniform sampler2D weatherMap;
uniform float cloudTime;     // sim のフレーム番号から導いた秒。実時間ではない
uniform float coverage;      // 雲量 0..1

const float CLOUD_BOTTOM = 1200.0;
const float CLOUD_TOP = 4500.0;

/** 形状ノイズが 1 周する世界の大きさ m。積雲の塊の大きさを決める */
const float SHAPE_SCALE = 4200.0;
/** ディテールノイズの周期 m。輪郭の削り込みの細かさ */
const float DETAIL_SCALE = 380.0;
/** 気象マップの周期 m。雲の配置が変わる間隔 */
const float WEATHER_SCALE = 42000.0;

/**
 * 消散係数 1/m。
 *
 * 積雲を 1 km 通ると光学的厚みが 10 から 20 になるあたりが実測に近い。
 * 0.045 では 600 m の 1 歩で厚み 27 になり、1 ステップで真っ白に潰れた。
 */
const float EXTINCTION = 0.012;

/** 風。ゆっくり流す */
const vec3 WIND = vec3(9.0, 0.0, 3.0);

float cloudRemap(float v, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (v - inMin) / max(inMax - inMin, 1e-6) * (outMax - outMin);
}

float sampleCloudDensity(vec3 p, bool detailed) {
  float h = clamp((p.y - CLOUD_BOTTOM) / (CLOUD_TOP - CLOUD_BOTTOM), 0.0, 1.0);

  vec3 drift = WIND * cloudTime;

  // どこに雲が湧くか。
  //
  // 気象マップは生の FBM。しきい値はここだけで掛ける。焼く時点でも掛けると
  // 雲量の応答が急峻になり、途中の段階がなくなる
  vec3 weather = texture(weatherMap, (p.xz + drift.xz) / WEATHER_SCALE).rgb;
  float threshold = 1.0 - coverage;
  float cover = smoothstep(threshold, threshold + 0.22, weather.r);
  if (cover <= 0.001) return 0.0;

  // 高度方向の勾配。雲頂の高さは気象マップでばらつかせる
  float topLimit = mix(0.35, 1.0, weather.g);
  float gradient = smoothstep(0.0, 0.10, h) * smoothstep(topLimit, topLimit * 0.35, h);
  if (gradient <= 0.001) return 0.0;

  // 塊の形。低周波の Perlin-Worley を高周波の Worley で削る
  vec4 shape = texture(shapeNoise, (p + drift) / SHAPE_SCALE);
  float fbm = shape.g * 0.625 + shape.b * 0.25 + shape.a * 0.125;
  float base = cloudRemap(shape.r, fbm - 1.0, 1.0, 0.0, 1.0);

  // 塊を削り出す。
  //
  // base の値域は 0.5 から 0.85 あたりに寄っている。cover が 0 のとき
  // しきい値 1.0 で何も残らず、1 のとき 0.45 まで下がって塊が育つ。
  float shaped = cloudRemap(base, mix(1.0, 0.45, cover), 1.0, 0.0, 1.0);
  if (shaped <= 0.0) return 0.0;

  float density = shaped * gradient;
  if (density <= 0.0) return 0.0;

  if (detailed) {
    vec3 detail = texture(detailNoise, (p + drift * 2.0) / DETAIL_SCALE).rgb;
    float d = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
    // 雲底は細かくちぎれ、雲頂はふわっと丸くなる
    float erosion = mix(d, 1.0 - d, clamp(h * 4.0, 0.0, 1.0));
    density = cloudRemap(density, erosion * 0.45, 1.0, 0.0, 1.0);
  }

  return clamp(density, 0.0, 1.0);
}
