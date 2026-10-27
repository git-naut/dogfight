import {
  FloatType,
  LinearFilter,
  Mesh,
  OrthographicCamera,
  PlaneGeometry,
  RGBAFormat,
  RenderTarget,
  Scene,
  type Texture,
  Vector3,
} from 'three'
import { Fn, dot, normalWorldGeometry, normalize, smoothstep, texture, uniform, vec3 } from 'three/tsl'
import { NodeMaterial, type Node, type Renderer } from 'three/webgpu'
import {
  GROUND_RADIUS,
  MULTISCATTER_SIZE,
  SKY_ILLUMINANCE,
  SKY_VIEW_HEIGHT,
  SKY_VIEW_WIDTH,
  SUN_ILLUMINANCE,
  TRANSMITTANCE_HEIGHT,
  TRANSMITTANCE_WIDTH,
} from './reference'
import {
  multiscatterFragmentNode,
  sampleTransmittanceNode,
  skyViewFragmentNode,
  skyViewUvNode,
  transmittanceFragmentNode,
} from './skyNodes'

/**
 * 自前の空（段 S2a、`?sky=hillaire` の隠しの口）。
 *
 * 透過率と多重散乱の LUT は太陽の向きにもカメラにも依らないので、起動時に 1 回だけ
 * 焼く。空の見え方の LUT は太陽とカメラの高さで変わるので、毎フレーム焼く
 * （web-ocean と同じ分け方）。背景は空の見え方の LUT に空の輝度の尺度
 * （`SKY_ILLUMINANCE`）を掛けた値と、太陽の円盤。
 *
 * S2a では既定の絵を変えない。背景だけを差し替え、霞・環境反射・地形と海の照度は
 * takram のまま（S2b で一斉に切り替える）。月と星は描かない（ユーザーの決定）。
 */

/** 太陽の見かけの半径 rad（takram と web-ocean の値） */
const SUN_ANGULAR_RADIUS = 0.004675

export interface HillaireSky {
  /** `Scene.backgroundNode` に入れる */
  readonly backgroundNode: Node<'vec3'>
  /** 空の見え方の LUT を焼き直す。毎フレーム、場面を描く前に呼ぶ */
  update(renderer: Renderer, cameraAltitudeMeters: number, sunDirectionWorld: Vector3): void
  dispose(): void
}

function floatTarget(width: number, height: number, name: string): RenderTarget {
  const target = new RenderTarget(width, height, {
    format: RGBAFormat,
    type: FloatType,
    depthBuffer: false,
    stencilBuffer: false,
  })
  target.texture.minFilter = LinearFilter
  target.texture.magFilter = LinearFilter
  target.texture.generateMipmaps = false
  target.texture.name = name
  return target
}

/** 全画面のクアッドへ 1 枚焼く。材質は呼び出し側が持ち続ける */
function quadFor(material: NodeMaterial, name: string) {
  const scene = new Scene()
  scene.name = name
  const camera = new OrthographicCamera(-1, 1, 1, -1, 0, 1)
  const geometry = new PlaneGeometry(2, 2)
  scene.add(new Mesh(geometry, material))
  return {
    render(renderer: Renderer, target: RenderTarget) {
      renderer.setRenderTarget(target)
      renderer.render(scene, camera)
      renderer.setRenderTarget(null)
    },
    dispose() {
      geometry.dispose()
      material.dispose()
    },
  }
}

function fragmentMaterial(node: Node<'vec4'>): NodeMaterial {
  const material = new NodeMaterial()
  ;(material as unknown as { fragmentNode: unknown }).fragmentNode = node
  material.depthTest = false
  material.depthWrite = false
  return material
}

export function createHillaireSky(renderer: Renderer): HillaireSky {
  const transmittance = floatTarget(TRANSMITTANCE_WIDTH, TRANSMITTANCE_HEIGHT, 'SkyTransmittance')
  const multiscatter = floatTarget(MULTISCATTER_SIZE, MULTISCATTER_SIZE, 'SkyMultiscatter')
  const skyView = floatTarget(SKY_VIEW_WIDTH, SKY_VIEW_HEIGHT, 'SkyView')

  // 起動時に 1 回だけ焼く
  const transmittanceQuad = quadFor(fragmentMaterial(transmittanceFragmentNode()), 'Sky [ Transmittance ]')
  transmittanceQuad.render(renderer, transmittance)
  const multiscatterQuad = quadFor(
    fragmentMaterial(multiscatterFragmentNode(transmittance.texture)),
    'Sky [ Multiscatter ]',
  )
  multiscatterQuad.render(renderer, multiscatter)
  transmittanceQuad.dispose()
  multiscatterQuad.dispose()

  // 毎フレーム焼く。高さ km と太陽の天頂角の余弦は uniform で渡す
  const altitude = uniform(0)
  const sunMu = uniform(0.5)
  const sunDir = uniform(new Vector3(0, 1, 0))
  const skyViewQuad = quadFor(
    fragmentMaterial(
      skyViewFragmentNode(
        transmittance.texture as Texture,
        multiscatter.texture as Texture,
        altitude as unknown as Node<'float'>,
        sunMu as unknown as Node<'float'>,
      ),
    ),
    'Sky [ View ]',
  )

  const scaleSky = vec3(SKY_ILLUMINANCE[0], SKY_ILLUMINANCE[1], SKY_ILLUMINANCE[2])
  const scaleSun = vec3(SUN_ILLUMINANCE[0], SUN_ILLUMINANCE[1], SUN_ILLUMINANCE[2])
  const backgroundNode = Fn(() => {
    const dir = normalize(normalWorldGeometry)
    const sd = sunDir as unknown as Node<'vec3'>
    const alt = altitude as unknown as Node<'float'>
    const sky = texture(skyView.texture, skyViewUvNode(dir as never, sd, alt), 0).rgb.mul(scaleSky)
    // 太陽の円盤。放射輝度 = 照度 / (π θ²)。縁は 1 画素ぶんぼかす
    const cosSun = dot(dir, sd)
    const disc = smoothstep(Math.cos(SUN_ANGULAR_RADIUS * 1.15), Math.cos(SUN_ANGULAR_RADIUS), cosSun)
    const sunT = sampleTransmittanceNode(
      transmittance.texture,
      alt.add(GROUND_RADIUS),
      sd.y,
    )
    const sunRadiance = scaleSun.mul(sunT).div(Math.PI * SUN_ANGULAR_RADIUS * SUN_ANGULAR_RADIUS)
    return sky.add(sunRadiance.mul(disc))
  })() as unknown as Node<'vec3'>

  return {
    backgroundNode,
    update(r, cameraAltitudeMeters, sunDirectionWorld) {
      altitude.value = Math.max(cameraAltitudeMeters, 0) / 1000
      sunMu.value = sunDirectionWorld.y
      ;(sunDir.value as Vector3).copy(sunDirectionWorld)
      skyViewQuad.render(r, skyView)
    },
    dispose() {
      skyViewQuad.dispose()
      transmittance.dispose()
      multiscatter.dispose()
      skyView.dispose()
    },
  }
}
