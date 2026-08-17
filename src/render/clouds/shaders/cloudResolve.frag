precision highp float;

/**
 * 雲のレイマーチ結果をフレーム間で足し込む。
 *
 * 1 フレームぶんのマーチには、どうしても消せない誤差が残る。歩幅の量子化で
 * 薄い雲が水平な板に割れ、歩数を使い切った視線は途中で止まって遠くの雲が
 * 現れたり消えたりする。歩数を増やしても割に合わない（実測で 96 歩から
 * 192 歩にしても打ち切りは 0.44% から 0.37% にしか減らず、費用は倍）。
 *
 * 誤差の出方をフレームごとにずらして平均すれば、これらは滑らかに均される。
 * ずらすのはマーチの開始位置と画素内の位置で、いずれもフレーム番号から
 * 決まるので決定論は保たれる。
 *
 * 前フレームの結果は、そのまま重ねると機体の移動でずれる。雲層との交点を
 * 使って前フレームの画面座標へ投影し直してから重ねる。雲は高度 1,200 m
 * から 4,500 m の板なので、交点だけで十分な近さになる。
 */

uniform sampler2D currentFrame;
uniform sampler2D historyFrame;

uniform mat4 inverseProjectionMatrix;
uniform mat4 inverseViewMatrix;
uniform mat4 previousViewProjection;
uniform vec3 cameraPositionWorld;
uniform vec3 previousCameraPosition;

/** 現フレームを混ぜる割合。1 なら履歴を使わない */
uniform float blendWeight;
/** テクセルの大きさ。近傍を舐めるのに使う */
uniform vec2 texelSize;
/**
 * 近傍で挟む幅の倍率。
 *
 * 0 なら挟まない。挟むのは動きに追従できなかった履歴が尾を引くのを
 * 止めるためだが、狭く挟むと現フレームの段差の範囲へ履歴が引き戻され、
 * 平均で均す効果そのものが消える。
 */
uniform float clampScale;

const float CLOUD_BOTTOM = 1200.0;
const float CLOUD_TOP = 4500.0;

in vec2 vUv;
out vec4 fragColor;

/** 視線と雲層の交わり。再投影に使う代表距離を返す */
float slabDistance(vec3 origin, vec3 direction) {
  float dirY = direction.y;
  if (abs(dirY) < 1e-5) return 8000.0;

  float toBottom = (CLOUD_BOTTOM - origin.y) / dirY;
  float toTop = (CLOUD_TOP - origin.y) / dirY;
  float near = max(min(toBottom, toTop), 0.0);
  float far = max(toBottom, toTop);
  if (far <= 0.0) return 8000.0;

  // 区間の手前寄りを代表点にする。雲は入り口の付近に濃さが集まる
  return mix(near, min(far, 26000.0), 0.35);
}

void main() {
  vec4 current = texture(currentFrame, vUv);

  if (blendWeight >= 1.0) {
    fragColor = current;
    return;
  }

  // 画素のワールド方向
  vec4 clip = vec4(vUv * 2.0 - 1.0, -1.0, 1.0);
  vec4 viewPos = inverseProjectionMatrix * clip;
  viewPos /= viewPos.w;
  vec3 rayDirection = normalize((inverseViewMatrix * vec4(viewPos.xyz, 0.0)).xyz);

  // 代表点を前フレームの画面へ投影する
  vec3 world = cameraPositionWorld + rayDirection * slabDistance(cameraPositionWorld, rayDirection);
  vec4 prevClip = previousViewProjection * vec4(world, 1.0);
  if (prevClip.w <= 0.0) {
    fragColor = current;
    return;
  }
  vec2 prevUv = prevClip.xy / prevClip.w * 0.5 + 0.5;

  // 画面の外へ出た履歴は使えない
  if (any(lessThan(prevUv, vec2(0.0))) || any(greaterThan(prevUv, vec2(1.0)))) {
    fragColor = current;
    return;
  }

  vec4 history = texture(historyFrame, prevUv);

  // 近傍の最小最大で挟む。
  //
  // 挟まないと、雲の縁で古い値が尾を引いて残る。3x3 の範囲に収めれば、
  // 動きの速い部分は履歴が捨てられて現フレームに寄る
  if (clampScale > 0.0) {
    vec4 minColor = current;
    vec4 maxColor = current;
    for (int y = -1; y <= 1; y++) {
      for (int x = -1; x <= 1; x++) {
        if (x == 0 && y == 0) continue;
        vec4 s = texture(currentFrame, vUv + vec2(float(x), float(y)) * texelSize);
        minColor = min(minColor, s);
        maxColor = max(maxColor, s);
      }
    }
    // 中心から広げて挟む。狭いと平均の効果が消える。
    // half は GLSL の予約語なので使えない
    vec4 mid = (minColor + maxColor) * 0.5;
    vec4 halfRange = (maxColor - minColor) * 0.5 * clampScale;
    history = clamp(history, mid - halfRange, mid + halfRange);
  }

  fragColor = mix(history, current, blendWeight);
}
