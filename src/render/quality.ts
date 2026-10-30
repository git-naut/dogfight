/**
 * 品質プリセット。
 *
 * 描画の設定を足すときは、まずこの表に列を追加してから実装する。表に載らない
 * 設定項目を作らないと決めておくと、あとから「この環境だと重い」となったときに
 * 触る場所が1か所で済む。
 *
 * three に依存しない純粋なデータなので node 環境のテストで検証できる。
 */

export type PresetName = 'low' | 'medium' | 'high' | 'ultra'

/** 影マップのフィルタ。node 経路だけが読む */
/**
 * 影マップのフィルタ。
 *
 * **`pcfSoft` は three 0.186 で無くなった。**`WebGPURenderer` は
 * `PCFSoftShadowMap` を受け取ると警告を出して `PCFShadowMap` へ倒す
 * （`Renderer.js:902`）。倒した先が既定でソフトになったためで、区別が
 * three 側から消えた。**表に残すと「実装が読まない列」が 4 つ目になる**ので
 * 落とした。ultra にソフト影を戻すなら VSM を別の列として足す（第 IV 群）。
 */
export type ShadowFilter = 'basic' | 'pcf'

/**
 * 機体の外板の細部。
 *
 * `procedural` は node 経路で汚れ・パネルごとのむらを差す（粗さを揺らすだけ）。パネルラインは
 * 2026-10-13 に外した（規則正しい格子がマス目に写った。`nodeAircraftMaterial.ts`）。
 * 計画書の `procedural-aniso`（異方性スペキュラ）は次の段で足す。
 * **値を先に置かない。**実装が読まない値を表に持たない（`ShadowFilter`）
 */
export type MaterialDetail = 'none' | 'procedural'

export interface QualitySettings {
  /** 描画解像度の倍率。1.0 が等倍 */
  renderScale: number
  /** devicePixelRatio の上限 */
  maxPixelRatio: number
  smaa: boolean
  anisotropy: number

  /**
   * ブルームの強さ。0 で掛けない。
   *
   * **閾値は露出前の値で渡す。**`createNodeOutputNode` が組む鎖はすべて
   * 露出の前にある。`RenderPipeline._updateContext` が戻り値を
   * `renderOutput()` で包み、その中の `ToneMappingNode` が AgX の関数へ
   * 露出を渡して `colortone.mulAssign(exposure)` が最初に走る。
   *
   * 空の線形値は 0.1365 / 0.1602 / 0.1844（`weapons/explosions.ts` に
   * rgb(195,201,206) の逆算として記録）。露出 6 を掛けた 1.11 がトーン
   * マッピングの入口に立つ値で、**ブルームが見るのは 0.1844 のほう。**
   * 「露出後で 1.2 を狙う」なら渡す閾値は 0.20 になる。
   *
   * 強さの段は掃引で決める。low は 0（掛けない）。
   */
  bloomStrength: number
  /**
   * 発光体だけを MRT の `emissive` へ書き出して、ブルームに拾わせるか。
   *
   * **閾値だけでは順光の排気口と雲を分けられない**（段 22 の宿題、
   * `docs/decisions/0011-post-processing.md`）。炎の材質だけが `emissive` を
   * 書き、ブルームの入力に倍率を掛けて足す。出力の絵には足さない。
   * ブルームを掛けないプリセット（`bloomStrength` が 0）では false
   */
  bloomEmissive: boolean

  /**
   * 風圧の演出を掛けるか。放射ブラー・色収差・ビネットの 3 つをまとめる。
   *
   * **強さは荷重倍数が決める。**1 G では 0 になるので、水平飛行の絵は
   * 動かない。ここは「掛ける機構を持つか」だけの切り替え。
   *
   * 3 つを別の列にしない。**同じ物理（機体に掛かる G）から導く 1 つの
   * 演出**で、片方だけ切る意味がない。費用も 1 つの鎖にまとまる。
   */
  lensEffects: boolean

