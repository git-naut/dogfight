# 0011 ポストプロセスの鎖

Phase 8 段 22 から。絵作りの段はすべてここに積む。

## 鎖は 1 関数にまとめる

`src/render/pipeline/nodeOutput.ts` の `createNodeOutputNode` が鎖の全部を組む。
呼ぶのは `nodeScene.ts` の `buildOutput(quality)` 1 か所だけ。

```
pass(scene, camera)
  → 雲の合成 + 大気（overlayCompositeNode）
  → bloom（quality.bloomStrength > 0 のときだけ）
  → smaa
  → renderOutput（RenderPipeline が足す。AgX + 露出 + 色空間）
```

段を足すときは `NodeOutputInput` に引数を増やす。**動的 import は
`nodeOutput.ts` に置かない。**呼ぶ側が `await import()` して関数を渡す。
SMAA が 53 KB、Bloom が 17 KB の別チャンクになるので、既定のバンドルに
載せない方針を保つ。

## 露出は鎖の外で掛かる

**これを踏むと 6 倍ずれる。**

`RenderPipeline._updateContext` が `renderOutput(this.outputNode, ...)` で
戻り値を包む。その中の `ToneMappingNode` は `toneMappingFn(rgb, exposureNode)`
を呼ぶ。AgX（`ToneMappingFunctions.js`）は `colortone.mulAssign(exposure)` を
最初に走らせる。

つまり **`createNodeOutputNode` の中を流れる値には露出が掛かっていない。**
空の線形値の最大は 0.1844 で、露出 6 を掛けた 1.11 ではない。

閾値のような「明るさの基準」を渡すノードは、**露出で割ってから渡す**
（`nodeScene.ts` の `bloomThresholdFor`）。`BLOOM_THRESHOLD_AFTER_EXPOSURE` は
露出後の値で宣言し、割る責任を 1 か所に集める。

`?exposure=` と `setExposure` が実行時に露出を変えるので、閾値は uniform に
して一緒に動かす。定数で焼くと露出を振った瞬間に意味がずれる。

## プリセットで鎖を組み直す

`applyPreset`（`nodeScene.ts`）の末尾で `pipeline.outputNode` を差し替えて
`needsUpdate` を立てる。`RenderPipeline` は差し替えを正式に受ける。

**uniform で 0 にする形は採らない。**`BloomNode` は強さ 0 でも 5 段の
ガウシアンぼかしを焼く。low で切る意味が費用の側にあるので、段そのものを
外す。

GLSL 側は `composer.ts` の `buildEffectPass(quality)` が同じ形。**写しを
2 つ作らない**という規約はここには当てはまらない（鎖の組み方そのものが
バックエンドで違う）。

## ポストの費用は `?sweep=1` で測れない

`MeasureConfig` のトグルは uniform で 0 にする形なので、鎖に入った段は評価が
走ったまま。鎖を組み直せば切れる。ただし掃引の最中に組み直すと、測る対象そのものが変わる。

2 回走らせて基準の行を引く。

```
?bloom=0&sweep=1&only=base   と   ?sweep=1&only=base
```

**ただし node 経路では `?sweep=1` の値そのものを信用できない。**
`docs/measuring.md` の 2026-09-17 の表では、切ったほうを遅く測った行が 3 つ並ぶ。
配分はライブループの `tools/win-perf.mjs` で引き算する。

## 効きの判定は 3 条件の組で行う

片側だけでは「全体が明るくなった」と「ハイライトが立った」を区別できない。
ブルームでは次の 3 つを同時に見る。

- 空だけの領域の中央値が **+2% 以内**（空をブルームさせていない）
- **雲**の領域の中央値が **+3% 以内**（積雲の輪郭を残している）
- 輝点の**外周**の中央値が **+25% 以上**（ハイライトが立った）

**雲を測るのを忘れない。**最初は雲量 0 の構図で掃引したので、ブルームさせたく
ない最大のものが構図に入っていなかった。決めた値を雲のある絵に当てると積雲が
白飛びした。雲は空より明るいので、空が +0.3% でも雲は大きく動く。

**輝点そのものを測らない。**白飛びしている画素は足しても 1.0 で頭打ちになり、
閾値を 3 倍以上振っても値が動かない（実測で +2.0% のまま並んだ）。

この形は計画書が段 24（表面ディテール）で書いた判定と同じで、
`tools/bloom-sweep.mjs` の実装をそちらでも使う。

## 判定は構図の性質に紐づく

上の 3 条件は**順光の構図でしか成立しない。**逆光（`level-backlit`、hour 8）は
太陽そのものが空にあるので、空を動かさない閾値では何も光らない（閾値 11 で
外周 +0.0%）。判定を満たす値が存在しない。

順光で候補を絞り、**逆光は実機の絵を並べて選ぶ。**

## 数だけでは決めない

閾値と強さは実機の絵 3 枚を並べて決めた。`low-pass` frame 1800、hour 9。

| 閾値・強さ | 絵 |
|---|---|
| 1.2・1.0 | 積雲の輪郭が消え、機体の青いマーキングも飛ぶ |
| 4.5・2.0 | 山の緑は戻るが、雲はまだ飛ぶ |
| **8.0・2.0** | **雲の輪郭が残り、太陽の周りだけが滲む** |

**掃引は候補を絞る道具で、決めるのは絵。**

## 順光の排気口は拾わない（宿題）

