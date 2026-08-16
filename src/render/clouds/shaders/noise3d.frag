precision highp float;
precision highp int;

/**
 * 雲の形を決める 3D ノイズを焼く。
 *
 * 走らせるのは起動時の一度だけ。
 *
 * ハッシュに sin() を使わないのが要点。fract(sin(x) * 43758.5) 系の定番は
 * 実装ごとに sin の精度が違い、その差が fract で増幅されて別の値になる。
 * 実測で SwiftShader と llvmpipe の結果がずれた。整数のビット演算なら
 * 仕様上どの実装でもビット一致するので、そちらへ寄せてある。
 *
 * すべてタイル化してある。ワールド座標で繰り返し参照するので、境界で
 * 継ぎ目が出ると空一面に格子模様が見えてしまう。
 */

uniform float layer;      // 焼いているスライスの深さ 0..1
uniform int channelSet;   // 0 = 形状ノイズ、1 = ディテールノイズ

in vec2 vUv;
out vec4 fragColor;

// -----------------------------------------------------------------------------
// 整数ハッシュ
//
// PCG の 3D 版。32bit 整数の乗算とシフトだけで作るので、実装差が入らない。
// -----------------------------------------------------------------------------

uvec3 pcg3d(uvec3 v) {
  v = v * 1664525u + 1013904223u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  v ^= v >> 16u;
  v.x += v.y * v.z;
  v.y += v.z * v.x;
  v.z += v.x * v.y;
  return v;
}

/** 整数の格子座標から 0..1 の3成分を返す */
vec3 hash33(ivec3 cell) {
  // 負の値をそのまま uint へ渡すと実装依存になるのでオフセットで正へ寄せる
  uvec3 u = uvec3(cell + 4096);
  return vec3(pcg3d(u)) * (1.0 / 4294967296.0);
}

/** 整数の剰余。GLSL の % は負で実装差が出るので自前で正へ丸める */
ivec3 wrapCell(ivec3 cell, int period) {
  return ((cell % period) + period) % period;
}

// -----------------------------------------------------------------------------
// Worley（セルラー）ノイズ
//
// 空間を格子に切り、各セルに1点を置いて最近傍までの距離を測る。反転すると
// 丸い塊が並ぶ模様になり、これが積雲の粒立ちの元になる。
// -----------------------------------------------------------------------------

float worley(vec3 p, int freq) {
  vec3 scaled = p * float(freq);
  ivec3 id = ivec3(floor(scaled));
  vec3 f = scaled - vec3(id);

  float minDistSq = 1e9;
  for (int x = -1; x <= 1; x++) {
    for (int y = -1; y <= 1; y++) {
      for (int z = -1; z <= 1; z++) {
        ivec3 offset = ivec3(x, y, z);
        vec3 point = vec3(offset) + hash33(wrapCell(id + offset, freq));
        vec3 diff = point - f;
        minDistSq = min(minDistSq, dot(diff, diff));
      }
    }
  }
  // 反転して「セルの中心が濃い」向きにする
  return 1.0 - clamp(sqrt(minDistSq), 0.0, 1.0);
}

/** 周波数を倍にしながら振幅を半分にして重ねる */
float worleyFbm(vec3 p, int freq) {
  return worley(p, freq) * 0.625
       + worley(p, freq * 2) * 0.25
       + worley(p, freq * 4) * 0.125;
}

// -----------------------------------------------------------------------------
// Perlin（勾配）ノイズ
//
// Worley だけだと塊が均一に並びすぎる。Perlin の緩やかなうねりを混ぜて
// 大小のばらつきを作る。
// -----------------------------------------------------------------------------

float gradientDot(ivec3 cell, vec3 delta, int period) {
  vec3 g = hash33(wrapCell(cell, period)) * 2.0 - 1.0;
  return dot(normalize(g), delta);
}

float perlin(vec3 p, int freq) {
  vec3 scaled = p * float(freq);
  ivec3 id = ivec3(floor(scaled));
  vec3 f = scaled - vec3(id);
  // 5次のスムーズステップ。2次だと格子の向きが見える
  vec3 w = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);

  float n000 = gradientDot(id + ivec3(0, 0, 0), f - vec3(0, 0, 0), freq);
  float n100 = gradientDot(id + ivec3(1, 0, 0), f - vec3(1, 0, 0), freq);
  float n010 = gradientDot(id + ivec3(0, 1, 0), f - vec3(0, 1, 0), freq);
  float n110 = gradientDot(id + ivec3(1, 1, 0), f - vec3(1, 1, 0), freq);
  float n001 = gradientDot(id + ivec3(0, 0, 1), f - vec3(0, 0, 1), freq);
  float n101 = gradientDot(id + ivec3(1, 0, 1), f - vec3(1, 0, 1), freq);
  float n011 = gradientDot(id + ivec3(0, 1, 1), f - vec3(0, 1, 1), freq);
  float n111 = gradientDot(id + ivec3(1, 1, 1), f - vec3(1, 1, 1), freq);

  float x00 = mix(n000, n100, w.x);
  float x10 = mix(n010, n110, w.x);
  float x01 = mix(n001, n101, w.x);
  float x11 = mix(n011, n111, w.x);
  float y0 = mix(x00, x10, w.y);
  float y1 = mix(x01, x11, w.y);
  return mix(y0, y1, w.z) * 0.5 + 0.5;
}

float perlinFbm(vec3 p, int freq) {
  return perlin(p, freq) * 0.5
       + perlin(p, freq * 2) * 0.3
       + perlin(p, freq * 4) * 0.2;
}

// -----------------------------------------------------------------------------

/** 値域を張り直す。ノイズの合成でよく使う */
float remap(float value, float inMin, float inMax, float outMin, float outMax) {
  return outMin + (value - inMin) / max(inMax - inMin, 1e-6) * (outMax - outMin);
}

void main() {
  vec3 p = vec3(vUv, layer);

  if (channelSet == 0) {
    // 形状ノイズ。R に Perlin と Worley を混ぜた基本形、GBA に細かさの階段
    float lowWorley = worleyFbm(p, 4);
    float perlinBase = perlinFbm(p, 4);
    // Perlin の谷を Worley で削る。塊の輪郭に不規則さが出る
    float perlinWorley = remap(perlinBase, lowWorley - 1.0, 1.0, 0.0, 1.0);

    fragColor = vec4(
      clamp(perlinWorley, 0.0, 1.0),
      worleyFbm(p, 8),
      worleyFbm(p, 16),
      worleyFbm(p, 32)
    );
  } else {
    // ディテールノイズ。輪郭を削る用途なので Worley だけでよい
    fragColor = vec4(
      worleyFbm(p, 8),
      worleyFbm(p, 16),
      worleyFbm(p, 32),
      1.0
    );
  }
}