  /**
   * 陽炎を掛けるか（ADR 0041）。自機の排気口の後ろの範囲だけ、場面の絵を読む位置を揺らす。
   * 絵を読む回数は増えず、範囲の計算が全画素に少し増えるだけ。low は切る
   */
  heatHaze: boolean
  /**
   * 機体の外板の細部（`MaterialDetail`）。
   *
   * node 経路が読む（段 S1 で捨てた GLSL 経路は機体の材質を写さず、口が無かった）。
   * medium 以下は `none`。低いプリセットは機体が小さく写るので、細部は
   * 1 画素を割って縞になるだけになる
   */
  materialDetail: MaterialDetail
  /**
   * キャノピーのガラスに clearcoat を重ねるか。
   *
   * **node 経路だけが読む。**外板は粗さ 0.82 の塗装で太陽の映り込みが視線に
   * 入らない（段 25・段 26 の実測）。艶のある曲面はキャノピーだけなので、
   * ハイライトはここで立てる。外板全体に掛けると鏡の失敗の再演になる
   * （計画書）
   */
  canopyClearcoat: boolean
  /**
   * ベイパーコーンを描くか（段 30f）。音速の近く（マッハ 0.88〜1.1）で機体を包む
   * 白い円錐の膜。24 段 x 32 分割の円錐 1 枚（1,536 三角形）。**組み立てのときに決まる**
   */
  vaporCone: boolean

  /**
   * LOD の切り替え距離の倍率。
   *
   * 海面の四分木の分割距離（`ocean/oceanLayout.ts` の `lodRange`）に掛ける。大きくすると
   * 手前が細かくなるかわりに三角形が増える。段 S4b まで地形の四分木も読んでいた
   */
  lodDistanceScale: number

  /**
   * 機体の影マップの一辺。0 で影なし。
   *
   * Phase 4 で `shadowCascades` を置き換えた。カスケードは実装しない。
   * 遮蔽物が機体だけなので、機体を囲む正射影の箱 1 つで自己遮蔽と対地影の
   * 両方をまかなえる。使われていない枠の名前を実装に合わせただけで、
   * 列は増えていない。
   */
  aircraftShadowMapSize: number
  /**
   * 影マップのフィルタ。
   *
   * **段 S1 で捨てた GLSL 経路は読まなかった。**そちらで `BasicShadowMap` を
   * 選んだのは、比較モードが付くと自前 GLSL の `sampler2D` から `r` 成分を
   * 読めなくなるためで
   * （`GL_INVALID_OPERATION: Mismatch between texture format and sampler
   * type` で描画そのものが捨てられた）、node 経路ではその制約が消える。
   * `shadow(light)` ノードが係数を返し、`ShadowNode` が `hasTextureCompare`
   * を見て自動で切り替える。
   *
   * 値は `basic` と `pcf` の 2 つ。**`pcfSoft` は three 0.186 で無くなった**
   * （この型の定義のコメント）。ultra と high の差は影マップの大きさで付ける。
   *
   * 段 15 の規約どおり、実装より先に列を作った（`CLAUDE.md`）。段 18 で
   * 経路を切り替えたとき、影が映る 12 枚がここで動く
   */
  shadowFilter: ShadowFilter
  /**
   * 機体に空を映す環境反射を入れるか。
   *
   * 段 S2b-2 まで、ここは空を焼くキューブの一辺（`skyEnvironmentSize`、low は 0）
   * だった。自前の空は空の見え方の LUT を反射の向きで直に引くので大きさを持たず、
   * 入れるか切るかだけが残った（ADR 0045）。同じ段で takram の LUT の倍率
   * （`atmosphereLutScale`）と霞の光線行進（`aerialRaymarchScattering`）の列も消した
   */
  skyEnvironment: boolean
  /**
   * FFT の海のカスケードの数（段 S4a、CP2 の決定）。カスケードは長い順に web-ocean の
   * 6 つ（1,103 m〜0.26 m）の先頭から取る。減らしても有義波高は変わらず（エネルギーは長い
   * 波）、細かい波の作りが粗くなる。実機の計算の所要は `docs/measuring.md` の「段 S3」
   */
  oceanCascades: number
  /** FFT の海の 1 カスケードの格子の一辺（2 のべき）。128 で最も細かい波は 12 cm まで */
  oceanFftSize: number
  /**
   * 海面の CDLOD の段数。最も細かい段の一辺が 0.5 m で、段ごとに 2 倍。カメラを中心に敷く
   * （地形の四分木は 48 km の定義域に固定だが、海は水平線まで続く）
   */
  oceanLodLevels: number
  /** 泡の層の数（0 で泡なし、段 S4a-2 で使う）。web-ocean は近と遠の 2 層 */
  oceanFoamLevels: number
  /**
   * 泡のクリップマップの一辺の texel（段 S4a-2）。web-ocean は 1024。high で 1024 は予算
   * （海 5.5 ms、2026-10-29 の改訂）を越えたので 512（実測で泡の計算 −0.5 ms）。ultra は推測
   */
  oceanFoamResolution: number
  /**
   * 海面で引くテクスチャの異方性の上限（段 S4a-2）。web-ocean は 16。high の 16 は海面の描画で
   * 約 +2 ms、4 でも予算を越えたので 1（ユーザーの決定、2026-10-29）。中景から先のさざ波は
   * ならされる。ultra は推測、S5 で測る
   */
  oceanAnisotropy: number
  /**
   * 層の雲（段 S4c、web-ocean の 2 層）の積雲の縁のノイズの段の数。自己影の 3 点と高層雲と
   * 雲の影はここから 1〜4 段減らす（web-ocean は 7）。low と medium は推測、S5 で測る
   */
  cloudLayerOctaves: number
  /**
   * 層の雲を描く解像度の倍率（段 S4c）。web-ocean と同じく半分で描き、合成で拡大する。全解像度
   * では積雲を上から見る構図で 1.7〜2.2 ms だった（2026-10-30 実測）。値は推測、S5 で測る
   */
  cloudLayerResolutionScale: number
  /**
   * 軌跡のリボンの分割数。0 で軌跡なし。
   *
   * コントレイルと翼端渦が使う。sim が持つ履歴（768 本 = 25.6 秒）のうち、
   * 新しいほうから何本を描くかを決める。濃さは経過秒で決まるので、段を
   * 落としても見えている部分の絵は変わらない。短くなるだけ。
   *
   * 引き起こしを続ける構図なら 48 本もあれば足りる（視錐台が先に切る）。
   * 効くのは機動が終わったあとで、置いてきた濃い区間が後方へ遠ざかって
   * いくのを見せるとき。high は 384 本 = 12.8 秒ぶん。
   */
  trailSegments: number

