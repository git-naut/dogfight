# 海の描画

海は FFT で解いた波を、カメラを中心にした CDLOD の格子へ載せて描く。コードは `src/render/ocean/` にある。波を解くのが `oceanNodes.ts`、海面の頂点と陰影が `oceanSurface.ts`、泡が `oceanFoam.ts`。空母のまわりの凪は `oceanCalm.ts` と `oceanCalmNodes.ts` が持つ。式の正本は倍精度の CPU 参照 `reference.ts` で、GPU 版はこれと 1 対 1 に写して突き合わせている。

技法は web-ocean（Noniv/web-ocean、MIT、a07c7fd）から写した。Tessendorf の FFT の海に、JONSWAP のスペクトルと Donelan-Banner の方向分布を組み合わせる。

決定の正本は次の 6 本の ADR にある。

| ADR | 中身 |
|---|---|
| 0046 | FFT と 32 ビットの計算の手順 |
| 0047 | CDLOD とテクスチャ、継ぎ目の割れ目（段 S4d の追補） |
| 0048 | LEAN・きらめき・泡、遠くの風の斑（段 S4d） |
| 0049 | 空母のまわりの凪・喫水線の泡・カメラの高さ |
| 0051 | 既定への切り替えと濁り 0.6 |
| 0052 | high を分割距離 0.5・カスケード 3 にした判断 |

以下、ファイル名は `src/render/ocean/` からの相対で書く。出典の欄の「web-ocean」は web-ocean の同名の関数か定数をそのまま写したもの、「推測」は根拠の無い値で、絵で確かめて決めたものを指す。

## 1 フレームの処理順

海面の `update`（`oceanSurface.ts:createOceanSurface`）が、場面を描く前に次の順で呼ばれる。

1. 覆う範囲（根の 3 × 3）を決め、uv の起点を置き直す
2. CDLOD のパッチを選び、インスタンスの属性へ書く
3. 時間発展で 2 本のスペクトルを作る（`Ocean [ Evolve ]`）
4. 行の逆 FFT（`Ocean [ FFT Rows ]`）、列の逆 FFT と並べ替え（`Ocean [ FFT Cols ]`）
5. 記憶域を配列テクスチャへ写し、ミップを作る（`oceanMips.ts`）
6. 泡のクリップマップを進める（`Ocean [ Foam ]`）
7. 場面のパスで海面と外側の板を描く

海の時刻は sim のフレーム番号 `ticks` だけから決める。描画の補間 `alpha` は渡さず、0 で解く（`simulation.update(r, t, 0)`）。同じ `ticks` で呼び直すと何もしない。キャプチャは 1 枚に複数のフレームを描くが、海を解くのは 1 回だけになる。

## 海の状態

CP2 で選んだ C を `reference.ts` の `DOGFIGHT_OCEAN` に置いた（ADR 0047）。風浪とうねりの強さだけを変え、向きや尖りは web-ocean の既定のまま使っている。

| 量 | 値 | 出典 |
|---|---|---|
| 海面 10 m の風速 U | 6 m/s | CP2 の C（ユーザーの決定） |
| 吹送距離 F | 20 km | CP2 の C |
| 風浪の向き | 118° | web-ocean の既定 |
| JONSWAP の尖り γ | 3.3 | web-ocean の既定 |
| うねりの有義波高 | 0.3 m | CP2 の C |
| うねりのピーク波長 | 80 m | CP2 の C |
| うねりの向き | 94° | web-ocean の既定 |
| うねりの方向分布の s | 48 | web-ocean の既定 |
| 横の変位の強さ λ（choppy） | 1.25 | web-ocean の既定 |
| 短い波を抑える長さ ℓ | 0.0012 m | web-ocean の既定 |
| 乱数の種 | 1 | web-ocean の既定 |

この条件の有義波高は 0.632 m になる。格子の上の分散 m0 から `Hs = 4√m0` で求める（`reference.ts:significantWaveHeight`）。カスケードを 3 本に減らしても 0.632 m のままで、エネルギーはほぼ全部が長い波にある。

向きは +X から +Z へ測る。three の右手系で Y が上なので、上から見て時計回りに 118° の向きへ波が進む。

## 分散関係

波数 k の波の角周波数は、深水の重力波に毛管波の項を足して求める。

```
ω(k)     = √(g k + σ k³)
dω/dk    = (g + 3 σ k²) / (2 ω)
g = 9.81 m/s²、σ = 7.4e-5 m³/s²（表面張力 / 密度）
```

毛管波の項が効くのは波長が数 cm より短い所だけで、high の最短の波（0.32 m）ではほぼ重力波の式に一致する。ultra の 6 段目（一辺 0.26 m）では最大 1432 rad/s に達し、後で書く位相の計算を整数へ移す理由になった。

| 式 | 実装 | 出典 |
|---|---|---|
| `ω = √(g k + σ k³)` | `reference.ts:omegaOf`、`oceanNodes.ts` の `omegaOf` | web-ocean `omegaOf` |
| `dω/dk` | `reference.ts:dOmegaOf` | web-ocean `dOmegaOf` |
| g・σ の値 | `GRAVITY`・`SURFACE_TENSION` | web-ocean `GRAV`・`SURF` |

## 風浪のスペクトル

周波数スペクトルは JONSWAP。吹送距離が短いほど波は若く、ピークが高い周波数に寄る。

```
α  = 0.076 (U² / (F g))^0.22
ωp = 22 (g² / (U F))^(1/3)

S(ω) = α g² / ω⁵ · exp(-1.25 (ωp/ω)⁴) · γ^r
r    = exp(-(ω - ωp)² / (2 σ² ωp²))
σ    = 0.07（ω ≤ ωp）、0.09（ω > ωp）
```

U = 6 m/s・F = 20 km では α = 0.01145、ωp = 2.044 rad/s。ピークの周期は 3.07 秒、深水の波長に直すと 14.8 m になる。

方向分布は Donelan-Banner。ピークの近くで鋭く、離れると広がる。

```
ω/ωp < 0.95  :  β = 2.61 (ω/ωp)^1.3
ω/ωp < 1.6   :  β = 2.28 (ω/ωp)^-1.3
それ以上      :  β = 10^(-0.4 + 0.8393 exp(-0.567 ln((ω/ωp)²)))

D(θ) = β / (2 tanh(β π)) · sech²(β θ)
```

θ は波の向きと風の向きの差。sech の引数は ±20 で切っている。−π から π までの積分は 1 になる。

