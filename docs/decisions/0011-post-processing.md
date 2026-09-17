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