  /**
   * ミサイルの煙のリボンの分割数。0 で煙なし。
   *
   * `trailSegments` と同じ考え方。sim が持つ履歴（512 本 = 17.1 秒）のうち、
   * 新しいほうから何本を描くかを決める。濃さは経過秒で決まるので、段を
   * 落としても見えている部分の絵は変わらず、短くなるだけ。
   *
   * **翼端渦とは効き方が違う。**渦は追従カメラのすぐ後ろにあるので視錐台が
   * 先に切り、320 本と 48 本で画素が 1 ビットも変わらなかった。煙は前方へ
   * 数キロ伸びて画面に映り続けるので、本数が絵に出る。
   */
  missileTrailSegments: number

  /**
   * 爆発 1 個あたりの破片の板の数。0 で破片なし（火球と煙は残る）。
   *
   * sim は 12 個ぶんの向きと速さを持つ（`SHARD_COUNT`）。ここが少なければ
   * 先頭から使う。**破片は 1 個 2 三角形なので、費用は板の枚数そのもの。**
   * high の 12 個 x 同時 8 個で 96 枚が上限。
   */
  explosionSprites: number

  /**
   * 爆発 1 個あたりの子の火の玉の数（段 29d、複数の球の連なり）。0 で主の 1 個だけ。
   *
   * node 経路が読む（段 S1 で捨てた GLSL 経路は円形スプライトの火球のままだった）。
   * 向きは破片の向き（`SHARD_COUNT` = 12 個）を先頭から
   * 流用するので、12 を越えると同じ向きに重なる。板は 1 個 2 三角形で、high の
   * 4 個 x 同時 8 個で 32 枚が上限
   */
  explosionBlobs: number

  /**
   * 爆発 1 個あたりの白い煙の尾の本数（段 29f）。0 で尾なし。
   *
   * 燃える破片が引く煙の筋。1 本は爆発の寿命ぶん 106 点のリボン（`explosionTrails.ts`）。
   * 向きは破片の向きを末尾から流用する。high の 3 本 x 同時 8 個で 24 本が上限
   */
  explosionSmokeTrails: number

