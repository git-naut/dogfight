# 空と大気

空・霞・太陽の光は、Hillaire 2020 の LUT 方式で描く。式は web-ocean（Noniv/web-ocean、MIT、コミット a07c7fd）の WGSL を TSL へ写したもので、`src/render/sky/` にある。決定の正本は ADR 0044（光の尺度）と ADR 0045（takram との継ぎ目の置き換え）。ADR 0002 は takram を使っていた頃の記録として残っている。

ファイルの役割は 4 つに分かれる。`reference.ts` が CPU 参照で、定数と式の唯一の定義を持つ。`skyNodes.ts` はその式を TSL へ 1 対 1 に写した LUT の焼き手。`hillaireSky.ts` が LUT を焼く順を決め、背景・環境反射・照度・機体の光として場面へ渡す。`solar.ts` と `src/render/geoFrame.ts` が太陽の向きを出す。

雲の層（`cloudLayerNodes.ts`・`cloudLayersReference.ts`）もこのディレクトリにあるが、扱いは `docs/clouds.md` に譲る。雲が空から読むのは `radiance()`（空の放射輝度）と直達光の照度の 2 つに限られる。

## 単位と座標

LUT の中の長さは km、係数は 1/km。web-ocean と同じ単位にそろえてある。場面の側は m なので、照度を引くときに `max(world.y, 0) / 1000` で km の高さに直す（`hillaireSky.ts` の `altitudeOf`）。

LUT を積分するときは、地球の中心を原点に置く。観測点は `(0, r, 0)`、`r = 6360 + 高さ`。太陽は xy 平面に置き、方位を +x とする。こうすると太陽の向きは天頂角の余弦 `μs` の 1 つの数で決まる。

場面のワールドは右手系で、X が南、Y が上、Z が西。機首方向の -Z が東を向く（`geoFrame.ts`）。地球の丸みは高さにだけ入れる。水平に 100 km 離れても太陽の角度は 0.9 度しか変わらないため。

## 大気の定数

散乱の定数は takram（Bruneton 2017 の既定）にそろえた。散乱の式は web-ocean のままにしてある。web-ocean の値（Hillaire 2020 の論文の値）と比べると、天空光で 2〜3% の差になる。今の絵との連続を取った（ADR 0044）。

| 定数 | 値 | 実装 | 出典 |
|---|---|---|---|
| 地表の半径 | 6360 km | `reference.ts:GROUND_RADIUS` | Hillaire 2020・Bruneton 2017 |
| 大気の上端の半径 | 6420 km | `reference.ts:TOP_RADIUS` | Bruneton 2017（takram）。web-ocean は 6460 km |
| Rayleigh の散乱係数 | (5.802, 13.558, 33.1) × 1e-3 /km | `reference.ts:RAYLEIGH_SCATTERING` | Hillaire 2020・Bruneton 2017 |
| Rayleigh の高さの尺度 | 8 km | `reference.ts:RAYLEIGH_SCALE_HEIGHT` | Hillaire 2020 |
| Mie の散乱係数 | 3.996e-3 /km | `reference.ts:MIE_SCATTERING` | Hillaire 2020・Bruneton 2017 |
| Mie の減衰係数 | 4.44e-3 /km | `reference.ts:MIE_EXTINCTION` | Bruneton 2017（takram）。web-ocean は 4.40e-3 |
| Mie の高さの尺度 | 1.2 km | `reference.ts:MIE_SCALE_HEIGHT` | Hillaire 2020 |
| Mie の非対称の度合い g | 0.8 | `reference.ts:MIE_G` | Bruneton 2017（takram）。web-ocean は 0.84 |
| オゾンの吸収係数 | (0.65, 1.881, 0.085) × 1e-3 /km | `reference.ts:OZONE_ABSORPTION` | Hillaire 2020・Bruneton 2017 |
| オゾンの層の中心と半幅 | 25 km・15 km | `reference.ts:OZONE_CENTER`・`OZONE_HALF_WIDTH` | Hillaire 2020 |
| 地面の反射率 | 0.1 | `reference.ts:GROUND_ALBEDO` | Bruneton 2017（takram）。web-ocean は 0.06 |
| 大気の上端の太陽の照度 | (1.474, 1.8504, 1.91198) | `reference.ts:SOLAR_IRRADIANCE` | Bruneton 2017（takram の `solarIrradiance`） |
| 太陽の見かけの半径 | 0.004675 rad | `hillaireSky.ts:SUN_ANGULAR_RADIUS` | takram と web-ocean |

