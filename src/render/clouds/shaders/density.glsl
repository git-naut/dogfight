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
/**
 * ディテールノイズの周期 m。
 *
 * 380 m だと 32³ の最小テクセルが 12 m になり、55 m 刻みのマーチでは
 * 折り返しノイズになる。実測で雲の粒立ちの 55% がこれ由来だった。
 * 周期を広げて最小の起伏を 22 m まで上げる。
 */
const float DETAIL_SCALE = 700.0;
/** 気象マップの周期 m。雲の配置が変わる間隔 */
const float WEATHER_SCALE = 42000.0;

/**
 * 消散係数 1/m。
 *
 * 積雲を 1 km 通ると光学的厚みが 10 から 20 になるあたりが実測に近い。
 * 0.045 では 600 m の 1 歩で厚み 27 になり、1 ステップで真っ白に潰れた。
 *
 * 0.012 から 0.016 へ上げた。歩幅を 130 m へ粗くしたぶん、雲の芯を
 * しっかり出すため。濃くすると視線が早く飽和するので、打ち切りにも
 * 達しにくくなり費用も下がる。
 *
 * 0.024 まで上げると行き過ぎで、雲量 0.5 の構図で画面の 99.5% が雲に
 * なり白一色になった。1.33 倍に留める。
 */
const float EXTINCTION = 0.016;

/** 風。ゆっくり流す */
const vec3 WIND = vec3(9.0, 0.0, 3.0);

/** ノイズテクスチャの一辺 */
const float SHAPE_SIZE = 64.0;
const float DETAIL_SIZE = 32.0;

/**
 * 三線形補間の折れ目を消してサンプルする。
 *
 * ハードウェアの補間は折れ線なので、テクセルの境界で微分が不連続になる。
 * 64³ を 4200 m に張ると Y 方向 65.6 m ごとに折れ目が来る。遠方の雲では
 * その面をほぼ真横から見ることになり、水平な縞として目に付く。
 *
 * テクセル内の位置に smoothstep をかけてから引けば、境界で微分が 0 になり
 * 折れ目が消える。テクスチャの取得回数は増えない。
 */
vec4 smoothSample3D(sampler3D tex, vec3 uvw, float size) {
  vec3 t = uvw * size - 0.5;
  vec3 base = floor(t);
  vec3 f = t - base;
  f = f * f * (3.0 - 2.0 * f);
  return texture(tex, (base + f + 0.5) / size);
}

float cloudRemap(float v, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (v - inMin) / max(inMax - inMin, 1e-6) * (outMax - outMin);
}

/**
 * 雲の密度。
 *
 * @param detailStrength ディテールノイズの効き 0..1。解像できない距離では
 *   0 にする。刻みより細かい起伏を拾うと折り返しノイズになるだけで、
 *   絵は良くならない。
 */
float sampleCloudDensity(vec3 p, float detailStrength) {
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
  vec4 shape = smoothSample3D(shapeNoise, (p + drift) / SHAPE_SCALE, SHAPE_SIZE);
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

  if (detailStrength > 0.01) {
    vec3 detail =
      smoothSample3D(detailNoise, (p + drift * 2.0) / DETAIL_SCALE, DETAIL_SIZE).rgb;
    float d = detail.r * 0.625 + detail.g * 0.25 + detail.b * 0.125;
    // 雲底は細かくちぎれ、雲頂はふわっと丸くなる
    float erosion = mix(d, 1.0 - d, clamp(h * 4.0, 0.0, 1.0));
    float eroded = cloudRemap(density, erosion * 0.45, 1.0, 0.0, 1.0);
    density = mix(density, max(eroded, 0.0), detailStrength);
  }

  return clamp(density, 0.0, 1.0);
}