| 式 | 実装 | 出典 |
|---|---|---|
| α と ωp | `reference.ts:windSeaShape` | web-ocean `spectrum` の前半。吹送距離の関係は JONSWAP（Hasselmann ほか 1973） |
| `S(ω)` | `reference.ts:jonswap`、`oceanNodes.ts` の `jonswap` | web-ocean `jonswap` |
| `D(θ)` | `reference.ts:donelanBanner` | web-ocean `donelanBanner`。式は Donelan ほか 1985 と Banner 1990 |
| γ = 3.3 | `WEB_OCEAN_DEFAULTS.gamma` | web-ocean の既定（JONSWAP の標準値） |

## うねり

うねりは遠くで生まれて届いた波で、風浪とは別の JONSWAP を足す。尖りは 6 に固定し、α は有義波高から逆算する。

```
ωs = √(g · 2π / λs)
αs = (Hs/4)² · 5 ωs⁴ / g² · (1 - 0.287 ln 6)
D(θ) = √(s + 1/4) / (2√π) · |cos(θ/2)|^(2s)
```

λs = 80 m で ωs = 0.878 rad/s、Hs = 0.3 m で αs = 8.43e-5。方向分布 cos^2s は s = 48 なので 96 乗になり、向きの幅は狭い。

GPU 版は cos(θ/2) を三角関数で求めない。波の向きと うねりの向きの内積 cos δ から `|cos(δ/2)| = √((1 + cos δ)/2)` を作り、2 乗を重ねて 96 乗する。WGSL の cos は絶対誤差 2⁻¹¹ まで許されていて、96 乗で 2% に拡大したからである（ADR 0046）。

| 式 | 実装 | 出典 |
|---|---|---|
| ωs | `reference.ts:swellPeak` | web-ocean `simF[46]` |
| αs | `reference.ts:swellAlpha` | web-ocean `alphaS`。`1 - 0.287 ln γ` は JONSWAP の α を有義波高から求める補正の形（Goda の近似と見ている。推測） |
| cos^2s の分布 | `reference.ts:cosSpread` | web-ocean `cosSpread` |
| 内積からの 96 乗 | `oceanNodes.ts` の `cosSpread`・`directionCos` | dogfight（ADR 0046） |

## 波数の面積あたりへの写しと振幅

上の S(ω)·D(θ) は周波数と角度あたりの量なので、波数の面積あたりへ写す。そのあとで短い波を抑える。

```
Ψ(k) = (S_wind(ω) D_wind(θ) + S_swell(ω) D_swell(θ)) · exp(-k² ℓ²) · (dω/dk) / k
```

格子の 1 点の振幅は、格子の間隔 Δk = 2π/L を掛けて求める。web-ocean は細かい 2 段のカスケードを控えめにしていて、その倍率もそのまま写した。

```
a(n) = √Ψ(n Δk) · Δk · 0.5 · g_c
g_c  = 1（c ≤ 3）、0.85（c = 4）、0.6（c = 5）
```

g_c が 1 でないのは 5 段目と 6 段目だけで、6 段を使う ultra でしか効かない。

波の向きと風の向きの差 θ は、外積と内積の atan2 で直接求める。web-ocean は `wrapAngle(atan2(kz, kx) - 風向)` で求める。格子の軸の上では kz がゼロになり、ゼロの符号で答えが ±π 分かれる。SwiftShader は −k 側の角度を π 取り違えた。そこでゼロの符号を使わない式へ直した（ADR 0046）。

| 式 | 実装 | 出典 |
|---|---|---|
| `Ψ(k)` | `reference.ts:spectrum` | web-ocean `spectrum`。`(dω/dk)/k` は Tessendorf の写し方 |
| `a(n)` | `reference.ts:amplitude`、`oceanNodes.ts` の `amplitude` | web-ocean `amplitude` |
| g_c | `reference.ts:cascadeGain` | web-ocean `amplitude` の g |
| θ の求め方 | `reference.ts:directionDelta` | dogfight（ADR 0046） |

## 初期値 h0

格子点ごとに標準正規の乱数の組を 2 つ引き、振幅を掛ける。−k の側の共役も同じ要素に持たせる。

```
h0(k)        = (ξr + i ξi) · a(k)
conj h0(-k)  = (ξr' - i ξi') · a(-k)
```

乱数は PCG のハッシュから作る 24 ビットの一様乱数で、Box-Muller で正規分布にする。種はカスケードごとに `seed × 7919 + c × 1000003` から振る。GPU 版は Box-Muller の sin・cos を組み込みでなく自前の多項式で求める（`sincos2pi`）。組み込みのままでは h0 が最大値の 1.9e-4 ずれた（ADR 0046）。

| 式 | 実装 | 出典 |
|---|---|---|
| h0 | `reference.ts:buildH0`、`oceanNodes.ts` の `initNode` | web-ocean `SIM_INIT` |
| PCG・一様乱数・Box-Muller | `reference.ts:pcgHash`・`rand01`・`gauss2` | web-ocean `pcgHash`・`rand01`・`gauss2` |
| 自前の sin・cos | `oceanNodes.ts` の `sincos2pi` | dogfight（ADR 0046、ユーザーの決定） |

## カスケードと帯

1 枚の格子では 1 km の波と 30 cm の波を同時に持てないので、一辺の違う格子（カスケード）を重ねる。各カスケードは波数の帯を受け持ち、隣との間に隙間と重なりを作らない。

```
kMin[0] = π / L0
kMin[c] = kMax[c-1]                         （c ≥ 1）
kMax[c] = 2π · 6 / L(c+1)                   （最後以外）
kMax[最後] = 0.98 · π N / L(最後)
```

実装は帯の境目を波数の浮動小数ではなく、格子の整数の半径の 2 乗 r² = nx² + ny² で判定する。2 段目以降の下限 2π·6/L には、格子点 `(±6, 0)` と `(0, ±6)` がちょうど乗る。32 ビットと 64 ビットで、この点が帯に入るかが分かれた（ADR 0046）。

```
r²の下限 = 0.25（1 段目、0 波数だけを除く）、36（2 段目以降）
r²の上限 = (6 L(c) / L(c+1))²、最後は (0.49 N)²
```

カスケードの一辺は web-ocean の 6 本を長い順に先頭から使う。

