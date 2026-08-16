precision highp float;
precision highp int;

/**
 * 気象マップ。雲がどこに、どれくらいの高さで湧くかを 2D で決める。
 *
 * R にカバレッジ、G に雲頂の高さ、B に雲底の持ち上がりを入れる。
 * 3D ノイズが「雲の形」を決めるのに対して、こちらは「雲の配置」を決める。
 * 点在する積雲にするには、カバレッジが疎らであることが要る。
 *
 * ハッシュを整数演算にしている理由は noise3d.frag と同じ。
 */

in vec2 vUv;
out vec4 fragColor;

uvec2 pcg2d(uvec2 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  v ^= v >> 16u;
  v.x += v.y * 1664525u;
  v.y += v.x * 1664525u;
  return v;
}

vec2 hash22(ivec2 cell) {
  uvec2 u = uvec2(cell + 4096);
  return vec2(pcg2d(u)) * (1.0 / 4294967296.0);
}

ivec2 wrapCell(ivec2 cell, int period) {
  return ((cell % period) + period) % period;
}

/** タイル化した 2D 勾配ノイズ */
float perlin2(vec2 p, int freq) {
  vec2 scaled = p * float(freq);
  ivec2 id = ivec2(floor(scaled));
  vec2 f = scaled - vec2(id);
  vec2 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n00 = dot(normalize(hash22(wrapCell(id + ivec2(0, 0), freq)) * 2.0 - 1.0), f - vec2(0, 0));
  float n10 = dot(normalize(hash22(wrapCell(id + ivec2(1, 0), freq)) * 2.0 - 1.0), f - vec2(1, 0));
  float n01 = dot(normalize(hash22(wrapCell(id + ivec2(0, 1), freq)) * 2.0 - 1.0), f - vec2(0, 1));
  float n11 = dot(normalize(hash22(wrapCell(id + ivec2(1, 1), freq)) * 2.0 - 1.0), f - vec2(1, 1));

  return mix(mix(n00, n10, w.x), mix(n01, n11, w.x), w.y) * 0.5 + 0.5;
}

float fbm2(vec2 p, int freq) {
  return perlin2(p, freq) * 0.5
       + perlin2(p, freq * 2) * 0.25
       + perlin2(p, freq * 4) * 0.15
       + perlin2(p, freq * 8) * 0.1;
}

void main() {
  // しきい値はここで掛けない。
  //
  // 焼く時点と実行時の両方で雲量を掛けると応答が急峻になり、0.55 で快晴、
  // 0.7 で全面雲というほとんど段階のない挙動になった（実測）。
  // 生の値を渡し、しきい値は clouds.frag の一箇所だけで適用する。
  // FBM の実際の値域は 0.25 から 0.75 あたりに寄る。そのまま渡すと
  // しきい値の効きが中央に圧縮され、雲量 0.4 で快晴、0.55 で全面雲という
  // 使えない応答になった（実測）。値域を 0..1 へ引き伸ばしておく
  float amount = clamp((fbm2(vUv, 3) - 0.30) / 0.40, 0.0, 1.0);

  // 雲頂の高さにばらつきを持たせる。全部同じ高さだと櫛のように見える
  float top = 0.45 + fbm2(vUv, 5) * 0.55;
  // 雲底のわずかな上下
  float bottom = fbm2(vUv, 7) * 0.3;

  fragColor = vec4(amount, top, bottom, 1.0);
}
