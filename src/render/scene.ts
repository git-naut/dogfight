import * as THREE from 'three'

/**
 * Phase 0 の暫定シーン。
 *
 * 空と大気は Phase 2、雲は Phase 3、機体は Phase 4 で入れ替える。
 * ここでは「WebGL コンテキストが取れて何かが描かれる」ことだけを保証する。
 */
export interface SceneHandle {
  renderer: THREE.WebGLRenderer
  scene: THREE.Scene
  camera: THREE.PerspectiveCamera
  /** シムの状態を受け取って描画状態へ反映する */
  sync(frame: number, alpha: number): void
  render(): void
  resize(width: number, height: number, pixelRatio: number): void
  dispose(): void
}

export function createScene(canvas: HTMLCanvasElement): SceneHandle {
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false, // ポストプロセス導入後は SMAA に任せるため切っておく
    powerPreference: 'high-performance',
  })
  renderer.setClearColor(0x0b1c2c, 1)

  const scene = new THREE.Scene()
  scene.fog = new THREE.Fog(0x0b1c2c, 200, 2000)

  const camera = new THREE.PerspectiveCamera(60, 16 / 9, 0.5, 20000)
  camera.position.set(0, 30, 80)
  camera.lookAt(0, 10, 0)

  const sun = new THREE.DirectionalLight(0xfff2e0, 2.2)
  sun.position.set(-120, 180, 90)
  scene.add(sun)
  scene.add(new THREE.HemisphereLight(0x88bbff, 0x2b3a1f, 0.6))

  // 地面の代わりのグリッド。高度感と速度感の確認用。
  const grid = new THREE.GridHelper(4000, 80, 0x3a6ea5, 0x1e3a52)
  scene.add(grid)

  // 機体の代わりのプレースホルダ。回転させて描画が動いていることを見る。
  const placeholder = new THREE.Mesh(
    new THREE.ConeGeometry(3, 14, 16),
    new THREE.MeshStandardMaterial({ color: 0xc8d4de, roughness: 0.35, metalness: 0.7 }),
  )
  placeholder.rotation.x = Math.PI / 2
  placeholder.position.set(0, 20, 0)
  scene.add(placeholder)

  const pivot = new THREE.Group()
  scene.add(pivot)
  pivot.add(placeholder)

  return {
    renderer,
    scene,
    camera,

    sync(frame: number, alpha: number) {
      // 補間込みの連続時間。alpha を使うことで 120Hz 未満でも滑らかに回る。
      const t = (frame + alpha) / 120
      pivot.rotation.y = t * 0.6
      placeholder.position.y = 20 + Math.sin(t * 1.2) * 4
    },

    render() {
      renderer.render(scene, camera)
    },

    resize(width: number, height: number, pixelRatio: number) {
      renderer.setPixelRatio(pixelRatio)
      renderer.setSize(width, height, false)
      camera.aspect = width / height
      camera.updateProjectionMatrix()
    },

    dispose() {
      renderer.dispose()
    },
  }
}