係数を 3 つ並べたものは赤・緑・青の順。web-ocean と takram で値が同じ行は、両方の出典を書いた。

## 媒質の密度

高さ h km の点の係数は、地表の係数に密度の分布を掛けて出す。

```
dR(h) = exp(-h / 8)
dM(h) = exp(-h / 1.2)
dO(h) = max(0, 1 - |h - 25| / 15)

σs_R(h) = β_R × dR(h)
σs_M(h) = β_M × dM(h)
σt(h)   = σs_R(h) + βe_M × dM(h) + β_O × dO(h)
```

Rayleigh と Mie は指数で薄くなり、オゾンは高さ 10〜40 km の三角形に分布する。オゾンは吸収だけで散乱しない。そのため減衰 `σt` には入り、散乱 `σs` には入らない。地表での減衰係数は (0.0102, 0.0180, 0.0375) /km で、青は赤の 3.7 倍減衰する。

| 式 | 実装 | 出典 |
|---|---|---|
| 密度の分布 3 つと係数の合成 | `reference.ts:medium`、`skyNodes.ts:mediumNode` | Hillaire 2020（web-ocean の `ATMO_CORE_WGSL`） |
| 球と光線の交点 | `reference.ts:raySphere`、`skyNodes.ts:sphereNear`・`sphereFar` | web-ocean |

`medium` の引数 `haze` は Mie の倍率で、web-ocean の `A.haze.x` に当たる。既定の 1 から動かしている所は無く、TSL の側は 1 に固定してある。

## 位相関数

散乱した光がどの向きへ行くかの分布。`c` は散乱角の余弦、つまり視線と太陽の向きの内積。

```
pR(c) = 3 / (16π) × (1 + c²)
pM(c) = 3 / (8π) × (1 - g²)(1 + c²) / ((2 + g²)(1 + g² - 2gc)^1.5)
```

Rayleigh は前と後ろに対称で、Mie は g = 0.8 で前方へ強く偏る。太陽のまわりの白い光の輪は `pM` の峰から出る。Mie の分母は `max(…, 1e-4)` で下を止めている。

| 式 | 実装 | 出典 |
|---|---|---|
| Rayleigh の位相関数 | `reference.ts:phaseRayleigh`、`skyNodes.ts:phaseRayleighNode` | Hillaire 2020 |
| Mie の位相関数（Cornette-Shanks） | `reference.ts:phaseMie`、`skyNodes.ts:phaseMieNode` | Hillaire 2020 |

## 透過率の LUT

半径 r の点から天頂角の余弦 μ の向きに、大気の上端までの透過率。

```
T(r, μ) = exp(-∫₀^tMax σt(h(t)) dt)
```

積分は 64 歩の中点則で刻む。地面に当たる向きでも上端まで積分する。地平線より下の値は、引く側が使わない。

LUT は 256 × 64。uv の写し方は Bruneton の方式で、地平線の付近に画素を寄せる。

```
H   = √(Rtop² - Rg²)
ρ   = √(r² - Rg²)
d   = -r μ + √(r²(μ² - 1) + Rtop²)     上端までの距離
u   = (d - (Rtop - r)) / (ρ + H - (Rtop - r))
v   = ρ / H
```

焼くときは逆の写し方で、画素の中心から `(r, μ)` を出す。

| 式 | 実装 | 出典 |
|---|---|---|
| 透過率の積分（64 歩・中点則） | `reference.ts:transmittanceToTop`、`skyNodes.ts:transmittanceFragmentNode` | web-ocean の `TRANS_LUT` |
| uv から `(r, μ)` | `reference.ts:transmittanceUvToRMu` | Bruneton 2017 |
| `(r, μ)` から uv | `reference.ts:transmittanceRMuToUv`、`skyNodes.ts:transmittanceUvNode` | Bruneton 2017 |
| 太陽が地平線の下か（`μ < -ρ / r`） | `reference.ts:sunBelowHorizon`、`skyNodes.ts:sunBelowHorizonNode` | web-ocean |

透過率は太陽の向きやカメラで変わらないので、起動時に 1 回だけ焼く。

## 多重散乱の LUT

2 回目以降の散乱を、Hillaire 2020 の近似で 1 枚の 32 × 32 の表に畳む。横が太陽の天頂角の余弦、縦が高さ。

