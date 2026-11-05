# 層の雲

雲は高さ 1.5 km の積雲と 4.5 km の高層雲の 2 枚の薄い層で描く。式は `src/render/sky/cloudLayerNodes.ts` にあり、CPU 参照は `src/render/sky/cloudLayersReference.ts` に置く。合成は `src/render/pipeline/nodeOutput.ts` と `src/render/overlayNodes.ts` が受け持つ。場面への組み込みは `src/render/pipeline/nodeScene.ts` にある。決定の正本は ADR 0050（層の雲）で、体積の雲を消した経緯は ADR 0051、積雲の板を採らなかった判断は ADR 0053 にある。

縁と密度とノイズは web-ocean（Noniv/web-ocean、MIT、a07c7fd）の `SKY_CLOUD_FUNCS` を WGSL のまま写した。下から見上げる陰影も web-ocean の `shadeLayer` から写した。上から見下ろす陰影と層を抜ける前後の薄めは web-ocean に無いので新しく作った。その係数は推測で、出典はない。旧い `docs/clouds.md` は体積の雲の記録で、今の描画には当てはまらない。

各節の対応表は「式」「実装」「出典」の 3 列で書く。出典の「web-ocean」は写しを指す。「新しく作った」はこの作品で足した式、「推測」は係数に根拠の数字が無いことを表す。

## 2 枚の層と座標

| 層 | 高さ `hc` | 光学的な厚さ `σ` | 量 | 位相の非対称 `g` |
|---|---|---|---|---|
| 積雲 | 1.5 km | 2.2 | 雲量 `coverage` | 0.75 |
| 高層雲 | 4.5 km | 0.9 | `veilFor(coverage)` | 0.8 |

層は厚みの無い球面で、地球の半径は `GROUND_RADIUS = 6360` km（`sky/reference.ts`）とする。層の上の水平の位置 `q` は km で、ワールドの x と z を 1000 で割った値に当たる。カメラの高さ `alt` も km で持つ。

web-ocean の注記は積雲を 2 km と書くが、実際に渡している `cloudP.x` は 1.5 なので、そちらに合わせた。

| 式 | 実装 | 出典 |
|---|---|---|
| `hc = 1.5`、`σ = 2.2`（積雲） | `cloudLayersReference.ts` の `LOW_LAYER_ALTITUDE`・`LOW_LAYER_SIGMA` | web-ocean の `cloudP.x`・`cloudP.z` |
| `hc = 4.5`、`σ = 0.9`（高層雲） | `cloudLayersReference.ts` の `HIGH_LAYER_ALTITUDE`・`HIGH_LAYER_SIGMA` | web-ocean の `cloudLayers` の `hc`・`atmo.w` |
| `g = 0.75`・`0.8` | `cloudLayerNodes.ts:node` が `layer` へ渡す引数 | web-ocean の写しと見ている（コードに出典の注記なし） |

## 勾配ノイズ

雲の形はすべて 2 次元の勾配ノイズ `gnoise` から作る。格子点の勾配の向きを PCG ハッシュで決め、5 次の補間でつなぐ。値はおおよそ −0.7〜0.7 で、格子点では 0 になる。

```
pcg(v)  : s = v·747796405 + 2891336453
          w = ((s >> ((s >> 28) + 4)) ^ s)·277803737
          return (w >> 22) ^ w                     （すべて 32 ビットの符号なし）
h(i)    = pcg(i.x·1664525 + pcg(i.y + 1013904223))
g(i)    = (cos a, sin a),  a = h(i) · 2π / 2^32
i = floor(p),  f = p − i
u = f³ (f (6f − 15) + 10)
n = mix( mix(g(i)·f,          g(i+(1,0))·(f−(1,0)), u.x),
         mix(g(i+(0,1))·(f−(0,1)), g(i+(1,1))·(f−(1,1)), u.x), u.y )
```

