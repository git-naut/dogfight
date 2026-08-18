# F/A-18C Hornet（FlightGear 由来の原本）

このディレクトリは改変前の原本を置いてある。`tools/ac3d-to-glb.mjs` と `tools/sgi-to-webp.py` がここから `public/aircraft/` を生成する。

原本を残す理由は 2 つある。ビルド時にネットワークを叩かないため。そして GPLv2 が改変に適した形式の提供を求めるからである。生成物の glb と WebP は改変に適した形式とは言えない。

## 出典

| 項目 | 内容 |
|---|---|
| プロジェクト | FlightGear FGAddon |
| パス | `trunk/Aircraft/f18/` |
| 取得元 | https://sourceforge.net/p/flightgear/fgaddon/HEAD/tree/trunk/Aircraft/f18/ |
| 取得時の HEAD | r21463 |
| 取得日 | 2026-08-18 |
| 作者 | Fabrice Kauffmann |
| ライセンス | GNU General Public License version 2 またはそれ以降 |

ファイルごとのリビジョン。`f18.ac` と `f18.xml` は r3（2014-09-09、f-jjth）、テクスチャ 3 枚は r997（2015-10-06、edauvergne）。

## ライセンスの根拠

`trunk/Aircraft/f18/` に COPYING は置かれていない。GPLv2+ の根拠は 2 つ。FlightGear wiki の当該機のページが License 欄に GPLv2+ と明記していること。そして FGAddon への収録条件が GPLv2+ であること。

このリポジトリ全体を GPLv2+ にしてあるのは、この原本と生成物を配布するため。詳細は `docs/decisions/0005-aircraft.md`。

## ファイル

| ファイル | 内容 |
|---|---|
| `f18.ac` | AC3D 形式の機体。201 オブジェクト、18,634 三角形、12,260 頂点 |
| `f18.xml` | FlightGear のモデル定義。舵面のヒンジ軸と舵角がここに入っている |
| `f18top.rgb` | 胴体と主翼の拡散テクスチャ。SGI 形式 512×512 RGB |
| `f18tail.rgb` | 尾部の拡散テクスチャ。SGI 形式 512×512 RGBA |
| `f18cockpit.rgb` | 操縦席内装の拡散テクスチャ。SGI 形式 512×512 RGB |

`f18.ac` の座標系は 機首 −X、上 +Y、左 +Z。`f18.xml` の座標系は 後方 +X、右 +Y、上 +Z で、`.ac` とは別物。突き合わせの詳細は `docs/aircraft.md`。