近似の考え方は、2 回目以降の散乱光は向きに依らない（等方）とみなすこと。こうすると、ある点のまわりの全方向から「1 回散乱して届く光」`L2` と「散乱して戻ってくる割合」`f` を測れば、無限次までの和が等比級数になる。

```
L2 = (1/4π) ∫ 全方向 [∫ T(t) σs(t) T_sun(t) / (4π) dt + 地面の反射] dω
f  = (1/4π) ∫ 全方向 ∫ T(t) σs(t) dt dω

Ψms = L2 × (1 + f + f² + …) = L2 / (1 - f)
```

方向は 8 × 8 = 64 本。天頂角は `acos(1 - 2(b + 0.5)/8)` で余弦を等分し、方位は等間隔に置く。1 本の視線は 20 歩で刻む。地面に当たる視線は、地面の点に反射率 0.1 のランバート面の寄与 `T × T_sun × max(μs, 0) × 0.1 / π` を足す。

| 式 | 実装 | 出典 |
|---|---|---|
| `L2` と `f` の積分と `L2 / (1 - f)` | `reference.ts:multiscatterTexel`、`skyNodes.ts:multiscatterFragmentNode` | Hillaire 2020（web-ocean の `MS_LUT`） |
| 方向 64 本・刻み 20 歩 | `reference.ts:MULTISCATTER_DIRECTIONS`・`MULTISCATTER_STEPS` | web-ocean |
| 地面の反射の項 | 同上の `hitG` の枝 | Hillaire 2020 |
| 端の画素の中心を 0 と 1 に合わせる写し方 | `reference.ts:fromUnitToSubUvs`・`fromSubUvsToUnit` | Hillaire 2020（UE の実装） |
| 引く側 | `reference.ts:sampleMultiscatter`、`skyNodes.ts:sampleMultiscatterNode` | web-ocean |

高さの下限は 0.01 km にしてある（`max(v × 60, 0.01)`）。透過率と同じく起動時に 1 回だけ焼く。

## 1 区間の積分

空の見え方と霞は、視線に沿って光を足し上げる。1 区間 `dt` の中では係数が一定とみなし、区間の中の減衰を解析的に積分する。

```
S   = T_sun × (σs_R × pR + σs_M × pM) + Ψms × (σs_R + σs_M)
ts  = exp(-σt × dt)
L  += T × (S - S × ts) / σt
T  *= ts
```

`S` の第 1 項が太陽からの 1 回散乱、第 2 項が多重散乱の LUT の寄与。`S × dt` を足す素朴な形より、区間が長くても光の総量が保たれる。`σt` は 1e-9 で下を止めて 0 除算を避ける。

刻みは 2 乗で配る。i 歩目の区間の終わりは `tMax × ((i + 1) / N)²` で、近くを細かく、遠くを粗く刻む。区間の中で引く位置は始まりから 0.3 の所。

| 式 | 実装 | 出典 |
|---|---|---|
| 区間の解析的な積分 | `reference.ts:skyRadiance`・`aerialPerspective` と、`skyNodes.ts` の同名のノード | Hillaire 2020（web-ocean の `SKYVIEW_LUT`） |
| 刻みの 2 乗の配り方 | 同上 | web-ocean |
| 区間の 0.3 の位置で引く | 同上 | Hillaire 2020（UE の実装） |

TSL で 1 つ罠を踏んだ。`t = tPrev + 0.3 dt` を `.toVar()` で確定させずに `tPrev.assign(tn)` すると、t は書き換え後の値で評価される。標本が 1 区間先へずれ、天空光が 6〜11% 低く出た（`docs/measuring.md` の段 S2a）。`skyRadianceNode` と `aerialNode` に注記がある。

## 空の見え方の LUT

カメラの高さから見た全方向の空の放射輝度。256 × 144 で、1 本の視線を 48 歩で刻む。太陽の天頂角とカメラの高さで変わるので、毎フレーム焼き直す。

視線の行き止まりは、地面に当たれば地面まで、当たらなければ大気の上端まで。

uv の写し方は Hillaire 2020 の非線形の写し方で、地平線の付近に画素を寄せる。`β` は地平線が水平から下がる角度、`zha = π - β` は天頂から地平線までの角度。

```
cos β = ρ / r

v < 0.5 :  vza = zha × (1 - (1 - 2v)²)          地平線より上
v ≥ 0.5 :  vza = zha + β × (2v - 1)²            地平線より下

u       :  cos(太陽との方位差) = -(2u² - 1)
```