負の格子の番号は `u32` へ巻き戻して扱う。CPU 参照は `>>> 0` と `Math.imul` で同じ巻き戻しを再現する。角 `a` は `Math.fround` で 32 ビットに丸め、GPU と同じ値から cos と sin を取る。

| 式 | 実装 | 出典 |
|---|---|---|
| `pcg(v)` | `cloudLayerNodes.ts:pcgHash`（WGSL の `clPcgHash`）、`cloudLayersReference.ts:pcgHash` | web-ocean の `NOISE_WGSL`。`ocean/reference.ts` の `pcgHash` と同じ式 |
| `g(i)` | `cloudLayerNodes.ts:hashGrad`、`cloudLayersReference.ts:hashGrad` | web-ocean |
| `n(p)` | `cloudLayerNodes.ts:gnoise`、`cloudLayersReference.ts:gnoise` | web-ocean の `gnoise` |

## 画素の大きさで段を消す fbm

細かい段を足す fbm に、画素の大きさ `fp` で段の重みを落とす項を掛ける。画素より細かい段は描いても縞やちらつきにしかならないので、0 へ落とす。

```
s   = Σ_{i=0}^{oct−1} a_i · n_i · w_i
a_i = 0.5^(i+1)
f_i = 2.03^i
w_i = 1 − smoothstep(0.08, 0.28, fp · f_i)
n_i = gnoise(q_i)
      i ≥ 2 では n_i ← mix(n_i, 2|n_i| − 0.38, billow)
q_0 = p,  q_{i+1} = 2.03 · R · q_i + (13.1, 7.7)
R   = [[0.8, −0.6], [0.6, 0.8]]                    （約 36.9° の回転）
```

`fp · f_i` が 0.08 未満の段は重み 1 で効き、0.28 を越えると 0 になる。`billow` は 3 段目から先を `|n|` の膨らみへ寄せる量で、積雲の縁のカリフラワー状の崩れを作る。WGSL の `mat2x2f(0.8, 0.6, −0.6, 0.8)` は列で並ぶので、行列にすると上の `R` になる。

| 式 | 実装 | 出典 |
|---|---|---|
| `s = Σ a_i n_i w_i` | `cloudLayerNodes.ts:cloudFbm`（`clFbm`）、`cloudLayersReference.ts:cloudFbm` | web-ocean の `cloudFbm` |
| `w_i` の閾値 0.08・0.28 | 同上 | web-ocean |
| `billow` の式と 0.38 | 同上 | web-ocean |

## 積雲の縁

積雲の縁 `e_low` は、ドメインを歪めた fbm に大きな斑を足し、雲量を引いて求める。正の所が雲になる。

```
p      = 0.38 q + t · (0.004, 0.0012)
w      = ( gnoise(0.3 p + (1.7, 9.2)), gnoise(0.3 p + (8.3, 2.8)) )
p     ← p + 1.4 w                                  （ドメインの歪み）
base   = 1.3 · fbm((p.x, 1.7 p.y), 0.65 fp, oct, billow = 0.35) + 0.5
large  = 0.7 · gnoise(0.05 q + (3.1, 1.3))
e_low  = base + large − (1 − coverage)
soft   = 0.38 + 0.3 · min(0.65 fp, 1)
d_low  = clamp(e_low / soft, 0, 1)
```

y を 1.7 倍に詰めるので、細胞は x の向きに少し伸びて雲の筋になる。fbm へ渡す画素の大きさの 0.65 倍は、ノイズの座標の縮み（`q` の 0.38〜0.65 倍）へ合わせたものと読める（推測）。

`large` は時刻を含まない。風が流すのは `base` の側だけで、大きな斑はその場に留まる。

| 式 | 実装 | 出典 |
|---|---|---|
| `e_low` | `cloudLayerNodes.ts:lowEdge`（`clLowEdge`）、`cloudLayersReference.ts:lowEdge` | web-ocean の積雲の縁 |
| `soft`・`d_low` | `cloudLayerNodes.ts:lowDensity`、`cloudLayersReference.ts:lowSoft`・`lowDensity` | web-ocean |

