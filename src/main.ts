import { FixedStepDriver, FIXED_DT } from './sim/loop'
import { World, createWorldFromScript } from './sim/world'
import { createAircraftSample, type AircraftSample } from './sim/aircraft'
import { createTargetSample, type TargetSample } from './sim/target'
import { Vec3 } from './sim/vec3'
import { Quat } from './sim/quat'
import { getScript } from './sim/scripts'
import { spawnFromSpec } from './sim/replay'
import { createScene, createMissilePose, type MissilePose } from './render/scene'
import { runNodeProbe } from './render/pipeline/node'
import { tileMeans } from './render/clouds/geometry'
import {
  MARCH_PROBE_HEIGHT,
  MARCH_PROBE_WIDTH,
  byteDifference,
  marchExhaustedCount,
  marchSampleStats,
} from './render/clouds/marchProbe'
import { CAPTURE_CONVERGE_FRAMES } from './render/clouds/cloudsPass'
import {
  readCaptureConfig,
  isDebugEnabled,
  resolveControlMode,
  installTestHook,
  DEFAULT_SEED,
} from './render/capture'
import { getQuality, PerformanceGovernor, type PresetName } from './render/quality'
import { KeyboardInput } from './input/keyboard'
import { applyAssist, type ControlMode } from './sim/assist'
import { catapultLaunch } from './sim/carrierDeck'
import { LAUNCH_DISTANCE } from './sim/launch'
import { climbAngleOf } from './sim/ai/steering'
import { MouseLook } from './input/mouseLook'
import { createDebugPanel } from './hud/debugPanel'
import { createHud, createHudLock, type Hud, type HudArmament } from './hud/hud'
import { createResultPanel, type ResultPanel } from './hud/resultPanel'
import { createTitlePanel, type TitlePanel } from './hud/titlePanel'
import { createSettingsPanel, type SettingsPanel } from './hud/settingsPanel'
import { createPausePanel, type PausePanel } from './hud/pausePanel'
import { createGameAudio, type GameAudio } from './audio/audio'
import { probeAudio } from './audio/probe'
import {
  loadSettings,
  saveSettings,
  applyUrlOverrides,
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsStorage,
} from './hud/settings'
import { createMissileThreat } from './sim/weapons/warning'
import { showBenchPanel } from './hud/benchPanel'
import { runBenchSweep } from './render/bench'

const canvas = document.querySelector<HTMLCanvasElement>('#viewport')
const hudRoot = document.querySelector<HTMLElement>('#hud')
if (!canvas || !hudRoot) throw new Error('#viewport か #hud が見つからない')

/**
 * 起動中の表示。
 *
 * 大気の LUT が 4.1 MB あり、そのあと 3D ノイズを焼くので初回は数秒かかる。
 * 何も出さないと真っ黒の画面が続き、読み込み中なのか初期化に失敗したのか
 * 区別がつかない。実際に「ブラックアウトした」という報告が出た。
 */
const boot = document.querySelector<HTMLElement>('#boot')
const bootText = document.querySelector<HTMLElement>('#boot-text')
const setBoot = (text: string) => {
  if (bootText) bootText.textContent = text
}
const finishBoot = () => {
  if (!boot) return
  boot.classList.add('is-done')
  // DOM から外すところまでやる。フェード中の不透明度が撮影結果に混ざると、
  // 「同じフレームからは同じピクセル」という前提が崩れる。実際に決定論の
  // E2E が CI で落ちた。キャプチャモードは実時間を使わないので待たない
  if (capture.enabled) boot.remove()
  else window.setTimeout(() => boot.remove(), 500)
}

const capture = readCaptureConfig(window.location.search)

// 大気の LUT は tools/copy-atmosphere-assets.mjs が public/atmosphere/ へ置く。
// GitHub Pages ではサイトが /dogfight/ 配下に出るので BASE_URL を挟む
const TEXTURES_URL = `${import.meta.env.BASE_URL}atmosphere/`
// 機体は tools/ac3d-to-glb.mjs が public/aircraft/ へ置く
const AIRCRAFT_URL = `${import.meta.env.BASE_URL}aircraft/f18.glb`
const ENEMY_URL = `${import.meta.env.BASE_URL}aircraft/f16.glb`
const CARRIER_URL = `${import.meta.env.BASE_URL}aircraft/nimitz.glb`

const hook = installTestHook({
  frame: 0,
  captureReady: false,
  seed: DEFAULT_SEED,
  droppedSteps: 0,
  backend: '',
  webglVersion: 0,
  atmosphereReady: false,
  sunElevation: 0,
  sunRadiance: [0, 0, 0],
  skyRadiance: [0, 0, 0],
  noiseMs: 0,
  noiseStats: { min: 0, max: 0, mean: 0 },
  gpuFrameMs: 0,
  gpuCloudMs: 0,
  gpuTimerSupported: false,
  cloudHdrTarget: false,
  benchMs: 0,
  benchSweep: [],
  cloudSamples: { mean: 0, max: 0, p99: 0 },
  terrainMs: 0,
  terrainStats: { min: 0, max: 0, mean: 0 },
  terrainPatches: 0,
  terrainTriangles: 0,
  aircraftTriangles: 0,
  hudReady: false,
  hudSpeedKt: 0,
  hudAltitudeFt: 0,
  hudHeadingDeg: 0,
  hudFlightPathOnScreen: false,
  hudGunReticleOnScreen: false,
  targetCount: 0,
  targetInstances: 0,
  targetsAlive: 0,
  enemyCount: 0,
  enemyInstances: 0,
  enemiesAlive: 0,
  enemyTriangles: 0,
  enemySurfaces: 0,
  enemyAiStates: '',
  enemyClearance: 0,
  enemyIntegrityRatio: 0,
  enemySmoke: 0,
  enemyDamaged: 0,
  enemyRoundsFired: 0,
  enemyMissilesFired: 0,
  incomingMissiles: 0,
  missileWarning: false,
  missileBearing: 0,
  missileTimeToImpact: 0,
  flaresLeft: 0,
  controlMode: 'expert',
  missionOutcome: 'none',
  missionRemaining: 0,
  flaresBurning: 0,
  playerTaken: 0,
  playerIntegrity: 0,
  playerLosses: 0,
  bulletsInFlight: 0,
  tracersDrawn: 0,
  roundsFired: 0,
  hits: 0,
  kills: 0,
  rounds: 0,
  lockState: 'none',
  lockRange: 0,
  closingSpeed: 0,
  lockAngleDeg: 0,
  lockProgress: 0,
  hudLockBoxOnScreen: false,
  missilesInFlight: 0,
  missilesDrawn: 0,
  missilesFired: 0,
  missilesLeft: 0,
  explosionsAlive: 0,
  explosionsDrawn: 0,
  explosionCount: 0,
  dlzMax: 0,
  dlzNe: 0,
  dlzMin: 0,
  hudDlzBarShown: false,
  preset: capture.preset,
  hour: capture.hour,
  volume: 0,
  audioReady: false,
  programs: 0,
  compileMs: 0,
  gearDown: false,
  audioProbe: null,
  gpuProbe: null,
  noiseSlice: null,
  weatherSlice: null,
  shadowHistogram: null,
  shadowTiles: null,
  shadowInputs: null,
  marchProbe: null,
  spriteProbe: null,
  speed: 0,
  altitude: 0,
  agl: 0,
  groundHeight: 0,
  elevator: 0,
  aileron: 0,
  rudder: 0,
  aircraftSurfaces: 0,
  environmentReady: false,
  aircraftShadowReady: false,
  drawCalls: 0,
  drawnTriangles: 0,
  angleOfAttack: 0,
  bank: 0,
  crashed: false,
  script: capture.script,
})

