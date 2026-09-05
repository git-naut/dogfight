import {
  ClampToEdgeWrapping,
  DataTexture,
  GLSL3,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RedFormat,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type Texture,
  type WebGLRenderer,
} from 'three'
import terrainSurfaceGlsl from './shaders/terrainSurface.glsl?raw'
import waterSurfaceGlsl from './shaders/waterSurface.glsl?raw'
import heightfieldGlsl from './shaders/heightfield.glsl?raw'
import {
  SURFACE_PROBE_SHADOW_CENTER,
  SURFACE_PROBE_SHADOW_EXTENT,
  SURFACE_PROBE_SHADOW_SIZE,
  SURFACE_PROBE_SIDE,
  SURFACE_PROBE_SKY_RADIANCE,
  SURFACE_PROBE_SUN_DIRECTION,
  SURFACE_PROBE_SUN_RADIANCE,
  SURFACE_PROBE_WAVE_TIME,
  TERRAIN_PROBE_REGION,
  WATER_PROBE_REGIONS,
  surfaceProbeShadowData,
} from './surfaceProbe'

/**
 * 地表と海面の GLSL 版を焼く。
 *
 * **チャンクは import した文字列をそのまま貼る。**`ShaderChunk` の登録に
 * 頼ると、登録する側（`terrainMesh.ts`）を読み込む順に左右される。
 * 固定入力の正本は `surfaceProbe.ts`。
 */

/** 雲影マップの代わり。中身は `surfaceProbe.ts` が決める */
export function createSurfaceProbeShadowTexture(): DataTexture {
  const size = SURFACE_PROBE_SHADOW_SIZE
  const texture = new DataTexture(
    surfaceProbeShadowData(),
    size,
    size,
    RedFormat,
    UnsignedByteType,
  )
  texture.minFilter = LinearFilter
  texture.magFilter = LinearFilter
  texture.wrapS = ClampToEdgeWrapping
  texture.wrapT = ClampToEdgeWrapping
  texture.generateMipmaps = false
  texture.needsUpdate = true
  return texture
}

export interface SurfaceProbeUniforms {
  heightMap: Texture
  terrainNormalMap: Texture
  terrainExtent: number
  terrainTexels: number
  cloudShadowMap: Texture
}

/** 共有のユニフォーム。GLSL 側の 2 つの材質が同じものを読む */
function sharedUniforms(inputs: SurfaceProbeUniforms): Record<string, { value: unknown }> {
  return {
    heightMap: { value: inputs.heightMap },
    terrainNormalMap: { value: inputs.terrainNormalMap },
    terrainExtent: { value: inputs.terrainExtent },
    terrainTexels: { value: inputs.terrainTexels },
    // 機体の影は引数で渡すので、`heightfield.glsl` の側は切っておく
    aircraftShadowMap: { value: null },
    aircraftShadowMatrix: { value: null },
    aircraftShadowEnabled: { value: 0 },
    aircraftShadowTexel: { value: 1 / 1024 },
    cloudShadowMap: { value: inputs.cloudShadowMap },
    cloudShadowCenter: {
      value: new Vector2(
        SURFACE_PROBE_SHADOW_CENTER.x,
        SURFACE_PROBE_SHADOW_CENTER.z,
      ),
    },
    cloudShadowExtent: { value: SURFACE_PROBE_SHADOW_EXTENT },
    cloudShadowEnabled: { value: 1 },
    sunDirectionWorld: {
      value: new Vector3(
        SURFACE_PROBE_SUN_DIRECTION.x,
        SURFACE_PROBE_SUN_DIRECTION.y,
        SURFACE_PROBE_SUN_DIRECTION.z,
      ),
    },
    sunRadiance: {
      value: new Vector3(
        SURFACE_PROBE_SUN_RADIANCE.x,
        SURFACE_PROBE_SUN_RADIANCE.y,
        SURFACE_PROBE_SUN_RADIANCE.z,
      ),
    },
    skyRadiance: {
      value: new Vector3(
        SURFACE_PROBE_SKY_RADIANCE.x,
        SURFACE_PROBE_SKY_RADIANCE.y,
        SURFACE_PROBE_SKY_RADIANCE.z,
      ),
    },
  }
}

/** 矩形と uv からワールド座標を組む GLSL。両側で同じ式を使う */
const WORLD_FROM_UV = /* glsl */ `
  uniform vec2 regionOrigin;
  uniform float regionSpan;
  uniform vec3 probeCamera;
  in vec2 vUv;
  out vec4 fragColor;

  vec2 probeWorldXZ() {
    float side = ${SURFACE_PROBE_SIDE}.0;
    float col = floor(vUv.x * side);
    float row = floor(vUv.y * side);
    return regionOrigin + vec2((col + 0.5) / side, (row + 0.5) / side) * regionSpan;
  }
`

