#!/usr/bin/env python3
"""SGI（.rgb）のテクスチャを WebP へ変換する。

FlightGear のテクスチャは SGI 形式で、ブラウザは読めない。Pillow が読めるので
WebP へ落とす。PNG より小さく、Chrome と Firefox と Safari のいずれも読める。

実行は `python3 tools/sgi-to-webp.py`。`npm run assets` から呼ばれる。
"""

from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parent.parent
SOURCE_DIR = ROOT / "assets" / "upstream" / "f18"
OUT_DIR = ROOT / "public" / "aircraft"

# 品質 90 は 512² の手描きテクスチャでは目視で劣化が分からない水準。
# 数値で確かめたいときは品質を振って sRGB の平均差を測る
QUALITY = 90

FILES = ["f18top.rgb", "f18tail.rgb", "f18cockpit.rgb"]


def convert(name: str) -> None:
    source = SOURCE_DIR / name
    target = OUT_DIR / (source.stem + ".webp")

    with Image.open(source) as image:
        mode = image.mode
        # SGI の RGBA はアルファを持つ。落とすと尾部の抜きが埋まる
        converted = image.convert("RGBA" if mode in ("RGBA", "LA") else "RGB")
        converted.save(target, format="WEBP", quality=QUALITY, method=6)

    before = source.stat().st_size
    after = target.stat().st_size
    print(
        f"  {name} ({mode}, {converted.size[0]}x{converted.size[1]}) -> "
        f"{target.name}  {before // 1024} KB -> {after // 1024} KB"
    )


def main() -> None:
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    print("SGI を WebP へ変換")
    for name in FILES:
        convert(name)


if __name__ == "__main__":
    main()