引く側（ワールドの向きから uv）はこの逆で、方位差の余弦 `lvc` から `u = √(0.5 - 0.5 lvc)` を出す。太陽の方位はワールドの `sunDir.xz` から取る。

| 式 | 実装 | 出典 |
|---|---|---|
| 1 本の視線の放射輝度（48 歩） | `reference.ts:skyRadiance`、`skyNodes.ts:skyRadianceNode` | web-ocean の `SKYVIEW_LUT` |
| uv から視線の向き | `reference.ts:skyViewDirection`、`skyNodes.ts:skyViewDirection` | Hillaire 2020（web-ocean の `SKYVIEW_LUT` の前半） |
| ワールドの向きから uv | `skyNodes.ts:skyViewUvNode` | web-ocean の `skyViewUV` |
| 焼く断片 | `skyNodes.ts:skyViewFragmentNode` | web-ocean |

焼くときは v を裏返す（`skyNodes.ts:bakeUv`）。node 経路はレンダーターゲットを引くときに v を裏返すので、焼く側で打ち消しておくと LUT の uv をそのまま `texture()` に渡せる。ループの中のテクスチャは LOD 0 で引く。分岐の中で暗黙の LOD を使うことを WGSL が許さないため。

空の見え方の LUT だけはミップを持つ。環境反射と海面の映り込みが、粗さに応じてミップを選ぶ。

## 霞

遠くの物ほど、視線の途中で散乱した光が乗り、物の色が減衰する。これを Hillaire 2020 の aerial perspective で表す。カメラの視錐台を 32 × 32 × 32 に切り、LUT へ焼く。

```
s 枚目の距離 = 200 km × ((s + 1) / 32)²
距離から枚   = √(d / 200) × 32 - 1
```

奥行きは 2 乗で配り、最後の 1 枚がカメラの遠方 200 km に当たる。1 枚ごとに、カメラから その距離までを空の見え方と同じ被積分関数で積分する。刻みは 32 歩。

場面の色への掛け方は次のとおり。

```
色' = 色 × T_aerial + L_aerial × SKY_ILLUMINANCE
```

深度 1 の画素（空）には掛けない。空は背景で描いてある。奥行きは隣り合う 2 枚を線形に補間する。0 枚目より手前は「入る光 0・透過率 1」との補間になる。

| 式 | 実装 | 出典 |
|---|---|---|
| 1 本の視線の霞（32 歩） | `reference.ts:aerialPerspective`、`skyNodes.ts:aerialNode` | Hillaire 2020（web-ocean） |
| 奥行きの配り方 | `reference.ts:aerialSliceDistance`・`aerialSliceOf` | web-ocean |
| 画面の uv から視線 | `skyNodes.ts:screenRayNode`、`skyProbe.ts:screenRay` | 推測（three の `getViewPosition` に合わせた） |
| 焼く断片（横 32 × 32 枚・縦 32 のアトラス） | `skyNodes.ts:aerialFragmentNode` | web-ocean |
| 場面の色へ掛ける | `skyNodes.ts:applyAerialNode`、`pipeline/nodeOutput.ts` の合成 | web-ocean |

web-ocean から変えた所が 3 つある（ADR 0045）。

1 つ目は透過率を色ごとに持つこと。Hillaire と UE は灰色の 1 値で持つが、海面の高さで水平に 50 km 進むと赤は 0.6、青は 0.15 まで落ちる。

2 つ目は入る光と透過率を 2 枚のアトラスに分けて焼くこと。three の材質は `fragmentNode` を持つと MRT の出力を組まないので、1 パスで 2 つを書けなかった。透過率の側は散乱を引かずに減衰係数だけを積むので軽い。

3 つ目は刻みの 32 歩。遠くまで積分した霞と空の放射輝度（48 歩）の差は、16 歩で最大 6.6%、32 歩で 1.8% だった。この差は水平線で遠い物と空の継ぎ目に出る。

## 太陽の位置

日時と地点から太陽の向きを出す式は、NOAA の太陽位置計算（Meeus『Astronomical Algorithms』に基づく）。web-ocean は太陽の向きを画面のつまみで決めていて、日時から出す式を持たない。そこで自前で書いた。大気差（屈折）は入れない。

```
t        = (JD - 2451545) / 36525                   ユリウス世紀
赤緯 δ   = asin(sin ε × sin λ)                       ε は黄道傾斜、λ は視黄経
時角 H   = (UTC 分 + 均時差 + 4 × 経度[度]) / 4 - 180
東       = -cos δ × sin H
北       = cos φ × sin δ - sin φ × cos δ × cos H
上       = sin φ × sin δ + cos φ × cos δ × cos H
ワールド = (-北, 上, -東)                            X 南・Y 上・Z 西
```

