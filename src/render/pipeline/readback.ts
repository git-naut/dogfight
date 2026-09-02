/**
 * レンダーターゲットの読み戻しを並べ直す。
 *
 * **three にも DOM にも依存しない純関数。**node 環境の単体テストで回る。
 * node 経路の読み戻しは、バックエンドによって行の間隔も向きも変わるので、
 * ここを 1 か所にまとめて縛る。写しを持つと片方だけ直したときに黙ってずれる。
 */

/**
 * 読み戻しの行の詰め物を外す。
 *
 * **WebGPU は行を 256 バイトへ揃える。**16 px 幅（64 バイト）を 16 行
 * 読むと 3,904 バイト戻った。15 行 x 256 + 64 で、最後の行だけ揃えられない。
 * WebGL2 バックエンドは詰まったまま 1,024 バイトを返す。
 *
 * 揃え幅を決め打ちにせず、戻ってきた長さから行の間隔を割り出す。
 * 詰まっていればそのまま返す。
 *
 * @param flipRows 行を上下反転するか。**WebGL2 の読み戻しは下から、WebGPU は
 * 上から返る。**実測で確かめた。ハッシュの検査用の格子で、WebGPU の先頭が
 * `hashTopByte(0, 15, 0)` に一致し、WebGL2 は `(0, 0, 0)` だった。
 * **算術は一致していて、違うのは並びだけ。**気づかなければ「WGSL の
 * ハッシュがずれている」と読み違える
 */
export function unpadRows(
  data: ArrayLike<number>,
  width: number,
  height: number,
  flipRows: boolean,
): number[] {
  const rowBytes = width * 4
  const total = data.length
  const stride =
    total === rowBytes * height
      ? rowBytes
      : height > 1
        ? (total - rowBytes) / (height - 1)
        : total

  if (!Number.isInteger(stride) || stride < rowBytes) {
    throw new Error(
      `読み戻しの行の間隔が読めない: 長さ ${total}、幅 ${width}、高さ ${height}`,
    )
  }

  const out: number[] = []
  for (let row = 0; row < height; row++) {
    const y = flipRows ? height - 1 - row : row
    const base = y * stride
    for (let i = 0; i < rowBytes; i++) out.push(data[base + i]!)
  }
  return out
}