const VERTEX = /* glsl */ `
  out vec2 vUv;
  void main() {
    vUv = uv;
    gl_Position = vec4(position.xy, 0.0, 1.0);
  }
`

function drawProbe(
  renderer: WebGLRenderer,
  material: ShaderMaterial,
): number[] {
  const side = SURFACE_PROBE_SIDE
  const scene = new Scene()
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const target = new WebGLRenderTarget(side, side, {
    format: RGBAFormat,
    type: UnsignedByteType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: false,
    stencilBuffer: false,
  })

  const previous = renderer.getRenderTarget()
  const buffer = new Uint8Array(side * side * 4)
  try {
    renderer.setRenderTarget(target)
    renderer.render(scene, camera)
    renderer.readRenderTargetPixels(target, 0, 0, side, side, buffer)
  } finally {
    renderer.setRenderTarget(previous)
    geometry.dispose()
    material.dispose()
    target.dispose()
  }
  return [...buffer]
}

/**
 * 地表を 1 枚焼いて読み戻す。GLSL 版。
 *
 * @param branchMode 枝の絵を出すか。false なら色
 */
export function renderTerrainSurfaceProbe(
  renderer: WebGLRenderer,
  inputs: SurfaceProbeUniforms,
  branchMode: boolean,
  detailNormals = true,
): number[] {
  const region = TERRAIN_PROBE_REGION
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      ...sharedUniforms(inputs),
      regionOrigin: { value: new Vector2(region.origin.x, region.origin.z) },
      regionSpan: { value: region.span },
      probeCamera: {
        value: new Vector3(region.camera.x, region.camera.y, region.camera.z),
      },
      detailNormals: { value: detailNormals },
      branchMode: { value: branchMode },
    },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2D;
      ${heightfieldGlsl}
      uniform vec3 sunRadiance;
      uniform vec3 skyRadiance;
      ${terrainSurfaceGlsl}
      ${WORLD_FROM_UV}
      uniform bool detailNormals;
      uniform bool branchMode;

      void main() {
        vec2 worldXZ = probeWorldXZ();
        vec3 world = vec3(worldXZ.x, terrainHeight(worldXZ), worldXZ.y);
        vec3 branches;
        vec3 color = terrainSurfaceColor(
          world, probeCamera, detailNormals, 1.0, branches
        );
        fragColor = vec4(branchMode ? branches : color, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  })
  return drawProbe(renderer, material)
}

/** 海面を 1 枚焼いて読み戻す。GLSL 版 */
export function renderWaterSurfaceProbe(
  renderer: WebGLRenderer,
  inputs: SurfaceProbeUniforms,
  regionIndex: number,
  branchMode: boolean,
  waterSpecular = true,
): number[] {
  const region = WATER_PROBE_REGIONS[regionIndex]
  if (region === undefined) return []
  const material = new ShaderMaterial({
    glslVersion: GLSL3,
    uniforms: {
      ...sharedUniforms(inputs),
      regionOrigin: { value: new Vector2(region.origin.x, region.origin.z) },
      regionSpan: { value: region.span },
      probeCamera: {
        value: new Vector3(region.camera.x, region.camera.y, region.camera.z),
      },
      waveTime: { value: SURFACE_PROBE_WAVE_TIME },
      waterSpecular: { value: waterSpecular },
      branchMode: { value: branchMode },
    },
    vertexShader: VERTEX,
    fragmentShader: /* glsl */ `
      precision highp float;
      precision highp sampler2D;
      ${heightfieldGlsl}
      uniform vec3 sunRadiance;
      uniform vec3 skyRadiance;
      ${waterSurfaceGlsl}
      ${WORLD_FROM_UV}
      uniform float waveTime;
      uniform bool waterSpecular;
      uniform bool branchMode;

      void main() {
        vec2 worldXZ = probeWorldXZ();
        // 海面は高度 0 の平らな板
        vec3 world = vec3(worldXZ.x, 0.0, worldXZ.y);
        vec4 branches;
        vec3 color = waterSurfaceColor(
          world, probeCamera, waveTime, waterSpecular, 1.0, branches
        );
        fragColor = branchMode ? branches : vec4(color, 1.0);
      }
    `,
    depthTest: false,
    depthWrite: false,
  })
  return drawProbe(renderer, material)
}
