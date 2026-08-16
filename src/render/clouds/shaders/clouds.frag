precision highp float;
precision highp int;
precision highp sampler3D;

/**
 * 積雲のボリュメトリックレイマーチング。
 *
 * 出力は RGB に乗算済みの散乱光、A に不透明度。これを
 * AerialPerspectiveEffect の overlay へ渡すと、ライブラリ側が
 * outputColor.rgb * (1 - a) + rgb で合成してくれる。大気の霞との順序を
 * 自前で組まなくて済む。
 *
 * 密度の定義は density.glsl を影マップと共有している。
 * 原理と式の対応は docs/clouds.md に書いてある。
 */

#include <cloud_density>

uniform sampler2D sceneDepth;

uniform mat4 inverseProjectionMatrix;
uniform mat4 inverseViewMatrix;
uniform vec3 cameraPositionWorld;
uniform float cameraNear;
uniform float cameraFar;

uniform vec3 sunDirection;   // ワールド座標。太陽へ向かう向き
uniform vec3 sunColor;
uniform vec3 ambientColor;

uniform int maxSteps;        // 主マーチの上限
uniform int lightSteps;      // 光マーチのステップ数
uniform bool useDetail;

in vec2 vUv;
out vec4 fragColor;

/**
 * マーチの最大距離 m。
 *
 * 雲層の内側を水平に飛ぶと、視線がいくらでも雲の中を進む。60 km まで見ると
 * どの方向も不透明になって空が消えた。手前だけ描いて、その先は大気の霞に
 * 溶かす。
 */
const float MAX_MARCH_DISTANCE = 26000.0;

/**
 * 散乱アルベド。水滴はほとんど吸収せず散乱するので 1 に近い。
 * わずかに下げて完全な白飛びを避ける。
 */
const float SCATTER_ALBEDO = 0.9;

const float TAU_PI = 3.14159265;

/**
 * 画素ごとのマーチ開始オフセット。
 *
 * 開始位置を揃えると等高線のような縞が出る。ずらして散らすのだが、白色
 * ノイズでずらすと今度は画素ごとにばらけて斑点になる。実測でそうなった。
 *
 * Bayer の秩序ディザなら周期の中で均等に散り、隣接画素の値が偏らない。
 * 4x4 では段階が 16 しかなく、雲の内部に横縞が残った。8x8 の 64 段階に
 * 上げて崩す。
 */
const float BAYER_8X8[64] = float[64](
   0.0, 32.0,  8.0, 40.0,  2.0, 34.0, 10.0, 42.0,
  48.0, 16.0, 56.0, 24.0, 50.0, 18.0, 58.0, 26.0,
  12.0, 44.0,  4.0, 36.0, 14.0, 46.0,  6.0, 38.0,
  60.0, 28.0, 52.0, 20.0, 62.0, 30.0, 54.0, 22.0,
   3.0, 35.0, 11.0, 43.0,  1.0, 33.0,  9.0, 41.0,
  51.0, 19.0, 59.0, 27.0, 49.0, 17.0, 57.0, 25.0,
  15.0, 47.0,  7.0, 39.0, 13.0, 45.0,  5.0, 37.0,
  63.0, 31.0, 55.0, 23.0, 61.0, 29.0, 53.0, 21.0
);

float dither(ivec2 pixel) {
  int index = (pixel.y & 7) * 8 + (pixel.x & 7);
  return BAYER_8X8[index] * (1.0 / 64.0);
}

/** Henyey-Greenstein 位相関数 */
float hg(float cosTheta, float g) {
  float g2 = g * g;
  float denom = 1.0 + g2 - 2.0 * g * cosTheta;
  return (1.0 - g2) / (4.0 * TAU_PI * pow(max(denom, 1e-4), 1.5));
}

/**
 * 前方散乱と後方散乱を混ぜた二重位相。
 *
 * 単一の HG だと、前方に尖らせると逆光の縁が光る代わりに順光が暗く沈む。
 * 二つ混ぜると両立する。
 *
 * 4π を掛けて「等方散乱を 1 とした相対値」に直してある。位相関数は全立体角で
 * 積分すると 1 になる定義なので、そのまま使うと値が 0.03 前後にしかならず、
 * 空（0.05 前後）より暗い雲になる。実測でそうなった。
 */
float dualPhase(float cosTheta) {
  float p = 0.7 * hg(cosTheta, 0.8) + 0.3 * hg(cosTheta, -0.2);
  return p * 4.0 * TAU_PI;
}

/**
 * 多重散乱の近似。
 *
 * 単一散乱だけを積むと雲は灰色に沈む。実際の雲が白いのは、内部で光が
 * 何度も散乱して奥まで回り込むため。オクターブごとに消散を弱め、位相を
 * 等方へ寄せながら重ねると、その効果を安く近似できる。
 *
 * @param opticalDepth 光源方向への光学的厚み
 */
vec3 multiScatter(float opticalDepth, float cosTheta) {
  vec3 sum = vec3(0.0);
  float attenuation = 1.0;   // 消散の効き
  float contribution = 1.0;  // 寄与の重み
  float anisotropy = 1.0;    // 位相の尖り

  for (int n = 0; n < 3; n++) {
    float phase = mix(1.0, dualPhase(cosTheta), anisotropy);
    sum += vec3(contribution * phase * exp(-opticalDepth * attenuation));
    attenuation *= 0.5;
    contribution *= 0.5;
    anisotropy *= 0.5;
  }
  return sum;
}

