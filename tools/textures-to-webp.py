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
}


def convert(craft: str, name: str) -> None:
    source = ROOT / "assets" / "upstream" / craft / name
    out_dir = ROOT / "assets" / "generated" / craft
    target = out_dir / (source.stem + ".webp")

    with Image.open(source) as image:
        mode = image.mode
        # アルファを落とすと尾部やロゴの抜きが埋まる
        has_alpha = "A" in image.convert("RGBA").getbands() and mode in (
            "RGBA",
            "LA",
            "P",
        )
        converted = image.convert("RGBA" if has_alpha else "RGB")
        converted.save(target, format="WEBP", quality=QUALITY, method=6)

    # 劣化を数える。可視画素だけを見る
    with Image.open(source) as image, Image.open(target) as saved:
        ref = np.asarray(image.convert("RGBA"), dtype=np.int16)
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