## 高層雲の縁

高層雲は滑らかで少し繊維状の膜になる。billow を使わず、異方の縮めで筋を作る。

```
p       = R · (0.09 q.x, 0.20 q.y) + (0.0015 t, 0)
n       = 1.25 · fbm(p, 0.2 fp, oct, billow = 0) + 0.5
big     = 0.6 · gnoise(0.012 q + (7, 3))
e_high  = n + big − (1 − veil)
soft    = 0.85 + 0.3 · min(0.2 fp, 1)
d_high  = clamp(e_high / soft, 0, 1)
```

`soft` が積雲の 0.38 より大きいので、縁はなだらかに薄れる。

| 式 | 実装 | 出典 |
|---|---|---|
| `e_high` | `cloudLayerNodes.ts:highEdge`（`clHighEdge`）、`cloudLayersReference.ts:highEdge` | web-ocean の高層雲の縁 |
| `soft`・`d_high` | `cloudLayerNodes.ts:highDensity`、`cloudLayersReference.ts:highSoft`・`highDensity` | web-ocean |

## 雲量と高層雲の量

雲量は URL の `?coverage=` で入り、無ければ `DEFAULT_COVERAGE = 0.29`（`pipeline/types.ts`）を使う。縁の式は雲量をそのまま足し引きするので、雲量を Δ 上げると縁はちょうど Δ 上がる。

web-ocean は高層雲の量を積雲と別に持つ（既定 0.36）。この作品の雲量の口は 1 つなので、積雲の雲量に比例させた。

```
veil = clamp(coverage, 0, 1) · 0.36 / 0.40 = 0.9 · clamp(coverage, 0, 1)
```

既定の雲量 0.29 では `veil` は 0.261 になる。快晴（0）では高層雲も消える。

| 式 | 実装 | 出典 |
|---|---|---|
| `veil = 0.9 · coverage` | `cloudLayersReference.ts:veilFor`、`cloudLayerNodes.ts:update` が uniform へ入れる | 新しく作った（比例は推測） |
| web-ocean の既定 0.40・0.36 | `WEB_OCEAN_COVERAGE`・`WEB_OCEAN_VEIL` | web-ocean の `P.clouds`・`P.veil` |
| 既定の雲量 0.29 | `pipeline/types.ts:DEFAULT_COVERAGE` | 体積の雲の時代に決めた値 |

## 球との交点

原点を地球の中心に置き、カメラを真上の軸に乗せて、視線と半径 `R` の球の交点を求める。

```
r0   = 6360 + alt,   R = 6360 + hc
b    = r0 · dir.y
c    = (r0 − R)(r0 + R)
disc = b² − c
下から（alt ≤ hc かつ dir.y > 0）: t = −b + √disc     （遠い方の交点）
上から（alt > hc）            : t = −b − √disc     （近い方。正のときだけ）
p    = (dir.x t, r0 + dir.y t, dir.z t)
up   = p / |p|
q    = p.xz + camera.xz / 1000
mu   = max(|up · dir|, 0.03)
```

当たらなければ `t = 1e9` とする。`mu` は層を斜めに見る度合いで、0.03 で下を抑えて水平線での発散を止める。

遠くは切り落とす。`t` が積雲で 36 km、高層雲で 70 km を越えたら描かない。その手前の 18〜36 km（高層雲は 30〜70 km）で密度を `far` で 0 へ下ろす。低い太陽が雲の下から差す、水平線の手前の晴れ間になる。

場面の物（機体・海・空母）が層より手前なら雲を描かない。深度から求めた距離 `sceneKm` を `t` と比べる。空の画素（深度 1）は距離を無限とする。