| 段 | 一辺 L | texel（N=256） | 使う品質 |
|---|---|---|---|
| 0 | 1103.0 m | 4.31 m | すべて |
| 1 | 211.3 m | 0.825 m | すべて |
| 2 | 39.7 m | 0.155 m | すべて |
| 3 | 7.43 m | 2.9 cm | ultra |
| 4 | 1.393 m | 5.4 mm | ultra |
| 5 | 0.2617 m | 1.0 mm | ultra |

high（3 × 256）の帯の上限は 19.85 rad/m で、最も短い波は 0.32 m。low と medium（3 × 128）は 9.93 rad/m で 0.63 m になる。

| 式 | 実装 | 出典 |
|---|---|---|
| 波数の帯 | `reference.ts:cascadeBands` | web-ocean `writeSimStatic` |
| 整数の半径の帯 | `reference.ts:latticeBands`、`oceanNodes.ts` の `amplitude` | dogfight（ADR 0046） |
| カスケードの一辺 | `WEB_OCEAN_DEFAULTS.cascades` | web-ocean `CASC_L` |
| 長い順に残す | `reference.ts:oceanParamsFor` | CP2 と S4a の合意（ADR 0047） |

## 品質ごとのカスケードと格子

品質表（`src/render/quality.ts`）の海の列は次のとおり。high のカスケード 3・分割距離 0.5 は段 S5 で決めた（ADR 0052）。

| 列 | low | medium | high | ultra |
|---|---|---|---|---|
| `oceanCascades` | 3 | 3 | 3 | 6 |
| `oceanFftSize` | 128 | 128 | 256 | 256 |
| `oceanLodLevels` | 8 | 10 | 12 | 13 |
| `oceanFoamLevels` | 0 | 1 | 1 | 2 |
| `oceanFoamResolution` | 512 | 512 | 512 | 1024 |
| `oceanAnisotropy` | 1 | 1 | 1 | 4 |
| `lodDistanceScale` | 0.5 | 0.5 | 0.5 | 1.15 |

ultra の泡の解像度と異方性は推測の値で、実機では測っていない。カスケード数・格子・泡・異方性のどれかが変わると、海面は一式を作り直す（`OceanSurface.setQuality`）。

## 時間発展

時刻 t の波は、h0 に位相を掛けて作る。

```
h(k, t) = h0(k) e^{-iωt} + conj(h0(-k)) e^{iωt}
```

web-ocean は ω を周期 600 秒で量子化する。ω を ω0 = 2π/600 の整数倍に丸めると、海は 600 秒ごとにまったく同じ形へ戻る。

```
n = floor(ω / ω0)
位相 = n ω0 t
```

ここでは n を整数で持ち、時刻を sim の刻み（1/120 秒）の整数 m に直す。位相の整数部は 32 ビットの整数で求める。周期は 72000 刻み。web-ocean のまま浮動小数で `floor(ω/ω0)·ω0 × t` を求めると、ultra の細かいカスケードで桁が足りない。ω/ω0 が最大 13.7 万、位相が 86 万ラジアンに達するからだ。

```
a  = n mod 72000
mh = floor(m / 512)、ml = m mod 512
whole = ((a · mh mod 72000) · 512 + a · ml) mod 72000
位相の割合 = fract((whole + n · alpha) / 72000)
```

n × m をそのまま掛けると約 98 億で 32 ビットを越えるので、m を 512 で上下に分けて掛ける。途中の値は最大でも約 7400 万に収まる。位相の割合は 1 周を 1 とした値で、自前の `sincos2pi` へ渡す。

n の食い違いは GPU と CPU で 644 個あり、どれも ω/ω0 の小数部が整数から 0.038 以内の境目の波だった（ADR 0046）。突き合わせでは GPU の n を CPU 参照へ渡している。

| 式 | 実装 | 出典 |
|---|---|---|
| `h(k, t)` | `reference.ts:evolve`、`oceanNodes.ts` の `evolveNode` | Tessendorf 2001。web-ocean `SIM_EVOLVE` |
| n の量子化と 600 秒 | `reference.ts:frequencyIndex`、`OCEAN_LOOP_SECONDS` | web-ocean `LOOP` |
| 整数の位相 | `reference.ts:phaseTicksMod`・`evolvePhase` | dogfight（ADR 0046） |
| 刻みの分け方 512 | `PHASE_SPLIT` | dogfight。32 ビットに収まる値として選んだ |

## 変位・傾き・ヤコビアンのスペクトル

高さ h から、横の変位・傾き・横の変位の微分を作る。どれも h に k の式を掛けるだけで、逆 FFT の前に周波数の側で求める。

```
Dx  = i λ (kx/k) h        Dz  = i λ (kz/k) h
sx  = i kx h              sz  = i kz h
jxx = -λ (kx²/k) h        jzz = -λ (kz²/k) h
jxz = -λ (kx kz/k) h
```

Dx・Dz は波頭を尖らせる横の変位（choppy）、sx・sz は高さの傾き、jxx・jzz・jxz は横の変位の微分。実数の場を 2 つずつ 1 本の複素数に詰めて逆 FFT の回数を半分にする。

```
A = (Dx + i Dz,  h + i jxz/κ)
B = (sx + i sz,  jxx + i jzz)
```

逆 FFT の後は、A の実部と虚部から `(Dx, Dz, h, jxz/κ)` が出る。並べ替えて `(Dx, Dy, Dz, jxz)` にし、jxz に κ を掛け戻す。

κ は帯の上限の波数で、jxz を縮めてから詰めるための係数になる。jxz は λ k h に比例するので、細かいカスケードでは h の 85 倍になる。そのまま h と同じ複素数に詰めると、jxz の丸めが高さに乗り、高さが最大値の 1.2% ずれた（ADR 0046）。逆 FFT は線形なので、割ってから掛け戻しても値は変わらない。

| 式 | 実装 | 出典 |
|---|---|---|
| 変位・傾き・微分 | `reference.ts:evolve`、`oceanNodes.ts` の `evolveNode` | Tessendorf 2001。web-ocean `SIM_EVOLVE` |
| 2 本への詰め方 | 同上 | web-ocean |
| κ で縮める | `reference.ts:jxzScale`・`assembleDisplacement`、`oceanNodes.ts` の `colsNode` | dogfight（ADR 0046） |

## 逆 FFT

2 次元の逆 FFT は、1 次元の逆 FFT を全部の行にかけ、続けて全部の列にかける。行が x、列が y の向き。1 次元は radix-2 の Cooley-Tukey で、ビット反転で並べ替えてから段ごとに蝶を組む。正規化はしない。指数の符号は +i。

```
X[j] = Σ x[n] e^{+2πi n j / N}
```

