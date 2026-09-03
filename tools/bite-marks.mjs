// 歯型。わざと壊して、落ちるべき検査が落ちることを確かめる表。
//
// **テストが通ることと、テストが守っていることは別。**この repo には
// 「宣言しただけで代入を忘れると E2E が静かに嘘をつく」「toHaveScreenshot の
// 通ったは変わっていないではない」という記録がある。どちらも「通っている
// のに守れていない」形だった。
//
// ここに 1 行足すと、その壊し方が毎回試される。`docs/lessons.md` に書いた
// 教訓のうち、機械にできるものはここへ落とす。**教訓を実行可能な形にする。**
//
// 表そのものが腐るので、`tests/tools/mutate.test.ts` が 18 秒の単体テストで
// 健全性を守る。`find` が対象ファイルにちょうど 1 回現れること、`expect` の
// テストが実在すること、`lesson` が `docs/lessons.md` にあること。定数を
// リネームしただけで `find` が当たらなくなり、変異を 1 度も走らせずに気づける。
//
// 変異の型は 6 つ。定数の摂動、比較の反転、条件の固定、文の削除、
// 表の行の削除、符号の反転。段 4 で 6 つ全部が埋まった。

/**
 * @type {import('./bite-marks.d.mts').BiteMark[]}
 */
