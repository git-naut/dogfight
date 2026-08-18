# アセットの出典

このプロジェクトで使うアセットは CC0、パブリックドメイン、OFL、MIT、GPLv2+ のみ。取得したものは URL、作者、ライセンス、取得日をここに記録する。記録のないアセットはコミットしない。

GPLv2+ を許すのは、このリポジトリ自体を GPLv2+ にしたため（`LICENSE`）。GPL のアセットは改変前の原本を `assets/upstream/` にコミットする。GPLv2 が改変に適した形式の提供を求めるので、生成物だけでは足りない。

## 3D モデル

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| assets/upstream/f18/f18.ac | F/A-18C Hornet の機体 | Fabrice Kauffmann | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/) `trunk/Aircraft/f18/Models/f18.ac`（r3、取得時の HEAD は r21463） | 2026-08-18 |
| assets/upstream/f18/f18.xml | 同モデルの FlightGear 定義。舵面のヒンジ軸と舵角 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18.xml`（r3） | 2026-08-18 |

201 オブジェクト、18,634 三角形、12,260 頂点。`tools/ac3d-to-glb.mjs` が `public/aircraft/f18.glb` へ変換する。

`trunk/Aircraft/f18/` に COPYING は置かれていない。GPLv2+ の根拠は FlightGear wiki の当該機のページが License 欄に GPLv2+ と明記していることと、FGAddon への収録条件が GPLv2+ であること。経緯は `docs/decisions/0005-aircraft.md`。

## テクスチャ・HDRI

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| public/atmosphere/scattering.exr | 大気散乱 LUT | Takram Design Engineering | MIT | [@takram/three-atmosphere](https://github.com/takram-design-engineering/three-geospatial) | 2026-08-16 |
| public/atmosphere/transmittance.exr | 大気透過率 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |
| public/atmosphere/irradiance.exr | 天空放射照度 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |
| assets/upstream/f18/f18top.rgb | F/A-18C の胴体と主翼 | Fabrice Kauffmann | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/) `Models/f18top.rgb`（r997） | 2026-08-18 |
| assets/upstream/f18/f18tail.rgb | F/A-18C の尾部 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18tail.rgb`（r997） | 2026-08-18 |
| assets/upstream/f18/f18cockpit.rgb | F/A-18C の操縦席内装 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18cockpit.rgb`（r997） | 2026-08-18 |

大気の 3 ファイルは Bruneton の Precomputed Atmospheric Scattering をパッケージ側で事前計算したもの。合計 4.12 MB。機体のテクスチャは SGI 形式の 512×512 で、`tools/sgi-to-webp.py` が WebP へ変換する。変換結果は `assets/generated/f18/` にコミットしてある。Pillow は GitHub のランナーに入っていないので、ビルドの経路には入れない。

## 効果音

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| （未取得） | | | | | |

## 調達先の候補

機体モデルは [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/) を主軸にする。収録条件が GPLv2+ で統一されており、認証なしで取得でき、操縦面が名前つきで分離されている。

[NASA 3D Resources](https://science.nasa.gov/3d-resources/) は 2026-08-18 に調べたが、航空機は X-57 Maxwell と Global Hawk の 2 機だけで戦闘機がない。X-57 は 1,369,522 三角形・マテリアル 0・テクスチャ 0 の CAD 由来メッシュ、Global Hawk は 37,120 三角形の高高度 UAV。使うなら米国政府著作物として扱えるが、インシグニアとロゴはパブリックドメインの対象外なのでマーキングを除去してから取り込む。NASA による推奨を示唆する表現は避ける。

Sketchfab は CC0 に戦闘機が 1 機もなく（在庫は美術館スキャン）、CC-BY には豊富にあるが、ダウンロードに OAuth トークンが要るため自動取得できない。操縦面も分離されていないのが普通。

補助オブジェクトは [Kenney](https://kenney.nl/) と [Quaternius](https://quaternius.com/)。どちらも CC0 で glTF を配布している。テクスチャアトラスを共有しているためドローコールを抑えやすい。

HDRI とテクスチャは [Poly Haven](https://polyhaven.com/) と [AmbientCG](https://ambientcg.com/)。効果音は [Freesound](https://freesound.org/) の CC0 フィルタと [OpenGameArt](https://opengameart.org/)。フォントは Google Fonts の OFL。