| 式・値 | 実装 | 出典 |
|---|---|---|
| 赤緯と均時差 | `solar.ts:solarDeclinationAndEquationOfTime` | NOAA の Solar Calculator（列名と 1 対 1） |
| 局所の向き | `solar.ts:sunDirectionLocal` | NOAA |
| 基準地点 北緯 35.6 度・東経 139.7 度 | `geoFrame.ts:REFERENCE_LATITUDE`・`REFERENCE_LONGITUDE` | ADR 0002（takram の頃から据え置き） |
| 基準日時 2026-08-16 02:45 UTC（地方真太陽時の正午） | `geoFrame.ts:SOLAR_NOON_UTC` | 推測（絵を固定するための値） |
| 既定の時刻 16 時（太陽高度 32.3 度） | `geoFrame.ts:DEFAULT_HOUR` | 推測（午後の斜光の絵で選んだ値） |
| 時刻から向きと高度 | `geoFrame.ts:sunFrameForHour` | — |

時刻は基準日時からの時間差で表す。実時間の Date を使うと絵が毎回変わり、スクリーンショット回帰が成立しない。

## 光の尺度

LUT の値は「大気の上端の太陽の照度 1 あたり」の放射輝度で、単位を持たない。これを takram の光の単位へ写す倍率が 2 つある。直達用と空用で換算が違う。

```
REL = 0.2126 × K_sun.r + 0.7152 × K_sun.g + 0.0722 × K_sun.b

SUN_ILLUMINANCE = E_sun × K_sun / REL = (1.9125, 1.7096, 1.6786)
SKY_ILLUMINANCE = E_sun × K_sky / REL = (2.2382, 1.7426, 1.6492)
```

`E_sun` は上端の太陽の照度。`K_sun` と `K_sky` は takram の放射輝度から輝度への換算（`sunRadianceToLuminance` と `skyRadianceToLuminance`）。`REL` は太陽の換算を Rec.709 の重みで輝度にした値。これで割って相対の輝度にする。

| 式・値 | 実装 | 出典 |
|---|---|---|
| `K_sun` | `reference.ts:SUN_RADIANCE_TO_LUMINANCE` | takram |
| `K_sky` | `reference.ts:SKY_RADIANCE_TO_LUMINANCE` | takram |
| 2 つの倍率 | `reference.ts:SUN_ILLUMINANCE`・`SKY_ILLUMINANCE` | takram の `sunRadianceToRelativeLuminance` と同じ割り方 |

直達光をこの尺度に合わせたのは、露出 6・ブルームの閾値・VFX の色を takram の尺度で決めてあるから（ADR 0044）。直達光は 6 時刻とも takram と 0.2% 以内で一致した。

## 直達光と天空光の照度

海・雲・照度の読み戻しは `hillaireSky.ts` の `lighting` を読む。位置と法線から、太陽の照度と天空の照度を返す。

```
直達(world, N) = T(r, μs) × SUN_ILLUMINANCE × max(N · sunDir, 0)
                 太陽が地平線の下なら 0

天空(world, N) = E(μs, h) × π × SKY_ILLUMINANCE × (1 + N.y) / 2
```

`E(μs, h)` は上向きの面が受ける天空の照度を π で割った値。同梱の表から引く。`(1 + N.y) / 2` は、上向きの面の値から傾いた面の値を出す近似。地面からの照り返しは 0 とする。three の `HemisphereLight`（地面の色が黒）と同じ式にしてあり、機体と海が同じ光を受ける。

表の 1 画素の値は、半球を天頂角 32 × 方位 64 に刻んで足す。

```
E / π = (1/π) Σ L(θ, φ) × cos θ × Δω
Δω    = Δ(cos θ) × 2π / 64                cos θ を等分するので立体角が等しい
```

表は 64 × 16 で、横が太陽の余弦 -0.4〜1、縦が高さ 0〜60 km。高さは 2 乗で配り、機体が飛ぶ 0〜15 km に画素を寄せる。太陽の余弦が -0.4 より下（太陽高度 -23.6 度より下）は、天空光がほぼ 0 なので端で止める。