GPU 版は 1 本の FFT を 1 つのワークグループ（N/2 本の呼び出し）で解き、共有メモリ（`workgroupArray`）と同期（`workgroupBarrier`）を使う。回転因子は段ごとに cos・sin を呼ばず、CPU が倍精度で求めた N/2 点の表から引く。組み込みの cos・sin では傾きの逆 FFT が最大値の 5.9e-4 ずれ、表にして 3.0e-7 になった（ADR 0046）。

| 式 | 実装 | 出典 |
|---|---|---|
| 1 次元の逆 FFT | `reference.ts:inverseFft1d`、`oceanNodes.ts` の `butterflies` | web-ocean `butterflies` |
| 行 → 列 | `reference.ts:inverseFft2d`、`oceanNodes.ts` の `rowsNode`・`colsNode` | web-ocean `FFT_ROWS`・`FFT_COLS` |
| 回転因子の表 | `oceanNodes.ts` の `twiddleTable` | dogfight（ADR 0046） |

## ヤコビアンと泡の目安

横の変位で海面が畳まれる度合いは、変位の写像のヤコビアンで測る。

```
J = (1 + jxx)(1 + jzz) - jxz²
```

J = 1 なら面は伸び縮みしていない。1 を下回るほど波頭へ面が寄せ集められ、負になると面が裏返る。web-ocean は J の小さい所に泡を注ぐ。泡のクリップマップは `J < 0.68` から、海面のその場の泡は `J < 0.48` から出る。

| 式 | 実装 | 出典 |
|---|---|---|
| J | `reference.ts:jacobian`、`oceanSurface.ts:oceanShadeNode`、`oceanFoam.ts:createOceanFoam` | Tessendorf 2001。web-ocean の泡の更新 |

## テクスチャとミップ

FFT の出力は 32 ビットの記憶域にある。これをカスケードを層にした配列テクスチャ 3 枚へ写す。

| テクスチャ | 中身 | 引く所 |
|---|---|---|
| 変位 | (Dx, Dy, Dz, jxz) | 頂点（間隔に合わせた段）と画素の jxz |
| 傾き | (sx, sz, jxx, jzz) | 画素 |
| モーメント | (sx², sz², sx·sz, 0) | 画素（LEAN） |

精度は 16 ビット（rgba16float）。32 ビットとの絵の差は 7 構図で最大 1 階調、費用は 0.2〜0.4 ms 軽い（ADR 0047、ユーザーの決定）。`?oceantex=32` で比べられる。

ミップは three の `generateMipmaps` を使わず、自前のコンピュートで 2 × 2 を平均して作る。three の生成は層 × 段 × 枚数の描画パス（high で 64 本）になり、GPU の時刻の道具で測れなかった。同じテクスチャを読みながら別の段へ書くとビューの用途が衝突するので、前の段は 32 ビットの記憶域のピラミッドから読む。

モーメントは傾きの記憶域から積を作って写し、ミップでは積のまま平均する。平均の積ではない。粗い段ほど、解けない波の傾きの分散が `⟨s²⟩ - ⟨s⟩²` として残る。これが LEAN の要点で、遠くのきらめきが広がる理由になる。

uv はワールドの xz をそのまま L で割らない。覆う範囲の角（起点）からの差を L で割り、起点の端数を CPU が倍精度で渡す。

```
uv = (xz - 起点) / L + fract(起点 / L) + 0.5 / N
```

ultra の 0.26 m のカスケードは 20 km 先で uv が 8 万を越え、32 ビットでは texel の位置が出ない。`0.5 / N` は格子点を texel の中心に合わせる分。

| 式 | 実装 | 出典 |
|---|---|---|
| 写しとミップ | `oceanMips.ts:createLayeredMips` | dogfight（ADR 0047） |
| モーメントの写し | `oceanSurface.ts:createOceanTextures` の `map` | LEAN（Olano と Baker 2010）。web-ocean |
| uv と端数 | `oceanLayout.ts:oceanUvOffset`、`oceanSurface.ts:createOceanSampler` | dogfight（ADR 0047） |

## CDLOD の分割

海面は四分木から選んだパッチを、1 回の描画でインスタンスとして敷く。パッチ 1 枚は 16 × 16 セル。根の一辺は段数から決まり、カメラを含む根のまわりに 3 × 3 で並べる。

```
根の一辺 = 0.5 × 2^(段数 - 1)
覆う範囲 = 根の 3 × 3、根の格子に寄せる
```

| 品質 | 段数 | 根の一辺 | 覆う範囲 |
|---|---|---|---|
| low | 8 | 64 m | 192 m 四方 |
| medium | 10 | 256 m | 768 m 四方 |
| high | 12 | 1024 m | 3072 m 四方 |
| ultra | 13 | 2048 m | 6144 m 四方 |

根の格子に寄せて動かすので、カメラが動いてもパッチの境目は世界に固定のまま。ノードを割るかは、カメラからノードまでの 3 次元の距離で決める。距離にカメラの高さを入れた。高度 600 m から真下を 0.5 m まで割る意味は無い。

```
d     = |カメラ - 高さ 0 の矩形|（水平の外側の差と、カメラの高さ）
range = 一辺 × 1.8 × lodDistanceScale
d ≤ range なら 4 つに割る
```

high（`lodDistanceScale` 0.5）で高度 2.5 m なら、一辺 4 m のノードは range 3.6 m で割れ、2 m のノードは range 1.8 m で割れない。真下の最も細かいパッチは一辺 2 m、頂点の間隔 12.5 cm になる。

パッチのセルを web-ocean の 32 から 16 に減らした。32 では high の低空で 109 万三角形になったためで、細かい波は頂点でなく法線で描く（ADR 0047）。

頂点の変位は、頂点の間隔に合わせてミップの段を選んで引く。

```
lod = log2(max(間隔 / (L/N), 1)) + 0.5
lod ≥ log2 N なら、そのカスケードは足さない
```

`+ 0.5` は頂点の間隔より細かい波を半段ぼかし、寄せで間隔が変わるときのちらつきを抑える。最後の段（1 × 1）は場の平均で、直流を除いてあるので 0 になる。

変位は覆う範囲の縁で 0 へ絞る。縁から根の一辺の 4 分の 1 の幅を smoothstep でつなぐ。

```
inset = 範囲の 4 辺までの最短の距離
fade  = smoothstep(0, 0.25 × 根の一辺, inset)
```

