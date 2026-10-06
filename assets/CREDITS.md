# アセットの出典

このプロジェクトで使うアセットは CC0、パブリックドメイン、OFL、MIT、GPLv2+、CC BY 4.0 のみ。取得したものは URL、作者、ライセンス、取得日をここに記録する。記録のないアセットはコミットしない。

**CC BY 4.0 を足した（2026-09-18）。**F/A-18E のモデルを入れるため。CC BY 4.0 は GPLv3 と一方向互換で、このリポジトリは GPLv2+（v2 or later）なので取り込める。表示義務はこの表への記載で果たす。

**CC BY-NC は入れない。**NC は商用利用を禁じるが、GPL は受け取った誰もが商用利用できることを保証する。同梱すると矛盾する。**自分が商用利用するかどうかとは別の問題で、公開した時点で第三者に GPL の権利を渡すため。**2026-09-18 に F/A-18E の候補を 6 件測り、2 件（`bohmerang` と `42manako`）をこの理由で落とした。

GPLv2+ を許すのは、このリポジトリ自体を GPLv2+ にしたため（`LICENSE`）。GPL のアセットは改変前の原本を `assets/upstream/` にコミットする。GPLv2 が改変に適した形式の提供を求めるので、生成物だけでは足りない。

## 3D モデル