| 式・値 | 実装 | 出典 |
|---|---|---|
| 直達の照度 | `hillaireSky.ts:directAt` | Hillaire 2020 の透過率に takram の尺度 |
| 天空の照度と `(1 + N.y) / 2` | `hillaireSky.ts:skyUpAt` と `lighting.illuminance` | takram の `getIndirectIlluminance` と同じ式 |
| 半球の積分 | `reference.ts:skyIrradianceOverPi` | 推測（takram の照度プローブと同じ量になるよう組んだ） |
| 表の画素の座標と値 | `reference.ts:irradianceTexelCoords`・`irradianceTexel` | 推測 |
| 表を引く | `reference.ts:sampleIrradiance`、`skyNodes.ts:sampleIrradianceNode` | 推測 |
| 表の数値 | `irradianceTable.ts:IRRADIANCE_TABLE` | CPU 参照から書き出した値 |

表は起動時に焼かず、数表として同梱する（36 KB）。照度は太陽の高さと点の高さだけで決まり、太陽の方位やカメラでは変わらない。GPU で焼くと 1 画素あたり 2048 方向 × 48 歩になる。CI の SwiftShader で起動のたびに秒の単位で掛かる見込みだった（推測、ADR 0045）。

表は手で直さない。定数か刻みを変えたら次で書き直す。全画素で 30 秒ほど掛かる。

```bash
WRITE_SKY_IRRADIANCE=1 npx vitest run tests/render/skyIrradiance.test.ts
```

## 機体のライト

機体は three の標準の光で照らす。直達は `DirectionalLight`、天空は `HemisphereLight`（地面の側は黒）。色は CPU が毎フレーム、機体の高さで入れ直す（`hillaireSky.ts:updateLights`）。

```
DirectionalLight.color = SUN_ILLUMINANCE × T(r, μs) × k_cloud
HemisphereLight.color  = SKY_ILLUMINANCE × E(μs, h) × π
HemisphereLight.ground = 黒
```

`T(r, μs)` は LUT を引かず、`transmittanceToTop` で直に積分する。GPU の側（海・雲）と同じ式なので、場面の中で機体と海面の光が同じ値になる。`k_cloud` は太陽への線が層の雲を横切るときの透過率 0〜1 で、層の雲が `setSunCloudTransmittance` で入れる。

光は機体から太陽の向きに 200 m の所に置く（`SUN_LIGHT_DISTANCE = AIRCRAFT_SHADOW_DISTANCE`）。光の位置は影の箱の位置でもあるため、影の追従と同じ距離にそろえた。最初は 1 m にしていて、影の追従の 200 m を上書きし、影の箱が機体の太陽側を切るおそれがあった（ADR 0045）。

| 式・値 | 実装 | 出典 |
|---|---|---|
| 直達の色 | `hillaireSky.ts:updateLights` | ADR 0045 |
| 天空の色 | 同上（`sampleIrradiance` で CPU 側の表を引く） | ADR 0045 |
| 光の距離 200 m | `hillaireSky.ts:SUN_LIGHT_DISTANCE` | 影の追従の距離にそろえた |
| 場面への追加 | `pipeline/nodeScene.ts` の `scene.add(sky.sunLight, …)` | — |

## 環境反射

機体の外板の映り込み。takram は空をキューブへ描いて PMREM で畳んでいて、約 1 秒に 1 回 2.5 ms 跳ねていた（段 S0c）。自前の空はキューブと PMREM を作らず、空の見え方の LUT を反射の向きで直に引く（ADR 0045）。

```
広がり   = atan(粗さ²) × 256 / π           LUT の横の 1 画素の角度で割った数
ミップ段 = log2(max(広がり, 1))
放射輝度 = skyView(反射の向き, ミップ段) × SKY_ILLUMINANCE
```

three の `EnvironmentNode` が反射の文脈（`getUV` と `getTextureLevel`）を被せて呼ぶので、自前のノードでそれを読む。照度の文脈では向きが法線になる。

海面の映り込み（`radiance(dir, spread)`）も同じ LUT を引く。こちらは映り込みの広がりを角度 rad で受け取り、`log2(max(spread × 256 / π, 1))` の段で引く。

| 式・値 | 実装 | 出典 |
|---|---|---|
| ミップ段の近似 | `hillaireSky.ts` の `environmentNode` と `SkyEnvironmentNode` | 推測（ADR 0045） |
| 海面の映り込み | `hillaireSky.ts` の `radiance` | 推測（段 S4a-2） |
| 入れるか切るか | `quality.ts:skyEnvironment`（low だけ切る）、`?env=0` | ADR 0045 |

