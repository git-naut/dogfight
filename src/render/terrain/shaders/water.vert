precision highp float;

/** 海面の板。ワールド座標をフラグメントへ渡すだけ */

out vec3 vWorld;

void main() {
  vWorld = (modelMatrix * vec4(position, 1.0)).xyz;
  gl_Position = projectionMatrix * viewMatrix * vec4(vWorld, 1.0);
}
