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
/**
 * 密度サンプルの実行回数を出力するモード。
 *
 * 計時はばらつきが大きく、最適化の効果が埋もれる。実行量そのものを数えれば
 * ノイズなく比べられる。R と G に 16bit 整数として詰める
 */
uniform int probeMode;   // 1 = サンプル数、2 = 歩数を使い切ったか
/**
 * 光マーチの歩幅の伸び率。
 *
 * 段数を減らすときは伸び率を上げて、太陽方向を見る距離を保つ。段数だけ
 * 減らすと 1051 m から 370 m へ縮み、自己遮蔽そのものが浅くなる。実測で
 * 6 段を 4 段にしたとき縦横の段差比が 1.477 から 1.991 へ悪化した
 */
uniform float lightGrowth;

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

/**
 * 手前の歩幅 m。ここから距離とともに伸ばす。
 *
 * 一律に粗くしてはいけない。130 m の上限を全距離へ掛けたら、近くの淡い雲が
 * 板に割れた。細かく刻む必要があるのは手前で、粗くしていいのは遠方。
 * 55 m よりさらに細かい 45 m から始める。
 */
const float NEAR_STEP = 45.0;

/**
 * 歩幅の伸び率の尺度 m。
 *
 * 歩幅は NEAR_STEP * (1 + t / これ)。歩数で 26 km を覆えるよう二分法で
 * 解いた値が入る。128 歩なら 2,300 前後で、手前 45 m、5 km で 143 m、
 * 20 km で 436 m になる。遠方が粗いぶんは時間方向の蓄積が埋める。
 *
 * 到達距離を歩数から保証するのが要点。足りないとマーチが途中で止まり、
 * 止まる位置がカメラの移動で前後して雲が現れたり消えたりする。
 */
uniform float stepGrowthScale;

/**
 * フレームごとの誤差のずらし。
 *
 * 1 フレームぶんのマーチには消せない誤差が残る。歩幅の量子化で薄い雲が
 * 水平な板に割れ、歩数を使い切った視線は途中で止まる。フレームごとに
 * ずらして時間方向に平均すれば、どちらも滑らかに均される。
 * フレーム番号から決まるので決定論は保たれる。
 */
uniform float startJitter;
/** 画素内のずらし。輪郭の階段も同時に均す */
uniform vec2 pixelJitter;
/**
 * 開始位置のずらし幅。1 歩に対する比。
 *
 * 時間方向に平均して量子化を消すには 1 歩ぶんを覆う必要がある。0.4 では
 * 40% しか覆えず、残りの構造がそのまま残る。空間だけで散らしていたときは
 * 粒立ちを抑えるために 0.4 にしていたが、時間蓄積を入れると前提が変わる。
 */
const float START_AMP = 1.0;

/**
 * ディテールノイズを効かせる距離 m。
 *
 * 刻みより細かい起伏は、遠くでは拾っても折り返しノイズにしかならない。
 * 実測で雲の粒立ちの 55% がディテール由来だった。手前だけ効かせる。
 */
const float DETAIL_NEAR = 2500.0;
const float DETAIL_FAR = 7000.0;

/**
 * 積むのをやめる透過率。
 *
 * 一度 0.05 へ上げたが戻した。打ち切りは硬い分岐なので、ちょうど境界に
 * かかる画素とかからない画素の間に段差ができる。段差の大きさはこの値に
 * 比例し、0.05 なら最大 5% の明るさの跳びになる。
 *
 * 遠景の構図では影響が 1.477 から 1.496 と小さく見えたが、雲に近い構図で
 * 測ると 1.256 から 1.674 へ悪化していた。構図を1つだけ見て決めた判断の
 * 誤り。0.03 で 1.452、0.02 で 1.345、0.01 で 1.256、0.005 で 1.232 と
 * 0.01 が膝になる。
 */
const float EXIT_TRANSMITTANCE = 0.01;


/**
 * 光マーチの段数を落とし始める距離 m。
 *
 * 遠方の雲は自己遮蔽の細かさが画面上で解像されない。到達距離は lightGrowth が
 * 保つので、落としても値は滑らかに変わり段差にならない。実測で縦横の段差比は
 * 1.477 から 1.479 と動かず、雲底を見上げる構図で密度サンプルが 23% 減った。
 */
const float LIGHT_FULL_DISTANCE = 4000.0;
const float LIGHT_HALF_DISTANCE = 10000.0;