  /**
   * フレアの板の数。0 でフレアを描かない。
   *
   * 段 B8 までは火と煙の 2 枚 x 同時に燃えている数。段 B9 で 1 発 7 枚（赤みの橙の火・帯と煙）になった
   * が、値は描くかどうかの切り替えにしか使っていない。**ビルボードなので費用は小さいはず
   * だが、測ってから判断する。**プリセットに載せてから実装する規約
   * （`CLAUDE.md`）に従い、実測の前に列を作った。
   */
  flareSprites: number

  /**
   * ミサイルの発射炎と炎の尾の板の数（1 発あたり、段 B9）。0 で描かない。
   *
   * 発射炎の 3 枚（赤みの橙・黄みの橙・黄みの白）と、炎の尾の 3 枚と噴射口の白い芯の 4 枚で 7 枚。
   * low はフレアと同じく切る
   */
  missileFlameSprites: number

  /**
   * ダメージの煙のリボンの分割数。0 で煙なし。
   *
   * `missileTrailSegments` と同じ考え方。sim が持つ履歴（384 本 = 12.8 秒）の
   * うち、新しいほうから何本を描くかを決める。
   *
   * **ミサイルの煙より短くて薄い。**幅の半分（0.55 m）、濃さも 0.13 対 0.16。
   * 敵 8 機ぶん同時に出る可能性があるので、本数はミサイルより控える。
   * **切り替え距離ではなく本数で落とす。**濃さは経過秒で決まるので、段を
   * 落としても見えている部分の絵は変わらず、後ろが短くなるだけ。
   */
  damageSmokeSegments: number
}

export const PRESET_ORDER: readonly PresetName[] = ['low', 'medium', 'high', 'ultra']

export const DEFAULT_PRESET: PresetName = 'high'

export const QUALITY_PRESETS: Readonly<Record<PresetName, QualitySettings>> = {
  low: {
    renderScale: 0.6,
    maxPixelRatio: 1,
    smaa: false,
    anisotropy: 1,
    // 掛けない。全画面に掛かるので、いちばん弱い機械で最初に外す
    bloomStrength: 0,
    bloomEmissive: false,
    lensEffects: false,
    heatHaze: false,
    materialDetail: 'none',
    canopyClearcoat: false,
    vaporCone: false,
    lodDistanceScale: 0.5,
    aircraftShadowMapSize: 0,
    shadowFilter: 'basic',
    skyEnvironment: false,
    oceanCascades: 3,
    oceanFftSize: 128,
    oceanLodLevels: 8,
    oceanFoamLevels: 0,
    oceanFoamResolution: 512,
    oceanAnisotropy: 1,
    cloudLayerOctaves: 5,
    cloudLayerResolutionScale: 0.5,
    trailSegments: 0,
    missileTrailSegments: 0,
    explosionSprites: 0,
    explosionBlobs: 0,
    explosionSmokeTrails: 0,
    flareSprites: 0,
    missileFlameSprites: 0,
    damageSmokeSegments: 0,
  },
  medium: {
    renderScale: 0.8,
    maxPixelRatio: 1.5,
    smaa: true,
    anisotropy: 4,
    // high の 2.0 に対して控えめ
    bloomStrength: 1.3,
    bloomEmissive: true,
    lensEffects: true,
    heatHaze: true,
    materialDetail: 'none',
    canopyClearcoat: true,
    vaporCone: true,
    lodDistanceScale: 0.75,
    aircraftShadowMapSize: 512,
    shadowFilter: 'basic',
    skyEnvironment: true,
    oceanCascades: 4,
    oceanFftSize: 128,
    oceanLodLevels: 10,
    oceanFoamLevels: 1,
    oceanFoamResolution: 512,
    oceanAnisotropy: 1,
    cloudLayerOctaves: 6,
    cloudLayerResolutionScale: 0.5,
    trailSegments: 192,
    missileTrailSegments: 192,
    explosionSprites: 6,
    explosionBlobs: 2,
    explosionSmokeTrails: 2,
    flareSprites: 6,
    missileFlameSprites: 7,
    damageSmokeSegments: 128,
  },
  high: {
    renderScale: 1,
    maxPixelRatio: 2,
    smaa: true,
    anisotropy: 8,
    // **閾値 8（露出後）と組。**逆光の実機の絵で決めた。4.5 では積雲の
    // 輪郭が消え、8 で残る。順光では何も拾わないので数では決められず、
    // 絵を 3 枚並べて選んだ（`docs/measuring.md`）
    bloomStrength: 2.0,
    bloomEmissive: true,
    lensEffects: true,
    heatHaze: true,
    materialDetail: 'procedural',
    canopyClearcoat: true,
    vaporCone: true,
    // 段 S4b で 1 → 0.75（ユーザーの決定、2026-10-30）。低空の構図で全体が予算 13.0 ms を越えた。
    // 実機 low-pass で場面のパスが約 0.4 ms 軽くなり、絵の差は目では分からなかった
    lodDistanceScale: 0.75,
    aircraftShadowMapSize: 1024,
    shadowFilter: 'pcf',
    skyEnvironment: true,
    oceanCascades: 4,
    oceanFftSize: 256,
    oceanLodLevels: 12,
    // 段 S4b で 2 → 1（同じ決定）。実機 low-pass で約 0.8 ms 減。近くの泡と喫水線の泡は残る
    oceanFoamLevels: 1,
    oceanFoamResolution: 512,
    oceanAnisotropy: 1,
    cloudLayerOctaves: 7,
    cloudLayerResolutionScale: 0.5,
    trailSegments: 384,
    missileTrailSegments: 384,
    explosionSprites: 12,
    explosionBlobs: 4,
    explosionSmokeTrails: 3,
    flareSprites: 12,
    missileFlameSprites: 7,
    damageSmokeSegments: 256,
  },
  ultra: {
    renderScale: 1.25,
    maxPixelRatio: 2,
    smaa: true,
    anisotropy: 16,
    // high より強い。外周 +36.2%（閾値 4.5）
    bloomStrength: 3.0,
    bloomEmissive: true,
    lensEffects: true,
    heatHaze: true,
    materialDetail: 'procedural',
    canopyClearcoat: true,
    vaporCone: true,
    // 地形のときに決めた値（1.5 だと地形の三角形が 2.19M でシーン予算 1.5M を超えた）。
    // 海面での見直しは段 S5
    lodDistanceScale: 1.15,
    aircraftShadowMapSize: 2048,
    // high と同じ。three 0.186 で `pcfSoft` が無くなった（型のコメント）。
    // ultra の影の差は影マップの大きさ 2048 で付ける
    shadowFilter: 'pcf',
    skyEnvironment: true,
    oceanCascades: 6,
    oceanFftSize: 256,
    oceanLodLevels: 13,
    oceanFoamLevels: 2,
    oceanFoamResolution: 1024,
    oceanAnisotropy: 4,
    cloudLayerOctaves: 7,
    cloudLayerResolutionScale: 0.5,
    trailSegments: 768,
    missileTrailSegments: 512,
    explosionSprites: 12,
    explosionBlobs: 6,
    explosionSmokeTrails: 5,
    flareSprites: 12,
    missileFlameSprites: 7,
    damageSmokeSegments: 384,
  },
}

