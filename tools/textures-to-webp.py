#!/usr/bin/env python3
"""機体のテクスチャを WebP へ変換する。

FlightGear のテクスチャは機体によって形式が違う。F/A-18C は SGI（.rgb）で
ブラウザが読めない。F-16 は PNG なので読めるが、2048² の RGBA が 1.2 MB あり、
そのまま配ると重い。どちらも WebP へ落とす。

出力はコミットする。このスクリプトはビルドの経路に入れない。GitHub の
ランナーに Pillow が入っておらず、`npm run assets` から呼んだら CI が
ModuleNotFoundError で落ちた。node は必ずあるが Python の追加パッケージは
そうではない。原本を変えたときだけ手で走らせて、結果をコミットする。

実行は `python3 tools/textures-to-webp.py [機体 id ...]`。
"""

import sys
from pathlib import Path

import numpy as np
from PIL import Image

ROOT = Path(__file__).resolve().parent.parent

# 品質 95。可視画素（アルファ > 0）の sRGB 平均差を実測して決めた。
#
#   f16.png (2048², RGBA)      1220 KB -> 243 KB  平均 0.54 階調 最大 42
#   f16trans.png (512², RGBA)    36 KB ->  18 KB  平均 0.63 階調 最大 174
#   canopy2.png (512², RGBA)    500 KB -> 175 KB  平均 1.72 階調 最大 21
#
# アルファは 3 枚とも最大差 0 で完全に保たれる。**完全透明の画素では RGB が
# 大きく動くが、見えないので数えない。**分けずに測ると f16trans が平均 16 階調
# ・最大 255 に見えて、劣化していると読み違える。
QUALITY = 95

CRAFT = {
    "f18": ["f18top.rgb", "f18tail.rgb", "f18cockpit.rgb"],
    "f16": ["f16.png", "f16trans.png", "canopy2.png", "nozzle-ring.png"],
    # F/A-18E は原本が glTF で、テクスチャが textures/ の下に 12 枚ある。
    # 名前は Sketchfab の変換が付けた Material.NNN_baseColor.png
    "f18e": [f"textures/{name}" for name in (
        "Material_baseColor.png",
        "Material.001_baseColor.png",
        "Material.002_baseColor.png",
        "Material.004_baseColor.png",
        "Material.005_baseColor.png",
        "Material.006_baseColor.png",
        "Material.007_baseColor.png",
        "Material.008_baseColor.png",
        "Material.009_baseColor.png",
        "Material.010_baseColor.png",
        "Material.011_baseColor.png",
        "Material.012_baseColor.png",
    )],
}

# 空母 Gerald R. Ford（Phase 9 の段 2）。原本は glTF で、10 材質ぶんの色・金属と粗さ・法線の 30 枚。
#
# **原寸では重すぎる。**ship_rest の 3 枚が 4096²、ほかの大半が 2048² で、原寸のまま積むと
# GPU のメモリが数百 MB になる（4096² の RGBA はミップ込みで 1 枚約 85 MB）。甲板の標識が
# 描かれた色の 3 枚（ship・ship_rest・deck_side_walks）は 2048 まで、ほかは 1024 まで落とす。
# **初めの値。**段 4 で実機の GPU で重さと見た目を測って決め直す
FORD_DECK_COLORS = {"ship_baseColor", "ship_rest_baseColor", "deck_side_walks_baseColor"}
FORD_MATERIALS = (
    "boats", "controller", "deck_side_walks", "guns", "lambert1",
    "radars", "ship", "ship_bridge1", "ship_interiors", "ship_rest",
)
CRAFT["ford"] = []
for material in FORD_MATERIALS:
    for kind, ext in (("baseColor", "jpeg"), ("metallicRoughness", "png"), ("normal", "png")):
        CRAFT["ford"].append(f"textures/{material}_{kind}.{ext}")

# 長い辺の上限 画素。載っていないものは原寸
MAX_SIZE = {
    "ford": {
        name: (2048 if Path(name).stem in FORD_DECK_COLORS else 1024)
        for name in CRAFT["ford"]
    },
}


def convert(craft: str, name: str) -> None:
    source = ROOT / "assets" / "upstream" / craft / name
    out_dir = ROOT / "assets" / "generated" / craft
    target = out_dir / (source.stem + ".webp")
    limit = MAX_SIZE.get(craft, {}).get(name)

    with Image.open(source) as image:
        mode = image.mode
        # アルファを落とすと尾部やロゴの抜きが埋まる
        has_alpha = "A" in image.convert("RGBA").getbands() and mode in (
            "RGBA",
            "LA",
            "P",
        )
        converted = image.convert("RGBA" if has_alpha else "RGB")
        if limit is not None and max(converted.size) > limit:
            # 縮めるときは LANCZOS。法線の縮小も同じ（向きの平均がわずかに短くなるが、
            # シェーダが正規化し直すので見えない）
            scale = limit / max(converted.size)
            converted = converted.resize(
                (round(converted.size[0] * scale), round(converted.size[1] * scale)),
                Image.Resampling.LANCZOS,
            )
        converted.save(target, format="WEBP", quality=QUALITY, method=6)

    # 劣化を数える。可視画素だけを見る。縮めたものは、原本を同じ大きさに縮めてから比べる
    with Image.open(source) as image, Image.open(target) as saved:
        reference = image.convert("RGBA")
        if reference.size != saved.size:
            reference = reference.resize(saved.size, Image.Resampling.LANCZOS)
        ref = np.asarray(reference, dtype=np.int16)
        got = np.asarray(saved.convert("RGBA"), dtype=np.int16)
        visible = ref[..., 3] > 0
        rgb = np.abs(got[..., :3] - ref[..., :3])[visible]
        alpha = np.abs(got[..., 3] - ref[..., 3])

    before = source.stat().st_size
    after = target.stat().st_size
    print(
        f"  {name} ({mode}, {converted.size[0]}x{converted.size[1]}) -> "
        f"{target.name}  {before // 1024} KB -> {after // 1024} KB  "
        f"可視部 RGB 平均 {rgb.mean():.2f} 最大 {rgb.max()} / "
        f"アルファ 最大 {alpha.max()}"
    )


def main() -> None:
    ids = sys.argv[1:] or list(CRAFT)
    for craft in ids:
        if craft not in CRAFT:
            raise SystemExit(f"未知の機体 {craft}。知っているのは {', '.join(CRAFT)}")
        print(f"{craft} のテクスチャを WebP へ変換")
        (ROOT / "assets" / "generated" / craft).mkdir(parents=True, exist_ok=True)
        for name in CRAFT[craft]:
            convert(craft, name)


if __name__ == "__main__":
    main()
