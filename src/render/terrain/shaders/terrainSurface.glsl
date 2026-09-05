// 地表の色。地形の断片シェーダと突き合わせのプローブが同じ本体を読む。
//
// **写しを 2 つ持たない。**TSL へ移すとき、比べる相手が定まらなくなる
// （段 16 で爆発とフレアの断片が 2 か所にあって同じ問題を踏んだ）。
// 断片シェーダは `main()` だけを持ち、色の決め方はここにある。
//
// 入力を引数で受ける。プローブは固定の値を渡し、本番は varying と
// 組み込みの `cameraPosition` を渡す。機体の影も引数で受けるのは、
// node 経路では `shadow(light)` に置き換わって関数ごと消えるため。
//
// 枝を通ったかどうかは `out` で出す。**絵では枝を数えられない**ので数える
// 口が要るが、別の関数にすると本体が 2 つになる（段 16 と同じ形）。

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

/**
 * 地表の色。
 *
 * @param world         ワールド座標。y は高さ場から引いた標高
 * @param cameraPos     カメラのワールド位置。距離で摂動の強さを決める
 * @param useDetail     近距離の凹凸を法線の摂動で出すか
 * @param aircraftShade 機体の影の明るさ 0..1。1 なら日向
 * @param branches      通った枝。R が摂動、G が雪、B が急斜面の岩
 */
vec3 terrainSurfaceColor(
  vec3 world,
  vec3 cameraPos,
  bool useDetail,
  float aircraftShade,
  out vec3 branches
) {
  vec3 normal = terrainNormal(world.xz);
  float toCamera = distance(cameraPos, world);
  branches = vec3(0.0);

  // 近距離だけ法線を揺らす。解像できない距離で細かい起伏を拾っても
  // 折り返しノイズにしかならない（雲のディテールノイズで学んだのと同じ）
  if (useDetail) {
    float strength = 1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, toCamera);
    if (strength > 0.01) {
      branches.r = 1.0;
      vec2 p = world.xz / DETAIL_SCALE;
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

  // 傾斜。1 が平ら、0 が垂直
  float flatness = clamp(normal.y, 0.0, 1.0);

  // 境目をばらつかせる。まっすぐだと等高線に見える
  float wobble = (valueNoise(world.xz / BLEND_NOISE_SCALE) - 0.5) * 190.0;
  float h = world.y + wobble;

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
  if (snow > 0.0) branches.g = 1.0;

  // 急斜面は標高によらず岩。草木も雪も付かない
  float rockMix = smoothstep(0.52, 0.80, flatness);
  albedo = mix(ROCK, albedo, rockMix);
  if (rockMix < 1.0) branches.b = 1.0;

  // 色そのものを少しばらつかせる。砂浜のような平らな面は陰影が付かないので、
  // 法線の摂動だけでは一様な塗りに見える
  // patch は GLSL の予約語。使うとコンパイルが黙って落ちる（half で同じ失敗をした）
  float mottle = valueNoise(world.xz / 130.0) + valueNoise(world.xz / 41.0) * 0.5;
  float mottleFade = 1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR * 2.0, toCamera);
  albedo *= 1.0 + (mottle / 1.5 - 0.5) * 0.22 * mottleFade;

  float shade = terrainCloudShade(world) * aircraftShade;
  float lambert = max(dot(normal, sunDirectionWorld), 0.0);

  // 拡散反射は 1/pi。three の BRDF_Lambert と同じ式にする。掛け忘れると
  // 3.14 倍明るくなり、AgX を通しても地表が白く飛ぶ（実測で確認した）。
  // skyRadiance は atmosphere.ts の側で 0.28 倍してあり、そこに 1/pi 相当が
  // 入っているので二重に掛けない。
  const float RECIPROCAL_PI = 0.3183098861837907;
  return albedo * (sunRadiance * lambert * shade * RECIPROCAL_PI + skyRadiance);
}
