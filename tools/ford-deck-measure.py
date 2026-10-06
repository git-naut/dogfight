#!/usr/bin/env python3
"""空母 Ford の甲板の標識を測り、`assets/generated/ford/deck.json` に出す（Phase 9 の段 3）。

カタパルトの帯・着艦区域の中心線・拘束索の印は、モデルの形ではなく色のテクスチャに描かれて
いる。甲板の 2 部品（`ship_deck_ship_0` と `ship_deck_deck side walks_0`）を、UV でテクスチャを
引きながら真上から 0.25 m 四方で描き、色で拾って直線を当てはめる。座標は段 2 の変換
（`tools/ford-parts.mjs`）を掛けたあとの m。

出力はコミットする。Pillow・numpy・scipy・OpenCV が要るので、ビルドの経路には入れない
（`tools/textures-to-webp.py` と同じ作法）。原本を変えたときだけ手で走らせる。

実行は `python3 tools/ford-deck-measure.py [図の出力先.png]`。図を出すと目で確かめられる。
"""

import json
import struct
import sys
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from scipy import ndimage

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "assets" / "upstream" / "ford"
OUT = ROOT / "assets" / "generated" / "ford" / "deck.json"

# tools/ford-parts.mjs と同じ値（丸めない測った値）。片方だけ直すと座標がずれる。
# tests/tools/fordDeck.test.ts が、この出力と ford-parts.mjs の甲板の高さを突き合わせる
Z_MIN, Z_MAX = -6.089748488153591, 5.999574618135766
DECK_X_MIN, DECK_X_MAX = -1.5452477804329916, 1.4599215436996449
KEEL, DECK_Z_MAX = 0.1065932532212894, 5.954013828365754
SCALE = 337 / (Z_MAX - Z_MIN)
OX, OY, OZ = (DECK_X_MIN + DECK_X_MAX) / 2, KEEL + 12 / SCALE, (Z_MIN + DECK_Z_MAX) / 2

RES = 0.25
X0, X1, Z0, Z1 = -50.0, 50.0, -175.0, 175.0


def to_world(p):
    return np.stack([-(p[:, 0] - OX) * SCALE, (p[:, 1] - OY) * SCALE, -(p[:, 2] - OZ) * SCALE], 1)


def node_matrix(n):
    if "matrix" in n:
        return np.array(n["matrix"]).reshape(4, 4).T
    t = n.get("translation", [0, 0, 0])
    x, y, z, w = n.get("rotation", [0, 0, 0, 1])
    s = n.get("scale", [1, 1, 1])
    r = np.array([
        [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
        [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
        [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)],
    ]) * np.array(s)
    m = np.eye(4)
    m[:3, :3] = r
    m[:3, 3] = t
    return m


def render_top():
    """甲板を真上から描く。戻り値は色（H×W×3）と高さ（H×W、描かれていない所は −1e9）"""
    gltf = json.loads((SRC / "scene.gltf").read_text())
    buf = (SRC / "scene.bin").read_bytes()
    parent = {c: i for i, n in enumerate(gltf["nodes"]) for c in n.get("children", [])}

    def world(i):
        m = node_matrix(gltf["nodes"][i])
        while i in parent:
            i = parent[i]
            m = node_matrix(gltf["nodes"][i]) @ m
        return m

    kinds = {5126: ("f", 4), 5125: ("I", 4), 5123: ("H", 2)}

    def accessor(i):
        a = gltf["accessors"][i]
        view = gltf["bufferViews"][a["bufferView"]]
        fmt, size = kinds[a["componentType"]]
        n = {"SCALAR": 1, "VEC2": 2, "VEC3": 3, "VEC4": 4}[a["type"]]
        stride = view.get("byteStride", size * n)
        offset = view.get("byteOffset", 0) + a.get("byteOffset", 0)
        out = np.empty((a["count"], n))
        for k in range(a["count"]):
            out[k] = struct.unpack_from("<" + fmt * n, buf, offset + k * stride)
        return out

    w, h = int((X1 - X0) / RES), int((Z1 - Z0) / RES)
    color = np.zeros((h, w, 3), np.uint8)
    height = np.full((h, w), -1e9)
    deck_nodes = [i for i, n in enumerate(gltf["nodes"]) if n.get("name", "").startswith("ship_deck") and "mesh" in n]
    for ni in deck_nodes:
        node = gltf["nodes"][ni]
        prim = gltf["meshes"][node["mesh"]]["primitives"][0]
        p = accessor(prim["attributes"]["POSITION"])
        p = to_world((world(ni) @ np.c_[p, np.ones(len(p))].T).T[:, :3])
        uv = accessor(prim["attributes"]["TEXCOORD_0"])
        tri = accessor(prim["indices"]).astype(int).reshape(-1, 3)
        material = gltf["materials"][prim["material"]]
        tex_index = material["pbrMetallicRoughness"]["baseColorTexture"]["index"]
        image = gltf["images"][gltf["textures"][tex_index]["source"]]["uri"]
        tex = np.asarray(Image.open(SRC / image).convert("RGB"))
        th, tw = tex.shape[:2]
        for a, b, c in tri:
            q, t = p[[a, b, c]], uv[[a, b, c]]
            px, pz = (q[:, 0] - X0) / RES, (q[:, 2] - Z0) / RES
            x0, x1 = int(max(0, np.floor(px.min()))), int(min(w - 1, np.ceil(px.max())))
            z0, z1 = int(max(0, np.floor(pz.min()))), int(min(h - 1, np.ceil(pz.max())))
            if x0 > x1 or z0 > z1:
                continue
            xs, zs = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(z0, z1 + 1) + 0.5)
            d = (pz[1] - pz[2]) * (px[0] - px[2]) + (px[2] - px[1]) * (pz[0] - pz[2])
            if abs(d) < 1e-12:
                continue
            l0 = ((pz[1] - pz[2]) * (xs - px[2]) + (px[2] - px[1]) * (zs - pz[2])) / d
            l1 = ((pz[2] - pz[0]) * (xs - px[2]) + (px[0] - px[2]) * (zs - pz[2])) / d
            l2 = 1 - l0 - l1
            inside = (l0 >= 0) & (l1 >= 0) & (l2 >= 0)
            if not inside.any():
                continue
            y = l0 * q[0, 1] + l1 * q[1, 1] + l2 * q[2, 1]
            u = (l0 * t[0, 0] + l1 * t[1, 0] + l2 * t[2, 0]) % 1
            v = (l0 * t[0, 1] + l1 * t[1, 1] + l2 * t[2, 1]) % 1
            iz, ix = np.nonzero(inside)
            gz, gx = iz + z0, ix + x0
            yy = y[inside]
            better = yy > height[gz, gx]
            gz, gx = gz[better], gx[better]
            height[gz, gx] = yy[better]
            color[gz, gx] = tex[(v[inside][better] * (th - 1)).astype(int), (u[inside][better] * (tw - 1)).astype(int)]
    return color, height