| 式 | 実装 | 出典 |
|---|---|---|
| 交点 `t` | `cloudLayerNodes.ts:layer`・`hitDistance` | web-ocean の `raySphere` |
| `mu` の下限 0.03 | `layer` | web-ocean |
| `far = 1 − smoothstep(18, 36, t)`（高層雲は 30・70） | `layer` の `farLimit` | web-ocean の水平線の手前の晴れ間 |
| `t < sceneKm` | `layer`、距離は `node` が `getViewPosition` から求める | 新しく作った |

## 画素の大きさの見積もり

層の上での 1 画素の幅 km を、距離と斜めの度合いから見積もる。

```
pixelAngle = 2 tan(fov / 2) / H        （H は描画バッファの高さの画素数）
fp         = t · pixelAngle / mu
```

`fp` は fbm の段の重み、縁の `soft`、縁のアンチエイリアスの 3 か所で使う。`H` は全解像度の高さで、雲を焼く半分の解像度の高さではない。

| 式 | 実装 | 出典 |
|---|---|---|
| `pixelAngle` | `nodeScene.ts:updateCloudLayers` | 新しく作った |
| `fp = t · pixelAngle / mu` | `cloudLayerNodes.ts:layer` | web-ocean のコンピュートの逃げ道の式 |

## 密度と自己影の点

交点の密度 `d` は縁から求め、遠くの `far` を掛ける。`d ≤ 0.002` の画素は陰影を計算せずに抜ける。

太陽の水平の向き `sxz` へずらした点で密度を引き直し、自己影に使う。

| 層 | 点 | ずらす距離 | 段の数 |
|---|---|---|---|
| 積雲 | `s1`・`s2`・`s3` | 0.08・0.25・0.6 km | `oct − 2`・`oct − 3`・`oct − 4` |
| 高層雲 | `s1`・`s2`（`s3 = s2`） | 0.15・0.5 km | `oct − 3`・`oct − 4` |

```
d     = clamp(e / soft, 0, 1) · far
s_k   = density(q + sxz · 距離_k) · far
τ     = d σ / mu
α     = 1 − exp(−τ)
sunC  = 高さ hc の太陽の照度
cosT  = dir · sunDir
rim   = clamp(2.5 (d − s1), 0, 1)                 （縁の光）
skyUp = 真上の空の放射輝度（広がり π/2）
hor   = 向き normalize(dir.x, 0.03, dir.z) の空の放射輝度
```

段の数は 1 より下げない。高層雲は 3 点目を持たず、`s2` を 3 点目にも使う。

| 式 | 実装 | 出典 |
|---|---|---|
| ずらす距離と段の減らし方 | `cloudLayerNodes.ts:layer`、`O(k)` | web-ocean の `shadeLayer` |
| `τ`・`α` | `layer` | web-ocean |
| `sunC` | `nodeScene.ts` が渡す `atmosphereNodes.scalarIlluminance(world).get('direct')` | この作品の空（Hillaire） |
| `skyUp`・`hor` | `nodeScene.ts` が渡す `sky.radiance` | この作品の空 |

## 下から見る陰影

カメラが層より下にいるときの色を求める。web-ocean の `shadeLayer` をそのまま写した。太陽へ向けた自己影 3 点、縁の光、薄い所の透過、多重散乱の近似、底の寒色の環境光から成る。

```
τs     = 0.55 σ (0.5 d + 0.6 s1 + s2 + 0.7 s3)
Ts     = exp(−τs)
fwd    = smoothstep(−0.2, 0.7, cosT)
single = 3 · sunC · Ts · ph · mix(0.55 α, 2.2 τ e^(−τ), fwd)
toward = smoothstep(−0.3, 0.9, cosT)
ms     = sunC · (0.22 rim + 0.025) · mix(1, Ts, 0.5) · α · (0.75 toward + 0.25)
amb    = (0.26 hor + 0.42 skyUp) · α · (1 − 0.35 d)
color  = single + ms + amb
```