| 式 | 実装 | 出典 |
|---|---|---|
| 根と覆う範囲 | `oceanLayout.ts:oceanRootSize`・`oceanCoverage` | dogfight（ADR 0047） |
| 3 次元の距離 | `oceanLayout.ts:distanceToPatch` | dogfight（ADR 0047） |
| `range` と 1.8 | `oceanLayout.ts:lodRange` | 段 S4b で消した地形の四分木の値 |
| 16 セル | `OCEAN_PATCH_CELLS` | dogfight（ADR 0047）。web-ocean `GRID` は 32 |
| 頂点の段 | `oceanLayout.ts:oceanCascadeLod`、`oceanSurface.ts:createOceanSampler` の `lod` | web-ocean の `OCEAN` の頂点シェーダ |
| 縁の絞り | `oceanLayout.ts:oceanEdgeFade`、`oceanSurface.ts` の `displacement` | dogfight（ADR 0047）。幅 0.25 は推測 |

## 寄せと継ぎ目

CDLOD は、分割の境目で頂点を親の格子へ連続に寄せて、細かさの切り替えを見せない。寄せる量は頂点ごとに、寄せる前の位置とカメラの 3 次元の距離から求める。

```
end   = 2 × range（親の分割距離）
start = 0.8 × end
m     = clamp((d - start) / (end - start), 0, 1)
i'    = i + (2 floor(i/2) - i) m
間隔  = (パッチの一辺 / 16) × (1 + m)
```

m = 1 で奇数番の頂点は偶数番の位置へ重なり、パッチは親と同じ細かさになる。

段 S4b までは、寄せを自分の分割距離 `range` で終えていた。選ばれたパッチは選ばれた時点で寄せ切っていて、常に半分の細かさで描かれていた。このため細かさの違う辺で両側の頂点がそろわず、射出直後の低空で海面の割れ目から空が黒い線として見えた。CPU で数えると 5280 本の辺すべてで頂点が食い違っていた（ADR 0047 の段 S4d）。

直し方は 2 つある。1 つ目は寄せを親の分割距離へ移したこと。これだけでは 1923 本の辺が食い違ったまま残った。2 つ目は、1 段粗い隣と接する辺に印を付け、その辺の頂点を粗い側の頂点として置くこと。

```
辺に沿う番号 a = 2 floor(j/2)       （粗い側の頂点へ）
mc = 粗い隣の寄せ（範囲を 2 倍にして同じ式）
j' = a + (4 floor(a/4) - a) mc      （粗い側の親の格子へ）
間隔 = 2 × (パッチの一辺 / 16) × (1 + mc)
```

位置も、変位のミップを決める頂点の間隔も、粗い隣の頂点と同じになる。辺の印は、辺のすぐ外の点を 1 段浅い節が覆っているかで決める。

| 式 | 実装 | 出典 |
|---|---|---|
| 寄せの範囲と 0.8 | `oceanLayout.ts` の `visit`、`OCEAN_MORPH_START_RATIO` | web-ocean の `0.8 * R`（ADR 0047 の段 S4d） |
| 寄せの量 | `oceanLayout.ts:morphFactor`・`oceanMorph` | CDLOD（Strugar 2009）。地形から移した |
| 辺の印 | `oceanLayout.ts` の `markCoarserEdges`、`OCEAN_EDGE_*` | dogfight（ADR 0047 の段 S4d） |
| 頂点の置き方 | `oceanLayout.ts:oceanVertex`、`oceanSurface.ts` の `patch` | dogfight（ADR 0047 の段 S4d） |

CPU の純関数 `oceanVertex` と頂点シェーダは同じ式を持つ。`tests/render/oceanLayout.test.ts` が 40 台のカメラで、細かい側と粗い側の頂点の位置と間隔の一致を見ている。

## 範囲の外の板

覆う範囲の外は、一辺 300 km・高さ 0 の板が同じ陰影で水平線まで覆う。板は範囲の内側を描かず、内側へ 2 m 重ねる。CDLOD の外周は板と T 字の継ぎ目になり、画素未満の隙間を作りうる。重なりでは変位がほぼ 0 で陰影も同じなので、深度の競合は見えない。

| 量 | 値 | 実装 | 出典 |
|---|---|---|---|
| 板の一辺 | 300 km | `PLATE_EXTENT` | 段 S4b で消した板の海と同じ |
| 重ね | 2 m | `PLATE_OVERLAP` | 推測（ADR 0047） |

## 法線と傾きの分布

画素シェーダは、変位の前の xz（`oceanXZ`）で全カスケードの傾きを引いて足す。法線は傾きを横の変位の微分で割ってから作る。横の変位で面が詰まった所では、同じ傾きでも面は急になる。

```
s   = Σ_c (sx, sz) · g_c'
sl  = (sx / max(1 + jxx, 0.15), sz / max(1 + jzz, 0.15))
n   = normalize(-sl.x, 1, -sl.z)
```

g_c' はカスケードごとの倍率で、空母のまわりの凪の係数 s と、風の斑の倍率を掛けた値になる。

傾きの共分散 Σ = (σxx, σzz, σxz) は 4 つの和で作る。

```
Σ  = Σ_c (⟨sx²⟩ - ⟨sx⟩², ⟨sz²⟩ - ⟨sz⟩², ⟨sx sz⟩ - ⟨sx⟩⟨sz⟩) · g_c'²
   + (σu, σu, 0)                                  解けない細かい傾き
   + min(1, 0.03 / max(a.x, a.y)) · a             画素の中の傾きの変化
σu = 0.0024 + 0.0035 · smoothstep(30, 500, 距離)
a  = 0.5 (dFdx(sl)² + dFdy(sl)²)
```

1 つ目がミップで残った LEAN の分散、2 つ目がどのカスケードにも乗らない細かい傾きの分散、3 つ目は鏡面の折り返しを抑えるための画素の幅の分散。σu は遠くで Cox-Munk 並みの合計へ近づける。

遠くでミップの最後の段に届くカスケードは引かない。画素が覆う texel の数から異方性フィルタが選ぶ段を見積もり、`log2 N - 0.5` 以上ならモーメントの最後の段（場全体の平均）を 1 回だけ引いて分散に足す。傾きと J の横の項は平均 0 なので落とせる。スペクトルから期待値を求めて足す形も試したが、乱数で作った実際の場と最大 27% 食い違ったので採らなかった（ADR 0048）。

