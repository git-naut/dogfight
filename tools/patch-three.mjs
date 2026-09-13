/**
 * three の `nodeProxyConstructor` に互換のトラップを 2 つ足す。
 *
 * three 0.184 までの `struct()` は `struct.layout = structType; return struct`
 * を返していた。0.185 で `return nodeProxyConstructor(struct, structType)` に
 * 変わり、返る Proxy は `get` と `set` しかトラップしなくなった。
 * `StructTypeNode` 自体は `layout` という名前のプロパティを持たない
 * （持つのは `membersLayout` / `name` / `isStructTypeNode`）ので、
 * `struct().layout` は undefined になる。
 *
 * `@takram/three-atmosphere@0.19.1` はこの `.layout` を 5 か所で読む。
 * build の先頭で `Re.layout.name` をトップレベル評価するので、**モジュールを
 * 読み込んだ時点で** `Cannot read properties of undefined (reading 'name')`
 * で落ちる。`@takram/three-geospatial` のほうは `'layout' in s` で
 * プロパティの存在そのものを見るため、`get` だけでは足りず `has` も要る。
 *
 * takram は 0.19.1（2026-05-06）から更新が止まっている。three だけが
 * 0.186（2026-09-08）まで進んだので、噛み合わせはこちらで作る。
 *
 * `isStructTypeNode` で絞るのは、`nodeProxyConstructor` が `Fn()` にも
 * 使われていて、そちらが `setLayout()` で書く `layout` を潰さないため。
 *
 * three を上げて対象の形が変わったら**黙って素通りせずに落ちる。**
 * 「exit code 0 は成功を意味しない」を踏まないための作り。
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 実装を持つビルド。`three.tsl.js` は `TSL.nodeProxyConstructor` を
 * 再エクスポートするだけなので対象にしない。
 */
const TARGETS = [
  'node_modules/three/build/three.webgpu.js',
  'node_modules/three/build/three.webgpu.nodes.js',
]

/** 当てる前の形。ここが一致しなければ three 側が変わったということ */
const BEFORE = `	return new Proxy( constructorFunction, {

		get( target, prop, receiver ) {

			return Reflect.get( nodeInstance, prop, receiver );

		},

		set( target, prop, value ) {

			return Reflect.set( nodeInstance, prop, value );

		}

	} );`

const AFTER = `	return new Proxy( constructorFunction, {

		get( target, prop, receiver ) {

			// dogfight のパッチ: 0.184 までの \`struct.layout\` を代理する
			if ( prop === 'layout' && nodeInstance.isStructTypeNode === true ) return nodeInstance;

			return Reflect.get( nodeInstance, prop, receiver );

		},

		has( target, prop ) {

			// dogfight のパッチ: geospatial は \`'layout' in s\` で存在を見る
			if ( prop === 'layout' && nodeInstance.isStructTypeNode === true ) return true;

			return Reflect.has( nodeInstance, prop );

		},

		set( target, prop, value ) {

			return Reflect.set( nodeInstance, prop, value );

		}

	} );`

/** 当たっているかの目印。冪等にするために見る */
const MARK = "if ( prop === 'layout' && nodeInstance.isStructTypeNode === true ) return nodeInstance;"

let patched = 0
let already = 0

for (const relative of TARGETS) {
  const path = join(root, relative)
  let source
  try {
    source = readFileSync(path, 'utf8')
  } catch (error) {
    throw new Error(
      `${relative} を読めない。three が入っていないか、ビルドの構成が変わった: ${error.message}`,
    )
  }

  if (source.includes(MARK)) {
    already += 1
    continue
  }

  const hits = source.split(BEFORE).length - 1
  if (hits !== 1) {
    throw new Error(
      `${relative} で nodeProxyConstructor の形が ${hits} 件。` +
        '1 件でなければ three 側が変わっている。' +
        'tools/patch-three.mjs の BEFORE を実物に合わせ直すこと',
    )
  }

  writeFileSync(path, source.replace(BEFORE, AFTER))
  patched += 1
}

console.log(
  `three のパッチ: ${patched} 件を当てた / ${already} 件は当たっていた（対象 ${TARGETS.length} 件）`,
)
