// スクリーンショット回帰の構図と、キャプチャ URL の組み立て。
//
// **ここが正本。**`tests/e2e/smoke.spec.ts` と `tools/exact.mjs` の両方が
// これを読む。写しを持たせない。
//
// 写しを持たせていたときに何が起きたか。`exact.mjs` は雲量を省略したカット
// にパラメータを付けず、アプリ既定の 0.3 が効いていた。`smoke.spec.ts` の
// `capture()` は `query.coverage ?? 0` なので省略すると 0（快晴）になる。
// 全カットが雲量を明示していたので今日は同じ絵が出るが、**雲量を書かない
// カットを 1 枚足した瞬間に `exact.mjs` だけが「動いた」と誤報する。**
// 基準画像の正しさを確かめる道具が嘘をつく。
//
// 素の JavaScript で書く。`tools/exact.mjs` は node が変換なしで実行する
// ため。型は `scenes.d.mts` で与える（`tools/ac3d.mjs` と同じ作法）。

/**
 * キャプチャ URL を組み立てる。
 *
 * **雲量の既定は 0（快晴）。**本番の既定は 0.3 だが、E2E では雲を主題に
 * するテストだけが払えばよい費用。雲のマーチは 1 枚あたり実測 3.9 秒
 * （雲なし 4.5 秒に対して雲あり 8.4 秒）で、160 回のキャプチャに掛かると
 * 待ち時間を倍にする。
 */
export function captureParams(query = {}) {
  const params = new URLSearchParams({ capture: '1' })
  params.set('script', query.script ?? 'level')
  params.set('frame', String(query.frame ?? 240))
  if (query.hour !== undefined) params.set('hour', String(query.hour))
  if (query.preset !== undefined) params.set('preset', query.preset)
  params.set('coverage', String(query.coverage ?? 0))
  if (query.targets === false) params.set('targets', '0')
  if (query.enemies === false) params.set('enemies', '0')
  if (query.aircraft === false) params.set('aircraft', '0')
  if (query.damageSmoke === false) params.set('dmgsmoke', '0')
  if (query.flares === false) params.set('flares', '0')
  if (query.hud !== undefined) params.set('hud', query.hud ? '1' : '0')
  if (query.tracers === false) params.set('tracers', '0')
  if (query.smoke === false) params.set('smoke', '0')
  if (query.explosions === false) params.set('explosions', '0')
  return params
}

/**
 * 基準画像を撮る構図。
 *
 * 増やしたらここだけに足す。`smoke.spec.ts` も `exact.mjs` もこの配列を
 * 読むので、片方だけ直したときに検査が素通りすることがない。
 */
