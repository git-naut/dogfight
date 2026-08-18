# dogfight

Three.js で作るアーケード空戦ゲーム。Ace Combat 系の操作感と絵作りを目標にした、オリジナルのオマージュ作。開発計画の正本は `/home/naut8/.claude/plans/ace-combat-claude-code-indexed-wadler.md`。

## 座標系と単位系

右手系、Y が上、機首は -Z。three.js のカメラの向きと揃えてある。

長さはメートル、時間は秒、角度はラジアン、質量はキログラム。HUD に出すときだけノットとフィートへ変換する。変換は表示層でのみ行い、シムの内部には持ち込まない。

## レイヤ規約

`src/sim/` は `three` を import しない。DOM にも触れない。`Math.random()`、`Date.now()`、`performance.now()` も使わない。乱数は `Rng`、時刻は `World.frame` から導出する。

依存は `sim → render` の一方向に限る。render は sim の状態を読むだけで、書き戻さない。この規約は `tests/sim/layering.test.ts` が機械的に検査する。破ると `npm test` が落ちる。

理由は3つある。vitest をブラウザなしで高速に回すため。同じ入力から同じ結果を出してリプレイ検証とスクリーンショット回帰を成立させるため。そして飛行物理のコードをエンジンに隠さず自分で読める形に保つため。

## 決定論の規則

シムは `FIXED_DT = 1/120` 秒の固定ステップで進める。呼び出しは `FixedStepDriver` を経由する。

経過秒は `frame * FIXED_DT` で毎回計算し直す。`time += dt` の積算は禁止。10 分回すと浮動小数点の誤差が乗って、同じフレーム数でも実行ごとに時刻がずれる。

描画に使う時間も `frame + alpha` から導く。エフェクトの位相もパーティクルの寿命も同様。実時間に依存する値を描画へ持ち込むとスクリーンショット回帰が壊れる。

`?capture=1&frame=N&seed=S&preset=high` で決定論キャプチャモードに入る。実時間を使わず N ステップ進めて 1 枚描き、`document.body.dataset.captureReady` を立てて止まる。Playwright はこのフラグを待って撮る。

## コマンド

```bash
npm run dev        # 開発サーバ (http://localhost:5173)
npm test           # vitest。シムの数値検証とレイヤ規約の検査
npm run typecheck  # tsc --noEmit
npm run build      # 型検査してから Vite ビルド
npm run test:e2e   # Playwright。SwiftShader 固定でスクリーンショット回帰
```

## 品質プリセット

Low / Medium / High / Ultra の4段。レンダースケール、雲の方式、影のカスケード段数、LOD 切替距離、ポストエフェクトの有無が連動する。基準は Intel Arc 140V で High・1080p・60fps。

描画の設定を足すときは、必ずプリセット表に列を追加してから実装する。プリセットに載らない設定項目を作らない。

## git identity

このリポジトリは `naut8008@gmail.com`（GitHub は `git-naut`）配下で完結させる。リポジトリローカルの `user.email` を設定済み。グローバル設定は空なので、`.git/config` を消すと別アカウント名でコミットが積まれる。

```bash
git config user.email   # naut8008@gmail.com が返ること
```

## アセットのライセンス

使うのは CC0、パブリックドメイン、OFL、MIT、GPLv2+ のみ。取得したものは URL、作者、ライセンス、取得日を `assets/CREDITS.md` に記録する。記録のないアセットはコミットしない。

GPLv2+ を許すのは、このリポジトリ自体を GPLv2+ にしたため。機体モデルを FlightGear から取り込んだ判断の経緯は `docs/decisions/0005-aircraft.md` にある。GPL のアセットは改変前の原本を `assets/upstream/` にコミットする。GPLv2 が改変に適した形式の提供を求めるので、生成物だけでは足りない。

NASA 3D Resources のモデルは米国政府著作物として使えるが、インシグニアとロゴはパブリックドメインではない。テクスチャからマーキングを除去してから取り込む。

## ドキュメント

飛行モデル、ミサイル誘導、雲のレイマーチングは、実装と並行して `docs/` に数式と実装の対応を書く。このプロジェクトの目的の半分は仕組みを理解することにあるので、後回しにしない。

設計上の判断は `docs/decisions/` に残す。WebGPU への移行、レンダリングスタックの選定、飛行モデルの係数決定などが対象。