const sample = createAircraftSample()

/**
 * 標的機の器。標的の数だけ使い回す。
 *
 * ワールドを作り直すと数が変わるので、そのつど合わせる。毎フレーム作ると
 * ゴミが増える
 */
let targetSamples: TargetSample[] = []

function fitTargetSamples(count: number): void {
  while (targetSamples.length < count) targetSamples.push(createTargetSample())
  if (targetSamples.length > count) targetSamples.length = count
}

/**
 * 敵機の状態。器は使い回す。
 *
 * 敵は `Aircraft` を持つので器も自機と同じ `AircraftSample`。舵面も軌跡も
 * 同じ経路で描ける。
 */
let enemySamples: AircraftSample[] = []

function fitEnemySamples(count: number): void {
  while (enemySamples.length < count) enemySamples.push(createAircraftSample())
  if (enemySamples.length > count) enemySamples.length = count
}

/**
 * 飛んでいるミサイルの姿勢。器は使い回す。
 *
 * サンプルには載せない。飛んでいるのは多くて 6 発だが、位置と姿勢を毎フレーム
 * 写すよりも、補間だけをここでやって描画へ渡すほうが素直。
 */
const missilePoses: MissilePose[] = []

/** 飛んでいるミサイルの補間した姿勢を集める。返すのは有効な本数 */
function collectMissilePoses(world: World, alpha: number): MissilePose[] {
  let count = 0
  // 敵のミサイルも描く。自機のぶんと同じ列に並べる
  for (const missile of world.combat.missileViews) {
    if (missile.state !== 'flying') continue
    while (missilePoses.length <= count) missilePoses.push(createMissilePose())
    const pose = missilePoses[count]!
    missile.sample(alpha, missileScratch.position, missileScratch.orientation)
    pose.position.set(
      missileScratch.position.x,
      missileScratch.position.y,
      missileScratch.position.z,
    )
    pose.quaternion.set(
      missileScratch.orientation.x,
      missileScratch.orientation.y,
      missileScratch.orientation.z,
      missileScratch.orientation.w,
    )
    count++
  }
  activeMissilePoses.length = 0
  for (let i = 0; i < count; i++) activeMissilePoses.push(missilePoses[i]!)
  return activeMissilePoses
}

/** sim 側の器。three へ写す前の受け皿 */
const missileScratch = { position: new Vec3(), orientation: new Quat() }
/** 描画へ渡す配列。長さが有効な本数になる */
const activeMissilePoses: MissilePose[] = []

/**
 * `localStorage` を取る。
 *
 * **アクセスそのものが投げる場合がある。**プライベートモードや site data を
 * 拒否する設定では `window.localStorage` を読んだ瞬間に `SecurityError` に
 * なる。取れなければ null を返し、設定はこのセッション限りになる
 */
function settingsStorage(): SettingsStorage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

/**
 * 起動時の設定。
 *
 * **キャプチャモードは `localStorage` を読まない。**開発者のブラウザに
 * 保存された画質や時刻で基準画像が変わってしまう。URL だけで絵が決まる
 * 状態を保つ
 */
const initialSettings: Settings = capture.enabled
  ? {
      ...DEFAULT_SETTINGS,
      preset: capture.preset,
      hour: capture.hour,
      controlMode: resolveControlMode(window.location.search),
    }
  : applyUrlOverrides(loadSettings(settingsStorage()), window.location.search)

