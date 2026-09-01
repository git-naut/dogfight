# 教訓

壊れ方の記録。なぜその設計にしたかは `docs/decisions/` にある。ここに書くのは、何が静かに嘘をついたか。

各行に 3 列を置く。何が起きたか、何で気づいたか、いま何が守っているか。**3 列目が「未対応」の行は教訓ではなく穴。**その数を減らすのが Phase 8 の仕事のひとつ。

3 列目に挙げた検査は `npm test` で毎回走る。1 件でも落ちたら、そこに書いた壊れ方が戻ってきている。

## 検査が守っているもの

| 何が起きたか | 何で気づいたか | いま何が守っているか |
|---|---|---|
| 基準画像の枚数が 4 通りの古い値で散っていた。`docs/hud.md` が 34 と 19、`src/hud/hud.ts` が 37、`tests/e2e/smoke.spec.ts` が 39。実際は 42 | Phase 8 の着手前調査 | `tests/tools/scenes.test.ts` が総数・HUD 入り・空母・ミッションの枚数を固定する |
| 画素比較の道具と基準画像を撮る側で雲量の既定が違った。前者は 0.3、後者は 0。全カットが明示していたので露見していなかった | 同上 | `tests/e2e/scenes.mjs` の `captureParams` を両方が呼ぶ。`tests/tools/scenes.test.ts` が既定値を固定 |
| ブラウザの起動引数を 2 か所に写しで持っていた。1 つ違うだけでラスタライザが変わる | 同上 | `tests/e2e/launch.mjs` を `playwright.config.ts` と `tools/exact.mjs` の両方が読む |
| `docs/flight-model.md` の誘導抗力係数が `0.1158` のままだった。AR 3.44（F-16）の値で、実装は 0.113173 | 同上 | `tests/tools/docsNumbers.test.ts` がドキュメントの数値と実装を突き合わせる |
| 翼面荷重を 4,395 N/m² と書いていた。実測は 4,393.99 で 4,394 | `tests/tools/docsNumbers.test.ts` を書いた直後に落ちた | 同上。ドキュメントから読んだ値と計算値を突き合わせ、期待値を 2 度書かない |
| `TestHook` に項目を足したのに `publish` の代入だけ抜け、E2E が「ミサイル 0 発」と報告した | E2E の数値検査 | `tests/render/testHook.test.ts` が全項目を機械的に検査する |
| `src/sim` から three を import しても、実行するまで気づけない | Phase 0 の設計 | `tests/sim/layering.test.ts` が禁止 13 パターンを検査し、既知違反 12 件で発火も確かめる |
| 操作説明と実装のキー割り当てがずれる | Phase 7 | `tests/input/controlHelp.test.ts` が `poll()` のソースと `CONTROL_HELP` を双方向に突き合わせる |
| ポーズ（Escape）が `CONTROL_HELP` に載っていない。判定が `main.ts` にあって抽出対象の外、しかも `event.key` を使うので正規表現にも当たらなかった。**二重に外れていた** | Phase 8 の着手前調査 | 同じ検査が `src/` からキーボードを見ているファイルを探して全部読む。`event.key` での判定も禁じる |
| 符号と向きだけを見ていると、掛け算を割り算に変えても落ちない。`assist.ts` の自動水平化は `-bank * 1.2` を `-bank / 1.2` にしても全テストが通った | Stryker の掃引（段 4） | `tests/sim/assist.test.ts` がゲインの大きさと境界を固定する。歯型 `level-gain-divide` `recover-pitch-boundary` |
| 基準画像 42 枚が VFX を見張っていなかった。宣言 56 件のうち発火したのは 27 件で、大面積のもの（`aircraft` 13、`terrain` 9、`water` 4）だけ。`maxDiffPixelRatio: 0.005` は 4,608 画素まで許すが、フレアの寄与は 1,590、曳光弾 304、爆発 52 画素 | 段 6 の画素の逆テスト | `tests/e2e/pixel-mutate.spec.ts`（`MUTATE=1`）が宣言と実測を突き合わせる。許容を 0 にした |
| 逆テストの基準画像が別ディレクトリに解決され、比較ではなく新規作成になっていた。`toHaveScreenshot` は spec ファイル名から置き場を決める。**落ちるはずの検査が静かに通る** | 書いた直後に気づいた | `playwright.config.ts` の `snapshotPathTemplate` が置き場を spec 名から切り離す |
| 追い越しの判定と DLZ の clamp が丸ごと素通りしていた。`overtook = true` を `false` にしても、`rNe > rMax` の補正を消しても落ちない | 同上 | `tests/sim/dlz.test.ts` が値を固定する。歯型 `dlz-overtook-never` `dlz-drop-clamp` |
| `webglVersion` をバックエンドの facade へ寄せるとき、値を `kind` から導いた。`kind === 'node-webgpu' ? 0 : 2` は WebGL 経路で必ず 2 を返すので、`smoke.spec.ts` の「WebGL2 が取れているか」が**原理的に落ちなくなっていた**。継ぎ目を作る作業がそのまま見張りを外す | 段 7 の差分を読み直したとき | `RenderBackend.webglVersion` が `gl.VERSION` の実物を読む。`smoke.spec.ts` は `hook.backend` も見る |
| 継ぎ目は、越える者が現れた瞬間に意味を失う。帳簿からレンダラを 1 行借りても絵は動かないので、基準画像 42 枚は気づかない。**段 15 で実装を差し替えたときに初めて落ちる** | 段 8 で継ぎ目を切ったとき | `tests/render/pipelineSeam.test.ts` が `scene.ts` の本文と import を検査する。`createGpuTimer` を 1 行足すと 2 件落ちることを実測した |
| three の描画順は、不透明が `material.id` を深度より先に見る（`WebGLRenderLists.js:1-49`）。`material.id` も `object.id` も生成のたびに 1 増える大域の連番なので、**組み立ての順番を入れ替えると前後関係に関係なく絵が動く** | 段 8 で 1,130 行を移す前に `node_modules` を読んだ | 組み立ての順番は `pipeline/webgl.ts` の 1 か所だけ。`npm run exact` が許容 0 で 42 枚を数える |
| node 経路の `ShaderMaterial` は**落ちない**。`THREE.NodeBuilder: Material "ShaderMaterial" is not compatible.` をコンソールへ出したまま描画が進み、`initError` も立たない。例外で止まると思っていると、エラーを 1 行見落とした時点で「動いている」と読む | 段 9 で実際に 1 枚入れて測った | `tests/e2e/node-path.spec.ts` が `shaderMaterials` の数と `errors` の両方を見る。1 枚入れると 2 件落ちることを実測した |
| node 経路の `info` は自分で 0 に戻さないと積算される。`autoReset` は既定 true だが、`info.reset()` は `Animation.js:75`（`setAnimationLoop` の中）からしか呼ばれない。`WebGLRenderer` は `render()` の中で戻すので、作法が逆になる | 9 枚描いたらドローコール 52 が 468、三角形 18,899 が 170,091 とちょうど 9 倍になった | `src/render/pipeline/node.ts` が読む直前に `info.reset()` を呼ぶ。段 15 で `backend.resetInfo()` を node 側へ移すときの前提 |

