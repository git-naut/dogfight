# dogfight

Three.js で作るアーケード空戦ゲーム。Ace Combat 系の操作感と絵作りを目標にしたオリジナルのオマージュ作。

現在 Phase 7（ミッションになる）まで。空母の甲板からカタパルトで射出され、敵 5 機と戦って制限時間内に決着する。物理ベースの大気散乱とボリュメトリック雲、海と島嶼、F/A-18C の機体、機銃とミサイル、敵 AI、HUD、効果音が入っている。

空力は F-16 の実測値を基準にした揚力・抗力・推力・重力の4力に、アーケード向けの補正を重ねてある。詳細は `docs/flight-model.md`。空は Bruneton の Precomputed Atmospheric Scattering で、時刻を変えると朝焼けから薄暮まで変化する。経緯は `docs/decisions/0002-atmosphere-integration.md`。

雲はレイマーチングで自前実装した。積雲が点在し、間を抜けられる。山肌には雲影が落ちる。原理と実装の対応は `docs/clouds.md`。

地形は 48 km 四方の高さ場から起こす。島が 4 個あり、主峰は 2,224 m で雲底を突き抜ける。山へ突っ込めば墜落する。高さ場は sim が持ち、描画と当たり判定が同じ値を引く。原理と実装の対応は `docs/terrain.md`。

機体は FlightGear FGAddon の F/A-18C（18,634 三角形）。舵面が入力どおりに動き、自分の影を地形へ落とし、高 G で翼端から渦を引く。飛行モデルの諸元も Hornet に揃えてある。原理と実装の対応は `docs/aircraft.md`。

武装は M61A1 バルカンと AIM-9 相当の赤外線ミサイル。弾道は重力と空気抵抗を積分する。敵はフレアで逸らしてくる。原理と実装の対応は `docs/weapons.md`、敵の挙動は `docs/enemy.md`。

空母は FlightGear fgdata の USS Nimitz（2,644 三角形）。甲板でスロットルを開けると C-13 カタパルトの公表値どおりに射出される。終端速度 150 kt、行程 94 m、3.2 G、2.44 秒。原理と実装の対応は `docs/carrier.md`。

効果音は Web Audio で合成する。外部の音源は使っていない。原理と実装の対応は `docs/audio.md`。

## 動かす

```bash
npm install
npm run dev        # http://localhost:5173
```

`?debug=1` を付けると速度、高度、対地高度、迎角、G、バンク角、太陽高度、GPU フレーム時間、地形の三角形数の計器が出る。`?hour=18` で時刻を、`?coverage=0.8` で雲量を、`?preset=low` で品質を切り替えられる。

操作は S と下矢印で機首上げ、W と上矢印で機首下げ。A と D でロール、Q と E でヨー。Shift でスロットル増、Ctrl で減。Space で機銃、F でミサイル、C でフレア。右ドラッグで視点、R でやり直し、Escape でポーズ。

キー割り当ての正本は `src/input/keyboard.ts` の `CONTROL_HELP`。タイトル画面にも同じ一覧が出る。

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

`?capture=1&script=level&frame=240&hour=16` を付けて開くと決定論キャプチャモードになる。実時間を使わず指定フレームまで進めて 1 枚描き、止まる。太陽の位置も雲の流れも時刻とフレーム番号から固定される。Playwright はこれを撮って基準画像と比べる。

## この先

Phase 4 で機体モデル、Phase 5 で武装と HUD、Phase 6 で敵 AI、Phase 7 でミッション。

Phase 7 で残っているのは実機での調整だけ。機銃の携行弾数、ミサイルの数、制限時間は推定で置いてあり、遊んで直す。手順は `docs/playtest.md`。

計画の正本は `/home/naut8/.claude/plans/ace-combat-claude-code-indexed-wadler.md`。

## ライセンス

GNU General Public License version 2 またはそれ以降（`LICENSE`）。

機体モデルに FlightGear FGAddon の F/A-18C Hornet（作者 Fabrice Kauffmann、GPLv2+）と F-16 を使っている。空母は fgdata の USS Nimitz（作者 Vivian Meazza、GPLv2）。そのためリポジトリ全体を GPLv2+ にしてある。改変前の原本は `assets/upstream/` にコミットしてある。GPLv2 が改変に適した形式の提供を求めるので、生成した glb と WebP だけでは足りない。

アセットの出典は `assets/CREDITS.md`。判断の経緯は `docs/decisions/0005-aircraft.md`。