ぼかしの形は GGX ではなく、LUT の画素の並び（地平線の付近が細かい）に沿う。絵で差が見えたらキューブと PMREM へ戻す、という条件で採った。

## 太陽の円盤

背景は空の見え方の LUT に太陽の円盤を足したもの（`hillaireSky.ts` の `backgroundNode`）。円盤の放射輝度は、照度を円盤の立体角で割って出す。

```
L_sun = SUN_ILLUMINANCE × T(r_cam, μs) / (π θ²)        θ = 0.004675 rad
円盤  = smoothstep(cos(1.15 θ), cos θ, dir · sunDir)
背景  = skyView(dir) × SKY_ILLUMINANCE + L_sun × 円盤
```

縁は半径の 15% ぶんの幅でぼかす。円盤の放射輝度は空の 1e5 倍ほどの桁になり、トーンマッピングで白く飽和する。月と星は描かない（ユーザーの決定、ADR 0044・0045）。

| 式 | 実装 | 出典 |
|---|---|---|
| 円盤の放射輝度 | `hillaireSky.ts` の `backgroundNode` | web-ocean |
| 縁のぼかし 1.15 倍 | 同上 | 推測 |

## 露出 6

トーンマッピングの露出は 6（`pipeline/types.ts:DEFAULT_EXPOSURE`）。takram の頃に 5 から 40 まで振って絵で比べ、空に深みが残る値として選んだ（ADR 0002）。自前の空でもこの値を動かしていない。直達光を takram の尺度に合わせたのはこのため。

天空光は物理の値を採ったので、昼の空と日陰は takram の頃より 25〜40% 暗い。ブルームの閾値（露出前で 0.20）は、takram の頃の空の最大 0.1844 より上にある。空が暗くなった分、ブルームへの影響は無い（`docs/measuring.md` の段 S2a）。

## 焼く順と費用

| LUT | 大きさ | 焼くとき | 実機の所要（Arc 140V、high） |
|---|---|---|---|
| 透過率 | 256 × 64 | 起動時に 1 回 | — |
| 多重散乱 | 32 × 32 | 起動時に 1 回（透過率の後） | — |
| 天空の照度 | 64 × 16 | 焼かない（同梱の数表） | — |
| 空の見え方 | 256 × 144、ミップあり | 毎フレーム | 0.15〜0.22 ms |
| 霞（入る光・透過率） | 1024 × 32 を 2 枚 | 毎フレーム | 2 枚で 0.13〜0.18 ms |

毎フレームの焼き直しは `hillaireSky.ts` の `update` が、場面を描く前に行う。カメラの射影を描き手の座標系（WebGPU の深度 0〜1）に合わせてから行列を写す。最初の 1 枚より前は WebGL の射影のままなので、ずれると霞の距離が桁で外れる。

時刻を変えた直後に照度を読み戻すときは、先に `setSun` を呼ぶ。`update` は場面を描く直前にしか走らないため。

## 検証

CPU 参照の光の強さは、近似の無い正解と比べて縛る。GPU の LUT は CPU 参照と比べて縛る。2 段に分けるのは、GPU と CPU が同じ誤りを持つと突き合わせだけでは通ってしまうため。

### モンテカルロ法の正解

`tests/render/skyMonteCarlo.ts` が、地表の上向きの面が受ける天空の照度を光線追跡で出す。余弦で重みを付けた向きに光線を飛ばし、散乱のたびに太陽への寄与を足し、次の向きを位相関数どおりに引く。

```
E / π = E[L]     余弦で重みを付けた向きの平均の放射輝度
寄与 += β × p(c) × T_sun        c = sun · d
β    *= σs / σt                  散乱のたびに
```

地球の丸み、散乱の全次数、地面の反射を近似せずに扱う。takram（Bruneton の次数の足し上げ）とも Hillaire（多重散乱の近似）とも違う、3 つ目の解き方になる。色ごとに 40 万本で、統計誤差は ±0.1〜0.3%。定数と媒質の式は `reference.ts` をそのまま読む。

途中で正解の側を 2 度誤った。1 度目は散乱角の向きを取り違え、Mie の前方の峰を後ろ向きに付けていた。2 度目は大気を平らな層とみなしていて、18.3 時の 1 回散乱を 8〜19% 誤った。

### 天空光の関門

