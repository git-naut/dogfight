# 0010 WebGPU と TSL へ移す

2026-08-31 決定。Phase 8。`0001-rendering-stack.md` を置き換える。0001 は当時の判断として残す。

## 決めたこと

レンダラを `WebGPURenderer` へ、シェーダを TSL へ移す。pmndrs `postprocessing` を外し、three の `RenderPipeline` とノードで組み直す。大気は `@takram/three-atmosphere/webgpu` を使う。

## 0001 の撤回条件は満たされていた

0001 は WebGPU を見送った。理由は 2 つ。`@takram/three-atmosphere` が GLSL で書かれ pmndrs の `postprocessing` を前提とすること。TSL と WebGPU への対応が計画段階に留まること。そのうえで「対応した時点で再検討する」と条件を書いた。

実物を読んだら、条件はとうに満たされていた。CHANGELOG によれば 0.15.0（2025-11-01）が WebGPU と TSL の初期対応を入れている。0.18.0（2026-04-05）で `renderer.contextNode` を使う形になり、`three >= 0.182.0` を要求するようになった。0.19.0（2026-04-27）の変更はすべて WebGPU 実装に対するもの。**0001 を書いた 2026-08-16 の 9 か月前から使えていた。**

Phase 2 で入れた版は最初から `^0.19.1` で、`./webgpu` を export していた。0001 はその後も見直されなかった。

外部の前提は落とす前に測る、という作法をこのプロジェクトは Phase 4 で学んでいる（NASA 3D Resources に戦闘機が 1 機もなかった）。同じ作法がライブラリの機能にも要る。**入っているパッケージの中身を読む手間を惜しむと、9 か月ぶん古い前提の上で設計してしまう。**

## 移行できると確かめたこと

`@types/three@0.185.4` に `three.webgpu.d.ts` と `three.tsl.d.ts` が同梱されている。型が付く。

`WebGPURenderer` は `forceWebGL: true` で WebGL2 バックエンドに落ちる。takram も `AtmosphereLUTTexturesWebGL` を持つ。TSL で 1 度書けば両方で動く。移行の途中で退避できる。

headless Chromium の SwiftShader Vulkan で実際に描けることを測った。次のフラグで adapter と device が取れる。

```
--enable-unsafe-webgpu --enable-features=Vulkan --use-vulkan=swiftshader
--use-angle=swiftshader --enable-unsafe-swiftshader --disable-vulkan-surface
```

320x200 に WGSL で全画面三角形を描いて読み戻すと、画素値がシェーダの式と一致した。adapter の取得 56.2 ms、描画 10 フレームの平均 6.12 ms。

`about:blank` では `navigator.gpu` が undefined になる。保安コンテキストではないため。最初にそれで測って「使えない」と誤読した。localhost 由来のページで測り直す。

速さは 1280x720 の重いフラグメントシェーダで WebGPU 65.2 ms、WebGL2 50.4 ms。**WebGPU が 1.29 倍遅い。**どちらも SwiftShader の Vulkan に落ちるので、差は Dawn と ANGLE の経路の違いになる。ただしこれは合成ベンチ 1 本の比で、「サンプル数の比から ms を外挿しない」が禁じている形をしている。実物の場面で測り直す。

## 公式ドキュメントと実物が食い違った 3 点

`aerialPerspectiveBackdrop()` は 0.19.1 に存在しない。`build/webgpu.js` と `types/webgpu/` を `backdrop` で探して 0 件。

`AerialPerspectiveNode` に `overlay` がない。持つのは `colorNode` / `depthNode` / `normalNode` / `skyNode` / `shadowLengthNode` の 5 つ。**雲を大気へ差し込む口が消える。**WebGL 版の `AerialPerspectiveEffect.overlay` に相当する合成を TSL で自前に書く。式は GLSL 版から写す。

`PostProcessing` は r183 で非推奨になっていた。`warnOnce` を出すだけのラッパで、実体は `RenderPipeline` へリネーム済み。使うのは `RenderPipeline`。

## 移行を楽にした 3 つ