| ファイル | 名称 | 作者 | ライセンス | 取得元 | 取得日 |
|---|---|---|---|---|---|
| assets/upstream/f18/f18.ac | F/A-18C Hornet の機体 | Fabrice Kauffmann | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/) `trunk/Aircraft/f18/Models/f18.ac`（r3、取得時の HEAD は r21463） | 2026-08-18 |
| assets/upstream/f18/f18.xml | 同モデルの FlightGear 定義。舵面のヒンジ軸と舵角 | Fabrice Kauffmann | GPLv2+ | 同上 `Models/f18.xml`（r3） | 2026-08-18 |
| assets/upstream/f16/f16.ac | F-16 の機体 | 下記 F-16 の作者一覧 | GPLv2+ | [FlightGear FGAddon](https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f16/) `trunk/Aircraft/f16/Models/f16.ac`（r8373、取得時の HEAD は r21473） | 2026-08-23 |
| assets/upstream/f16/F-16.xml | 同モデルの FlightGear 定義。舵面のヒンジ軸 | 同上 | GPLv2+ | 同上 `Models/F-16.xml`（r8373） | 2026-08-23 |
| assets/upstream/f16/jsb-controls.xml | 同機の JSBSim 飛行制御。舵角の上限 | 同上 | GPLv2+ | 同上 `Systems/jsb-controls.xml`（r8373） | 2026-08-23 |
| assets/upstream/f18e/scene.gltf ほか | Boeing F/A-18E "Super Hornet" | KOG_THORNS | **CC BY 4.0** | [Sketchfab](https://sketchfab.com/3d-models/boeing-fa-18e-super-hornet-9e852037bf2141dcb3fda17013958131) | 2026-09-18 |
| assets/upstream/ford/scene.gltf ほか | 空母 Gerald R Ford aircraft Carrier（CVN-78） | waelXcm | **CC BY 4.0** | [Sketchfab](https://sketchfab.com/3d-models/gerald-r-ford-aircraft-carrier-562bf516e1494df38d8f222504dc798b) | 2026-10-05 |

F/A-18C は 201 オブジェクト、18,634 三角形、12,260 頂点。F-16 は 125 オブジェクト、18,042 三角形、10,627 頂点。`tools/ac3d-to-glb.mjs` が `public/aircraft/` へ変換する。

F/A-18E は 220 部品、77,840 三角形。全長 18.31 m / 翼幅 13.19 m / 全高 4.91 m（公称 18.31 / 13.62 / 4.88 と 3.2% 以内で一致）。

**舵面がほとんど名前で分かれていない。**`tools/f18e-parts.mjs` が位置と寸法で同定し、`tests/tools/f18eParts.test.ts` が結果を固定する。名前が残っているのは左のエルロン `La1` だけ。左右の割り当てはこれと `Lw1` / `Rw1` から決めた。

## 諸元の出典

公表値の取得元は英語版 Wikipedia の [Boeing F/A-18E/F Super Hornet](https://en.wikipedia.org/wiki/Boeing_F/A-18E/F_Super_Hornet) の諸元表（2026-09-18 取得）。読み手はモデルの検査（`tools/f18e-parts.mjs` の `SPEC`）と飛行モデル（`src/sim/flightModel.ts`）。同表が挙げる一次資料は次の 4 つ。

| 資料 | 発行 |
|---|---|
| U.S. Navy fact file | 米海軍 |
| NATOPS Flight Manual, Navy Model F/A-18E/F, 165533 and up | Naval Air Systems Command |
| Standard Aircraft Characteristics F/A-18E Super Hornet (SAC) | Naval Air Systems Command、2001-03 |
| Selected Acquisition Report FY 2012 | Defense Acquisition Management Information Retrieval |

**NAVAIR の製品ページは 403 で取れない。**Wikipedia の表を経由したのはそのため。

値そのものは 2 つの導出量で裏が取れている。翼面荷重 459 kg/m² と推力重量比 0.936（44,000 lbf ÷ 47,000 lb）はどちらも諸元表に載る量。質量・翼面積・推力から独立に再現できることを `tests/sim/flightModel.test.ts` が見ている。

CC BY 4.0 の表示。原文のまま載せる（`assets/upstream/f18e/license.txt` の指定）。

```
This work is based on "Boeing F/A-18E "Super Hornet""
(https://sketchfab.com/3d-models/boeing-fa-18e-super-hornet-9e852037bf2141dcb3fda17013958131)
by KOG_THORNS (https://sketchfab.com/ioai25312)
licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
```

空母 Ford は 158 部品、116,316 三角形、材質 11、テクスチャ 30 枚。ユーザーが Sketchfab からダウンロードした zip を、展開して `assets/upstream/ford/` に置いた。zip の sha256 は `855403a307b1ab29dafdc03b1f4c86ad03f511ef97e8b08c8271f9f744b06855`。テクスチャは `tools/textures-to-webp.py ford` で WebP に落とし、`assets/generated/ford/` にコミットした。色の 3 枚は 2048、ほかは 1024 まで縮めてある。`tools/ford-to-glb.mjs` が `public/aircraft/ford.glb` へ変換する。全長 337 m に合わせて 27.876 倍、甲板は水面から 18.87 m（`tools/ford-parts.mjs`）。

CC BY 4.0 の表示。原文のまま載せる（`assets/upstream/ford/license.txt` の指定）。

```
This work is based on "Gerald R Ford aircraft Carrier"
(https://sketchfab.com/3d-models/gerald-r-ford-aircraft-carrier-562bf516e1494df38d8f222504dc798b)
by waelXcm (https://sketchfab.com/waelXcm)
licensed under CC-BY-4.0 (http://creativecommons.org/licenses/by/4.0/)
```

F-16 の作者は `f16-block-50-set.xml` の `<author>` にある一覧。

Erik Hofman、Martin "Pegasus" Schmitt、Pensacola、Nikolai V. Chr.、J Maverick 16。
Richard Harrison、Josh Davidson、Martien Van Der P.、Jonathan Redpath、Gary Brown。
Justin Nicholson、Enrico Castaldi、Timi、Barszczisbad、PH-JAKE、Bat Campion、LJQCN101。

空母は Phase 9 の段 4（2026-10-06）で Gerald R. Ford に替えた。それまでの FlightGear fgdata の USS Nimitz（Vivian Meazza、GPLv2）は、原本ごと外した。Nimitz の出典とライセンスの根拠は、git の履歴（`bf5435f` までのこのファイル）と `docs/decisions/0009-mission.md` に残る。

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
