# dogfight

Three.js で作るアーケード空戦ゲーム。Ace Combat 系の操作感と絵作りを目標にしたオリジナルのオマージュ作。

現在 Phase 1（飛ぶ）まで。キーボードで実際に飛ばせる。空力は F-16 の実測値を基準にした揚力・抗力・推力・重力の4力で、そこにアーケード向けの補正を重ねてある。詳細は `docs/flight-model.md`。

## 動かす

```bash
npm install
npm run dev        # http://localhost:5173
```

`?debug=1` を付けると速度、高度、迎角、G、バンク角の計器が出る。

操作は S と下矢印で機首上げ、W と上矢印で機首下げ。A と D でロール、Q と E でヨー。Shift でスロットル増、Ctrl で減。右ドラッグで視点、R でリセット。

## 検証する

```bash
npm test           # vitest。シムの数値検証とレイヤ規約の検査
npm run typecheck  # tsc --noEmit
npm run test:e2e   # Playwright。SwiftShader 固定でスクリーンショット回帰
```

E2E は初回に `npx playwright install chromium` が要る。

## 設計の骨格

`src/sim/` は three.js に依存しない純粋な TypeScript で書く。飛行物理、ミサイル誘導、敵 AI、当たり判定がここに入る。`src/render/` は sim の状態を読むだけで、書き戻さない。この一方向の依存は `tests/sim/layering.test.ts` が機械的に検査する。

シムは 1/120 秒の固定ステップで進む。経過秒は `frame * FIXED_DT` で毎回計算し直し、`time += dt` の積算はしない。10 分走らせると浮動小数点の誤差が乗るため。

`?capture=1&frame=240&seed=42` を付けて開くと決定論キャプチャモードになる。実時間を使わず指定フレームまで進めて 1 枚描き、止まる。Playwright はこれを撮って基準画像と比べる。

## この先

Phase 1 は飛行モデル。Phase 2 で大気散乱、Phase 3 でボリュメトリック雲。Phase 4 で機体モデル、Phase 5 で武装と HUD。Phase 6 で敵 AI、Phase 7 でミッション。

計画の正本は `/home/naut8/.claude/plans/ace-combat-claude-code-indexed-wadler.md`。

## ライセンス

コードは未定。アセットは CC0、パブリックドメイン、OFL のみを使い、出典を `assets/CREDITS.md` に記録する。