export const BITE_MARKS = [
  // ── 表の行の削除 ────────────────────────────────────────────
  {
    id: 'help-drop-keyf',
    kind: '表の行の削除',
    file: 'src/input/keyboard.ts',
    find: "  { keys: 'F', action: 'ミサイル', codes: ['KeyF'] },\n",
    replace: '',
    expect: 'tests/input/controlHelp.test.ts',
    lesson: '操作説明と実装のキー割り当てがずれる',
  },
  {
    id: 'help-drop-escape',
    kind: '表の行の削除',
    file: 'src/input/keyboard.ts',
    find: "  { keys: 'Escape', action: 'ポーズ', codes: ['Escape'] },\n",
    replace: '',
    expect: 'tests/input/controlHelp.test.ts',
    lesson: 'ポーズ（Escape）が `CONTROL_HELP` に載っていない',
  },
  {
    id: 'layering-drop-rule',
    kind: '表の行の削除',
    file: 'tests/sim/layering.test.ts',
    find: "  { pattern: /Math\\.random\\s*\\(/, reason: 'Math.random（Rng を使うこと）' },\n",
    replace: '',
    expect: 'tests/sim/layering.test.ts',
    lesson: '`src/sim` から three を import しても、実行するまで気づけない',
  },

  // ── 文の削除 ────────────────────────────────────────────────
  {
    id: 'help-drop-keyc-impl',
    kind: '文の削除',
    file: 'src/input/keyboard.ts',
    find: "    this.input.deployFlare = this.pressed.has('KeyC')\n",
    replace: '',
    expect: 'tests/input/controlHelp.test.ts',
    lesson: '操作説明と実装のキー割り当てがずれる',
  },
  {
    id: 'hook-drop-assign',
    kind: '文の削除',
    file: 'src/main.ts',
    find: '    hook.missilesLeft = currentWorld.combat.missilesLeft\n',
    replace: '',
    expect: 'tests/render/testHook.test.ts',
    lesson: '`TestHook` に項目を足したのに `publish` の代入だけ抜け',
  },

  // ── 定数の摂動 ──────────────────────────────────────────────
  {
    id: 'docs-drag-factor',
    kind: '定数の摂動',
    file: 'docs/flight-model.md',
    find: 'k  = 1 / (π AR e) = 0.113173',
    replace: 'k  = 1 / (π AR e) = 0.1158',
    expect: 'tests/tools/docsNumbers.test.ts',
    lesson: '誘導抗力係数が `0.1158` のままだった',
  },
  {
    id: 'scenes-change-coverage',
    kind: '定数の摂動',
    file: 'tests/e2e/scenes.mjs',
    find: "name: 'clouds-dense', script: 'level', frame: 480, hour: 16, coverage: 0.8",
    replace: "name: 'clouds-dense', script: 'level', frame: 480, hour: 16, coverage: 0.3",
    expect: 'tests/tools/scenes.test.ts',
    lesson: '画素比較の道具と基準画像を撮る側で雲量の既定が違った',
  },
  {
    id: 'lift-slope',
    kind: '定数の摂動',
    file: 'src/sim/flightModel.ts',
    find: '  liftSlope: 4.0,',
    replace: '  liftSlope: 4.5,',
    expect: 'tests/sim/flightModel.test.ts',
    why: '揚力傾斜は最大揚力係数とコーナー速度の両方に効く。動かして誰も気づかないなら、その 2 つを見張れていない',
  },
  {
    id: 'seeker-acquire-angle',
    kind: '定数の摂動',
    file: 'src/sim/weapons/lock.ts',
    find: 'export const SEEKER_ACQUIRE_ANGLE = 20 * DEG',
    replace: 'export const SEEKER_ACQUIRE_ANGLE = 30 * DEG',
    expect: 'tests/sim/lock.test.ts',
    why: '捕捉の視野。広げて誰も気づかないなら、境界を見張れていない',
  },
  // ── Stryker の掃引が見つけた穴（段 4）────────────────────────
  // 生存していた変異をそのまま歯型にする。13 分の掃引を毎回は回せないので、
  // **見つかったものだけ 1 秒の検査へ引き上げる。**
  {
    id: 'level-gain-divide',
    kind: '符号の反転',
    file: 'src/sim/assist.ts',
    find:
      '  if (input.roll === 0 && Math.abs(view.bank) > LEVEL_DEADZONE) {\n' +
      '    roll = clamp(-view.bank * LEVEL_GAIN, -1, 1)',
    replace:
      '  if (input.roll === 0 && Math.abs(view.bank) > LEVEL_DEADZONE) {\n' +
      '    roll = clamp(-view.bank / LEVEL_GAIN, -1, 1)',
    expect: 'tests/sim/assist.test.ts',
    lesson: '符号と向きだけを見ていると、掛け算を割り算に変えても落ちない',
  },
  {
    id: 'recover-pitch-boundary',
    kind: '比較の反転',
    file: 'src/sim/assist.ts',
    find: '    pitch = Math.abs(view.bank) < 0.5 ? 1 : 0.2',
    replace: '    pitch = Math.abs(view.bank) <= 0.5 ? 1 : 0.2',
    expect: 'tests/sim/assist.test.ts',
    lesson: '符号と向きだけを見ていると、掛け算を割り算に変えても落ちない',
  },
  {
    id: 'dlz-overtook-never',
    kind: '定数の摂動',
    file: 'src/sim/weapons/dlz.ts',
    find: '    if (speed > targetSpeedAway) overtook = true',
    replace: '    if (speed > targetSpeedAway) overtook = false',
    expect: 'tests/sim/dlz.test.ts',
    lesson: '追い越しの判定と DLZ の clamp が丸ごと素通りしていた',
  },
  {
    id: 'dlz-drop-clamp',
    kind: '文の削除',
    file: 'src/sim/weapons/dlz.ts',
    find: '  if (out.rNe > out.rMax) out.rNe = out.rMax\n',
    replace: '',
    expect: 'tests/sim/dlz.test.ts',
    lesson: '追い越しの判定と DLZ の clamp が丸ごと素通りしていた',
  },

  {
    id: 'standard-roll-gain',
    kind: '定数の摂動',
    file: 'src/sim/assist.ts',
    find: 'const STANDARD_ROLL_GAIN = 0.7',
    replace: 'const STANDARD_ROLL_GAIN = 1.0',
    expect: 'tests/sim/assist.test.ts',
    why: 'スタンダード操作のロール抑制。1.0 はエキスパートと同じ。補助が効いていることを数で見張れているか',
  },

  // ── 比較の反転 ──────────────────────────────────────────────
  {
    id: 'fixed-step-boundary',
    kind: '比較の反転',
    file: 'src/sim/loop.ts',
    find: '    while (this.accumulator >= this.dt) {',
    replace: '    while (this.accumulator > this.dt) {',
    expect: 'tests/sim/loop.test.ts',
    why: '固定ステップの境界。ちょうど 1 ステップぶん溜まったときに進めなくなる。「半ステップ 2 回で 1 ステップ」がこれを見張っているはず',
  },

  {
    id: 'escape-uses-event-key',
    kind: '比較の反転',
    file: 'src/main.ts',
    find: "    if (event.code !== 'Escape') return",
    replace: "    if (event.key !== 'Escape') return",
    expect: 'tests/input/controlHelp.test.ts',
    lesson: 'ポーズ（Escape）が `CONTROL_HELP` に載っていない',
  },

  // ── 条件の固定 ──────────────────────────────────────────────
  {
    id: 'help-scan-one-file',
    kind: '条件の固定',
    file: 'tests/input/controlHelp.test.ts',
    find: "    .filter(({ source }) => source.includes('keydown') || source.includes('KeyboardEvent'))",
    replace: "    .filter(({ path }) => path.endsWith('keyboard.ts'))",
    expect: 'tests/input/controlHelp.test.ts',
    lesson: 'ポーズ（Escape）が `CONTROL_HELP` に載っていない',
  },
  {
    id: 'aoa-limiter-always-off',
    kind: '条件の固定',
    file: 'src/sim/aircraft.ts',
    find: '    const useLimiter = options.aoaLimiter !== false',
    replace: '    const useLimiter = false',
    expect: 'tests/sim/aircraft.test.ts',
    why: '迎角制限器を常に切る。既定で効いていることを見張れているか。切れるようにしてある機能は、既定側も見張らないと片側しか通らない',
  },
  {
    id: 'shadow-tiles-drop-length-guard',
    kind: '文の削除',
    file: 'src/render/clouds/geometry.ts',
    find: '  if (bytes.length < width * height * 4) return []\n',
    replace: '',
    expect: 'tests/render/shadowHistogram.test.ts',
    why: '読み戻せていない絵を 0 で埋めて返すと、GLSL 版との突き合わせが「一致した」になる。長さが足りないときは空を返すこと',
  },
  {
    id: 'shadow-tiles-single-cell',
    kind: '定数の摂動',
    file: 'src/render/clouds/geometry.ts',
    find: 'export const SHADOW_TILES = 4',
    replace: 'export const SHADOW_TILES = 1',
    expect: 'tests/render/shadowHistogram.test.ts',
    lesson: '分布は配置を見ない',
  },
  {
    id: 'shadow-inputs-drop-empty-check',
    kind: '文の削除',
    file: 'src/render/clouds/shadowInputs.ts',
    find: "  if (parts.some((p) => p.trim() === '')) return null\n",
    replace: '',
    expect: 'tests/render/shadowInputs.test.ts',
    why: "`Number('')` は 0 を返すので、末尾の欠けた `?shadowinputs=` が「中心 Z が 0」として黙って通る。TSL 版と GLSL 版が別の入力で焼いたものを比べることになる",
  },
  {
    id: 'readback-drop-stride-guard',
    kind: '文の削除',
    file: 'src/render/pipeline/readback.ts',
    find: `  if (!Number.isInteger(stride) || stride < rowBytes) {
    throw new Error(
      \`読み戻しの行の間隔が読めない: 長さ \${total}、幅 \${width}、高さ \${height}\`,
    )
  }

`,
    replace: '',
    expect: 'tests/render/readback.test.ts',
    lesson: '読み戻しの向きと原点がバックエンドで違う',
  },
  {
    id: 'march-samples-drop-high-byte',
    kind: '文の削除',
    file: 'src/render/clouds/marchProbe.ts',
    find: 'bytes[i * 4]! * 256 + bytes[i * 4 + 1]!',
    replace: 'bytes[i * 4 + 1]!',
    expect: 'tests/render/marchProbe.test.ts',
    why: '密度サンプル数は R と G に 16bit で詰めてある。上位バイトを落とすと 256 以上が全部同じに見え、歩き方の違いが埋もれる',
  },
  {
    id: 'march-camera-below-slab',
    kind: '定数の摂動',
    file: 'src/render/clouds/marchProbe.ts',
    find: '  positionY: 2000,\n  positionZ: 0,',
    replace: '  positionY: 900,\n  positionZ: 0,',
    expect: 'tests/render/marchProbe.test.ts',
    lesson: '通っていない枝は検査されない',
  },
  {
    id: 'byte-difference-drop-length-guard',
    kind: '文の削除',
    file: 'src/render/clouds/marchProbe.ts',
    find: `  if (a.length !== b.length) {
    return { differing: Number.POSITIVE_INFINITY, max: Number.POSITIVE_INFINITY }
  }
`,
    replace: '',
    expect: 'tests/render/marchProbe.test.ts',
    why: '長さの違う 2 枚を先頭だけ比べると「違うバイト 0 個」になる。読み戻せていない絵を一致したと読む形を作らない',
  },
  {
    id: 'height-probe-step-on-grid',
    kind: '定数の摂動',
    file: 'src/render/terrain/heightProbe.ts',
    find: 'step: { x: 1237.3, z: 1511.7 }',
    replace: 'step: { x: 1248, z: 1536 }',
    expect: 'tests/render/heightProbe.test.ts',
    why: '刻みをテクセル 48 m の倍数にすると双三次が t = 0 になり、焼いた値をそのまま返すだけの検査になる。補間の途中を通さないと写し間違いが見えない',
  },
  {
    id: 'height-error-drop-nan-guard',
    kind: '文の削除',
    file: 'src/render/terrain/heightProbe.ts',
    find: '    if (!Number.isFinite(d)) return Number.POSITIVE_INFINITY\n',
    replace: '',
    expect: 'tests/render/heightProbe.test.ts',
    why: 'NaN との差は比較が常に false になるので、最大のずれ 0 として通ってしまう。読み戻せていない点を一致したと読む形を作らない',
  },
]