`MeshStandardMaterial` は無変換で動く。`NodeBuilder` が `renderer.library.fromMaterial()` を呼び、`StandardNodeLibrary` が対応するノードマテリアルを返す。glb 由来のマテリアルも `MeshBasicMaterial(vertexColors)` の VFX 4 種も触らない。書き換えが要るのは `ShaderMaterial` の 10 箇所だけ。VFX がテクスチャを 1 枚も使っていないのも効く。サンプラの色空間の食い違いが起きない。

影パスがオブジェクトの `positionNode` を引き継ぐ。CDLOD で頂点変位した地形が影を落とせる。WebGL 経路ではできなかった。障壁は `terrain.vert` のモーフが `cameraPosition` 組み込みを読んでいることで、影パスでは光源カメラの値になり亀裂が出る。主カメラ位置を uniform にすれば済む。現行の絵は変わらない。

`clouds.frag` の `BAYER_8X8[64]` は配列を持たずビット演算で書ける。64 要素すべて一致を確かめた。WGSL で `const array<f32,64>` を動的添字するとテーブルが関数ローカルへ展開されうるので、6 命令のビット式のほうが安い。

## 何を捨てるか

4.1 MB の EXR と `tools/copy-atmosphere-assets.mjs`。`AtmosphereLUTNode` が LUT を実行時に GPU で計算する。代わりに起動時の計算が乗るので、SwiftShader での所要を測ってから確定する。

pmndrs `postprocessing` への依存。`EffectComposer` / `EffectPass` / `SMAAEffect` / `ToneMappingEffect` と、`Pass` を継承した `CloudsPass`。

`ShaderChunk` へのグローバル登録による共有（`#include <cloud_density>` と `<terrain_heightfield>`）。ES module の import になる。型が付き、Vite の依存グラフに乗る。

`EXT_disjoint_timer_query` の直呼びと、フレーム全体と雲パスの交互計測。`renderer.resolveTimestampsAsync()` に替え、内訳は `?sweep=1` の差分に一本化する。

`environment.ts` の `CubeCamera` と `PMREMGenerator`。`skyEnvironment()` に替わる。

## 何を捨てないか

自前の雲のレイマーチ。`@takram/three-clouds` には `./webgpu` がない（`.` と `./r3f` だけで、peer 依存は pmndrs `postprocessing`）。426 行を自力で TSL へ移す。

露出 6。AgX の式は GLSL と TSL で同一だった。一致するのは 4 つ。行列、`AgxMinEv = -12.47393` と `AgxMaxEv = 4.026069`、多項式係数、そして `color *= toneMappingExposure` を掛ける位置。**VFX の色定数を測り直さずに済む。**

## 影は CSM へ上げない

`BasicShadowMap` を選んだ理由は「`PCFShadowMap` は深度テクスチャに `compareFunction` を付けるので自前 GLSL の `sampler2D` から読めない」だった。node 経路では生のサンプラを束縛しないので、この制約は消える。フィルタだけ `PCFShadowMap` へ上げ、ultra は `PCFSoftShadowFilter` を使う。

カスケードは入れない。遮蔽物が機体 1 機（全長 17.8 m）しかなく、28 m 角の箱 1 つで足りている。地形を影の投げ手にするのは別の仕事で、バックエンド移行と同じ段でやると基準画像の差分の帰属が読めなくなる。予算の面でも、4 段 × 2048 は地形 45 万三角形を 4 回投げることになる。

## Phase 9 の範囲

`CascadedShadowMapsNode` による CSM。`shadowLength()` によるエピポーラの体積影（`CSMShadowNode` を引数に要求するので CSM が前提）。`TemporalAntialiasNode`、`SSGINode`、`GTAONode`。地形を影の投げ手にすること。

## 参照

- 実装計画は `~/.claude/plans/phase-8-compiled-sprout.md`
- 置き換えられた判断は `docs/decisions/0001-rendering-stack.md`
- takram の WebGPU の使い方は `packages/atmosphere/WEBGPU.md`（three-geospatial）