| 式 | 実装 | 出典 |
|---|---|---|
| 傾きの和と sl・n | `oceanSurface.ts:oceanShadeNode` | web-ocean の `OCEAN` の画素シェーダ |
| LEAN の分散 | 同上の `accumulate` | LEAN（Olano と Baker 2010）。web-ocean |
| σu = 0.0024 | `UNRESOLVED_SLOPE_VARIANCE` | web-ocean `waterCol.w` |
| 遠くの +0.0035 | `oceanShadeNode` の `unres` | web-ocean |
| 画素の幅の分散 | `oceanShadeNode` の `aa` | web-ocean |
| 遠くのカスケードを飛ばす | `oceanShadeNode` の `skipFar` の分岐 | dogfight（ADR 0048） |

## 太陽のきらめき

太陽の鏡面反射は、傾きの分布をそのまま微小面の分布として使う。半ベクトル H を向く面の傾きが、平均の傾き sl からどれだけ離れているかを、共分散 Σ の 2 次元のガウス分布で測る。

```
H    = normalize(V + L)
hs   = -H.xz / H.y
d    = hs - sl
pdf  = exp(-½ dᵀ Σ⁻¹ d) / (2π √det Σ)
D    = pdf / H.y⁴
G    = 1 / (1 + Λ(V) + Λ(L))
spec = E_sun · F(V·H) · D · G / (4 max(V.y, 0.02))
```

Λ は Smith の遮蔽で、向き w の断面の傾きの分散 σ² から有理式で近似する。

```
a = cot θ_w / √(2 σ²)
a < 1.6  :  Λ = (1 - 1.259 a + 0.396 a²) / (3.535 a + 2.181 a²)
a ≥ 1.6  :  Λ = 0
```

F は水の F0 0.02 の Schlick。太陽が地平線の下なら spec は 0。E_sun は太陽の照度に、層の雲の影と機体の影の遮りを掛けた値。

| 式 | 実装 | 出典 |
|---|---|---|
| 異方のガウスの D | `oceanShadeNode` の `pdf`・`Dm` | web-ocean。傾きの分布で鏡面を書く形は Cox-Munk |
| Λ の近似 | `oceanSurface.ts` の `lambdaSmith` | web-ocean `lambdaSmith`。係数は Walter ほか 2007 の Beckmann の近似 |
| Schlick、F0 = 0.02 | `oceanSurface.ts` の `fresnelWater` | web-ocean `fresnelWater` |
| 遮り | `OceanLighting.sunShade`（`pipeline/nodeScene.ts`） | 段 S4a-1 の板の海と同じ |

## 空の映り込み

反射の向きの空を、自前の空の見え方の LUT（`sky/hillaireSky.ts` の `radiance`）から直に引く。環境キューブは使わない。

すれすれの角度で見ると、見える面は見る側へ傾いた面に偏る。その分を法線に足してから反射させる。

```
vh   = 視線の水平成分の向き
σV   = vh の向きの傾きの標準偏差
aV   = (V.y / √(1 - V.y²)) / (√2 σV)
tilt = 0.32 σV (1 - smoothstep(0, 2.5, aV))
nV   = normalize(n + vh · tilt)
R    = reflect(-V, nV)
R.y' = 0.4 |R.y| + 0.6 max(R.y, 0)
```

R.y の折り返しで、地平線より下の空を引かない。フレネルは長い波の面に細かい面の分を寄せた法線で求める。

```
nF = normalize(mix(n, 上, 0.45))
Fr = F(max(nF·V, 0))
```

陰影の式は、映り込みの広がりとして傾きの標準偏差 `σ = √(½(σxx + σzz))` の 2 倍を `skyRadiance` へ渡す。ただし本番の場面の配線は広がりの引数を捨てている。`pipeline/nodeScene.ts` の `createOceanSurfaceFor` が `skyRadiance: (dir) => sky.radiance(dir)` と書いているためだ。このため今の絵では、映り込みも天頂と法線の向きの空も LUT のミップ 0 を引く。ADR 0048 は広がりで選ぶと書いているが、この文書はコードに合わせた。

| 式 | 実装 | 出典 |
|---|---|---|
| tilt と nV | `oceanShadeNode` の `sigV`・`aV`・`tilt` | web-ocean |
| R.y の折り返し | `oceanShadeNode` の `Ry` | web-ocean |
| nF の 0.45 | `oceanShadeNode` の `nF` | web-ocean |
| 広がり 2σ | `oceanShadeNode` の `refl`（配線で捨てられる） | web-ocean `envLod` の `2 * sig` |
| 空の LUT | `sky/hillaireSky.ts` の `radiance` | dogfight（ADR 0045） |

## 水中から戻る光と濁り

水中で散乱して戻る光は、水の色に上半球の空と太陽を掛けて作る。

```
E_hemi = E_sky / π
body   = c_w · τ · (1.6 E_hemi + 0.8 E_sun max(L.y, 0))
c_w    = (0.016, 0.080, 0.096)、τ = 0.6
```

τ が濁り。web-ocean の既定 1.6 は沿岸の明るい青緑になる。段 S4b で島を消して見える海が外洋だけになったので、空母・低空・夕景で 1.6・1.0・0.6 を撮り比べ、ユーザーが 0.6（深い青）を選んだ（ADR 0051）。`?oceanturbidity=` で振れる。

web-ocean は上半球の空を環境キューブの 5 点から取るが、ここは天空の照度を π で割る。空を引く回数は既定で 2 回（映り込みと法線の向き）で、天頂の空もこの E_hemi で代える。

逆光で薄い波頭は、太陽の光が透けて緑がかる。

```
crest = clamp((h - 0.05) / 0.9, 0, 1)
thin  = clamp(0.5 - 0.5 L·n, 0, 1)³
k1    = 2.6 crest² · max(L·(-V), 0)⁴ · thin · exp(-距離 / 600)
body += (0.035, 0.12, 0.085) · E_sun · k1
```

h は頂点の変位の高さで、板では 0 になる。最後に、水中の光・映り込み・きらめきを合わせる。

```
color = body (1 - Fr) + refl Fr + spec
```

霞はここでは掛けない。場面の合成（`pipeline/nodeOutput.ts`）が深度から掛ける。

浅瀬の色は持たない。ADR 0047 は浅瀬を段 S4a-3 に置いていたが、同じ段で島を消すと決めたので海岸の係数は作らなかった（ADR 0049）。地面が海面だけなので、水深を使う所が無い。

