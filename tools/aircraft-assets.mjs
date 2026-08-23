/**
 * 取り込む機体の定義。
 *
 * `ac3d-to-glb.mjs` は F/A-18C 専用にハードコードしてあった。Phase 6 で F-16 を
 * 足すので、機体ごとに違うところをここへ集める。**変換の手順は共通で、違うのは
 * 原本の場所・テクスチャの張り替え・舵面の名前・隠すノードだけ。**
 *
 * パスは全部リポジトリのルートからの相対。`ac3d-to-glb.mjs` が絶対パスへ直す。
 */

import { F18_HINGES } from './f18-hinges.mjs'
import { F16_HINGES } from './f16-hinges.mjs'
import { xmlToWorld } from './fg-coords.mjs'

/**
 * 降着装置。地上でしか使わないので別ノードにして隠せるようにする。
 *
 * 名前の付け方は FlightGear のモデルでおおむね共通なので既定にしてある。
 * 合わない機体が出たら `gearPattern` で上書きする。
 */
export const DEFAULT_GEAR_PATTERN = /Door|Gear|Wheel|Tire|Strut|Hook/i

export const AIRCRAFT_ASSETS = [
  {
    id: 'f18',
    /** 原本の .ac */
    source: 'assets/upstream/f18/f18.ac',
    /**
     * 変換済みテクスチャの置き場。
     *
     * SGI から WebP への変換は Pillow が要るので、ビルドの経路に入れられない
     * （GitHub のランナーに入っておらず CI が落ちた）。変換結果をコミットして、
     * ここでは複製するだけにする。
     */
    textureDir: 'assets/generated/f18',
    /** .ac のテクスチャ名から、出力へ置くファイル名へ張り替える */
    textures: {
      'f18top.rgb': 'f18top.webp',
      'f18tail.rgb': 'f18tail.webp',
      'f18cockpit.rgb': 'f18cockpit.webp',
    },
    /** テクスチャが無いときに出す指示 */
    textureHint: 'python3 tools/textures-to-webp.py f18 を走らせてコミットすること',
    /** 舵面のヒンジ。XML 座標のまま持つ */
    hinges: F18_HINGES,
    /** ヒンジの XML 座標を当方の座標へ移す */
    xmlToWorld,
    /** 操縦席の内装を見分けるテクスチャ。外から見えないので別ノードにする */
    cockpitTexture: 'f18cockpit.rgb',
    /**
     * 描画側で個別に出し入れする部品。
     *
     * 原本にはアフターバーナーの炎が入っている。FlightGear は
     * engines/engine[0]/augmentation で ExternalFlame を出し入れし、
     * InternalFlame は常に見せている（f18.xml の select アニメーション）。
     * 同じ扱いにするので別ノードへ切り出す。
     */
    extraNodes: ['ExternalFlame', 'InternalFlame'],
    copyright:
      'F/A-18C model by Fabrice Kauffmann, FlightGear FGAddon, GPLv2+. See assets/CREDITS.md',
  },
  {
    id: 'f16',
    source: 'assets/upstream/f16/f16.ac',
    textureDir: 'assets/generated/f16',
    /**
     * テクスチャ。原本は PNG だが WebP へ落としてある。
     *
     * `f16.png` は 2048² の RGBA で 1.2 MB。品質 95 の WebP で 243 KB に
     * なり、可視画素の sRGB 平均差は 0.54 階調（実測。`textures-to-webp.py`）。
     *
     * `Effects/glass/canopy2.png` はキャノピーの内側だけが使う。**パスに
     * ディレクトリが入っているので、そのままの名前で引く。**
     */
    textures: {
      'f16.png': 'f16.webp',
      'f16trans.png': 'f16trans.webp',
      'nozzle-ring.png': 'nozzle-ring.webp',
      'Effects/glass/canopy2.png': 'canopy2.webp',
    },
    textureHint: 'python3 tools/textures-to-webp.py f16 を走らせてコミットすること',
    hinges: F16_HINGES,
    xmlToWorld,
    /**
     * 操縦席の内装は f16.ac に入っていない（別モデル）。
     *
     * キャノピーのガラスは外から見えるので、これを内装として隠してはいけない。
     */
    cockpitTexture: undefined,
    extraNodes: ['ExternalFlame', 'InternalFlame'],
    copyright:
      'F-16 model from FlightGear FGAddon, GPLv2+. See assets/CREDITS.md',
  },
]

/** id から定義を引く。無ければ例外 */
export function assetById(id) {
  const asset = AIRCRAFT_ASSETS.find((a) => a.id === id)
  if (asset === undefined) {
    const known = AIRCRAFT_ASSETS.map((a) => a.id).join(', ')
    throw new Error(`未知の機体 ${id}。知っているのは ${known}`)
  }
  return asset
}
