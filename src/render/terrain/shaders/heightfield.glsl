// 高さ場のサンプルと雲影の適用。地形と海面で共有する。
//
// 双三次の式は src/sim/terrain.ts の catmullRom と同じにする。ここがずれると
// 「見えている山と当たる山が違う」状態になり、高さ場を sim に持たせた意味が
// なくなる。sim 側は格子点で焼いた値と一致することをテストで見ている。

uniform sampler2D heightMap;
uniform sampler2D terrainNormalMap;
/** 高さ場が覆う world の一辺 m */
uniform float terrainExtent;
/** 高さ場の一辺のテクセル数 */
uniform float terrainTexels;

/**
 * 機体の影。
 *
 * three が焼いた指向光の影マップを引く。種類は BasicShadowMap にしてある
 * （aircraftShadow.ts）。深度テクスチャに比較モードが付かないので、ただの
 * sampler2D で r 成分を読める。PCFShadowMap だと比較モードが付き、
 * GL_INVALID_OPERATION: Mismatch between texture format and sampler type で
 * 描画そのものが捨てられた。
 *
 * 縁が硬くならないよう 2x2 で平均する。
 *
 * 行列は light.shadow.matrix で、world から [0,1]³ の影空間へ写す。
 * 影マップは機体を囲む 28 m 角しか覆っていない。範囲外は日向として扱う。
 */
uniform sampler2D aircraftShadowMap;
uniform mat4 aircraftShadowMatrix;
uniform float aircraftShadowEnabled;
/** 影マップの 1 テクセルの大きさ */
uniform float aircraftShadowTexel;

uniform sampler2D cloudShadowMap;
uniform vec2 cloudShadowCenter;
uniform float cloudShadowExtent;
uniform float cloudShadowEnabled;
uniform vec3 sunDirectionWorld;

/** 格子の値。範囲外は縁で止める。島は縁から離してあるので海底が返る */
float terrainTexelAt(ivec2 coord) {
  int last = int(terrainTexels) - 1;
  return texelFetch(heightMap, clamp(coord, ivec2(0), ivec2(last)), 0).r;
}

/** t=0 で p1 を厳密に返す。格子点では焼いた値と一致する */
float terrainCatmullRom(float p0, float p1, float p2, float p3, float t) {
  float t2 = t * t;
  float t3 = t2 * t;
  return p1
    + 0.5 * t * (p2 - p0)
    + 0.5 * t2 * (2.0 * p0 - 5.0 * p1 + 4.0 * p2 - p3)
    + 0.5 * t3 * (-p0 + 3.0 * p1 - 3.0 * p2 + p3);
}

/**
 * 双三次で引いた高さ m。
 *
 * 線形補間だと稜線が 48 m 刻みの折れ線になり、近距離で目に見える。
 * フィルタは最近傍にしてあるので、ハードウェアの補間と二重に掛からない。
 */
float terrainHeight(vec2 world) {
  float halfExtent = terrainExtent * 0.5;
  float texel = terrainExtent / terrainTexels;
  vec2 grid = (world + halfExtent) / texel - 0.5;
  vec2 base = floor(grid);
  ivec2 origin = ivec2(base);
  vec2 t = grid - base;

  float rows[4];
  for (int r = -1; r <= 2; r++) {
    rows[r + 1] = terrainCatmullRom(
      terrainTexelAt(origin + ivec2(-1, r)),
      terrainTexelAt(origin + ivec2(0, r)),
      terrainTexelAt(origin + ivec2(1, r)),
      terrainTexelAt(origin + ivec2(2, r)),
      t.x
    );
  }
  return terrainCatmullRom(rows[0], rows[1], rows[2], rows[3], t.y);
}

/**
 * いちばん近いテクセルの高さ m。1 タップ。
 *
 * 海面が浅瀬かどうかを判定するためだけに使う。48 m の粗さで足りる用途に
 * 16 タップの双三次を掛けると、水平線まで覆う板の全画素でそれを払うことに
 * なる。実測で GPU 時間の主因がここだった。
 */
float terrainHeightNearest(vec2 world) {
  float halfExtent = terrainExtent * 0.5;
  float texel = terrainExtent / terrainTexels;
  vec2 grid = (world + halfExtent) / texel - 0.5;
  return terrainTexelAt(ivec2(floor(grid + 0.5)));
}

/** 焼いた法線。双三次で 4 回引くと 1 画素 64 タップになるので焼いてある */
vec3 terrainNormal(vec2 world) {
  vec2 uv = (world + terrainExtent * 0.5) / terrainExtent;
  return normalize(texture(terrainNormalMap, uv).xyz * 2.0 - 1.0);
}

/**
 * 雲影の明るさ 0..1。1 なら日向。
 *
 * 影マップは「(x, 0, z) から太陽へ向かう光線の透過率」を持っている。標高 h の
 * 点が欲しい値は、同じ光線を y=0 まで延ばした足元の値と一致する。雲底より下に
 * 雲はないので、これは近似ではなく厳密。ずらさないと太陽高度 30 度・標高
 * 500 m で約 866 m ずれ、山肌で影が合わなくなる。
 *
 * 縁はフェードさせる。硬く切ると、影の領域の境界が空中に四角い線として出る。
 * 影マップは 30 km 四方しか覆っていないので、地形が遠くまで見えると目に付く。
 */
/** 機体の影の明るさ 0..1。1 なら日向 */
float terrainAircraftShade(vec3 world) {
  if (aircraftShadowEnabled < 0.5) return 1.0;

  vec4 coord = aircraftShadowMatrix * vec4(world, 1.0);
  vec3 shadowUv = coord.xyz / coord.w;
  // 箱の外は日向。機体を囲む 28 m 角しか覆っていない
  if (
    shadowUv.x < 0.0 || shadowUv.x > 1.0 ||
    shadowUv.y < 0.0 || shadowUv.y > 1.0 ||
    shadowUv.z < 0.0 || shadowUv.z > 1.0
  ) {
    return 1.0;
  }

  float lit = 0.0;
  for (int y = 0; y < 2; y++) {
    for (int x = 0; x < 2; x++) {
      vec2 offset = (vec2(float(x), float(y)) - 0.5) * aircraftShadowTexel;
      float depth = texture(aircraftShadowMap, shadowUv.xy + offset).r;
      lit += shadowUv.z <= depth ? 1.0 : 0.0;
    }
  }
  lit *= 0.25;

  // 影でも真っ暗にはしない。空からの散乱光は届く
  return mix(0.35, 1.0, lit);
}

float terrainCloudShade(vec3 world) {
  if (cloudShadowEnabled < 0.5) return 1.0;

  vec2 offset = sunDirectionWorld.y > 0.05
    ? sunDirectionWorld.xz * (world.y / sunDirectionWorld.y)
    : vec2(0.0);
  vec2 uv = (world.xz - offset - cloudShadowCenter) / cloudShadowExtent + 0.5;

  vec2 edge = min(uv, 1.0 - uv);
  float inside = smoothstep(0.0, 0.07, min(edge.x, edge.y));
  if (inside <= 0.0) return 1.0;

  float shade = texture(cloudShadowMap, clamp(uv, 0.0, 1.0)).r;
  // 影でも真っ暗にはしない。空からの散乱光は雲があっても届く
  return mix(1.0, mix(0.42, 1.0, shade), inside);
}