| 式 | 実装 | 出典 |
|---|---|---|
| c_w | `WATER_BODY_BASE` | web-ocean `ocean.html` の `f[76..83]` |
| τ = 0.6 | `OCEAN_TURBIDITY` | ユーザーの決定（ADR 0051）。web-ocean は 1.6 |
| 1.6 と 0.8 | `oceanShadeNode` の `body` | web-ocean |
| E_hemi = E_sky/π | `oceanShadeNode` の `skyHemi` | dogfight（ADR 0047）。段 S4a-1 の板の海と同じ |
| 空 2 回 | `OceanShadeOptions.skyLookups` | dogfight（ADR 0048） |
| 波頭の透過光 | `SSS_COLOR`・`SSS_STRENGTH`、`oceanShadeNode` の `k1` | web-ocean `sssCol` |

## 風の斑

web-ocean の cat's paws。短い波が強い所と凪いだ所の斑を、模様のテクスチャの濃淡から作る。

```
g    = mix(0.35, 1.2, smoothstep(0.3, 0.72, 模様.b(xz · 0.011 + 風 · t · 0.0004)))
px   = (1 / 0.011) / 画素が覆う幅
g'   = mix(1, g, smoothstep(16, 48, px))
g_c' = mix(1, g', share_c) · s
share_c = 0（c ≤ 2）、0.5（c = 3）、1（c ≥ 4）
```

模様は約 91 m ごとにくり返す。遠くで 1 周期が画面で十数画素まで縮むと遠近の網目に見えたので、48 画素より小さい所から斑を効かない側（1）へ寄せ、16 画素以下では使わない（ADR 0048 の段 S4d）。

斑が掛かるのは 4 段目以降のカスケードだけ。low・medium・high はカスケードが 3 本なので、今の設定で斑が効くのは ultra だけになる。

| 式 | 実装 | 出典 |
|---|---|---|
| g | `oceanShadeNode` の `gust`、`GUST_SCALE` | web-ocean |
| 遠くで寄せる | `oceanLayout.ts:oceanTileFade`、`OCEAN_TILE_FADE_PX` | 推測（ADR 0048 の段 S4d）。実機の絵で網目が消えることを確かめた |
| share_c | `oceanShadeNode` の `share` | web-ocean |

## 泡

泡は 2 つの層で作る。その場の J から出る瞬間の泡と、ワールドに固定したクリップマップが持ち越す泡。

クリップマップは一辺 128 m と 1024 m の 2 段で、段の数は品質表の `oceanFoamLevels` で決まる。high は 1 段（128 m、512²、texel 0.25 m）。番地はカメラを中心とするトーラス状に振る。カメラが動いても泡を写し直さずに済み、前の窓の外から入った texel だけは泡 0 で始まる。毎フレーム、全 texel で次を解く。

```
J     = (1 + s jxx)(1 + s jzz) - (s jxz)²        texel の大きさに合わせた段で引く
inj   = max(clamp((0.68 - J) · 2, 0, 1), 喫水線の泡)
before = 風下へ 0.03 U · dt だけ戻した点の前の泡
f     = max(before.f · exp(-0.22 dt), inj)
f     = min(f + inj · dt, 1.6)
fresh = max(before.fresh · exp(-1.6 dt), inj)
```

前の泡を風下から引くのは半ラグランジュの移流で、泡は風速 6 m/s で 0.18 m/s 流れる。状態は 32 ビットの記憶域に (f, fresh, J, 1) で持ち、16 ビットのテクスチャへ写してミップを作る。

泡を進める刻みは sim の刻みの差から求める。実時間は使わない。刻みが 30（0.25 秒）より飛んだとき、つまり最初のフレームとキャプチャでは、前から 4 刻みずつ 16 回回して泡を作る。減衰は exp なので刻みを粗くしても正確で、粗くなるのは波頭への注ぎ足しだけ（ADR 0048）。ライブで一度に進める上限は 0.1 秒。

画素では、クリップマップの泡とその場の泡を合わせて覆いの量を作る。

```
w0     = 1 - smoothstep(0.3 S0, 0.45 S0, カメラからのチェビシェフ距離)
fresh' = clamp((0.48 - J) · 2.5, 0, 1)
cover  = clamp(max(f_w, fresh' (1 - 0.7 w)) + 0.6 fresh_w, 0, 1.5)
```

f_w・fresh_w はクリップマップから引いた値に重み w を掛けたもの。0 段の品質（low）では w = 0 で、その場の泡だけになる。古い泡は風に沿った筋へほどけ、新しい泡は密なまま残る。泡の色は模様のテクスチャの網目と cover の smoothstep で縁を決め、最後に `mix(color, 泡の色, 0.95 · mask)` で重ねる。

模様のテクスチャ（512²、rgba8）は web-ocean の周期的なノイズの WGSL を `wgslFn` でそのまま写し、起動時に 1 回作る。R が網目、G が細かい網目、B が濃淡（風の斑にも使う）、A が筋。

| 式 | 実装 | 出典 |
|---|---|---|
| クリップマップの更新 | `oceanFoam.ts:createOceanFoam` の `update` | web-ocean `FOAM_UPDATE` |
| 0.68・2・1・0.22・1.6・1.6 | `FOAM_THRESHOLD`・`FOAM_GAIN`・`FOAM_GROWTH`・`FOAM_DECAY`・`FRESH_DECAY`・`FOAM_MAX` | web-ocean の既定（泡の強さ 1） |
| 流れ 0.03 U | `FOAM_DRIFT_PER_WIND` | web-ocean |
| 128 m・1024 m | `FOAM_LEVEL_SIZES` | web-ocean `FOAM_LEVEL_SIZE` |
| 前から 16 回・4 刻み | `FOAM_WARMUP_STEPS`・`FOAM_WARMUP_STRIDE` | ユーザーの決定（ADR 0048） |
| その場の泡 0.48・2.5 | `FOAM_FRESH_THRESHOLD`・`FOAM_FRESH_GAIN` | web-ocean `foamP` |
| 画素の泡の合成 | `oceanShadeNode` の泡の節 | web-ocean |
| 模様 | `oceanFoam.ts:createFoamPattern` | web-ocean `FOAM_TEX` |

## 空母のまわりの凪と喫水線の泡

FFT の波は見た目だけで、sim の海面は高さ 0 の平面のまま。見た目の波が空母の船腹に刺さらないように、船体からの距離で波を絞る。

船体の水線は、端を半幅で丸めた長方形（スタジアム形）で近似する。符号付きの距離が m で出るので、帯の幅を m で決められる。