太陽の側を向くほど `fwd` が 1 に寄り、単散乱は `τ e^(−τ)` の形になる。薄い所ほど光が抜け、逆光の縁が明るく見える。`amb` の `1 − 0.35 d` は、厚い所の底を暗くする。

| 式 | 実装 | 出典 |
|---|---|---|
| `τs`・`Ts` | `cloudLayerNodes.ts:layer` の `Else` | web-ocean の `shadeLayer` |
| `single`・`fwd` | 同上 | web-ocean |
| `ms`・`toward` | 同上 | web-ocean |
| `amb` | 同上 | web-ocean |

## 上から見る陰影

カメラが層より上にいるときの色を求める。web-ocean は見上げるだけなので、この作品で新しく作った。太陽の当たる上面を見るので、向こう側の自己影は薄く、環境光は上の空から取る。

```
Ts_top = exp(−0.55 σ (0.3 s1 + 0.15 s2))
single = 1.65 · sunC · Ts_top · ph · α · [sunDir.y > 0]
ms     = sunC · (0.22 rim + 0.06) · α
amb    = (0.6 skyUp + 0.2 hor) · α
color  = single + ms + amb
```

`1.65` は `0.55 × 3` で、下から見る式の薄い側の係数を引き継いだ。太陽が地平線より下なら単散乱を 0 にする。下から見る式と違い、`fwd` による透過の切り替えと `amb` の底の暗さは持たない。

| 式 | 実装 | 出典 |
|---|---|---|
| `Ts_top` の重み 0.3・0.15 | `cloudLayerNodes.ts:layer` の `If(above)` | 新しく作った（推測） |
| `single` の 1.65 と太陽の向きの条件 | 同上 | 新しく作った（推測） |
| `ms` の 0.06 | 同上 | 新しく作った（推測） |
| `amb` の 0.6・0.2 | 同上 | 新しく作った（推測） |

## 位相関数

Henyey-Greenstein の位相関数を 2 つ混ぜる。前方へ強く散らす項に、後ろへ少し返す項を 25% 足す。

```
HG(c, g) = (1 − g²) / (4π · max(1 + g² − 2 g c, 1e−4)^1.5)
ph       = mix(HG(cosT, g), HG(cosT, −0.2), 0.25)
```

| 式 | 実装 | 出典 |
|---|---|---|
| `HG` | `cloudLayerNodes.ts:phaseHG` | web-ocean の `phaseHG` |
| `ph` の −0.2 と 0.25 | `layer` | web-ocean の写しと見ている（コードに出典の注記なし） |

## 縁のアンチエイリアス

画面の微分を使わず、画素の大きさ `fp` から縁のぼかし幅を見積もる。微分を取らないので、雲の無い画素を分岐で早く抜けられる。

```
aw     = fp · 2.5 · (積雲 0.38、高層雲 0.2)
edgeAa = smoothstep(0, 1.5 aw + 1e−6, e)
```

`e` は密度へ割る前の縁の値を指す。縁の 0 から 1.5 `aw` の幅で 0 から 1 へ上がる。

| 式 | 実装 | 出典 |
|---|---|---|
| `aw`・`edgeAa` | `cloudLayerNodes.ts:layer` | web-ocean の `aa` が負のときの式 |

## 層を抜ける前後の薄め

厚みの無い板を突き抜けると、1 フレームで雲の全面が見えたり消えたりする。カメラが層の高さの前後 100 m にいる間は、層を薄くする。

```
crossing = clamp(|alt − hc| / 0.1, 0, 1)
```

| 式 | 実装 | 出典 |
|---|---|---|
| 幅 0.1 km | `cloudLayerNodes.ts:layer` | 新しく作った（推測の幅） |

## 霞の中へ溶かす

雲は霞（`aerial`）の後ろへ重ねるので、霞は雲に掛からない。代わりに距離で雲そのものを薄くする。

```
vis = exp(−0.02 t)     （積雲）
vis = exp(−0.01 t)     （高層雲）
k   = edgeAa · crossing · vis
out = (color · k, α · k)            （前乗算の色と隠す割合）
```

