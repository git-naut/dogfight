# アセットの出典

このプロジェクトで使うアセットは CC0、パブリックドメイン、OFL、MIT、GPLv2+ のみ。取得したものは URL、作者、ライセンス、取得日をここに記録する。記録のないアセットはコミットしない。

GPLv2+ を許すのは、このリポジトリ自体を GPLv2+ にしたため（`LICENSE`）。GPL のアセットは改変前の原本を `assets/upstream/` にコミットする。GPLv2 が改変に適した形式の提供を求めるので、生成物だけでは足りない。

## 3D モデル

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| assets/upstream/f18/f18.ac | F/A-18C Hornet の機体 | Fabrice Kauffmann | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/) `trunk/Aircraft/f18/Models/f18.ac`（r3、取得時の HEAD は r21463） | 2026-08-18 |
| assets/upstream/f18/f18.xml | 同モデルの FlightGear 定義。舵面のヒンジ軸と舵角 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18.xml`（r3） | 2026-08-18 |
| assets/upstream/f16/f16.ac | F-16 の機体 | 下記 F-16 の作者一覧 | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f16/) `trunk/Aircraft/f16/Models/f16.ac`（r8373、取得時の HEAD は r21473） | 2026-08-23 |
| assets/upstream/f16/F-16.xml | 同モデルの FlightGear 定義。舵面のヒンジ軸 | 同上 | GPLv2+ | 同上 `Models/F-16.xml`（r8373） | 2026-08-23 |
| assets/upstream/f16/jsb-controls.xml | 同機の JSBSim 飛行制御。舵角の上限 | 同上 | GPLv2+ | 同上 `Systems/jsb-controls.xml`（r8373） | 2026-08-23 |
| assets/upstream/nimitz/nimitz.ac | 空母 USS Nimitz (CVN-68) | Vivian Meazza | GPLv2 | [FlightGear fgdata](https://sourceforge.net/p/flightgear/fgdata/ci/next/tree/Models/Geometry/Nimitz/) `Models/Geometry/Nimitz/nimitz.ac` | 2026-08-31 |
| assets/upstream/nimitz/nimitz.xml | 同モデルの FlightGear 定義。カタパルトと拘束索の割り当て | 同上 | GPLv2 | 同上 `nimitz.xml` | 2026-08-31 |
| assets/upstream/nimitz/*.png（10 枚） | 同モデルのテクスチャ | 大部分は Javier Fernandez（下記） | GPLv2 | 同上 | 2026-08-31 |

F/A-18C は 201 オブジェクト、18,634 三角形、12,260 頂点。F-16 は 125 オブジェクト、18,042 三角形、10,627 頂点。`tools/ac3d-to-glb.mjs` が `public/aircraft/` へ変換する。

F-16 の作者は `f16-block-50-set.xml` の `<author>` にある一覧。

Erik Hofman、Martin "Pegasus" Schmitt、Pensacola、Nikolai V. Chr.、J Maverick 16。
Richard Harrison、Josh Davidson、Martien Van Der P.、Jonathan Redpath、Gary Brown。
Justin Nicholson、Enrico Castaldi、Timi、Barszczisbad、PH-JAKE、Bat Campion、LJQCN101。

空母は 270 オブジェクト、2,806 三角形、2,593 頂点。船体（`Hull*`）の全長は 326.1 m。飛行甲板（`Deck-Underside`）は 332.8 m × 75.7 m あり、ニミッツ級の公表値 333 m とほぼ一致する。座標系は 艦首 −X、上 +Y、右舷 −Z。

取り込むのは 171 オブジェクト 2,644 三角形。乗員（`Crew-*` 61 個）、航跡（`Wake`）、軍艦旗（`Ensign`）、見張所（`Howdah`）は外す。これらだけが `rainbow_*.rgb` `crew_*.rgb` `wake.rgb` `flag.png` を使うので、テクスチャが 31 種から 10 種に減る。

`cat-1`〜`cat-4` と `wire-1`〜`wire-4` は三角形を持たない線分で、カタパルトと拘束索の位置を表す。`nimitz.xml` はこれらに `interaction-type` を割り当てるだけで、向きは持たない。`cat-1` は `(9.28, 20.00, -16.17)` から `(-105.41, 20.00, -8.16)` までの 115.0 m。艦首が −X なので、+X 側が射出の開始点になる。

**空母のライセンスの根拠は fgdata の `COPYING`**（GNU GPL v2 全文）。当該ディレクトリに COPYING と README は無い。作者は `nimitz.xml` の `<author>` から取った。同ファイルの冒頭にテクスチャの由来がある。

```
the Eisenhower model is based on the work by Javier Fernandez, which
he has kindly given FGFS permission to use. Very little of the original,
apart from most of the very excellent textures, remain.
```

**テクスチャの根拠はモデル本体より弱い。**原作者が与えたのは「FGFS が使う許可」であって、GPL を選んだとは書かれていない。fgdata が GPLv2 で配布している以上その条件で使うという筋で採った。この点は記録に残す。

`trunk/Aircraft/f18/` と `trunk/Aircraft/f16/` のどちらにも COPYING は置かれていない。GPLv2+ の根拠は FlightGear wiki の当該機のページが License 欄に GPLv2+ と明記していることと、FGAddon への収録条件が GPLv2+ であること。経緯は `docs/decisions/0005-aircraft.md`。

舵角の上限は F-16 だけ FDM から取った。`F-16.xml` の rotate は水平尾翼に factor 57.3 を持つ。正規化された −1..1 のプロパティに掛かるので、そのまま読むと ±57.3 度になり実機の可動域と合わない。`jsb-controls.xml` の `kinematic` の `clipto` が水平尾翼 ±25 度、ラダー ±30 度、フラッペロン −23..+20 度を持っている。`tests/tools/ac3d.test.ts` がこのファイルから読んだ値と突き合わせる。

## テクスチャ・HDRI

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| public/atmosphere/scattering.exr | 大気散乱 LUT | Takram Design Engineering | MIT | [@takram/three-atmosphere](https://github.com/takram-design-engineering/three-geospatial) | 2026-08-16 |
| public/atmosphere/transmittance.exr | 大気透過率 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |
| public/atmosphere/irradiance.exr | 天空放射照度 LUT | Takram Design Engineering | MIT | 同上 | 2026-08-16 |
| assets/upstream/f18/f18top.rgb | F/A-18C の胴体と主翼 | Fabrice Kauffmann | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/) `Models/f18top.rgb`（r997） | 2026-08-18 |
| assets/upstream/f18/f18tail.rgb | F/A-18C の尾部 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18tail.rgb`（r997） | 2026-08-18 |
| assets/upstream/f18/f18cockpit.rgb | F/A-18C の操縦席内装 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18cockpit.rgb`（r997） | 2026-08-18 |
| assets/upstream/f16/f16.png | F-16 の機体外板 | 下記 F-16 の作者一覧 | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f16/) `Models/f16.png`（r8373） | 2026-08-23 |
| assets/upstream/f16/f16trans.png | F-16 の塗装デカール（ロゴ・帯） | 同上 | GPLv2+ | 同上 `Models/f16trans.png`（r3973） | 2026-08-23 |
| assets/upstream/f16/nozzle-ring.png | F-16 の排気口リング | 同上 | GPLv2+ | 同上 `Models/nozzle-ring.png`（r8373） | 2026-08-23 |
| assets/upstream/f16/canopy2.png | F-16 のキャノピー内側 | 同上 | GPLv2+ | 同上 `Models/Effects/glass/canopy2.png`（r5407） | 2026-08-23 |

大気の 3 ファイルは Bruneton の Precomputed Atmospheric Scattering をパッケージ側で事前計算したもの。合計 4.12 MB。

機体のテクスチャは `tools/textures-to-webp.py` が WebP へ変換する。変換結果は `assets/generated/<id>/` にコミットしてある。Pillow は GitHub のランナーに入っていないので、ビルドの経路には入れない。

F/A-18C は SGI 形式の 512×512。F-16 は PNG で、`f16.png` が 2048×2048 の RGBA。品質 95 の WebP で 1,220 KB から 243 KB になる。可視画素（アルファが 0 でない画素）の sRGB 平均差は 0.54 階調、最大 42（実測）。アルファの差は最大 0 で、1 階調も動かない。**アルファが 0 の画素では RGB が大きく動くが、見えないので数えない。**分けずに測ると `f16trans.png` が平均 16 階調・最大 255 に見えて、劣化していると読み違える。4 枚の合計は 1,756 KB から 436 KB。

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
