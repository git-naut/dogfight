import { ALPHA_CUT, CORE_CUT } from './radialSprite'

/**
 * 円形スプライトを固定の入力で焼く。TSL 版と CPU 参照の突き合わせ専用。
 *
 * **ここが唯一の定義。**TSL の焼き手（`pipeline/node.ts`）と CPU 参照が
 * この値を読む。断片は `vUv` だけの関数なので、全画面のクアッドへ焼けば
 * 場面を組まずに比べられる。段 S1 で GLSL 版の焼き手を捨てた。
 *
 * three にも DOM にも依存しない。
 */

/** 焼く大きさ。円が縁まで入る奇数でない一辺にする */
export const SPRITE_PROBE_SIDE = 64

/**
 * 色と濃さと落ち方。
 *
 * 濃さは `CORE_CUT`（0.5）を跨ぐ値にする。**下回ると芯の枝が全部捨てられ、
 * `OPAQUE_CORE` の側が真っ白な絵どうしの比較になる**
 */
export const SPRITE_PROBE_COLOR = { r: 0.92, g: 0.55, b: 0.2 } as const
export const SPRITE_PROBE_OPACITY = 0.8
export const SPRITE_PROBE_FALLOFF = 1.8

/** 芯の枝を通す濃さになっているか。検査で使う */
export function spriteProbeCrossesCoreCut(): boolean {
  // 中心（d = 0）の a は opacity そのもの
  return SPRITE_PROBE_OPACITY > CORE_CUT
}

/**
 * 焼いた絵の CPU 参照。式は `radialSprite.ts` の注記（もとは GLSL 版の断片
 * シェーダ `RADIAL_SPRITE_FRAGMENT`）。
 *
 * **GLSL 版を捨てたあとの突き合わせの相手。**全画面のクアッドへ焼くので、
 * 画素 (col, row) の `vUv` は画素の中心 ((col + 0.5) / side, (row + 0.5) / side)。
 * 円は上下にも左右にも対称なので、読み戻しの行の向きは結果を変えない。
 * 捨てた画素はクリアの色 (0, 0, 0, 0) のまま残る。
 *
 * GPU は 32 ビットで計算するので、比べるときは 1 階調まで許す
 */
export function spriteProbeExpected(opaqueCore: boolean): number[] {
  const side = SPRITE_PROBE_SIDE
  const out = new Array<number>(side * side * 4).fill(0)
  const unorm = (v: number) => Math.round(Math.min(1, Math.max(0, v)) * 255)
  for (let row = 0; row < side; row++) {
    for (let col = 0; col < side; col++) {
      const u = (col + 0.5) / side - 0.5
      const v = (row + 0.5) / side - 0.5
      const d = Math.hypot(u, v) * 2
      if (d > 1) continue
      const a = Math.pow(Math.max(0, 1 - d), SPRITE_PROBE_FALLOFF) * SPRITE_PROBE_OPACITY
      if (a < ALPHA_CUT) continue
      if (opaqueCore && a < CORE_CUT) continue
      const at = (row * side + col) * 4
      out[at] = unorm(SPRITE_PROBE_COLOR.r)
      out[at + 1] = unorm(SPRITE_PROBE_COLOR.g)
      out[at + 2] = unorm(SPRITE_PROBE_COLOR.b)
      out[at + 3] = unorm(opaqueCore ? 1 : a)
    }
  }
  return out
}

/** 焼いた絵のうち、捨てられていない画素の数を数える */
export function spriteDrawnPixels(bytes: ArrayLike<number>): number {
  let drawn = 0
  for (let i = 0; i < bytes.length / 4; i++) {
    if (bytes[i * 4 + 3]! > 0) drawn++
  }
  return drawn
}