export const SCENES = [
  { name: 'level-afternoon', script: 'level', frame: 240, hour: 16, coverage: 0.3 },
  { name: 'level-backlit', script: 'level', frame: 240, hour: 8, coverage: 0.3 },
  // バンク 66 度・3.27 G・揚力係数 0.449 なので翼端渦が 0.30 の濃さで出る。
  // 荷重倍数で判定していたころは出なかった
  { name: 'bank-left-dusk', script: 'bank-left', frame: 420, hour: 18.3, coverage: 0.3 },
  { name: 'low-pass-afternoon', script: 'low-pass', frame: 240, hour: 16, coverage: 0.3 },
  // 雲を主題にした構図
  { name: 'clouds-climb', script: 'pull-up', frame: 200, hour: 16, coverage: 0.3 },
  { name: 'clouds-dense', script: 'level', frame: 480, hour: 16, coverage: 0.8 },
  { name: 'clouds-clear', script: 'level', frame: 240, hour: 16, coverage: 0 },
  // 地形を主題にした構図。島を見下ろす、海岸線を低空で抜ける、雲を突き抜ける主峰
  { name: 'terrain-overlook', script: 'island-run', frame: 2000, hour: 9, coverage: 0.3 },
  { name: 'terrain-coast', script: 'low-pass', frame: 1800, hour: 9, coverage: 0.3 },
  { name: 'terrain-peak', script: 'island-run', frame: 3240, hour: 17, coverage: 0.3 },
  // 機体を主題にした構図。斜め後方からの接写、自分の影が地面を走るカット、
  // 高 G で翼端渦が出るカット、その渦が画面の縁で切れているカット
  { name: 'aircraft-close', script: 'bank-left', frame: 30, hour: 12, coverage: 0.3 },
  { name: 'aircraft-shadow', script: 'low-pass', frame: 2500, hour: 16, coverage: 0.3 },
  { name: 'aircraft-vortex', script: 'pull-up', frame: 430, hour: 12, coverage: 0.3 },
  // 引き起こしを続けて 7.5 秒。左右の渦が画面の下隅を突き抜ける。
  // 軌跡が空中で尻すぼみに消えていないことを、この 1 枚で見張る
  { name: 'aircraft-vortex-long', script: 'pull-up', frame: 900, hour: 12, coverage: 0.3 },
  // 定常旋回。荷重倍数は 3.08 しかないが揚力係数 0.569 で渦が出る。
  // 荷重倍数で判定していたころは、この構図でまったく渦が出なかった
  { name: 'aircraft-vortex-turn', script: 'bank-left', frame: 1800, hour: 12, coverage: 0.3 },
  // 急上昇して舵を戻した 1.3 秒後。翼端の水蒸気に減衰の時定数がないと、
  // ここで渦が 1 階調しか残らず消える。**この 1 枚が遅れの見張り。**
  { name: 'aircraft-vortex-fade', script: 'zoom-climb', frame: 400, hour: 12, coverage: 0.3 },
  // 水平から 5.4 G の旋回へ入って 9 秒。引き始めた位置に水蒸気の段差が
  // あり、その先細りが視界に入る。**この 1 枚が末端の見張り。**
  // 先細りがないと、いちばん太いところで直角に切り落とされて見える
  { name: 'aircraft-vortex-end', script: 'turn-in', frame: 1100, hour: 12, coverage: 0.3 },
  // 標的機。**快晴で撮る。**雲を背に置くと、実測 28 x 10 画素の機体が
  // 明るい雲に埋もれて絵で判別できない。追従カメラの垂直画角は 66.4 度
  // （速度 250 m/s）あるので、190 m の機体でもこの大きさにしかならない
  { name: 'target-ahead', script: 'target-ahead', frame: 240, hour: 16, coverage: 0 },
  // 定常右旋回。バンク 55.8 度で右へ抜けていく
  { name: 'target-turn', script: 'target-turn', frame: 300, hour: 16, coverage: 0 },
  // HUD を含むカット。ほかのカットに入れると、ピッチラダーの刻みを 1 度
  // 動かすだけで全部が差分を出す
  { name: 'hud-level', script: 'target-ahead', frame: 240, hour: 16, coverage: 0, hud: true },
  // バンク 66 度。ピッチラダーが世界に重なって傾き、水平線が実際の
  // 水平線と一致することを、この 1 枚で見張る
  { name: 'hud-bank', script: 'bank-left', frame: 420, hour: 16, coverage: 0, hud: true },
  // 仰角 35 度。フライトパスマーカーと機首の十字が迎角ぶん離れる
  { name: 'hud-climb', script: 'pull-up', frame: 430, hour: 16, coverage: 0, hud: true },
  // 機銃。曳光弾の帯とガンレティクルと残弾。実測で 304 画素・最大 165 階調
  { name: 'gun-firing', script: 'gun-pass', frame: 60, hour: 16, coverage: 0, hud: true },
  // 捕捉中。破線の箱と進みの帯。ロック後は hud-level が見張る（同じ台本の
  // frame 240 で、そちらは角括弧になる）
  { name: 'hud-acquiring', script: 'target-ahead', frame: 40, hour: 16, coverage: 0, hud: true },
  // ミサイル。発射から 1.5 秒。煙が後方へ伸び、本体が前方にいる
  { name: 'missile-launch', script: 'missile-shot', frame: 300, hour: 16, coverage: 0, hud: true },
  // 自機が自分の煙の筋に沿って飛ぶ。**near 面の見張り。**実測で
  // このフレームの煙の中ほどがカメラの 0.1 m を通る（濃さ 1）
  { name: 'missile-smoke-near', script: 'missile-near', frame: 841, hour: 16, coverage: 0 },
  // 爆発。機銃で落とした 0.13 秒後。火球が膨らみ切る手前。
  // **耐久を 60 へ上げて撃墜が 0.95 秒になったので f90 から f130 へ移した**
  { name: 'explosion-gun', script: 'gun-pass', frame: 130, hour: 16, coverage: 0 },
  // ミサイルの命中。弾頭の炸裂と撃墜の 2 つが重なる。
  // **台本を 1,200 m へ寄せたので命中が 5.56 秒 = f667 になった**
  //
  // **芯が生きているフレームで撮る。**f700 は命中の 0.275 秒後で、芯は
  // `CORE_HOLD` 0.18 秒 + 0.12 秒の減衰で 0.30 秒に消える。実測でも
  // f700 の寄与は 118 画素・彩度 17 で、芯の色を変えても最大差が
  // 19 → 13 としか動かなかった。**芯を壊しても気づけない見張りだった。**
  // f679（0.10 秒後）なら 52 画素・彩度 27 で、色を変えると 45 へ動く
  { name: 'explosion-missile', script: 'missile-shot', frame: 679, hour: 16, coverage: 0 },
  // DLZ バー。正面から向かい合う構図で、rNe と rMax の帯が分かれる。
  // 実測で接近 481 m/s・rMax 40,304 m・rNe 12,070 m
  { name: 'hud-dlz', script: 'head-on', frame: 1080, hour: 16, coverage: 0, hud: true },
  // 敵機。**近くで形が読める大きさで撮る。**190 m だと実測 20 画素で、
  // 単垂直尾翼が 1 本あることくらいしか分からない。台本は右前方 45 m に
  // 置くが、自機が後方にいるので敵は回避（水平のブレイクターン）に入る。
  // 深くバンクした平面形が 2,600 画素で写るので、かえって形が読める。
  // **回避の機動の見張りもこの 1 枚が兼ねる。**220 m の `enemy-evade` は
  // 実測 97 画素しかなく、見張りにならなかった
  { name: 'enemy-formation', script: 'enemy-formation', frame: 240, hour: 16, coverage: 0 },
  // 交戦距離の敵機。ロックボックス込みで、実際に戦う大きさを見張る。
  // **敵は回避に入ってフレアを撒くので、その列もここに写る**
  // （実測 2,069 画素・外接 39x80）。フレアの絵を変えるとこの 1 枚も動く
  { name: 'enemy-ahead', script: 'enemy-ahead', frame: 240, hour: 16, coverage: 0, hud: true },
  // 傷ついた敵が煙を引く。**この 1 枚が煙の見張り。**耐久 2 割で濃さ 0.67。
  // 実測で 4,358 画素・12 階調以上 68 画素・最大 27 階調
  { name: 'enemy-smoking', script: 'damage-smoke', frame: 240, hour: 16, coverage: 0 },
  // 撃たれている。後方から曳光弾が来る。**この 1 枚が「撃たれる」の見張り。**
  // 実測で曳光弾は 1,001 画素・最大 60 階調、画面の下から中央へ 358 画素伸びる
  { name: 'enemy-firing', script: 'enemy-attack', frame: 2400, hour: 16, coverage: 0, hud: true },
  // 敵とすれ違ったあと、置いていかれた煙の中をカメラが通る。
  // **この 1 枚が near 面の見張り。**リボンは新しい端がカメラの後ろにあると
  // 全部消える欠陥があった（翼端渦とミサイルの煙では踏まれない経路）。
  // 実測で煙の寄与は 104,942 画素・12 階調以上 37,397 画素・最大 110 階調。
  // 欠陥があるとこれが 0 になる
  { name: 'damage-smoke-near', script: 'damage-smoke-near', frame: 720, hour: 16, coverage: 0 },
  // 敵が回避に入って撒いたフレア。**この 1 枚がフレアの見張り。**
  // **自機のフレアは追従カメラに映らない**（後方 23 m から前を向くので、
  // 撒いた 0.7 秒後にはカメラの後ろ。旋回しても視線角 155〜173 度のまま）。
  // 実測でフレアの寄与は 1,590 画素・最大 64 階調（`?flares=0` との引き算）。
  // **`FLARE_SALVO_COUNT` 段が縦に並ぶのをこの 1 枚で見張る。**外接 64x47。
  // 横並びだったころは 113x31 だった。
  // **色は付けない。**最も赤い画素で赤み 3・彩度 3。深度書きを落とすと
  // 大気の霞に潰れて寄与そのものが減る（`docs/decisions/0008` の表）
  { name: 'enemy-flare', script: 'enemy-flare', frame: 180, hour: 16, coverage: 0 },
  // 点火の閃光。**f180 には写らない**（撒いてから 1.49 秒後で、閃光は
  // `FLARE_FLASH_SECONDS` 0.25 秒で終わる）。この台本は f1 で撒くので、
  // f10 は経過 0.075 秒にあたる。**この 1 枚が閃光の見張り。**
  // 実測で寄与は 119 画素・最大 169 階調（定常の 64 より強い）。
  // **閃光を落とすとここが暗くなる。**色ではなく明るさで見張る
  { name: 'enemy-flare-flash', script: 'enemy-flare', frame: 10, hour: 16, coverage: 0 },
  // ミッションの時計と残敵。**走行中は HUD 緑。**左上に置く（中央上部は
  // 方位テープとその上の現在方位・三角、さらに上へピッチラダーの目盛が
  // 来て埋まっている）。
  //
  // **f600 は射出が終わった直後。**mission-01 は空母から始まるので、
  // 甲板で待つあいだと射出の 2.4 秒は時計が動かない（f353 で射出完了）。
  // ここは動き始めて 2 秒で、まだ 5 機とも生きている
  { name: 'hud-mission', script: 'mission-01', frame: 600, hour: 16, coverage: 0, hud: true },
  // 決着したミッション。**失敗すると橙に変わる。**この 1 枚が色の
  // 切り替わりの見張り。実測で f2284（19.0 秒）に撃墜されるので、
  // その後の f2400 を撮る（キャプチャは入力なしで飛ぶので撃たれる）
  { name: 'hud-mission-failed', script: 'mission-01', frame: 2400, hour: 16, coverage: 0, hud: true },
  // ミサイル警告。方位の矢印と着弾までの秒。**この 1 枚が警告の見張り。**
  // 真後ろから来るので矢印は真下を指す
  { name: 'missile-warning', script: 'enemy-missile', frame: 600, hour: 16, coverage: 0, hud: true },
  // 降着装置。**対地 30 m なので出ている**（`GEAR_DOWN_AGL` は 80 m）。
  // 脚の有無が画素に出る。他の 41 枚はすべて高度 1,000 m 以上なので
  // 出ていない
  {
    name: 'gear-down',
    script: 'gear-down',
    frame: 30,
    hour: 16,
    coverage: 0,
    targets: false,
    enemies: false,
  },
  // カタパルト射出の途中。**甲板の上を走っている。**降着装置が出て、
  // 機首上げ 10 度、スロットル全開でアフターバーナーが点いている。
  // f180 は射出開始（f60）から 1 秒
  {
    name: 'catapult',
    script: 'catapult-launch',
    frame: 180,
    hour: 16,
    coverage: 0,
    hud: true,
  },
  // 空母。**自機を消す。**追従カメラは自機の後方にあるので、出したまま
  // だと船体の前半が機体で隠れて甲板の標識が読めない。差分が読めない
  // 基準画像には意味がない
  {
    name: 'carrier',
    script: 'carrier-deck',
    frame: 1,
    hour: 16,
    coverage: 0,
    targets: false,
    enemies: false,
    aircraft: false,
  },
]