/**
 * 太陽方向へマーチして光学的厚みを測る。
 *
 * 歩幅を等間隔にすると近傍だけ細かく見て遠方を取りこぼす。指数的に広げると
 * 少ないステップで奥まで届く。
 */
float lightOpticalDepth(vec3 origin) {
  float totalDensity = 0.0;
  float stepSize = 40.0;
  vec3 p = origin;

  for (int i = 0; i < 8; i++) {
    if (i >= lightSteps) break;
    p += sunDirection * stepSize;
    if (p.y > CLOUD_TOP || p.y < CLOUD_BOTTOM) break;
    // 光マーチではディテールを見ない。効果が薄いわりに高くつく
    totalDensity += sampleCloudDensity(p, false) * stepSize;
    stepSize *= 1.6;
  }

  return totalDensity * EXTINCTION;
}

/** 深度バッファの値からカメラまでの距離 m を出す */
float linearDistance(float depth, vec3 rayDirection) {
  if (depth >= 1.0) return 1e9;  // 空。遮るものがない
  float ndc = depth * 2.0 - 1.0;
  float viewZ = (2.0 * cameraNear * cameraFar)
              / (cameraFar + cameraNear - ndc * (cameraFar - cameraNear));
  // 視線方向の奥行きを、レイに沿った距離へ直す
  vec3 forward = -normalize(vec3(inverseViewMatrix[2]));
  return viewZ / max(dot(rayDirection, forward), 1e-4);
}

void main() {
  // 画素の UV からワールド空間のレイを作る
  vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec4 viewPos = inverseProjectionMatrix * clip;
  viewPos /= viewPos.w;
  vec3 rayDirection = normalize((inverseViewMatrix * vec4(viewPos.xyz, 0.0)).xyz);

  float sceneDistance = linearDistance(texture(sceneDepth, vUv).r, rayDirection);

  // スラブとの交差
  float originY = cameraPositionWorld.y;
  float dirY = rayDirection.y;
  bool inside = originY >= CLOUD_BOTTOM && originY <= CLOUD_TOP;

  float start;
  float end;
  if (abs(dirY) < 1e-6) {
    if (!inside) { fragColor = vec4(0.0); return; }
    start = 0.0;
    end = sceneDistance;
  } else {
    float toBottom = (CLOUD_BOTTOM - originY) / dirY;
    float toTop = (CLOUD_TOP - originY) / dirY;
    start = max(min(toBottom, toTop), 0.0);
    end = min(max(toBottom, toTop), sceneDistance);
  }

  end = min(end, MAX_MARCH_DISTANCE);
  if (end <= start) { fragColor = vec4(0.0); return; }

  float span = end - start;
  // 距離に応じて歩幅を広げる。
  //
  // 等間隔にすると、26 km を 96 歩で刻んで 1 歩 270 m になる。雲の起伏と
  // 同じ大きさなので、画素ごとの開始位置のずれがそのまま塊のムラとして
  // 見えた（実測）。手前を細かく刻めば、目につく近距離のムラが消える。
  float baseStep = span / float(maxSteps) * 0.32;
  float offset = dither(ivec2(gl_FragCoord.xy));

  float cosTheta = dot(rayDirection, sunDirection);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;

  // 振れ幅は 1 歩ぶん取る。抑えると縞が残り、広げると斑になるが、
  // 1/2 解像度なら 1 画素が 2x2 にしか広がらないので 1 歩でも斑は目立たない
  float t = start + baseStep * offset;
  // 密度ゼロの区間は大股で飛ばす。空振りに時間を使わない
  float emptySkip = 3.0;
  int consecutiveEmpty = 0;

  for (int i = 0; i < 256; i++) {
    if (i >= maxSteps || t >= end || transmittance < 0.01) break;

    // 手前は細かく、奥は粗く
    float stepSize = baseStep * (1.0 + t / 9000.0);

    vec3 p = cameraPositionWorld + rayDirection * t;
    float density = sampleCloudDensity(p, useDetail);

    if (density > 0.0) {
      consecutiveEmpty = 0;

      float tauToSun = lightOpticalDepth(p);

      // powder 項。密度そのものから作る。歩幅をメートルで掛けると
      // 1 歩で飽和して常に 1 になり、意味を失う（実測で確認）
      float powderTerm = 1.0 - exp(-density * 4.0);

      vec3 luminance =
        sunColor * multiScatter(tauToSun, cosTheta) * powderTerm * SCATTER_ALBEDO
        + ambientColor;

      // 区間内の吸収を解析的に積む。段ごとに足すより滑らかになる
      float stepT = exp(-density * stepSize * EXTINCTION);
      scattered += transmittance * (1.0 - stepT) * luminance;
      transmittance *= stepT;

      t += stepSize;
    } else {
      consecutiveEmpty++;
      // 空振りが続くほど歩幅を伸ばす。雲に当たったら細かい歩幅へ戻る
      t += stepSize * (consecutiveEmpty > 2 ? emptySkip : 1.0);
    }
  }

  float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  // overlay は乗算済みアルファで合成される
  fragColor = vec4(scattered, alpha);
}
