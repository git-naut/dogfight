import * as THREE from 'three'
import type { AircraftSample } from '../sim/aircraft'
import type { LookOffset } from '../input/mouseLook'
import { createChaseCamera, type ChaseCamera } from './camera'
import { createAircraftView, type AircraftView } from './aircraftView'

/**
 * Phase 1 の暫定シーン。
 *
 * 空は縦方向のグラデーション、地面は平面とグリッド。物理的に正しい大気散乱は
 * Phase 2 で @takram/three-atmosphere に、起伏のある地形とボリュメトリック雲は
 * Phase 3 で差し替える。
 *
 * ここで必要なのは飛行モデルを検証できるだけの手がかり。高度と速度と姿勢が
 * 読み取れればよい。
 */

const HORIZON_COLOR = new THREE.Color(0x9fc0d8)
const ZENITH_COLOR = new THREE.Color(0x2a5f96)
// グリッド線とのコントラストを稼ぐため、地面は暗めに置く
const GROUND_COLOR = new THREE.Color(0x1e2c22)

/** グリッドの目盛り間隔 m。速度の目安になる */
const GRID_SPACING = 400
const GRID_EXTENT = 40_000
const GROUND_EXTENT = 300_000

export interface SceneHandle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  chase: ChaseCamera
  /** sim の状態を描画へ反映する */
  sync(sample: AircraftSample, dt: number, look: LookOffset, snap?: boolean): void
  render(): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // Phase 2 で SMAA に置き換える
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(HORIZON_COLOR, 1)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(HORIZON_COLOR, 6000, 55_000)

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 400_000)
  const chase = createChaseCamera(camera)

  const sun = new THREE.DirectionalLight(0xfff0dc, 2.6)
  sun.position.set(-0.42, 0.78, 0.46).normalize()
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0xbcd8f0, 0x40503a, 1.0))

  const sky = createSkyDome()
  scene.add(sky.mesh)

  const ground = createGround()
  scene.add(ground)

  const aircraft: AircraftView = createAircraftView()
  scene.add(aircraft.object)

  const quaternion = new THREE.Quaternion()

  return {
    renderer,
    scene,
    camera,
    chase,

    sync(sample, dt, look, snap = false) {
      aircraft.object.position.set(
        sample.position.x,
        sample.position.y,
        sample.position.z,
      )
      quaternion.set(
        sample.orientation.x,
        sample.orientation.y,
        sample.orientation.z,
        sample.orientation.w,
      )
      aircraft.object.quaternion.copy(quaternion)
      aircraft.setThrottle(sample.throttle)

      // 地面と空を機体に追従させて、有限のジオメトリで無限に見せる。
      // グリッド模様はワールド座標で描くので、板が動いても線は流れない
      ground.position.x = sample.position.x
      ground.position.z = sample.position.z
      sky.mesh.position.copy(camera.position)

      if (snap) chase.snap(sample, look)
      else chase.update(sample, dt, look)
    },

    render() {
      renderer.render(scene, camera)
    },

    resize(width, height, pixelRatio) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },

    dispose() {
      aircraft.dispose()
      sky.dispose()
      ground.geometry.dispose()
      ;(ground.material as THREE.Material).dispose()
      renderer.dispose()
    },
  }
}

/**
 * 地面。グリッドは別のジオメトリを重ねず、地面のシェーダに直接焼く。
 *
 * 線の板を地面の少し上に置く方式だと、遠距離で深度精度が足りなくなって
 * 線が消える。ワールド座標から模様を計算すれば深度の競合が起きないし、
 * fwidth でアンチエイリアスもかかり、距離フェードも入れられる。
 *
 * 照明とフォグを効かせたいので MeshStandardMaterial に差し込む。
 */