閾値 8 では順光の排気口が光らない（`low-pass-afternoon` で外周 +0.0%）。
排気口の線形輝度は 0.92 で、雲の明るい部分と近い。**閾値だけでは分けられない。**

発光体だけを光らせるには emissive を MRT へ出す。three の `BloomNode` の doc に
その形が載っている。

```js
scenePass.setMRT( mrt( { output, emissive } ) )
const bloomPass = bloom( scenePass.getTextureNode( 'emissive' ) )
renderPipeline.outputNode = scenePassColor.add( bloomPass )
```

段 27 で MRT を入れたら測り直す。

## 風圧はトーンマップの後ろに置く（段 23）

放射ブラーと色収差は表示域の色に掛けるのが本来で、HDR の線形値に掛けると暗部の滲みが出ない。`RenderPipeline.outputColorTransform` を切り、鎖の側で `renderOutput` を挟む。挟んだかどうかは `NodeOutput.ownsOutputTransform` で `buildNodePipeline` へ渡す。呼ぶ側が条件を書き写すと、片方だけ直したときにトーンマッピングが 2 度掛かる。

強さは荷重倍数が決める。`AircraftSample.loadFactor` を毎フレーム uniform へ渡す。実時間ではなく sim の値なので、キャプチャでも絵が決まる。

### 1 G で恒等にするのに 3 つ踏んだ

巡航中の絵が動かないことは、演出を積む前に単独で証明する（段 22 で作った作法）。最初の実装は 42 枚とも 8%・1 階調動いた。原因は 3 つ別だった。

`convertToTexture` の往復。`radialBlur` と `chromaticAberration` は先頭で入力をテクスチャへ焼く。`exposure: 0` / `strength: 0` は数式の上では元の色を返す。だが中間のテクスチャを往復するぶん量子化される。強さを固定値で作り、`mix` で混ぜる形にした。

`mix` のメソッド形式。`a.mix(b, c)` は `mix(b, c, a)` になる（`mixElement` の定義）。a が混ぜ率として使われ、全画面が 226 階調動いた。関数形式で書く。

閾値を 1 G ちょうどに置いたこと。水平飛行でも荷重倍数は 1.001 になる。`(g - 1) / 5` が小さな正の値を返すので、効き始めを 1.5 G へ上げた。**物理量のちょうどの値を閾値にしない。**

### 色収差は外した（費用が合わない）

実機で段階ごとに測ったら、放射ブラーまでは 9.7 ms・60 fps なのに、色収差を
足すと 14.0 ms・53 fps へ落ちた（`lens=0` は 7.3 ms・60 fps）。
`chromaticAberration` は先頭で `convertToTexture` を通すので、中間ターゲット
への焼き付けがもう 1 回増える。

絵の寄与は滲みと周辺減光に比べて小さいので外した。鎖は
`renderOutput → radialBlur → vignette` の 3 段。放射ブラーのサンプル数も
three の doc が勧める下限（16）より下の 8 にした。絵の差は最大 6 階調で、
`interleavedGradientNoise` のディザが効いて帯は出ない。

**ポストの段は「安い」と決めてから積まない。**計画書はこの段を「ブルームの
次に安い色だけの段」と見ていたが、実測では色収差だけでブルーム全体
（+1.8 ms）の 2 倍を超えた。

### 効き方は高 G で振って決めた

最初の定数（滲み 0.6 / 周辺減光 0.45）は、6.7 G で画面を明るく霞ませた。実機の高 G は逆に、視野が狭まって周辺は暗くなる。滲みを 0.22 へ下げ、周辺減光を 0.72 へ上げた。3.3 G で控えめ、6.7 G で明確という段が付く。

`radialBlur` が明るくするのは最後の `mix(blur, base.mul(2), 0.5)` の形による。`blur` を足す構造なので、強くするほど明るくなる。

## SSR は入れない（段 27、2026-09-25）

計画書は SSR を ultra だけ `half`、high は `off` とし、判定を「低空の台本で、機体の真下に機体の輪郭とおおむね一致する差分が出ること」としていた。**追従カメラではこの差分が画面に入らない。**

海面に映る機体の像は、機体の高度を h とすると機体より 2h 下にある。追従カメラは機体の後ろ約 23 m にいるので、像を見下ろす角度はおよそ atan((2h + 5) / 23)。画面の縦の視野は上下 30° なので、像が入るには 2h + 5 < 13、つまり h < 4 m が要る。低空の台本 `low-pass` は高度 220 m。

SSR が映すのは画面に写っている物だけなので、この構図で映り込むのは水平線近くの島くらいになる。計画書は SSR を「超えたら削る順の 1 番目」に置き、失うのは正確さであって存在感ではない（海面は既に Schlick のフレネルで空を映している）と書いている。ultra にしか効かない費用の大きい効果を、遠くの島のために入れる理由が薄い。

段 27a で開けた MRT の口（`createScenePass` の `normals`）は残す。地表と海面を `outputNode` へ差し替えたので、MRT を受けられる状態になっている。次は上の宿題（選択的ブルーム）で、`emissive` を MRT の 2 本目として使う。

入れ直すなら、海面すれすれを外から見る固定カメラの台本を作って、計画どおり機体の映り込みで判定する。three の `SSRNode` は `reflectNonMetals=false` で金属度 0 の画素を打ち切るので、MRT の 3 本目に海面だけが 1 を書く印を置けば、海面以外で費用を払わない。
