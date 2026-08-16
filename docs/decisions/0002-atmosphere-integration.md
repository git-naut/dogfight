# 0002 大気散乱の統合

2026-08-16 決定。Phase 2。

## 決めたこと

`@takram/three-atmosphere` を vanilla API で使い、pmndrs `postprocessing` の `EffectComposer` に載せる。局所座標と ECEF の橋渡しは `worldToECEFMatrix` で行う。散乱 LUT は実行時に計算せず、パッケージ同梱の EXR を自前で配信して読み込む。

## 座標系の橋渡し

このライブラリは参照フレームが ECEF に固定されていて変更できない。地球中心を原点とするメートル座標で、こちらの「地表を原点とする Y-up」とは噛み合わない。

`worldToECEFMatrix` がこのためにある。基準地点を北緯 35.6 度・東経 139.7 度・標高 0 に置き、そこを原点とする局所フレームを組んで各コンポーネントへ渡す。局所座標が原点近傍に留まるので、ECEF の 6,400 km を float32 で扱うときの精度崩れも起きない。

ドキュメントが薦める `getNorthUpEastFrame` は X が北、Z が東になる。これだと機首方向の -Z が西を向き、午後の太陽に正対して機体が逆光で潰れる。基底を組み直して X を南、Y を上、Z を西とした。機首の -Z が東を向くので、午後の光が背後から当たる。

軸の割り当てを間違えると太陽が真下から照らすような絵になる。しかも目では気づきにくい。`tests/render/atmosphere.test.ts` で正規直交性、右手系（行列式が +1）、各軸の方位、高度の対応を数値で押さえている。

## 散乱 LUT はファイルから読む

Bruneton の手法は散乱を 3D テクスチャに事前計算する。`PrecomputedTexturesGenerator` が実行時に GPU で作れるが、この方式は採らなかった。

理由は CI にある。スクリーンショット回帰は SwiftShader のソフトウェアレンダラで走る。3D 浮動小数点テクスチャへの描画が通るか読めず、通らなければ回帰テストが丸ごと成立しなくなる。

パッケージは計算済みの EXR を同梱している。`tools/copy-atmosphere-assets.mjs` で `public/atmosphere/` へ複製し、`PrecomputedTexturesLoader` で読む。`combinedScattering` を有効にすると単一ミー散乱は散乱テクスチャに畳まれる。必要なのは3ファイルで 4.12 MB。高次散乱を足すと 3.58 MB 増えるが、薄暮の精度が上がるだけなので既定では切ってある。

実測では SwiftShader でも問題なく読めた。読み込みから最初の描画まで 1.3 秒。`setType(renderer)` が `OES_texture_float_linear` の有無を見て Float と HalfFloat を切り替える。対応の弱い環境でも落ちない。

## ライティングの分担

`AerialPerspectiveEffect` はポストプロセス側でライティングもできるが、Lambertian BRDF にしか対応していない。使うと機体の金属感が失われる。

既定で `sunLight: false`、`skyLight: false` になっているのでそのまま使い、透過と in-scatter だけを担当させる。機体と地面のライティングは `SunDirectionalLight` と `SkyLightProbe` による前方ライティングで行う。この2つは three のライトのサブクラスで、強度が大気の LUT から決まるため、空と光の色が一貫する。

## 露出

ここが実装中に最も時間を使った。

初回の描画は真昼でも薄暗く、太陽高度 68 度でも空の輝度が 255 中 62 にしかならなかった。原因はライブラリの正規化にある。ソースにこう書いてある。

> Luminance values are too large for storing in half precision buffer. We divide them by the luminance of the sun with the unit radiance.

半精度バッファに収めるため、輝度を「単位放射輝度の太陽の輝度」で割った相対値として返している。空はその何桁も下になるので、掛け直さないと表示域に届かない。

`postprocessing` のトーンマッピングは three の `tonemapping_pars_fragment` を取り込む。`toneMappingExposure` uniform をレンダラから受け取る形になっている。`renderer.toneMapping` が `NoToneMapping` でも `renderer.toneMappingExposure` は伝わるので、そこで調整する。

1 から 40 まで振って実測した。AgX は上側のロールオフが強く、40 でも白飛びは 0%。数値だけでは決められないので絵で比べ、空に深みが残り地面の緑も飛ばない 6 を採った。

## 地面のアルベド

Phase 1 ではグリッド線を読みやすくするため地面を 0x1e2c22 まで暗くしていた。リニアでは 0.02 で舗装並みの暗さになる。大気を入れると 3 km 先の霞に埋もれ、近距離まで一様な青灰色になった。

植生として妥当な 0x4a5f3e へ上げ、グリッド線の側を暗色に変えて対比を取った。これで近距離に緑が残り、距離とともに霞へ抜ける空気遠近が出る。

## 地面の広さ

平面を伸ばしすぎると地球の丸みから外れる。150 km 先では 1.8 km ずれて地平線の位置が合わなくなる。60 km 四方で切り、その先は `SkyMaterial` の `ground` が描く楕円体地面に任せる。境目が見えないよう `groundAlbedo` をこちらの地面色と揃えてある。

## 決定論

太陽方向は実時間の `Date` から計算される。そのままではスクリーンショット回帰が成立しない。基準日時を定数に固定し、時刻はそこからの時間差で表す。`?hour=` で上書きできる。

`SMAA` は時間方向の蓄積を持たないので決定論を壊さない。`TAA` は Halton ジッタの蓄積が入るため Phase 2 では採らなかった。品質の自動降格も実時間に依存するので、キャプチャモードでは動かさない。

## React の peer 依存

`@takram/three-atmosphere` は peer に React 19 と R3F 一式を並べている。npm が自動導入するので `node_modules` には `react` と `@react-three/fiber` が入る。

ただしエクスポートが `.`（vanilla）と `./r3f` に分かれていて、こちらは `.` しか import していない。ビルド成果物を grep して React が含まれないことを実測で確認し、`tests/e2e/smoke.spec.ts` の検査に組み込んだ。import 経路が変わって混入したらテストが落ちる。

## 変更後の規模

バンドルは 536 KB から 908 KB（gzip 276 KB）。配信物は LUT の 4.12 MB を加えて約 5 MB。Phase 1 時点の 3.3 MB から増えたが、目標の 200 MB に対しては余裕がある。

## 参照

- [@takram/three-atmosphere README](https://github.com/takram-design-engineering/three-geospatial/blob/main/packages/atmosphere/README.md)
- [Precomputed Atmospheric Scattering（Bruneton）](https://ebruneton.github.io/precomputed_atmospheric_scattering/)