/**
 * 空振り区間の大股送りの倍率。
 *
 * 4 では遠くの薄い雲が水平な板に割れた。ステップ数を使い切ってマーチが
 * 途中で止まり、その打ち切り位置が画面の行ごとに飛ぶため。実機で
 * 「雲に近づくと横線」と指摘された形はこれだった。
 *
 * 8 にすると到達距離が伸びて解消する。16 や 32 まで上げると今度は雲ごと
 * 飛び越し、薄い雲の画素が 70k から 48k、13.9k へ落ちる。8 が上限。
 *
 * ステップ数を 256 へ増やしても直るが、密度サンプルが 153% 増える。
 * こちらは逆に減る（既定の構図で 32% 減、快晴で 49% 減）。
 */
const float EMPTY_SKIP = 8.0;


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
float lightOpticalDepth(vec3 origin, int steps, inout int samples) {
  float totalDensity = 0.0;
  float stepSize = 40.0;
  vec3 p = origin;

  for (int i = 0; i < 8; i++) {
    if (i >= steps) break;
    p += sunDirection * stepSize;
    if (p.y > CLOUD_TOP || p.y < CLOUD_BOTTOM) break;
    // 光マーチではディテールを見ない。効果が薄いわりに高くつく
    totalDensity += sampleCloudDensity(p, 0.0) * stepSize;
    samples++;
    stepSize *= lightGrowth;
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
  // 画素の UV からワールド空間のレイを作る。フレームごとに画素内でずらす
  vec2 uv = vUv + pixelJitter;
  vec4 clip = vec4(uv * 2.0 - 1.0, -1.0, 1.0);
  vec4 viewPos = inverseProjectionMatrix * clip;
  viewPos /= viewPos.w;
  vec3 rayDirection = normalize((inverseViewMatrix * vec4(viewPos.xyz, 0.0)).xyz);

  float sceneDistance = linearDistance(texture(sceneDepth, uv).r, rayDirection);

  // スラブとの交差
  float originY = cameraPositionWorld.y;
  float dirY = rayDirection.y;
  bool inside = originY >= CLOUD_BOTTOM && originY <= CLOUD_TOP;

  float start;
  float end;
  if (abs(dirY) < 1e-6) {
    if (!inside) { fragColor = vec4(0.0, 0.0, 0.0, probeMode > 0 ? 1.0 : 0.0); return; }
    start = 0.0;
    end = sceneDistance;
  } else {
    float toBottom = (CLOUD_BOTTOM - originY) / dirY;
    float toTop = (CLOUD_TOP - originY) / dirY;
    start = max(min(toBottom, toTop), 0.0);
    end = min(max(toBottom, toTop), sceneDistance);
  }

  end = min(end, MAX_MARCH_DISTANCE);
  if (end <= start) { fragColor = vec4(0.0, 0.0, 0.0, probeMode > 0 ? 1.0 : 0.0); return; }

  float span = end - start;
  // 距離に応じて歩幅を広げる。
  //
  // 等間隔にすると、26 km を 96 歩で刻んで 1 歩 270 m になる。雲の起伏と
  // 同じ大きさなので、画素ごとの開始位置のずれがそのまま塊のムラとして
  // 見えた（実測）。手前を細かく刻めば、目につく近距離のムラが消える。
  //
  // さらに絶対値で頭打ちにする。雲層の内側を飛ぶと span が 26 km になり、
  // 区間から割り出すだけでは手前も 87 m 刻みになる。粒立ちの粗さはここから
  // 来ていた。近距離を細かくしても、遠方は下の距離依存の伸長と、
  // 密度ゼロ区間の大股送りが補う。
  float baseStep = NEAR_STEP;
  // Bayer の並びにフレームごとの位相を足す。空間だけで散らすと、同じ誤差が
  // 毎フレーム同じ場所に出るので時間方向に平均しても消えない
  float offset = fract(dither(ivec2(gl_FragCoord.xy)) + startJitter);

  float cosTheta = dot(rayDirection, sunDirection);

  vec3 scattered = vec3(0.0);
  float transmittance = 1.0;
  int samples = 0;

  float t = start + baseStep * offset * START_AMP;
  // 密度ゼロの区間は大股で飛ばす。空振りに時間を使わない。
  // 距離による伸びを抑えたぶん、ここを強めて到達距離を確保する
  int consecutiveEmpty = 0;
  bool lastWasSkip = false;

  bool exhausted = false;
  // ループの上限。maxSteps より大きくしておく。等しいと i >= maxSteps に
  // 達する前にループが終わり、打ち切りの検出が働かない
  for (int i = 0; i < 512; i++) {
    if (t >= end || transmittance < EXIT_TRANSMITTANCE) break;
    // 歩数を使い切って止まると、止まる位置が空振りの歩数で決まるため
    // カメラの移動で前後する。遠くの雲が現れたり消えたりする形で見える
    if (i >= maxSteps) { exhausted = true; break; }

    // 距離による伸びはごく緩やかにする。
    //
    // 到達距離を稼ぐために伸びを速くしていたが、20 km 先で 1 歩 240 m に
    // なり、手前の 4 倍以上粗く刻んでいた。遠方だけ粒立って見えるのは
    // これが原因（実機で指摘を受けて判明）。
    //
    // 距離は下の大股送りで稼ぐ。雲の中では細かい刻みを保ち、
    // 何もない区間だけ飛ばすほうが、同じステップ数で密度の解像度が上がる。
    float stepSize = baseStep * (1.0 + t / stepGrowthScale);

    vec3 p = cameraPositionWorld + rayDirection * t;
    // 解像できる距離でだけディテールを効かせる
    float detailStrength = useDetail
      ? 1.0 - smoothstep(DETAIL_NEAR, DETAIL_FAR, t)
      : 0.0;
    float density = sampleCloudDensity(p, detailStrength);
    samples++;

    if (density > 0.0) {
      // 大股で飛び越した直後なら戻して細かい歩幅で入り直す。
      //
      // 戻さないと雲への進入面が大股の刻み（55 m × 8）に丸められ、
      // 大股を強めた意味がなくなる。実測で、戻しなしの skip16 は比が
      // 1.643 のまま変わらなかった。
      if (lastWasSkip) {
        t -= stepSize * (EMPTY_SKIP - 1.0);
        lastWasSkip = false;
        consecutiveEmpty = -3;
        continue;
      }
      consecutiveEmpty = 0;
      lastWasSkip = false;

      // 光マーチは 1 歩あたりの費用の大半を占める。主マーチは 96 歩で
      // 上限が決まっているので、変動するのはこちらだけ。1 歩あたり最大
      // 6 サンプル増えるため、最悪ケースの 85% がここで決まる。
      //
      // 削り方は3つ。太陽方向の光学的厚みは雲の形の周期（4.2 km、細部でも
      // 700 m）に比べてゆっくり変わるので、歩幅ごとに測り直す必要がない。
      // 遠方では自己遮蔽の細かさが見えないので段数も落とす。透過率が
      // 下がったあとは寄与自体が小さいので測り直さない。
      // 距離ごとに測り直す間隔を空けて使い回す案は捨てた。値が階段状に
      // 変わり、切り替わる位置が視線の高さで決まるので、消したい横縞
      // そのものを作る。実測で縦横の段差比が 1.477 から 2.271 へ悪化した。
      // 段数を落とすほうは値が滑らかに変わるので、こちらを採る。
      int lightN = t < LIGHT_FULL_DISTANCE
        ? lightSteps
        : (t < LIGHT_HALF_DISTANCE ? (lightSteps + 1) / 2 : 2);
      float tauToSun = lightOpticalDepth(p, lightN, samples);

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
      // 空振りが続いたら歩幅を伸ばす。雲に当たったら細かい歩幅へ戻る。
      // 雲の縁を跨いで飛び越さないよう、1 歩は様子を見てから加速する
      bool skip = consecutiveEmpty > 1;
      t += stepSize * (skip ? EMPTY_SKIP : 1.0);
      lastWasSkip = skip;
    }
  }

  if (probeMode == 1) {
    // 整数のまま 8bit 二つに分ける。v/255 は UNORM の丸めで厳密に戻る
    float c = float(min(samples, 65535));
    fragColor = vec4(floor(c / 256.0) / 255.0, mod(c, 256.0) / 255.0, 0.0, 1.0);
    return;
  }
  if (probeMode == 2) {
    fragColor = vec4(0.0, exhausted ? 1.0 : 0.0, 0.0, 1.0);
    return;
  }

  float alpha = clamp(1.0 - transmittance, 0.0, 1.0);
  // overlay は乗算済みアルファで合成される
  fragColor = vec4(scattered, alpha);
}