積雲は 35 km で `vis` が約 0.50、高層雲は 70 km で約 0.50 になる。

| 式 | 実装 | 出典 |
|---|---|---|
| `vis` の 0.02・0.01 | `cloudLayerNodes.ts:layer` | web-ocean の `loVis`・`hiVis` を霞の濃さ 1 で写した |
| `k` と前乗算 | 同上 | web-ocean |

## 2 枚の前後と合成

同じ視線に 2 枚が乗るときは、手前の層を奥の層に重ねる。前後は交点の距離で決める。

```
front, back = 距離の近い方, 遠い方
cloud.rgb   = front.rgb + back.rgb · (1 − front.a)
cloud.a     = front.a  + back.a  · (1 − front.a)
```

合成は霞を掛けた場面の上に雲を置く。雲が光を通さない（`a = 1`）画素では、霞を計算しない。

```
a = 1 なら   out = cloud
それ以外     out.rgb = aerial(scene).rgb · (1 − a) + cloud.rgb
             out.a   = aerial(scene).a
```

爆発などの重ね描き（`overlay`）は雲よりさらに手前に置き、`絵 · (1 − a) + rgb` で重ねる。`?clouds=0` は雲のテクスチャに 0 を掛けて合成から外す。

| 式 | 実装 | 出典 |
|---|---|---|
| 前後の重ね | `cloudLayerNodes.ts:node`、`hitDistance` | 新しく作った |
| 霞との合成 | `overlayNodes.ts:overlayCompositeNode`、`nodeOutput.ts:createNodeOutputNode` | 体積の雲の時代の合成（GLSL 版 `aerialPerspectiveEffect.frag` の写し） |
| 雲を外す口 | `nodeScene.ts` の `cloudVisibility` | 新しく作った |

## 雲の影

海と機体の光は、ワールドの点から太陽へ向かう線が層を横切る点の密度で遮る。層は平らとみなす。太陽の高さが 0.2 でも、積雲までの水平の道のりは 7.5 km で、地球の丸みによる沈みは約 4 m に留まる。

```
h = max(y, 0) / 1000
hc > h の層ごとに
  s  = (hc − h) / sunDir.y
  q  = (x, z) / 1000 + sunDir.xz · s
  τ += d(q, fp, oct − 3) · σ / sunDir.y
T = exp(−τ)
sunDir.y ≤ 0.01 なら T = 1
```

GPU の海は、画素が海面で覆う幅 `footMajor` m を 1000 で割って `fp` に渡す。空の雲と同じく画素より細かい段を消し、遠くの影の模様が風の斑の網目を強めるのを止めた（段 S4d）。機体の光は CPU 参照で 1 点だけ求め、`fp = 0` で引く。

影には `far`・`edgeAa`・`vis` を掛けない。自己影の点も使わない。

| 式 | 実装 | 出典 |
|---|---|---|
| `T`（GPU） | `cloudLayerNodes.ts:sunTransmittance` | 新しく作った（ADR 0050 の合意の 4） |
| `T`（CPU） | `cloudLayersReference.ts:layerSunTransmittance` | 同上 |
| 段を 3 減らす | `CLOUD_SHADOW_OCTAVE_DROP`、`nodeScene.ts:updateCloudLayers` | 新しく作った（推測） |
| 海の画素の幅 | `ocean/oceanSurface.ts` の `footMajor` → `sunShade` | 新しく作った（段 S4d、ADR 0048・0050） |
| 海へ掛ける形 `T · 機体の影` | `nodeScene.ts` の `sunShade` | 新しく作った |
| 機体の光 | `nodeScene.ts:updateCloudLayers` → `hillaireSky.ts:setSunCloudTransmittance` | 新しく作った |

## 半分の解像度