```
(lx, lz) = 空母の座標系の点
qx = |lx - 1.3|
qz = max(|lz - 1.0| - (160.5 - 19.3), 0)
d  = √(qx² + qz²) - 19.3                    中は負
s  = smoothstep(0, 30, d)                   変位と傾きに s、モーメントに s²
泡 = d < 0 なら 0、それ以外 0.8 (1 - smoothstep(0, 4, d))
```

半幅 19.3 m と半長 160.5 m は、空母の模型の船体の部品 `ship_lower`・`ship_mid` のうち水面から ±3 m の帯の頂点の外接箱から取った。幅 38.6 m、長さ 320.9 m（ADR 0049）。

泡のクリップマップでは J の項に s を掛ける。船体の中では J が 1 になり、波頭の泡は出ない。喫水線の泡は注ぎ足しの `inj` に max で重ねる。空母の居ない場面では s = 1・泡 0 の定数にして、節点を作らない。

| 式 | 実装 | 出典 |
|---|---|---|
| 船体の距離 | `oceanCalm.ts:hullDistance`、`oceanCalmNodes.ts:createCalmNodes` | dogfight（ADR 0049） |
| 船体の寸法 | `CARRIER_HULL` | 模型の実測（2026-10-29） |
| 凪の帯 30 m | `CARRIER_CALM_BAND` | 推測（ADR 0049） |
| 泡の帯 4 m | `WATERLINE_FOAM_BAND` | 推測（ADR 0049） |
| 泡の量 0.8 | `WATERLINE_FOAM_STRENGTH` | ADR 0049。根拠の記述なし |
| s と s² の掛け方 | `oceanShadeNode` の `calm`・`gk`、`oceanFoam.ts` の `k` | dogfight（ADR 0049） |

## カメラの下限

描画のカメラは海面から 2.5 m より下げない。sim の機体の位置は触らない。

```
camera.y = max(camera.y, 2.5)
```

波の高さの上限は、カスケードごとの最大の和で 1.02 m（段 S4a-3 の high の条件 4 × 256、CPU 参照の 3 時刻）。カメラと波頭の間に約 1.5 m 残る。

| 式 | 実装 | 出典 |
|---|---|---|
| 下限 2.5 m | `src/render/camera.ts:cameraFloor`、`CAMERA_MIN_HEIGHT` | dogfight（ADR 0049） |

## 費用

実機は Intel Arc 140V、high、窓 1600×789・倍率 1.5。記録の本体は `docs/measuring.md` の段 S3〜S5。

| 段 | 測ったもの | 値 |
|---|---|---|
| S3 | 時間発展と逆 FFT（6 × 256） | 1.64〜1.89 ms |
| S3 | 同（3 × 128） | 0.30 ms |
| S4a-1 | 海の合計（計算＋海面、4 × 256、16 ビット） | 1.28〜1.48 ms |
| S4a-2 | web-ocean のまま（異方性 16・泡 1024²） | 6.3〜8.3 ms |
| S4a-2 | 軽くする手 4 つ＋異方性 1 | 3.6〜4.5 ms |
| S4a-3 | low-pass の 4 回の中央 | 5.25 ms |
| S4b | 泡 1 段・分割 0.75 にした後の中央 | 5.33 ms |
| S5 | 判定の計測、low-pass の海の合計 | 5.09 ms |
| S5 | 同、catapult-launch | 4.09 ms |
| S5 | 海の計算の群 | 0.82〜1.14 ms |

海の予算は 3.5 ms から始まり、5.5 ms（段 S4a-2、島をやめた分）、7.4 ms（段 S5、層の雲で浮いた分）と改めた。全体の予算は中央値 13.0 ms・95% 15.0 ms・降格なしのまま。段 S5 の判定では 7 条件とも全体の予算の内に入った。

効いたつまみは次の表のとおり。

| つまみ | 変えた値 | 効き |
|---|---|---|
| 異方性 | 16 → 4 | 約 −1 ms |
| 泡の段 | 2 → 1 | 約 −0.8 ms |
| 分割距離の倍率 | 0.75 → 0.5 | 場面のパス −0.2〜−0.4 ms |
| カスケード | 4 → 3 | −0.36〜−0.53 ms |
| FFT の格子 | 256 → 128 | −0.8〜−1.1 ms（採らなかった） |
格子は最も効いたが、近くの波の形が変わるので採らなかった（ADR 0052）。

## ADR の記述から動いた値

ADR は決めた時点の値で書かれている。後の段で変わった値を、今のコードの値と並べておく。

| 項目 | ADR の記述 | 今のコード | 変えた所 |
|---|---|---|---|
| high のカスケード | 4（ADR 0047） | 3 | ADR 0052 |
| medium のカスケード | 4（ADR 0047） | 3 | ADR 0052 |
| high の泡の段 | 2（ADR 0048） | 1 | ADR 0051 |
| high の分割距離の倍率 | 1（ADR 0047） | 0.5 | ADR 0051、0052 |
| 寄せの範囲 | 自分の分割距離（ADR 0047 の本文） | 親の分割距離・0.8 から | ADR 0047 の段 S4d |
| 濁り | 1.6（ADR 0047・0049） | 0.6 | ADR 0051 |
| 映り込みの広がり | 2σ でミップを選ぶ（ADR 0048） | 配線で捨てられ、ミップ 0 | 記録なし |

## 検証

式は `tests/render/oceanReference.test.ts` が縛る。分散の極限、方向分布の積分、JONSWAP のピーク、うねりの有義波高、帯の境目、整数の位相、逆 FFT、場のエルミート性と周期を見ている。

GPU と CPU の突き合わせは node-path の「FFT の海が CPU 参照と一致する」（WebGPU のみ）と `?oceanprobe=1`（`oceanProbe.ts`）が行う。許容は各カスケード・各成分の最大値に対する差で 1e-4。直した後の差は h0 3.4e-6、時間発展 3.3e-6、変位 4.1e-6、傾き 9.1e-7 だった。

CDLOD は `tests/render/oceanLayout.test.ts` が見る。凪と泡の帯は `tests/render/oceanCalm.test.ts`、テクスチャの引き方は `tests/render/oceanSurfaceProbe.test.ts`。海面の材質が場面のパスの MRT で消えないことは `tests/render/oceanMrt.test.ts` が縛る。

絵は `npm run dev` で確かめる。`?water=0` で海面を隠せるので、海面の割れ目は水平線より下の空が見えるかで分かる。`?ocean=debug` は海の計算だけを画面に出す。