def grid(shape):
    h, w = shape
    return X0 + (np.arange(w) + 0.5) * RES, Z0 + (np.arange(h) + 0.5) * RES


def fit_line(x, z):
    """x = k z + c を当て、外れを落として 3 回当て直す"""
    for _ in range(3):
        (k, c), *_ = np.linalg.lstsq(np.c_[z, np.ones_like(z)], x, rcond=None)
        res = x - (k * z + c)
        keep = np.abs(res) < max(0.6, 2.5 * res.std())
        x, z = x[keep], z[keep]
    return float(k), float(c), x, z


def catapults(color):
    """カタパルトの帯（明るいベージュ）。4 本を X の範囲で分けて当てはめる。

    番号は Nimitz と同じ約束。1 が艦首の右舷、2 が艦首の左舷、3 が斜め甲板の内側、4 が外側
    """
    xx, zz = grid(color.shape[:2])
    r, g, b = (color[..., k].astype(int) for k in range(3))
    track = (r > 150) & (g > 140) & (r - b > 18) & (r - b < 70)
    ys, xs = np.nonzero(track)
    x, z = xx[xs], zz[ys]
    groups = {
        "cat-1": (z < -60) & (x > 7) & (x < 21),
        "cat-2": (z < -60) & (x > -7) & (x < 3),
        "cat-3": (z > -80) & (z < 60) & (x > -28.5) & (x < -17),
        "cat-4": (z > -80) & (z < 60) & (x > -36) & (x < -29.5),
    }
    out = {}
    for name, mask in groups.items():
        k, c, gx, gz = fit_line(x[mask], z[mask])
        order = np.sort(gz)
        z_fore, z_aft = order[int(len(order) * 0.005)], order[int(len(order) * 0.995)]
        out[name] = {
            # 射出の始点は艦尾側の端、終点は艦首側の端
            "start": [round(k * z_aft + c, 3), round(float(z_aft), 3)],
            "end": [round(k * z_fore + c, 3), round(float(z_fore), 3)],
            "angleDeg": round(float(np.degrees(np.arctan(k))), 3),
            "residual": round(float(np.std(gx - (k * gz + c))), 3),
            "pixels": int(len(gx)),
        }
    return out