export function isPresetName(value: unknown): value is PresetName {
  return typeof value === 'string' && (PRESET_ORDER as readonly string[]).includes(value)
}

/** 不正な名前は既定へ倒す。クエリ文字列から直接受けるので緩く扱う。 */
export function resolvePreset(value: string | null | undefined): PresetName {
  return isPresetName(value) ? value : DEFAULT_PRESET
}

export function getQuality(name: PresetName): QualitySettings {
  return QUALITY_PRESETS[name]
}

/** 1段下のプリセット。最下段なら null。 */
export function lowerPreset(name: PresetName): PresetName | null {
  const index = PRESET_ORDER.indexOf(name)
  return index > 0 ? PRESET_ORDER[index - 1]! : null
}

/** 1段上のプリセット。最上段なら null。 */
export function higherPreset(name: PresetName): PresetName | null {
  const index = PRESET_ORDER.indexOf(name)
  return index >= 0 && index < PRESET_ORDER.length - 1 ? PRESET_ORDER[index + 1]! : null
}

/**
 * フレームレートを見て品質を落とし、軽くなったら戻す判断をする。
 *
 * 一瞬の落ち込みで降格すると、プリセットが上下して絵がちらつく。一定時間
 * 連続で下回ったときだけ動かし、降格後はしばらく様子を見る。
 *
 * **戻す働きは Phase 10 で足した**（ADR 0042）。それまでは落とす働きしか無く、遊び始めの一時的な重さや
 * ほかの作業の負荷で一度下がると、軽くなっても戻らなかった。`upgradeSeconds` 秒の平均が `upgradeFps`
 * 以上なら 1 段戻す。上限は人が選んだ画質（`ceiling`）。
 * 戻した直後は材質を組み直して重くなるので、落とした直後と同じく `cooldown` 秒は判断しない。戻してから
 * `thrashWindow` 秒以内にまた落ちたら、次に戻すまでに要る秒を 2 倍にする（最長 `maxUpgradeSeconds`）。
 * 値はどれも推測（ユーザーの決定）
 *
 * 実時間に依存するのでキャプチャモードでは使わない。動くと絵が変わって
 * スクリーンショット回帰が壊れる。
 */