async function main(): Promise<void> {
  // hook の初期値は `capture` から置いてある。ライブでは保存された設定が
  // 起点なので、シーンを作る前に合わせる
  hook.preset = initialSettings.preset
  hook.hour = initialSettings.hour

  // **音の自己診断。**`?audioprobe=1` のときだけ。絵には影響しないので
  // キャプチャの早期 return より前に置く。`OfflineAudioContext` なので
  // 実時間を待たず、1.5 秒ぶんの合成がミリ秒で終わる
  if (capture.audioProbe) {
    void probeAudio().then((result) => {
      hook.audioProbe = result as unknown as Record<
        string,
        { rms: number; peak: number }
      >
    })
  }

  // **node 経路の自己診断。**`?gpu=1` か `?gpu=2` のときだけ。第 2 経路を
  // 立てて glb を 1 枚描くところまでを確かめ、既定の経路には入らない。
  // 音の自己診断と同じく、絵とは別の目的で走らせるモード
  if (capture.gpu > 0) {
    setBoot('node 経路を立てています')
    // 大気の設定はプリセットから取る。**`?preset=` で振れるので、LUT の
    // 費用を段ごとに測れる**
    const quality = getQuality(initialSettings.preset)
    const probe = await runNodeProbe(canvas!, {
      gpu: capture.gpu,
      aircraftUrl: AIRCRAFT_URL,
      carrierUrl: CARRIER_URL,
      width: window.innerWidth,
      height: window.innerHeight,
      hour: initialSettings.hour,
      lutScale: quality.atmosphereLutScale,
      skyEnvironmentSize: quality.skyEnvironmentSize,
      raymarchScattering: quality.aerialRaymarchScattering,
      // **GLSL 側が実際に焼いた入力を渡す。**`?shadowprobe=1` で読み出した
      // ものをそのまま `?shadowinputs=` へ載せ替える。ここで導き直すと、
      // ヒストグラムの不一致が移植の欠陥なのか入力の違いなのか分からない
      shadowInputs: capture.shadowInputs,
      marchProbe: capture.marchProbe,
      heightProbe: capture.heightProbe,
      nodeShadow: capture.nodeShadow,
      spriteProbe: capture.spriteProbe,
      shadowFilter: quality.shadowFilter,
    })
    hook.gpuProbe = probe
    hook.backend = probe.backend
    hook.drawCalls = probe.drawCalls
    hook.drawnTriangles = probe.triangles
    hook.programs = probe.programs
    finishBoot()
    // **キャプチャの合図は出す。**E2E が同じ待ち方で拾えるようにする
    document.body.dataset['captureReady'] = '1'
    hook.captureReady = true
    return
  }

  setBoot('大気の散乱テーブルを読み込み中')
  const view = await createScene(canvas!, {
    preset: initialSettings.preset,
    hour: initialSettings.hour,
    texturesUrl: TEXTURES_URL,
    aircraftUrl: AIRCRAFT_URL,
    enemyUrl: ENEMY_URL,
    // **台本が空母を要求したときだけ読む。**基準画像 39 枚は空母の無い
    // 海を撮ってあるので、既定で置くと全件が差分を出す
    ...(getScript(capture.script).carrier !== undefined
      ? {
          carrierUrl: CARRIER_URL,
          carrier: getScript(capture.script).carrier!,
        }
      : {}),
    coverage: capture.coverage,
    qualityOverride: {
      ...(capture.cloudScale !== null ? { resolutionScale: capture.cloudScale } : {}),
      ...(capture.cloudSteps !== null ? { maxSteps: capture.cloudSteps } : {}),
      ...(capture.cloudLight !== null ? { lightSteps: capture.cloudLight } : {}),
      ...(capture.lodScale !== null ? { lodDistanceScale: capture.lodScale } : {}),
      ...(capture.terrainCells !== null ? { terrainPatchCells: capture.terrainCells } : {}),
      ...(capture.cloudFar !== null ? { cloudMaxDistance: capture.cloudFar } : {}),
    },
    ...(capture.exposure !== null ? { exposure: capture.exposure } : {}),
    cloudProbe: capture.probe,
    cloudTemporal: !capture.noTemporal,
    cloudCaptureMode: capture.enabled,
    showTerrain: capture.showTerrain,
    showWater: capture.showWater,
    showEnvironment: capture.showEnvironment,
    showAircraftShadow: capture.showAircraftShadow,
    showTargets: capture.showTargets,
    showEnemies: capture.showEnemies,
    showDamageSmoke: capture.showDamageSmoke,
    showFlares: capture.showFlares,
    showTracers: capture.showTracers,
    showAircraft: capture.showAircraft,
    showTrails: capture.showTrails,
    showMissiles: capture.showMissiles,
    showSmoke: capture.showSmoke,
    showExplosions: capture.showExplosions,
  })

  setBoot('描画の準備中')
  // **バックエンドの名前を出す。**`webglVersion` は WebGPU 経路では意味を
  // 失うので、段 18 まで残しつつ `backend` を正本にする。ただし値そのものは
  // `kind` から導かず、バックエンドが `gl.VERSION` を読んだ実物を渡す
  hook.backend = view.backend.kind
  hook.webglVersion = view.backend.webglVersion
  hook.atmosphereReady = true
  // **生バイトを出すのは頼まれたときだけ。**1,024 個をフックへ常時置くと
  // 読み出しの費用が全テストに乗る
  hook.noiseSlice = capture.noiseProbe ? [...view.noiseSlice] : null
  hook.weatherSlice = capture.noiseProbe ? [...view.weatherSlice] : null
  hook.sunElevation = view.sunElevation
  hook.sunRadiance = view.sunRadiance.toArray()
  hook.skyRadiance = view.skyRadiance.toArray()
  hook.noiseMs = view.noiseMs
  hook.noiseStats = view.noiseStats
  hook.gpuTimerSupported = view.gpuTimerSupported
  hook.cloudHdrTarget = view.cloudHdrTarget
  hook.terrainMs = view.terrainMs
  hook.terrainStats = view.terrainStats
  hook.aircraftTriangles = view.aircraftTriangles
  hook.aircraftSurfaces = view.aircraftSurfaces
  hook.environmentReady = view.environmentReady
  hook.aircraftShadowReady = view.aircraftShadowReady
  hook.drawCalls = view.drawCalls
  hook.drawnTriangles = view.drawnTriangles

  /**
   * HUD。`?hud=1` / `?hud=0` で明示でき、省略時はライブで出しキャプチャで出さない。
   *
   * 2D canvas なので composer の外。HUD の緑がトーンマッピングを通らない
   */
  const hud: Hud | null = capture.showHud ? createHud(hudRoot!) : null
  hook.hudReady = hud !== null

  const applySize = () => {
    // capture モードでは端末の DPR に依存させない。環境差の主要因になる
    // キャプチャは DPR 1 に固定する。基準画像を機械に依らせないため。
    // ただし計測モードは別で、実際に遊ぶ解像度で測らないと意味がない。
    // 実測で DPR 1.5 と 1.0 では画素数が 2.25 倍違い、そのぶん値がずれた
    const dpr = capture.enabled && !capture.sweep ? 1 : window.devicePixelRatio
    view.resize(window.innerWidth, window.innerHeight, dpr)
    // HUD も同じ DPR にそろえる。ずらすと基準画像が機械に依る
    hud?.resize(window.innerWidth, window.innerHeight, dpr)
  }
  applySize()
  window.addEventListener('resize', applySize)

  /** HUD へ渡す武装の状態。使い回す */
  const armament: HudArmament = {
    rounds: 0,
    lock: createHudLock(),
    flares: 0,
    threat: createMissileThreat(),
    // 器を使い回す。ミッションのない台本では null を入れて何も描かせない
    mission: { remainingFrames: 0, enemiesAlive: 0, outcome: 'none' },
  }

  /** HUD を 1 枚描き直して、読み取れる値をフックへ載せる */
  const drawHud = (currentWorld: World) => {
    if (hud === null) return
    armament.rounds = currentWorld.combat.rounds
    armament.flares = currentWorld.countermeasures.left

    // ミッションが無ければ null。**HUD 側は null で何も描かない**ので、
    // 既存の基準画像は 1 画素も動かない
    const currentMission = currentWorld.mission
    if (currentMission === null) armament.mission = null
    else {
      if (armament.mission === null) {
        armament.mission = { remainingFrames: 0, enemiesAlive: 0, outcome: 'none' }
      }
      armament.mission.remainingFrames = currentMission.remainingFrames(currentWorld.frame)
      armament.mission.enemiesAlive = currentWorld.enemiesAlive
      armament.mission.outcome = currentMission.outcome
    }
    // 器は使い回す。sim が測った値をそのまま写す
    const threat = currentWorld.combat.threat
    armament.threat.active = threat.active
    armament.threat.bearing = threat.bearing
    armament.threat.range = threat.range
    armament.threat.timeToImpact = threat.timeToImpact
    armament.threat.count = threat.count

    const lock = currentWorld.combat.lock
    armament.lock.state = lock.state
    armament.lock.range = lock.range
    armament.lock.closingSpeed = lock.closingSpeed
    armament.lock.progress = lock.progress
    armament.lock.dlz.rMax = currentWorld.combat.dlz.rMax
    armament.lock.dlz.rNe = currentWorld.combat.dlz.rNe
    armament.lock.dlz.rMin = currentWorld.combat.dlz.rMin
    const locked = currentWorld.combat.lockedTarget
    // ロックボックスは補間した位置に置く。sim の位置をそのまま使うと、
    // 60fps の描画で 1 ステップぶん（最大 1/120 秒）遅れて機体からずれる。
    //
    // **添字は `combatants` のもの。**標的機が先、敵機があとで 1 本に
    // 並んでいるので、標的の数を引いて敵側の器を引く。標的の器だけを見て
    // いたころは、敵をロックすると補間が効かず sim の位置に落ちていた
    if (locked !== null) {
      const index = lock.index
      const interpolated =
        index < targetSamples.length
          ? targetSamples[index]
          : enemySamples[index - currentWorld.targets.length]
      if (interpolated !== undefined) armament.lock.position.copy(interpolated.position)
      else armament.lock.position.copy(locked.position)
    }

    hud.update(sample, armament, view.viewProjection)
    hook.hudSpeedKt = hud.readout.speedKt
    hook.hudAltitudeFt = hud.readout.altitudeFt
    hook.hudHeadingDeg = hud.readout.headingDeg
    hook.hudFlightPathOnScreen = hud.flightPathOnScreen
    hook.hudGunReticleOnScreen = hud.gunReticleOnScreen
    hook.hudLockBoxOnScreen = hud.lockBoxOnScreen
    hook.hudDlzBarShown = hud.dlzBarShown
  }

  /**
   * フックへ現在の状態を載せる。
   *
   * **ワールドは引数で受け取る。**外側の `let world` を閉じ込めると、
   * キャプチャ経路がその宣言より前に return するので TDZ に落ちる
   * （キャプチャ側はローカルの `world` で影を作っている）。実際に
   * `Cannot access 'm' before initialization` で起動ごと落ちた。
   * **単体テストは main.ts を通らないので気づけない。**
   */
  const publish = (currentWorld: World, frame: number) => {
    hook.frame = frame
    hook.speed = sample.speed
    hook.altitude = sample.altitude
    hook.agl = sample.agl
    hook.gearDown = sample.gearDown
    hook.groundHeight = sample.groundHeight
    hook.elevator = sample.elevator
    hook.aileron = sample.aileron
    hook.rudder = sample.rudder
    hook.terrainPatches = view.terrainPatches
    hook.terrainTriangles = view.terrainTriangles
    hook.aircraftTriangles = view.aircraftTriangles
    hook.targetCount = targetSamples.length
    hook.targetInstances = view.targetInstances
    hook.targetsAlive = currentWorld.combat.targetsAlive
    hook.enemyCount = currentWorld.enemies.length
    hook.enemyInstances = view.enemyInstances
    hook.enemiesAlive = currentWorld.enemiesAlive
    hook.enemyTriangles = view.enemyTriangles
    hook.enemySurfaces = view.enemySurfaces
    hook.enemyAiStates = currentWorld.enemies
      .filter((enemy) => enemy.alive)
      .map((enemy) => enemy.aiState)
      .join(',')
    hook.enemyClearance = currentWorld.enemies[0]?.ai.clearance ?? 0
    hook.enemyIntegrityRatio = currentWorld.enemies[0]?.integrityRatio ?? 0
    hook.enemySmoke = currentWorld.enemies[0]?.smokeStrength ?? 0
    hook.enemyDamaged = currentWorld.enemies.filter(
      (enemy) => enemy.alive && enemy.smokeStrength > 0,
    ).length
    hook.enemyRoundsFired = currentWorld.enemies.reduce(
      (sum, enemy) => sum + enemy.roundsFired,
      0,
    )
    hook.enemyMissilesFired = currentWorld.enemies.reduce(
      (sum, enemy) => sum + enemy.missilesFired,
      0,
    )
    hook.incomingMissiles = currentWorld.combat.incomingMissilesInFlight
    hook.missileWarning = currentWorld.combat.threat.active
    hook.missileBearing = currentWorld.combat.threat.bearing
    hook.missileTimeToImpact = currentWorld.combat.threat.timeToImpact
    hook.flaresLeft = currentWorld.countermeasures.left
    const mission = currentWorld.mission
    hook.missionOutcome = mission ? mission.outcome : 'none'
    hook.missionRemaining = mission ? mission.remainingFrames(currentWorld.frame) : 0
    // **敵のぶんも数える。**自機のフレアは追従カメラに映らないので、
    // 絵の見張りは前方の敵が撒くぶん。自機だけ数えると 0 になる
    hook.flaresBurning =
      currentWorld.countermeasures.aliveCount +
      currentWorld.enemies.reduce(
        (sum, enemy) => sum + enemy.countermeasures.aliveCount,
        0,
      )
    hook.playerTaken = currentWorld.combat.taken
    hook.playerIntegrity = currentWorld.player.integrity
    hook.playerLosses = currentWorld.combat.losses
    hook.bulletsInFlight = currentWorld.combat.bulletsInFlight
    hook.tracersDrawn = view.tracersDrawn
    hook.roundsFired = currentWorld.combat.roundsFired
    hook.hits = currentWorld.combat.hits
    hook.kills = currentWorld.combat.kills
    hook.rounds = currentWorld.combat.rounds
    hook.lockState = currentWorld.combat.lock.state
    hook.lockRange = currentWorld.combat.lock.range
    hook.closingSpeed = currentWorld.combat.lock.closingSpeed
    hook.lockAngleDeg = (currentWorld.combat.lock.angleOffBoresight * 180) / Math.PI
    hook.lockProgress = currentWorld.combat.lock.progress
    hook.missilesInFlight = currentWorld.combat.missilesInFlight
    hook.missilesDrawn = view.missilesDrawn
    hook.missilesFired = currentWorld.combat.missilesFired
    hook.missilesLeft = currentWorld.combat.missilesLeft
    hook.explosionsAlive = currentWorld.combat.explosionsAliveAt(
      currentWorld.frame,
      FIXED_DT,
    )
    hook.explosionsDrawn = view.explosionsDrawn
    hook.explosionCount = currentWorld.combat.explosionCount
    hook.dlzMax = currentWorld.combat.dlz.rMax
    hook.dlzNe = currentWorld.combat.dlz.rNe
    hook.dlzMin = currentWorld.combat.dlz.rMin
  hook.aircraftSurfaces = view.aircraftSurfaces
  hook.environmentReady = view.environmentReady
  hook.aircraftShadowReady = view.aircraftShadowReady
  hook.drawCalls = view.drawCalls
  hook.drawnTriangles = view.drawnTriangles
    hook.angleOfAttack = sample.angleOfAttack
    hook.bank = sample.bank
    hook.crashed = sample.crashed
    hook.sunElevation = view.sunElevation
  hook.sunRadiance = view.sunRadiance.toArray()
  hook.skyRadiance = view.skyRadiance.toArray()
  hook.noiseMs = view.noiseMs
  hook.noiseStats = view.noiseStats
  hook.gpuTimerSupported = view.gpuTimerSupported
  }

  if (capture.enabled) {
    // 実時間を一切使わず、スクリプトを指定フレームまで再生して 1 枚描く
    const script = getScript(capture.script)
    const { world, player } = createWorldFromScript(script)
    hook.seed = script.seed
    hook.script = script.name

    for (let i = 0; i < capture.frame; i++) {
      world.step(player.at(i))
    }

    world.samplePlayer(1, sample)
    fitTargetSamples(world.targets.length)
    world.sampleTargets(1, targetSamples)
    fitEnemySamples(world.enemies.length)
    world.sampleEnemies(1, enemySamples)
    view.setTrailSource(world.player)
    view.setBulletSources(world.combat.bulletSources)
    view.setSmokeSources(world.combat.smokeSources)
    view.setDamageSmokeSources(world.damageSmokeSources)
    view.setFlareSources(world.flares)
    view.setExplosionSource(world.combat.explosions)
    view.sync(
      sample,
      targetSamples,
      enemySamples,
      collectMissilePoses(world, 1),
      world.frame,
      0,
      { yaw: 0, pitch: 0 },
      true,
    )
    // HUD は sync のあと。行列がそろってから 1 枚描く。雲の収束で render を
    // 何度も回すが、HUD は別の canvas なので描き直す必要はない
    drawHud(world)

    // 雲は時間方向に足し込むので、1 枚だけ描いても収束しない。
    // カメラを止めたまま必要な本数を描く。実時間は使わないので決定論は保たれる。
    //
    // **雲量 0 なら 1 枚でよい。**マーチが何も返さないので蓄積の中身が毎回
    // 同じになり、8 枚描いても絵は変わらない。基準画像 36 枚のうち 30 枚が
    // `coverage=0` なので、ここが E2E の待ち時間に効く。
    // 等価であることは `exact.mjs` の画素単位の比較で確かめる
    const converge =
      capture.converge > 0
        ? capture.converge
        : capture.coverage === 0
          ? 2
          : CAPTURE_CONVERGE_FRAMES
    for (let i = 0; i < converge; i++) view.render()

    if (capture.probe > 0) hook.cloudSamples = view.readCloudProbe()
    // **影を焼いたあとに読む。**`renderShadow` は `view.render()` の中なので、
    // 収束のぶんを描き終えたここで読み戻す
    if (capture.spriteProbe) {
      hook.spriteProbe = {
        soft: view.readSpriteProbe(false),
        core: view.readSpriteProbe(true),
      }
    }

    if (capture.marchProbe) {
      // **固定の入力で 3 枚焼く。**サンプル数と打ち切りは整数なので、
      // TSL 版と完全に一致するはず。絵は区画平均で見る
      const currentBytes = view.readMarchProbe(0)
      const resolveBytes = view.readResolveProbe()
      hook.marchProbe = {
        samples: marchSampleStats(view.readMarchProbe(1)),
        exhausted: marchExhaustedCount(view.readMarchProbe(2)),
        tiles: tileMeans(currentBytes, MARCH_PROBE_WIDTH, MARCH_PROBE_HEIGHT),
        resolve: resolveBytes,
        // **履歴を読む枝を通ったか。**現フレームと同じなら通っていない
        resolveChanged: byteDifference(resolveBytes, currentBytes).differing,
      }
    }

    if (capture.shadowProbe) {
      const shadow = view.readShadowHistogram()
      hook.shadowHistogram = shadow.bins
      hook.shadowTiles = shadow.tiles
      // **同じ入力を TSL 側へ渡すために出す。**分布だけ出しても、
      // 突き合わせる相手が別の入力で焼いたものなら比較にならない
      hook.shadowInputs = view.readShadowInputs()
    }

    if (capture.sweep) {
      const samplesPerCase = capture.bench > 0 ? capture.bench : 40
      const rows = await runBenchSweep(view, samplesPerCase, capture.sweepOnly)
      hook.benchSweep = rows
      // **何を測ったかを絵の中に残す。**実機の計測で 3 度、script を
      // 渡し忘れて既定の level を測っていた
      const size = view.backend.drawingBufferSize()
      if (hudRoot)
        showBenchPanel(hudRoot, rows, {
          script: capture.script,
          frame: capture.frame,
          hour: capture.hour,
          coverage: capture.coverage,
          preset: capture.preset,
          noDegrade: capture.noDegrade,
          drawingBufferWidth: size.width,
          drawingBufferHeight: size.height,
          enemyCount: world.enemies.length,
          targetCount: world.targets.length,
          samplesPerCase,
          caseCount: rows.length,
        })
    } else if (capture.bench > 0) {
      // 排出はバックエンドが持つ。`gl.finish()` では足りない理由もそちらに書いた
      const drain = () => view.backend.drain()

      // 1 回目はシェーダのコンパイルとテクスチャの常駐化が混ざるので捨てる
      view.render()
      drain()

      const started = performance.now()
      for (let i = 0; i < capture.bench; i++) {
        view.render()
        drain()
      }
      hook.benchMs = (performance.now() - started) / capture.bench
    }

    publish(world, world.frame)
    hook.captureReady = true
    finishBoot()
    document.body.dataset['captureReady'] = '1'
    return
  }

  const keyboard = new KeyboardInput()
  const mouse = new MouseLook()
  keyboard.attach(window)
  mouse.attach(canvas!)

  const debug = isDebugEnabled(window.location.search)
    ? createDebugPanel(hudRoot!)
    : null

  /**
   * リザルト。**ライブ専用。**キャプチャモードはここより前に return するので
   * 基準画像には写らない。`#hud` の兄弟に置く（あちらは pointer-events: none）
   */
  const resultRoot = document.querySelector<HTMLElement>('#result')
  const resultPanel: ResultPanel | null = resultRoot
    ? createResultPanel(resultRoot)
    : null
  /** 台本の敵の総数。自滅の内訳を出すのに要る */
  const enemyTotal = getScript(capture.script).enemies?.length ?? 0

  /**
   * タイトル。**ライブ専用**（キャプチャはここより前に return する）。
   *
   * `?title=0` で出さない。開発中に毎回押すのは邪魔なので逃げ道を作る
   */
  const titleRoot = document.querySelector<HTMLElement>('#title')
  const showTitle = new URLSearchParams(window.location.search).get('title') !== '0'
  const titlePanel: TitlePanel | null =
    titleRoot && showTitle
      ? createTitlePanel(titleRoot, {
          onStart: () => {
            titlePanel?.hide()
            startAudio()
          },
          onSettings: () => openSettings(),
        })
      : null
  titlePanel?.show()

  /**
   * 設定。**ライブ専用。**
   *
   * `Escape` で開閉する。ポーズは段 13 の範囲なので、開いていてもシムは
   * 進み続ける
   */
  let settings: Settings = initialSettings
  /**
   * 自動降格を続けるか。
   *
   * **設定画面で画質を選んだら止める。**`PerformanceGovernor` は 3 秒
   * 連続で 55 fps を割ると 1 段落とす。選んだ直後に落とされると、選んだ
   * ことが無かったことになる。人の指定が機械の判断に勝つ
   */
  let autoDegrade = true

  /**
   * 設定を開いたときタイトルが出ていたか。閉じるとき戻すのに使う。
   *
   * **暗幕を 2 枚重ねない。**どちらも `rgba(5, 16, 26, 0.88)` を全面に
   * 敷くので、重なると実質 0.986 になって背景がほぼ黒くなる。実測で
   * タイトルの文字が設定の下に透けて雑然として見えた
   */
  let titleWasShown = false
  /** 設定を開いたときポーズが出ていたか。閉じたら戻すのに使う */
  let pauseWasShown = false

  /**
   * 効果音。**START を押すまで作らない。**
   *
   * ブラウザの autoplay 制限で、ユーザ操作を経ずに作った `AudioContext` は
   * `suspended` のまま音が出ない。`?sound=0` とキャプチャモードでは作らない
   */
  let audio: GameAudio | null = null

  const startAudio = (): void => {
    if (audio !== null || !capture.sound) return
    audio = createGameAudio(settings.volume)
    hook.audioReady = audio !== null
  }

  const openSettings = (): void => {
    titleWasShown = titlePanel?.visible ?? false
    pauseWasShown = pausePanel?.visible ?? false
    titlePanel?.hide()
    // **ポーズは畳まない。**設定は DOM 順で後にあるので上に重なる。
    // 暗幕は 0.72 と 0.88 で、重なっても背景は読める
    // **操縦を止める。**つまみに焦点があるとき矢印キーは値を動かすもので、
    // 同時に機体をロールさせては困る
    keyboard.setEnabled(false)
    settingsPanel?.show()
  }

  const closeSettings = (): void => {
    settingsPanel?.hide()
    // **キーは常に戻す。**タイトルへ帰る場合も、あちらは操縦を止めない
    // （段 7 からの挙動）。止めたままにすると設定を開いた履歴で操作感が変わる
    keyboard.setEnabled(true)
    if (titleWasShown) titlePanel?.show()
    // **ポーズから開いたならポーズへ帰る。**いきなり動き出さない
    else if (pauseWasShown) {
      pausePanel?.show()
      keyboard.setEnabled(false)
    }
  }

  /**
   * ポーズ。
   *
   * **`Escape` は 3 つの状態で意味が変わる。**設定が開いていれば設定を
   * 閉じる（段 8 で `settingsPanel` が自前で拾う）。タイトルが出ていれば
   * 何もしない（まだ始まっていない）。それ以外はポーズの切り替え。
   *
   * 出しているあいだ `FixedStepDriver` を回さない。復帰のとき `reset()` を
   * 呼んで蓄積を捨てる。捨てないと、止まっていた秒数ぶんのステップを
   * まとめて進めようとして大きく飛ぶ。
   */
  const pauseRoot = document.querySelector<HTMLElement>('#pause')
  const pausePanel: PausePanel | null = pauseRoot
    ? createPausePanel(pauseRoot, {
        onResume: () => resumeFromPause(),
        onSettings: () => openSettings(),
      })
    : null

  const enterPause = (): void => {
    if (pausePanel === null || pausePanel.visible) return
    pausePanel.show()
    keyboard.setEnabled(false)
  }

  const resumeFromPause = (): void => {
    if (pausePanel === null || !pausePanel.visible) return
    pausePanel.hide()
    keyboard.setEnabled(true)
    // **蓄積を捨てる。**止まっていた秒数ぶんをまとめて進めない
    driver.reset()
  }

  /**
   * `Escape` を拾う。
   *
   * **設定が開いているときは何もしない。**あちらが自前で拾って閉じる
   * （`settingsPanel.ts`）。二重に処理すると、設定を閉じた勢いでポーズも
   * 切り替わる。
   *
   * タイトルが出ているあいだも何もしない。まだ始まっていない。
   */
  const onEscape = (event: KeyboardEvent): void => {
    // **`event.code` で見る。**`event.key` はレイアウトで変わるうえ、
    // 操作説明との突合（`tests/input/controlHelp.test.ts`）が拾えない
    if (event.code !== 'Escape') return
    if (settingsPanel?.visible === true) return
    if (titlePanel?.visible === true) return
    event.preventDefault()
    if (pausePanel?.visible === true) resumeFromPause()
    else enterPause()
  }
  document.addEventListener('keydown', onEscape)

  const settingsRoot = document.querySelector<HTMLElement>('#settings')
  const settingsPanel: SettingsPanel | null = settingsRoot
    ? createSettingsPanel(settingsRoot, settings, {
        onChange: (next) => {
          if (next.preset !== settings.preset) {
            preset = next.preset
            view.setQuality(preset)
            applySize()
            hook.preset = preset
            // 人が選んだので機械の判断を止める
            autoDegrade = false
            governor.reset()
          }
          if (next.hour !== settings.hour) {
            view.setHour(next.hour)
            hook.hour = next.hour
          }
          if (next.mouseSensitivity !== settings.mouseSensitivity) {
            mouse.setSensitivity(next.mouseSensitivity)
          }
          if (next.controlMode !== settings.controlMode) {
            controlMode = next.controlMode
            hook.controlMode = controlMode
          }
          if (next.volume !== settings.volume) audio?.setVolume(next.volume)
          settings = next
          hook.volume = next.volume
          saveSettings(settingsStorage(), next)
        },
        onClose: () => closeSettings(),
      })
    : null

  // 保存された値を起動時に効かせる。画質と時刻はシーンの生成時に渡して
  // あるが、感度と操作の型は渡す先が無いのでここで入れる
  mouse.setSensitivity(settings.mouseSensitivity)
  hook.volume = settings.volume

  /**
   * 操作の型。**既定は `expert`**（`resolveControlMode`）。段 8 で設定画面
   * から変えられるようにするので `let` で持つ
   */
  let controlMode: ControlMode = initialSettings.controlMode
  hook.controlMode = controlMode

  const driver = new FixedStepDriver()
  const governor = new PerformanceGovernor()
  let preset: PresetName = initialSettings.preset
  let world = spawnWorld()
  view.setTrailSource(world.player)
  view.setBulletSources(world.combat.bulletSources)
  view.setSmokeSources(world.combat.smokeSources)
  view.setDamageSmokeSources(world.damageSmokeSources)
  view.setExplosionSource(world.combat.explosions)
  let lastTime = performance.now()
  let smoothedFps = 60
  // 1 フレームだけ見ると外れ値に振られるので平滑化して読む
  let cpuSimMs = 0
  let cpuSyncMs = 0
  let cpuRenderMs = 0
  let cpuHudMs = 0

  function spawnWorld(): World {
    // ライブでも台本の初期条件を使う。?script= で標的つきの台本を選べる
    const script = getScript(capture.script)
    const spawn = spawnFromSpec(script.spawn)
    keyboard.setThrottle(spawn.throttle)
    const world = new World({
      seed: DEFAULT_SEED,
      aircraft: {
        position: spawn.position,
        velocity: spawn.velocity,
        orientation: spawn.orientation,
        throttle: spawn.throttle,
      },
      ...(script.targets ? { targets: script.targets } : {}),
      ...(script.enemies ? { enemies: script.enemies } : {}),
      // **ここも渡す。**`createWorldFromScript`（キャプチャとテストの経路）と
      // 別に組み立てているので、片方だけ直すとライブでミッションが走らない
      ...(script.missionSeconds !== undefined
        ? { mission: { limitFrames: Math.round(script.missionSeconds / FIXED_DT) } }
        : {}),
      // **ここも渡す。**`createWorldFromScript`（キャプチャとテストの経路）と
      // 別に組み立てているので、片方だけ直すとライブで射出が始まらない
      ...(script.launchFrom !== undefined && script.carrier !== undefined
        ? { launch: catapultLaunch(script.carrier, script.launchFrom, LAUNCH_DISTANCE) }
        : {}),
    })
    fitTargetSamples(world.targets.length)
    fitEnemySamples(world.enemies.length)
    return world
  }

  const frame = (now: number) => {
    const delta = Math.min((now - lastTime) / 1000, 0.25)
    lastTime = now

    if (keyboard.consumeReset()) {
      // やり直すのでリザルトを畳む
      resultPanel?.hide()
      world = spawnWorld()
      view.setTrailSource(world.player)
      view.setBulletSources(world.combat.bulletSources)
      view.setSmokeSources(world.combat.smokeSources)
      view.setDamageSmokeSources(world.damageSmokeSources)
    view.setFlareSources(world.flares)
      view.setExplosionSource(world.combat.explosions)
      driver.reset()
      mouse.reset()
      governor.reset()
    }

    const raw = keyboard.poll(delta)
    // **補助は sim へ渡す直前に掛ける。**`expert` は素通しなので、既存の
    // 操作感は 1 つも変わらない（`assist.ts`）
    const input = applyAssist(raw, controlMode, {
      bank: world.player.bank,
      agl: world.player.agl,
      speed: world.player.speed,
      climbAngle: climbAngleOf(world.player.velocity),
    })
    const t0 = performance.now()
    /**
     * ポーズ中はシムを進めない。
     *
     * **描画は続ける。**止めると画面が固まって、ポーズの UI も更新
     * されなくなる。`alpha` は 1 に固定して最後の状態を見せる
     */
    const paused = pausePanel?.visible === true
    const alpha = paused ? 1 : driver.advance(delta, () => world.step(input))

    const t1 = performance.now()
    world.samplePlayer(alpha, sample)
    world.sampleTargets(alpha, targetSamples)
    world.sampleEnemies(alpha, enemySamples)
    view.sync(
      sample,
      targetSamples,
      enemySamples,
      collectMissilePoses(world, alpha),
      world.frame,
      delta,
      mouse.update(delta),
    )

    const t2 = performance.now()
    view.render()
    const t3 = performance.now()
    drawHud(world)
    const t4 = performance.now()

    cpuSimMs += (t1 - t0 - cpuSimMs) * 0.1
    cpuSyncMs += (t2 - t1 - cpuSyncMs) * 0.1
    cpuRenderMs += (t3 - t2 - cpuRenderMs) * 0.1
    cpuHudMs += (t4 - t3 - cpuHudMs) * 0.1

    if (delta > 0) {
      smoothedFps += (1 / delta - smoothedFps) * 0.08
    }

    // 重いときは品質を1段落とす。実時間に依存するので capture では動かさない。
    // ?nodegrade=1 のときも止める。品質を固定しないと GPU 時間を比較できない
    const degraded =
      capture.noDegrade || !autoDegrade ? null : governor.update(delta, preset)
    if (degraded !== null) {
      preset = degraded
      view.setQuality(preset)
      applySize()
      hook.preset = preset
      // **設定画面の表示も合わせる。**開いたまま降格すると、選択肢が
      // 実際の画質と食い違ったままになる。保存はしない（人の指定ではない）
      settings = { ...settings, preset }
      settingsPanel?.sync(settings)
    }

    publish(world, world.frame)
    hook.programs = view.backend.programs

    // **音は `publish` の後。**あちらが `hook` と HUD へ状態を配るので、
    // 同じフレームの値を見ることになる
    audio?.update({
      roundsFired: world.combat.roundsFired,
      explosionCount: world.combat.explosionCount,
      missilesFired: world.combat.missilesFired,
      throttle: world.player.throttle,
      threatened: world.combat.threat.active,
    })

    // 決着したらリザルトを出す。**毎フレーム作り直さない。**出ていなければ
    // 1 回だけ。R でやり直すと `hide()` が呼ばれて畳まれる
    const settled = world.mission
    if (settled !== null && settled.outcome !== 'running' && resultPanel !== null) {
      if (!resultPanel.visible) {
        resultPanel.show({
          outcome: settled.outcome,
          endedFrame: settled.endedFrame,
          enemyTotal,
          enemiesAlive: world.enemiesAlive,
          kills: world.combat.kills,
          roundsFired: world.combat.roundsFired,
          hits: world.combat.hits,
          missilesFired: world.combat.missilesFired,
        })
      }
    }

    hook.droppedSteps = driver.droppedSteps
    debug?.update(sample, world.frame, smoothedFps, {
      sunElevation: view.sunElevation,
      preset,
      gpuFrameMs: view.gpuFrameMs,
      gpuFrameMaxMs: view.gpuFrameMaxMs,
      gpuCloudMs: view.gpuCloudMs,
      gpuCloudMaxMs: view.gpuCloudMaxMs,
      gpuTimerSupported: view.gpuTimerSupported,
      cpuSimMs,
      cpuSyncMs,
      cpuRenderMs,
      cpuHudMs,
      terrainPatches: view.terrainPatches,
      terrainTriangles: view.terrainTriangles,
      aircraftTriangles: view.aircraftTriangles,
      drawCalls: view.drawCalls,
      drawnTriangles: view.drawnTriangles,
      enemiesAlive: world.enemies.filter((enemy) => enemy.alive).length,
      enemyCount: world.enemies.length,
      drawingBufferWidth: view.backend.domElement.width,
      drawingBufferHeight: view.backend.domElement.height,
      devicePixelRatio: window.devicePixelRatio,
    })

    requestAnimationFrame(frame)
  }

  // 初期姿勢でカメラを定位置に置いてから回し始める
  world.samplePlayer(1, sample)
  fitTargetSamples(world.targets.length)
  world.sampleTargets(1, targetSamples)
  fitEnemySamples(world.enemies.length)
  world.sampleEnemies(1, enemySamples)
  view.sync(
    sample,
    targetSamples,
    enemySamples,
    collectMissilePoses(world, 1),
    world.frame,
    FIXED_DT,
    mouse.offset,
    true,
  )
  view.render()
  drawHud(world)

  /**
   * シェーダを先に全部作る。
   *
   * **1 枚描いただけでは足りない。**three はオブジェクトを最初に描くときに
   * コンパイルするので、そのとき画面に出ていないもの（爆発・フレア・
   * 曳光弾・ミサイル・煙）は初登場のフレームでまとめて走る。実測で、
   * 初弾を撃った瞬間に 13 個が作られ、そのフレームが 772.9 ms かかった
   * （SwiftShader、`?script=mission-01`）。
   *
   * 読み込み表示を出している間に済ませて、遊び始めてからの予算を空ける。
   * **失敗しても進む。**コンパイルは遅れて起きるだけで、遊べなくはならない
   */
  if (capture.precompile) {
    const compileStarted = performance.now()
    try {
      // **4 段ぶん作る。**品質を落とすと影のマップ解像度が変わり、全マテリアルの
      // プログラムが作り直される。実測でその瞬間が 772.9 ms 止まった
      await view.compileAllPresets(preset, (done, total) => {
        // **4 段ぶんは時間がかかる。**実測で SwiftShader が 6.6 秒。
        // 何も出さないと止まったように見える
        setBoot(`シェーダを準備中 ${done}/${total}`)
      })
      applySize()
    } catch (error) {
      console.warn('[dogfight] シェーダの事前コンパイルに失敗した', error)
    }
    hook.compileMs = performance.now() - compileStarted
  }
  hook.programs = view.backend.programs

  finishBoot()
  requestAnimationFrame(frame)
}

main().catch((error: unknown) => {
  console.error('[dogfight] 初期化に失敗した', error)
  document.body.dataset['initError'] = '1'
  boot?.classList.add('is-error')
  boot?.classList.remove('is-done')
  setBoot(
    `初期化に失敗しました\n${error instanceof Error ? error.message : String(error)}`,
  )
})