def landing_centerline(color):
    """着艦区域の中心線（オレンジの破線）。艦首へ向かうほど左舷へ寄る角度が正"""
    xx, zz = grid(color.shape[:2])
    r, g, b = (color[..., k].astype(int) for k in range(3))
    ys, xs = np.nonzero((r > 180) & (g > 80) & (g < 170) & (b < 90) & (r - g > 50))
    x, z = xx[xs], zz[ys]
    # 白い縁の線の向き（8.75 度）で、中心線の帯の横の位置を先に絞る。ほかのオレンジの標識を外すため
    k0 = np.tan(np.radians(8.75))
    offset = x - k0 * z
    near = (z > 0) & (z < 170) & (np.abs(offset + 16) < 6)
    band = (z > 0) & (z < 170) & (np.abs(offset - np.median(offset[near])) < 1.5)
    (k, c), *_ = np.linalg.lstsq(np.c_[z[band], np.ones(band.sum())], x[band], rcond=None)
    return {
        "k": round(float(k), 6),
        "c": round(float(c), 3),
        "angleDeg": round(float(np.degrees(np.arctan(k))), 3),
        "residual": round(float(np.std(x[band] - (k * z[band] + c))), 3),
        "zRange": [round(float(z[band].min()), 1), round(float(z[band].max()), 1)],
        "pixels": int(band.sum()),
    }


def wires(color, centerline):
    """拘束索の印（甲板より明るさのばらつきが大きい、斜めの長方形）を拾い、中心線へ投影する。

    印は着艦区域の両側に 3 個ずつある。向かい合う 2 個は中心線に沿って同じ位置に来る
    """
    lum = color.mean(2)
    xx, zz = grid(lum.shape)
    mean = ndimage.uniform_filter(lum, 5)
    sq = ndimage.uniform_filter(lum * lum, 5)
    std = np.sqrt(np.maximum(sq - mean * mean, 0))
    white = ndimage.uniform_filter((lum > 150).astype(float), 7)
    mask = (std > 17) & (mean < 100) & (white < 0.05)
    mask[(zz < 60) | (zz > 130), :] = False
    mask = ndimage.binary_closing(mask, iterations=1)
    labels, _ = ndimage.label(mask)
    k, c = centerline["k"], centerline["c"]
    d = np.array([k, 1.0]) / np.hypot(k, 1.0)
    n = np.array([d[1], -d[0]])
    p0 = np.array([c, 0.0])
    marks = []
    for i, sl in enumerate(ndimage.find_objects(labels), 1):
        m = labels[sl] == i
        ys, xs = np.nonzero(m)
        x, z = xx[xs + sl[1].start], zz[ys + sl[0].start]
        cov = np.cov(np.c_[x, z].T)
        ev = np.linalg.eigvalsh(cov)
        length, width = 4 * np.sqrt(ev[1]), 4 * np.sqrt(ev[0])
        v = np.array([x.mean(), z.mean()]) - p0
        s, lateral = float(v @ d), float(v @ n)
        # 印の大きさ（長さ 5〜9 m、幅 1.4〜3 m）と、中心線から横に 10〜15 m
        if 5 <= length <= 9 and 1.4 <= width <= 3 and 10 <= abs(lateral) <= 15:
            marks.append({"x": round(float(x.mean()), 2), "z": round(float(z.mean()), 2), "s": round(s, 2), "lateral": round(lateral, 2)})
    marks.sort(key=lambda m: m["s"])
    stations = []
    for m in marks:
        if stations and abs(stations[-1]["marks"][-1]["s"] - m["s"]) < 2:
            stations[-1]["marks"].append(m)
        else:
            stations.append({"marks": [m]})
    for st in stations:
        st["s"] = round(float(np.mean([m["s"] for m in st["marks"]])), 2)
    return stations


def outline(height):
    """飛行甲板（高さ 18.6 m より上）の輪郭。1 m の精度で頂点を間引く"""
    top = (height > 18.6).astype(np.uint8)
    contours, _ = cv2.findContours(top, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    contour = max(contours, key=cv2.contourArea)
    approx = cv2.approxPolyDP(contour, 1.0 / RES, True)[:, 0, :]
    return [[round(X0 + (x + 0.5) * RES, 2), round(Z0 + (y + 0.5) * RES, 2)] for x, y in approx]


def main():
    color, height = render_top()
    if len(sys.argv) > 1:
        Image.fromarray(color).save(sys.argv[1])
    centerline = landing_centerline(color)
    result = {
        "note": "tools/ford-deck-measure.py が測った値。座標は tools/ford-parts.mjs の変換後の m（艦首 −Z、右舷 +X）",
        "resolution": RES,
        "deckTop": round(float(height[height > -1e8].max()), 3),
        "catapults": catapults(color),
        "landingCenterline": centerline,
        "wires": wires(color, centerline),
        "outline": outline(height),
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k != "outline"}, ensure_ascii=False, indent=1))
    print("輪郭の頂点", len(result["outline"]))


if __name__ == "__main__":
    main()