export class PerformanceGovernor {
  private belowSeconds = 0
  private cooldownSeconds = 0
  /**
   * 戻す判断の窓。**平均で見る。**1 枚ずつ見て数え直すと、画質を固定しても実機で 10 秒に 0〜4 枚
   * 出る 33 ms のコマ（描画の更新を 1 回逃したもの）で窓が切れ、なかなか戻らない
   */
  private windowSeconds = 0
  private windowFrames = 0
  /** 戻すまでに要る秒。行ったり来たりすると延びる */
  private upgradeHold: number
  /** 通算の秒と、最後に戻した時刻 */
  private elapsed = 0
  private lastUpgradeAt = -Infinity

  constructor(
    /** この fps を下回り続けたら降格する */
    private readonly targetFps = 55,
    /** 何秒連続で下回ったら動かすか */
    private readonly sustainSeconds = 3,
    /** 降格・昇格の後、次の判断までの待ち時間 */
    private readonly cooldown = 5,
    /** この fps 以上が続いたら 1 段戻す */
    private readonly upgradeFps = 58,
    /** 戻すまでに要る秒（最初） */
    upgradeSeconds = 10,
    /** 戻してからこの秒以内に落ちたら、行ったり来たりとみる */
    private readonly thrashWindow = 15,
    /** 戻すまでに要る秒の上限 */
    private readonly maxUpgradeSeconds = 60,
  ) {
    this.upgradeHold = upgradeSeconds
  }

  /** 今、戻すまでに要る秒（検査用） */
  get upgradeSeconds(): number {
    return this.upgradeHold
  }

  /**
   * @param dt 前フレームからの経過秒
   * @param current 現在のプリセット
   * @param ceiling 戻してよい上限（人が選んだ画質）。省けば戻さない
   * @returns 変えるべきなら次のプリセット名、そのままなら null
   */
  update(dt: number, current: PresetName, ceiling: PresetName = current): PresetName | null {
    if (!Number.isFinite(dt) || dt <= 0) return null
    this.elapsed += dt

    if (this.cooldownSeconds > 0) {
      this.cooldownSeconds -= dt
      return null
    }

    const fps = 1 / dt
    if (fps >= this.targetFps) {
      this.belowSeconds = 0
    } else {
      this.belowSeconds += dt
      if (this.belowSeconds >= this.sustainSeconds) {
        this.belowSeconds = 0
        const next = lowerPreset(current)
        if (next !== null) {
          this.cooldownSeconds = this.cooldown
          this.windowSeconds = 0
          this.windowFrames = 0
          if (this.elapsed - this.lastUpgradeAt < this.thrashWindow) {
            this.upgradeHold = Math.min(this.maxUpgradeSeconds, this.upgradeHold * 2)
          }
          return next
        }
      }
    }
    return this.considerUpgrade(dt, current, ceiling)
  }

  private considerUpgrade(dt: number, current: PresetName, ceiling: PresetName): PresetName | null {
    if (PRESET_ORDER.indexOf(current) >= PRESET_ORDER.indexOf(ceiling)) {
      this.windowSeconds = 0
      this.windowFrames = 0
      return null
    }
    this.windowSeconds += dt
    this.windowFrames++
    if (this.windowSeconds < this.upgradeHold) return null
    const average = this.windowFrames / this.windowSeconds
    this.windowSeconds = 0
    this.windowFrames = 0
    if (average < this.upgradeFps) return null
    const next = higherPreset(current)
    if (next === null) return null
    this.cooldownSeconds = this.cooldown
    this.lastUpgradeAt = this.elapsed
    return next
  }

  reset(): void {
    this.belowSeconds = 0
    this.cooldownSeconds = 0
    this.windowSeconds = 0
    this.windowFrames = 0
  }
}
