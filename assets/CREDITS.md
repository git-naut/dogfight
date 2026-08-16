# アセットの出典

このプロジェクトで使うアセットは CC0、パブリックドメイン、OFL、MIT のみ。取得したものは URL、作者、ライセンス、取得日をここに記録する。記録のないアセットはコミットしない。

外部からダウンロードしたアセットはまだない。いま配信しているのは npm パッケージ同梱の大気の事前計算テクスチャのみ。`tools/copy-atmosphere-assets.mjs` が `node_modules` から `public/atmosphere/` へ複製する。リポジトリには含めず、ビルド時に再生成する。

## 3D モデル

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| （未取得） | | | | | |

## テクスチャ・HDRI

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| public/atmosphere/scattering.exr | 大気散乱 LUT | Takram Design Engineering | MIT | [@takram/three-atmosphere](https://github.com/takram-design-engineering/three-geospatial) | 2026-08-16 |
| public/atmosphere/transmittance.exr | 大気透過率 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |
| public/atmosphere/irradiance.exr | 天空放射照度 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |

これら3ファイルは Bruneton の Precomputed Atmospheric Scattering をパッケージ側で事前計算したもの。合計 4.12 MB。

## 効果音

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| （未取得） | | | | | |

## 調達先の候補

機体モデルは [NASA 3D Resources](https://science.nasa.gov/3d-resources/) を主軸にする。米国政府著作物として使えるが、NASA のインシグニアとロゴはパブリックドメインの対象外。テクスチャからマーキングを除去してから取り込む。出典として NASA を明記する。NASA による推奨を示唆する表現は避ける。

補助オブジェクトは [Kenney](https://kenney.nl/) と [Quaternius](https://quaternius.com/)。どちらも CC0 で glTF を配布している。テクスチャアトラスを共有しているためドローコールを抑えやすい。

HDRI とテクスチャは [Poly Haven](https://polyhaven.com/) と [AmbientCG](https://ambientcg.com/)。効果音は [Freesound](https://freesound.org/) の CC0 フィルタと [OpenGameArt](https://opengameart.org/)。フォントは Google Fonts の OFL。
