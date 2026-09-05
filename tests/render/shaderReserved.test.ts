import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath, URL } from 'node:url'
import { join } from 'node:path'

/**
 * GLSL の予約語を識別子に使っていないか。
 *
 * **予約語を使うとコンパイルが黙って落ちる。**three は
 * `THREE.WebGLProgram: Shader Error` をコンソールへ出すが、例外は飛ばず
 * 描画は進む。材質が無効なプログラムのまま `useProgram` を呼び続けるので、
 * そのメッシュだけが消える。
 *
 * このリポジトリは 3 度踏んでいる。`patch`、`half`、そして段 17b の
 * `active`。3 度目は海面が丸ごと消え、基準画像 38 枚が動いてから
 * 二分探索で 4 往復してようやく行に辿り着いた。**1 秒の検査にする。**
 *
 * 対象は `src/` に置いた自前のシェーダだけ。`node_modules` の外部
 * ライブラリは見ない。
 */

const SHADER_DIRS = [
  'src/render/clouds/shaders',
  'src/render/terrain/shaders',
] as const

/**
 * GLSL ES 3.00 の予約語。仕様 3.6 節から、識別子として書きうるものだけ。
 *
 * `attribute` と `varying` は入れない。GLSL ES 1.00 では文法上のキーワード
 * だが、このリポジトリの `?raw` シェーダはすべて GLSL3 で書いてあり、
 * three 側の生成コードにも現れないので、識別子として使う機会がない。
 */
const RESERVED = [
  'active',
  'asm',
  'cast',
  'class',
  'common',
  'double',
  'enum',
  'extern',
  'external',
  'filter',
  'fixed',
  'goto',
  'half',
  'inline',
  'input',
  'interface',
  'long',
  'namespace',
  'noinline',
  'noperspective',
  'output',
  'partition',
  'patch',
  'public',
  'resource',
  'restrict',
  'sample',
  'short',
  'sizeof',
  'static',
  'subroutine',
  'superp',
  'template',
  'this',
  'typedef',
  'union',
  'unsigned',
  'using',
  'volatile',
] as const

interface ShaderFile {
  readonly name: string
  readonly source: string
  /** 注記を外した本文。予約語を注記で説明できるようにする */
  readonly body: string
}

function loadShaders(): ShaderFile[] {
  const out: ShaderFile[] = []
  for (const dir of SHADER_DIRS) {
    const base = fileURLToPath(new URL(`../../${dir}`, import.meta.url))
    for (const file of readdirSync(base).sort()) {
      if (!/\.(glsl|frag|vert)$/.test(file)) continue
      const source = readFileSync(join(base, file), 'utf8')
      out.push({
        name: `${dir}/${file}`,
        source,
        body: source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, ''),
      })
    }
  }
  return out
}

const SHADERS = loadShaders()

describe('シェーダの予約語', () => {
  it('シェーダを読めている', () => {
    // 読めていなければ以下の検査は空振りで通る
    expect(SHADERS.length).toBeGreaterThanOrEqual(13)
    for (const shader of SHADERS) {
      expect(shader.body, `${shader.name} が空`).toContain('float')
    }
  })

  it('注記を外す処理が本文を消していない', () => {
    const terrain = SHADERS.find((s) => s.name.endsWith('terrain.frag'))
    expect(terrain).toBeDefined()
    expect(terrain!.body).toContain('void main()')
    // 注記のほうには予約語の名前が残っている（本文だけを見ていることの裏取り）
    const water = SHADERS.find((s) => s.name.endsWith('waterSurface.glsl'))
    expect(water!.source).toContain('active')
    expect(water!.body.includes('active')).toBe(false)
  })

  for (const word of RESERVED) {
    it(`\`${word}\` を識別子に使っていない`, () => {
      const pattern = new RegExp(`\\b${word}\\b`)
      const hits = SHADERS.filter((s) => pattern.test(s.body)).map((s) => s.name)
      expect(hits, `${word} が ${hits.join(', ')} にある`).toEqual([])
    })
  }
})