層の雲は `rtt` で半分の解像度のテクスチャに焼き、合成が全解像度で引いて拡大する。品質表の `cloudLayerResolutionScale` は全段で 0.5 とした。テクスチャの名前 `cloudLayers` が計時の群「雲」の目印になる（`passTimes.ts`）。

雲は場面の深度を読むので、場面のパスより後に焼く必要がある。順はノードを辿った順で決まり、`nodeOutput.ts` の合成の中で場面のパスを先に触る。半分の解像度の雲は深度も半分の解像度で読むので、機体の縁に雲の 1 画素ぶんの滲みが出うる（ADR 0050、推測）。

費用は実機（Arc 140V、high、窓 1600×789・倍率 1.5）で測った。

| 段 | 構図 | 雲の費用 |
|---|---|---|
| S4c 全解像度 | level（積雲を上から） | 約 1.7〜2.2 ms |
| S4c 全解像度 | low-pass（見上げ） | 約 0.9 ms |
| S4c 半分 | level | 中央 0.61 ms（0.51〜0.76） |
| S4c 半分 | low-pass | 中央 0.31 ms（0.30〜0.45） |
| S4b | 既定へ切り替えたあと | 0.48〜0.54 ms |
| S4d | 雲の影に画素の幅を渡したあと | 0.49〜0.55 ms |
| S5 | 予算の検収 | 0.68 ms 以下 |

雲の予算は 2.7 ms から 0.8 ms に改めた（ADR 0050、ユーザーの決定）。

| 式 | 実装 | 出典 |
|---|---|---|
| 半分の解像度で焼く | `cloudLayerNodes.ts:cloudLayerTexture` | web-ocean と同じ倍率。値は推測 |
| 焼く順 | `nodeOutput.ts:createNodeOutputNode`、`nodeScene.ts` の `buildOutput` | この作品の鎖 |

## 風の時刻と決定論

雲を流す時刻 `t` は実時間ではなく、sim のフレーム番号から毎回求める。

```
t = frame · FIXED_DT          （FIXED_DT = 1/120 s）
```

`scene.ts` が `cloudTime(frame, FIXED_DT)` を `pipeline.updateClouds` へ渡す。`nodeScene.ts` はこれを雲の uniform と CPU の機体の光へ入れ、海の刻み `oceanTicks` もここから戻す。同じフレームからは同じ雲が出るので、キャプチャの絵が固定される。

風の速さは縁の式から導ける。積雲は `p` が `0.38 q` なので、模様は x へ −10.5 m/s、z へ −3.2 m/s で流れる。高層雲は回転と縮めを戻して、x へ約 −13.3 m/s、z へ約 +4.5 m/s になる。どちらも式から計算した値で、測ってはいない。

| 式 | 実装 | 出典 |
|---|---|---|
| `t = frame · FIXED_DT` | `cloudLayersReference.ts:cloudTime`、`scene.ts` の `updateClouds` | この作品の決定論の規則（体積の雲から移した） |
| 積雲の流れ `(0.004, 0.0012)` | `lowEdge` | web-ocean |
| 高層雲の流れ `0.0015` | `highEdge` | web-ocean |

## 品質ごとの段の数

品質表の列は `cloudLayerOctaves`（積雲の縁の段の数）と `cloudLayerResolutionScale` の 2 つ。ほかの段の数は `cloudLayerOctaves` から減らして決め、1 段より下げない。

| 使う所 | 段の数 | low | medium | high | ultra |
|---|---|---|---|---|---|
| 積雲の縁 | `oct` | 5 | 6 | 7 | 7 |
| 高層雲の縁 | `oct − 1` | 4 | 5 | 6 | 6 |
| 積雲の自己影 `s1`・`s2`・`s3` | `oct − 2`・`− 3`・`− 4` | 3・2・1 | 4・3・2 | 5・4・3 | 5・4・3 |
| 高層雲の自己影 `s1`・`s2` | `oct − 3`・`− 4` | 2・1 | 3・2 | 4・3 | 4・3 |
| 雲の影 | `oct − 3` | 2 | 3 | 4 | 4 |
| 解像度の倍率 | | 0.5 | 0.5 | 0.5 | 0.5 |