| 時刻（太陽高度） | Hillaire / 正解（赤・緑・青） | takram / 正解 | 許容 |
|---|---|---|---|
| 8 時（32.1 度） | 1.012 0.995 0.980 | 1.24〜1.34 | 3% |
| 9 時（44.1 度） | 1.017 1.003 0.991 | 1.35〜1.45 | 3% |
| 12 時（68.2 度） | 1.028 1.017 1.010 | 1.50〜1.61 | 3% |
| 16 時（32.3 度） | 1.011 0.993 0.979 | 1.24〜1.34 | 3% |
| 17 時（20.1 度） | 1.003 0.985 0.967 | 1.12〜1.21 | 5% |
| 18.3 時（4.4 度） | 0.982 0.967 0.954 | 0.97〜1.04 | 5% |

関門は、太陽高度 25 度以上なら 3%、25 度未満なら 5%。25 度の境は結果を見たあとで引いた線である（ADR 0044）。Hillaire は低い太陽で青を約 4% 低く出す。多重散乱の LUT の歩数を 20 から 200 に、方向を 8 × 8 から 16 × 16 に増やしても残った。等方とみなす近似に固有のものと見ている（推測）。

takram の天空光は昼に正解の 1.24〜1.61 倍あった。原因は特定していない。物理の値を採ったのはユーザーの決定。

### 検査の一覧

| 検査 | 比べるもの | 許容 |
|---|---|---|
| `tests/render/skyTruth.test.ts` | 直達光を takram の 6 時刻の記録と | 3%（実測 0.2% 以内） |
| 同上 | 天空光を正解と（積分した値と、同梱の表を引いた値の両方） | 25 度以上 3%・未満 5% |
| 同上 | takram の天空光を正解の代わりに置くと落ちる（歯の確認） | 5% を超えること |
| 同上 | モンテカルロを 4000 本で回し直して記録と合う | 5 標準偏差の内 |
| `tests/render/skyIrradiance.test.ts` | 同梱の表の 10 画素を作り直して比べる | 相対 1e-5 |
| 同上 | 画素の間を引いた値と、その点で積分した値 | 1% |
| `tests/render/skyAerial.test.ts` | 遠くまで積分した霞と空の放射輝度（3 時刻 × 3 高度 × 18 方向） | 2.5% |
| 同上 | 地表の水平 1 km の透過率と `exp(-σt d)` | 1e-3 |
| `tests/render/solar.test.ts` | 太陽の向きを takram の 9 時刻の記録と | 0.02 度（実測 0.007 度） |
| node-path.spec（`?skyprobe=1`） | GPU の LUT と CPU 参照 | 各色の LUT の最大値に対して 2e-3 |
| 同上 | LUT を引いて半球で足した天空光 | 相対 1e-3 |

GPU と CPU の LUT の差の実測は次のとおり。WebGL2（`?gpu=1`）と WebGPU（`?gpu=2`）で同じ値だった。

| LUT | 差（各色の最大値に対して） |
|---|---|
| 透過率 | 3.7e-5 |
| 多重散乱 | 1.4e-3（赤） |
| 空の見え方 | 5.6〜6.0e-4 |
| 天空光（LUT を引いて半球で足した値） | 3.5e-4（相対） |
| 照度の表を GPU で引いた格子 16 × 6 点 | 2.1e-7 |
| 霞の入る光・透過率 | 6.7e-5・1.9e-5 |

LUT の許容は、最初は画素ごとの相対 1e-3 で合意していた。多重散乱は太陽が地平線のすぐ下の帯（値が 1e-7〜3.6e-4）で、画素ごとの相対が 7.6e-3 まで開いた。64 方向 × 20 歩を 32 ビットで足し上げる精度と見ている（推測）。そこで各色の最大値に対する差へ改めた（`skyProbe.ts:SKY_PROBE_LUT_TOLERANCE`）。

## 定数を変えるとき

`reference.ts` の定数を変えると、CPU 参照・TSL・同梱の表・モンテカルロの正解のすべてが動く。手順は次の順になる。

1. `reference.ts` の値を変える。TSL は同じ定数を import するので、写し直す所は無い
2. 同梱の表を書き直す（`WRITE_SKY_IRRADIANCE=1`）
3. `tests/render/skyTruth.test.ts` の正解を出し直す。正解は定数に依るので、記録の値は古くなる。種は `9001 + 色 × 7 + round(時 × 10)`
4. `npx vitest run tests/render` と node-path.spec を流す

web-ocean の値へ寄せる場合、上端 6460 km・g 0.84・地面 0.06・Mie の減衰 4.40e-3 の 4 つを替える。天空光は 2〜3% 動く（ADR 0044）。
