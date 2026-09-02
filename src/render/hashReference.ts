/**
 * 雲ノイズのハッシュの CPU 参照実装。
 *
 * **three を import しない純関数。**node 環境の単体テストで回り、GPU の
 * 出力と突き合わせる物差しになる。
 *
 * 元は `src/render/clouds/shaders/noise3d.frag` の `pcg3d`。段 11 で
 * 同じものを TSL へ移すので、GLSL と WGSL と JS の 3 つが同じ値を出すことを
 * 数値で確かめる。**1 ビットずれたら、以降の雲の絵はすべて別物になる。**
 *
 * `uint` の乗算は GLSL でも WGSL でも 2^32 で巻く。JS では `Math.imul` が
 * 同じ巻き方をするので、仕様上 3 者はビット一致する。`sin` を使うハッシュを
 * 避けた元の判断（実測で SwiftShader と llvmpipe がずれた）が、そのまま
 * WGSL でも効く。
 */

/** PCG の乗数と加数。GLSL 側の `1664525u` と `1013904223u` */
export const PCG_MULTIPLIER = 1664525
export const PCG_INCREMENT = 1013904223

/**
 * PCG の 3D 版。
 *
 * `out` は長さ 3 の `Uint32Array`。器を使い回せるように受け取る。
 * 入力は 32bit 符号なしとして扱う（負を渡すと `Math.imul` が巻く）。
 */
export function pcg3d(
  x: number,
  y: number,
  z: number,
  out: Uint32Array = new Uint32Array(3),
): Uint32Array {
  // v = v * 1664525u + 1013904223u
  let vx = (Math.imul(x, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vy = (Math.imul(y, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vz = (Math.imul(z, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0

  vx = (vx + Math.imul(vy, vz)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0

  vx = (vx ^ (vx >>> 16)) >>> 0
  vy = (vy ^ (vy >>> 16)) >>> 0
  vz = (vz ^ (vz >>> 16)) >>> 0

  vx = (vx + Math.imul(vy, vz)) >>> 0
  vy = (vy + Math.imul(vz, vx)) >>> 0
  vz = (vz + Math.imul(vx, vy)) >>> 0

  out[0] = vx
  out[1] = vy
  out[2] = vz
  return out
}

/**
 * 格子座標をずらしてから引くときのオフセット。
 *
 * 負の値をそのまま `uint` へ渡すと実装依存になるので正へ寄せる。
 * GLSL 側の `uvec3(cell + 4096)` と同じ
 */
export const HASH_CELL_OFFSET = 4096

/** 整数の格子座標から 0..1 の 3 成分を返す。GLSL の `hash33` と同じ */
export function hash33(
  cellX: number,
  cellY: number,
  cellZ: number,
  out: Float64Array = new Float64Array(3),
): Float64Array {
  const h = pcg3d(
    cellX + HASH_CELL_OFFSET,
    cellY + HASH_CELL_OFFSET,
    cellZ + HASH_CELL_OFFSET,
  )
  out[0] = h[0]! / 4294967296
  out[1] = h[1]! / 4294967296
  out[2] = h[2]! / 4294967296
  return out
}

/**
 * ハッシュの上位 8 ビット。
 *
 * GPU 側は RGBA8 のレンダーターゲットへ焼くので、32 ビットのまま読み戻せない。
 * 上位 8 ビットだけを `k / 255` で書き出せば UNORM8 の丸めで k がそのまま
 * 戻る。**量子化の丸めを跨がないので、ビット一致をそのまま検査できる。**
 */
export function hashTopByte(
  cellX: number,
  cellY: number,
  cellZ: number,
  out: Uint8Array = new Uint8Array(3),
): Uint8Array {
  const h = pcg3d(
    cellX + HASH_CELL_OFFSET,
    cellY + HASH_CELL_OFFSET,
    cellZ + HASH_CELL_OFFSET,
  )
  out[0] = h[0]! >>> 24
  out[1] = h[1]! >>> 24
  out[2] = h[2]! >>> 24
  return out
}

/** ハッシュの検査に使う格子の一辺。16x16 の 256 セル */
export const HASH_PROBE_SIDE = 16

/**
 * 検査用の格子の期待値を作る。
 *
 * セルは `(x, y, 0)` を `x` が内側で並べる。GPU 側の読み戻しは左下原点で
 * 行が下から来るので、突き合わせる側で並びを合わせること
 */
export function hashProbeExpected(side = HASH_PROBE_SIDE): Uint8Array {
  const out = new Uint8Array(side * side * 3)
  const one = new Uint8Array(3)
  for (let y = 0; y < side; y++) {
    for (let x = 0; x < side; x++) {
      hashTopByte(x, y, 0, one)
      const i = (y * side + x) * 3
      out[i] = one[0]!
      out[i + 1] = one[1]!
      out[i + 2] = one[2]!
    }
  }
  return out
}

/**
 * PCG の 2D 版。気象マップが使う。
 *
 * `shaders/weather.frag` の `pcg2d` と同じ。3D 版と違って乗数が
 * 各行に入る形なので、別関数として写す
 */
export function pcg2d(
  x: number,
  y: number,
  out: Uint32Array = new Uint32Array(2),
): Uint32Array {
  let vx = (Math.imul(x, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0
  let vy = (Math.imul(y, PCG_MULTIPLIER) + PCG_INCREMENT) >>> 0

  vx = (vx + Math.imul(vy, PCG_MULTIPLIER)) >>> 0
  vy = (vy + Math.imul(vx, PCG_MULTIPLIER)) >>> 0

  vx = (vx ^ (vx >>> 16)) >>> 0
  vy = (vy ^ (vy >>> 16)) >>> 0

  vx = (vx + Math.imul(vy, PCG_MULTIPLIER)) >>> 0
  vy = (vy + Math.imul(vx, PCG_MULTIPLIER)) >>> 0

  out[0] = vx
  out[1] = vy
  return out
}

/**
 * 気象マップの格子の巻き方。
 *
 * 周波数が 3・5・7 系で **2 のべき乗ではない**ので、ビット積では書けない。
 * ただし `id = floor(uv * freq)` は 0..freq-1 に収まり、足す近傍は 0 か +1
 * だけなので、格子は 0..freq の範囲にしかならない。**上端の 1 つを折り返す
 * だけで足りる。**`((cell % period) + period) % period` と同値であることは
 * `tests/render/noiseWrap.test.ts` が実際の範囲で確かめる
 */
export function wrapCell2(cell: number, period: number): number {
  return cell >= period ? cell - period : cell
}