web-ocean は 7 段で、high と ultra はこれに合わせた。low と medium の値は推測で決めた。段の数は uniform なので、品質が変わっても組み直さず `setOctaves` で値だけ入れ替える。

| 式 | 実装 | 出典 |
|---|---|---|
| 段の数の表 | `quality.ts` の `cloudLayerOctaves` | web-ocean の 7。low・medium は推測 |
| 減らす量 | `cloudLayerNodes.ts` の `O(k)` | web-ocean の `shadeLayer`。雲の影の 3 は新しく作った |
| 解像度の倍率 | `quality.ts` の `cloudLayerResolutionScale` | web-ocean と同じ半分 |

## 検証

GPU と CPU の突き合わせは、`?oceanprobe=1` の自己診断（`pipeline/node.ts`）が 256 点で行う。点は ±30 km に散らし、画素の大きさを 0・0.05・0.3・1.5 と振る。雲量 0.4、時刻 1234.5 s、段の数 7 で比べる。

| 比べる値 | 差（2026-10-30、SwiftShader） | 許容 |
|---|---|---|
| `gnoise` | 7.0e-5 | 1e-3 |
| `lowEdge` | 2.9e-4 | 1e-3 |
| `highEdge`（段の数 6） | 6.4e-5 | 1e-3 |

差の出どころは WGSL の cos と sin の精度（絶対 2⁻¹¹ まで許される）と見ている（推測）。検査は `tests/e2e/node-path.spec.ts` にある。同じファイルは、雲を焼いた時点の描画呼び出しが 20 を越えることも見る。これが崩れると、雲が場面のパスより先に走って 1 フレーム前の深度を読んでいる。

突き合わせるのはノイズと縁だけで、陰影と `sunTransmittance` の GPU 側は CPU と点で比べていない。陰影は基準画像（exact 47 枚）と画素の見張り（`?clouds=0`）で守る。

CPU 参照そのものの性質は `tests/render/cloudLayersReference.test.ts` が縛る。中身は次の 5 つ。

- 格子点でノイズが 0 になり、負の格子でも周期が出ない
- 画素が粗いと fbm が 0 になり、段を足すと細かい成分が加わる
- 雲量を Δ 上げると縁が Δ 上がり、雲量 0.4 で積雲が空の 10〜90% を覆う
- `veilFor(0.4) = 0.36`、`veilFor(0) = 0`
- 快晴と太陽が沈んだときと両方の層より上では、雲の影の透過率が 1 になる

## 採らなかった積雲の板と持ち越しの差

段 S6（2026-11-05）で、積雲だけを高さ場の板にして厚みを持たせる形を試し、採らなかった（ADR 0053）。頂を 1.5 km、雲底を 0.9 km に置き、見下ろす視線だけを板の中で等分に歩いた。8 歩では雲の群が 2.23〜2.33 ms で予算 0.8 ms の約 3 倍になり、近くの縁に網目が残った。16 歩は合計の中央値が 13.14〜13.59 ms で CP1 の 13.0 ms を越えた。差分は `~/.claude/plans/dogfight-ocean-ref/measure/s6/s6-cloud-slab-trial.patch` に控えてあり、リポジトリには入っていない。

上から見た積雲は平らで陰影が薄く、遠くは横に引き延ばされて見える。この差は持ち越した。平らに見えるのは、層に厚みが無く、上からは上面しか見えないため。引き延ばしは `fp = t · pixelAngle / mu` が浅い視線で大きくなり、細かい段が早く消えることから来る。段 S4d で上面の自己影の重みを強める手と、斜めの画素の幅を和らげる手を試したが、前者は効きが小さく、後者は半分の解像度の縁を階段状に欠いた。作り直すなら、雲の無い所を大股で飛ばす歩み方か、体積の雲のような別の作りを考える。