## まだ守るものがない穴

| 何が起きたか | 何で気づいたか | いま何が守っているか |
|---|---|---|
| ADR 0001 が「対応した時点で再検討する」と条件を書いたが、条件が満たされたかを誰も確かめなかった。ライブラリは 9 か月前から対応済み | Phase 8 の着手前調査 | 未対応。段 1 の歯型表で扱う |
| `HudArmament.flares` は代入されているのに読む場所が 1 つもない。フレア残数が画面に出ない | 同上 | 未対応。段 30 で埋める |
| glb の `cockpit` に内装がないのに、ADR 0005 が「見せれば足りる」と書いていた。実測 244 三角形、0.43 × 0.41 × 0.96 m | 同上 | 未対応。ADR 0005 に実測を書いたのみ |
| `src/input/` と `src/render/camera.ts` に単体テストが 1 件もない。カメラを動かすと基準画像 42 枚が全部動くので原因が切り分けられない | 同上 | 未対応。段 37 で埋める |
| 揚力傾斜 4.0 の補正式が書かれておらず、値だけでは検算できなかった | 同上 | 式を書いた。`tests/tools/docsNumbers.test.ts` が式と実装の一致を見る |

## 測り方で踏んだもの

| 何が起きたか | 何で気づいたか | いま何が守っているか |
|---|---|---|
| `about:blank` で `navigator.gpu` を見て「WebGPU は使えない」と結論した。保安コンテキストではないため undefined になる | 同じ測定を localhost 由来のページでやり直した | `tools/webgpu-probe.mjs` が `secureContext` を必ず出す |
| adapter が取れることと描けることを同じものとして扱いかけた | 読み戻しまでやった | `tools/webgpu-probe.mjs` が画素をシェーダの式と突き合わせる |
| `toHaveScreenshot` が通ったことを「変わっていない」と読んだ。1 画素あたり 0.05 まで許すので、機体をまるごと差し替えても 10 枚中 4 枚が通る | Phase 4 | `tools/exact.mjs` が許容差なしで数える。描画に触る段ごとに走らせる |
| 合成ベンチ 1 本の比から所要を外挿しかけた。雲では +31% の見積りが実測 +58% だった。**段 9 では向きすら逆だった。**段 0 の合成ベンチは「WebGPU が 1.29 倍遅い」、実物の場面では WebGPU が 1.23 倍速い | Phase 3 の記録と、段 9 の実測 | 未対応。人が思い出すしかない。`docs/measuring.md` に見積りと実測を並べて残した |
| 21 条件を全部回すと統合 GPU が熱で遅くなる。ばらつきが 0.35 から 6.01 ms へ悪化した | Phase 6 | `?only=` で条件を絞る。`benchUnreadable` が読めない表を判定する |
| CI の E2E が 25 分の上限に当たった。テストは 1 件も落ちていない。2 分割のまま所要が 16.7 → 24.0 → 25.7 分と育っていたが、通り続けていたので余裕が減っていることが見えなかった | 上限に当たって初めて | 4 分割にして 1 台 13 分前後へ。上限を 18 分に下げ、余裕を 1.4 倍に留めた。**当たったら分割を増やす。上限は上げない** |
| `--shard` はテストの本数で割る。並びはファイル順・行順なので、末尾に固まったライブ UI が 1 台へ寄る。4 分割にしても最長 17.4 分で上限 18 分に対し余裕 1.03 倍だった | 上限に当たって初めて | 未対応。8 分割にして薄めているだけで、釣り合わせてはいない。所要を見た分配が要る |
| 遅さの正体は競合だった。ページ読み込みは実測 3.4 秒、テストの中身も待ち 1.5 秒 × 2 程度。SwiftShader は CPU 律速なので、ワーカーが同時に描くと 1 件が 20〜45 秒へ伸びる | 段 5 で `preset` を振って測った | 未対応。ワーカー数と分割数で調整しているだけ |
| CI の E2E が実時間の待ちで落ちた。`waitForTimeout(3000)` のあと `speed > 50` が 30 秒待って 0 のまま。スロットルは `dt / 2.5` を積むので、シムが実時間に追いつかないと開き切らない。**リトライで通ったので隠れていた** | run 33378420162 のログに `✘` を探して | `tests/e2e/smoke.spec.ts` が値で待つ形になった。ポーズの復帰も同じ形へ直した |