function createGround(): THREE.Mesh {
  const material = new THREE.MeshStandardMaterial({
    color: GROUND_COLOR,
    roughness: 1,
    metalness: 0,
  })

  material.onBeforeCompile = (shader) => {
    shader.uniforms['minorSpacing'] = { value: GRID_SPACING }
    shader.uniforms['majorSpacing'] = { value: GRID_SPACING * 5 }
    shader.uniforms['minorColor'] = { value: new THREE.Color(0x74a98d) }
    shader.uniforms['majorColor'] = { value: new THREE.Color(0xcfeadb) }
    shader.uniforms['gridFadeStart'] = { value: 9_000 }
    shader.uniforms['gridFadeEnd'] = { value: GRID_EXTENT }

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGroundWorldPos;')
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvGroundWorldPos = (modelMatrix * vec4(transformed, 1.0)).xyz;',
      )

    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        /* glsl */ `
        #include <common>
        varying vec3 vGroundWorldPos;
        uniform float minorSpacing;
        uniform float majorSpacing;
        uniform vec3 minorColor;
        uniform vec3 majorColor;
        uniform float gridFadeStart;
        uniform float gridFadeEnd;

        // 線からの距離をピクセル単位で測り、1 px 前後の幅に収める
        float gridMask(vec2 worldXZ, float spacing, float widthPx) {
          vec2 coord = worldXZ / spacing;
          vec2 derivative = fwidth(coord);
          vec2 distanceToLine = abs(fract(coord - 0.5) - 0.5) / max(derivative, vec2(1e-6));
          float nearest = min(distanceToLine.x, distanceToLine.y);
          return 1.0 - clamp(nearest / widthPx, 0.0, 1.0);
        }
        `,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `
        #include <map_fragment>
        {
          float toCamera = distance(vGroundWorldPos.xz, cameraPosition.xz);
          float fade = 1.0 - smoothstep(gridFadeStart, gridFadeEnd, toCamera);
          float minorLine = gridMask(vGroundWorldPos.xz, minorSpacing, 1.1) * 0.5;
          float majorLine = gridMask(vGroundWorldPos.xz, majorSpacing, 1.6) * 0.95;
          diffuseColor.rgb = mix(diffuseColor.rgb, minorColor, minorLine * fade);
          diffuseColor.rgb = mix(diffuseColor.rgb, majorColor, majorLine * fade);
        }
        `,
      )
  }

  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(GROUND_EXTENT, GROUND_EXTENT),
    material,
  )
  mesh.rotation.x = -Math.PI / 2
  return mesh
}

/**
 * 空のドーム。視線の高さで水平線色と天頂色を混ぜるだけの簡易版。
 *
 * 大気散乱ではないので朝焼けも夕景も出ないが、水平線の位置が読めるので
 * 姿勢の確認には足りる。Phase 2 で置き換える。
 */
function createSkyDome(): { mesh: THREE.Mesh; dispose: () => void } {
  const geometry = new THREE.SphereGeometry(1, 24, 16)
  const material = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    uniforms: {
      horizonColor: { value: HORIZON_COLOR },
      zenithColor: { value: ZENITH_COLOR },
      groundColor: { value: GROUND_COLOR },
    },
    vertexShader: /* glsl */ `
      varying vec3 vDirection;
      void main() {
        vDirection = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 horizonColor;
      uniform vec3 zenithColor;
      uniform vec3 groundColor;
      varying vec3 vDirection;

      void main() {
        float h = normalize(vDirection).y;
        // 水平線付近を滑らかに、上空へ向かって濃くする
        vec3 sky = mix(horizonColor, zenithColor, pow(clamp(h, 0.0, 1.0), 0.55));
        vec3 below = mix(horizonColor, groundColor, pow(clamp(-h, 0.0, 1.0), 0.35));
        gl_FragColor = vec4(h >= 0.0 ? sky : below, 1.0);
      }
    `,
  })

  const mesh = new THREE.Mesh(geometry, material)
  // カメラに追従させるので、遠クリップの内側に収まるスケールで十分
  mesh.scale.setScalar(180_000)
  mesh.renderOrder = -1
  mesh.frustumCulled = false

  return {
    mesh,
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}
