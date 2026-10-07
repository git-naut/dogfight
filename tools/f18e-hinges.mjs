// F/A-18E のヒンジ軸を舵面の頂点から導く。
//
// **FlightGear の XML が無い。**F/A-18C は `assets/upstream/f18/f18.xml` が
// ヒンジの 2 点を持っていたが、Sketchfab のモデルには何も付いていない。
// 舵面のメッシュから軸を組み立てる。
//
// ## ヒンジの置き方（Phase 9、2026-10-07 に頂点から測る形へ替えた）
//
// | 舵面 | 位置 | 軸 |
// |---|---|---|
// | エルロン | 両端の断面の前縁の鼻の中心を結ぶ線 | 下反角と後退角に沿う |
// | スタビレータ | 翼弦の 30%（**全遊動**なので前縁ではない） | 面の傾きに沿う |
// | ラダー | 両端の断面の前縁の鼻の中心を結ぶ線 | 外へ約 20 度傾いた前縁に沿う |
//
// **以前は外接箱から軸を作っていた。**エルロンは「外接箱の前端を通る高さ一定の
// 真横の線」、ラダーは「前端を通る鉛直の線」だった。主翼には下反角が、垂直尾翼には
// 外への傾きがあるので、回すと付け根が主翼や胴体から浮いた（ユーザーがライブで
// 「機体に接しておらず隙間がある」と指摘）。原本のメッシュで測ると、最大舵角で継ぎ目の
// 頂点が固定の部品から離れる距離はエルロン 11〜15 cm、ラダー 8〜30 cm で、頂点から
// 作る軸では 5〜6 cm になる（`seamDeparture` と `tests/tools/f18eParts.test.ts`）。
// 残る数 cm は、舵面の両端の断面が隣のフラップや翼端と接しているぶんで、実機も
// 舵角を付ければそこはずれる。
//
// スタビレータの 30% は実機のピボット位置。前縁に置くと、舵角を付けたときに
// 後縁が大きく振れて尾部を突き抜ける。
import { identifyParts, SCALE } from './f18e-parts.mjs'
import { readGltfParts } from './gltf-parts.mjs'

/**
 * 舵角の上限 deg。F/A-18C（`tools/f18-hinges.mjs`）の値を流用する。
 *
 * **E/F の NATOPS の値は取れなかった。**C 型と E/F で舵面の大きさは違うが、
 * 舵角の上限は飛行制御の設計で決まる量で、同系の機体なら大きく変わらない。
 * 実機の値が手に入ったら差し替える。
 */
export const MAX_DEG = {
  aileron: 30,
  stabilator: 24,
  rudder: 30,
}

/**
 * 舵の向き。指令に掛ける符号。
 *
 * 目標の動きは `tools/f18-hinges.mjs` と同じ。左ロール（指令が負）で左の
 * エルロンが上がって右が下がる。機首上げ（指令が正）で水平尾翼の後縁が
 * 上がる。右ヨー（指令が正）でラダーの後縁が右へ振れる。
 *
 * **符号は C 型から写せない。**C 型は FlightGear の XML がヒンジの 2 点を
 * 持っていて、その向きに合わせた値だった。こちらは bbox から軸を組むので
 * 向きが別に決まる。エルロンとスタビレータは実測でどちらも反転した
 * （エルロンは −1 で左の後縁が −0.500、スタビレータは −1 で −0.407）。
 *
 * **確かめるのは変換後の座標。**`tests/render/aircraftSurfaces.test.ts` が
 * glb の extras を読んで、左右を名指しして見張る。
 */
export const SIGN = {
  aileron: 1,
  stabilator: 1,
  rudder: 1,
}

/** スタビレータのピボットの位置。前縁から翼弦の何割か */
const STABILATOR_PIVOT = 0.3

/** 端の断面とみなす幅。舵面の翼幅方向の長さに対する割合 */
const RIB_BAND = 0.03

/** 前縁の鼻とみなす範囲。断面の翼弦に対する、前端からの割合 */
const NOSE_BAND = 0.12

/**
 * 舵面の頂点（m、モデルの元の軸）をノードごとに集める。親ノードでまとめる
 * （`identifyParts` と同じ。Sketchfab の変換はマテリアルごとにノードを分ける）
 */
function surfaceVertices(gltfPath) {
  const { parts } = readGltfParts(gltfPath, { vertices: true })
  const byNode = new Map()
  for (const p of parts) {
    const key = p.parent ?? p.name
    if (!byNode.has(key)) byNode.set(key, [])
    for (const v of p.vertices) byNode.get(key).push(v.map((x) => x * SCALE))
  }
  return byNode
}

/**
 * 端の断面の前縁の鼻の中心。
 *
 * **最前端の 1 点ではない。**エルロンの断面は丸い鼻で、最前端の頂点は上面の縁にある
 * （付け根側で x 2.037・y 0.651、鼻の下面は y 0.534）。最前端を軸にすると、回したとき
 * 鼻の下側が主翼の外へ出る。前から翼弦の 12% までの頂点の平均を取る
 *
 * @param span 翼幅方向の軸（エルロン 2、ラダー 1）
 * @param end 'lo' か 'hi'。翼幅方向のどちらの端か
 */
export function noseCenter(vertices, span, end) {
  const values = vertices.map((v) => v[span])
  const lo = Math.min(...values)
  const hi = Math.max(...values)
  const at = end === 'lo' ? lo : hi
  const rib = vertices.filter((v) => Math.abs(v[span] - at) <= RIB_BAND * (hi - lo))
  const xs = rib.map((v) => v[0])
  const front = Math.min(...xs)
  const chord = Math.max(...xs) - front
  const nose = rib.filter((v) => v[0] <= front + NOSE_BAND * chord)
  const center = [0, 1, 2].map((k) => nose.reduce((s, v) => s + v[k], 0) / nose.length)
  center[span] = at
  return center
}

/**
 * 頂点に平面 y = a·z + b·x + c を最小二乗で当てる。スタビレータの傾きを測る
 *
 * @returns [a, b, c]
 */
function fitPlane(vertices) {
  // 正規方程式 (AᵀA) p = Aᵀy を 3×3 で解く（A の行は [z, x, 1]）
  const m = [
    [0, 0, 0],
    [0, 0, 0],
    [0, 0, 0],
  ]
  const r = [0, 0, 0]
  for (const v of vertices) {
    const row = [v[2], v[0], 1]
    for (let i = 0; i < 3; i++) {
      r[i] += row[i] * v[1]
      for (let j = 0; j < 3; j++) m[i][j] += row[i] * row[j]
    }
  }
  return solve3(m, r)
}

/** 3×3 の連立一次方程式をクラメルの公式で解く */
function solve3(m, r) {
  const det = (a) =>
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])
  const d = det(m)
  return [0, 1, 2].map((col) => det(m.map((row, i) => row.map((v, j) => (j === col ? r[i] : v)))) / d)
}

/**
 * ヒンジの定義を作る。
 *
 * 返す座標は**モデルの元の軸**（X 前後で機首が負、Y 上下、Z 翼幅）で、
 * 単位は m。座標系の変換は `tools/f18e-to-glb.mjs` が最後に 1 回だけ掛ける。
 * **ここで回すと、回した後の値をもう 1 度回す事故が起きる。**
 */
export function buildHinges(gltfPath) {
  const { matched } = identifyParts(gltfPath)
  const vertices = surfaceVertices(gltfPath)
  const hinges = []

  for (const m of matched) {
    const v = vertices.get(m.node)
    if (v === undefined || v.length === 0) throw new Error(`${m.node} の頂点が無い`)

    let from
    let to
    if (m.role === 'rudder') {
      // 前縁の鼻を下から上へ結ぶ。**鉛直にしない。**垂直尾翼は外へ約 20 度傾いて
      // いて、鉛直の軸で回すとラダーが自分の面の外へ振れ、付け根が胴体から浮く
      from = noseCenter(v, 1, 'lo')
      to = noseCenter(v, 1, 'hi')
    } else if (m.role === 'stabilator') {
      // 翼弦の 30%。全遊動なので前縁ではない。軸は面の傾き（下反角）に沿わせる。
      // **スタビレータは左右同じ方向に動く**（機首上げで両方の後縁が上がる）
      // ので、軸は左右とも −Z から +Z へ向ける
      const xs = v.map((p) => p[0])
      const zs = v.map((p) => p[2])
      const x = Math.min(...xs) + (Math.max(...xs) - Math.min(...xs)) * STABILATOR_PIVOT
      const [a, b, c] = fitPlane(v)
      const y = (z) => a * z + b * x + c
      const z0 = Math.min(...zs)
      const z1 = Math.max(...zs)
      from = [x, y(z0), z0]
      to = [x, y(z1), z1]
    } else {
      // エルロン。両端の断面の前縁の鼻を結ぶ。主翼の下反角と後退角に沿う。
      //
      // **軸の向きを左右で逆にする。**同じ向きだと、同じ符号を与えたときに左右が
      // 同じ方向へ動く。エルロンは逆に動かないとロールしない。外側→内側の向きに
      // 揃えると、左（+Z 側）が −Z・右（−Z 側）が +Z になって符号 1 つで逆向きになる
      // （`tools/f18-hinges.mjs` が F-16 について書いているのと同じ形）
      const outer = noseCenter(v, 2, m.side === 'left' ? 'hi' : 'lo')
      const inner = noseCenter(v, 2, m.side === 'left' ? 'lo' : 'hi')
      from = outer
      to = inner
    }

    hinges.push({
      node: m.name,
      sourceNode: m.node,
      role: m.role,
      side: m.side,
      from,
      to,
      maxDeg: MAX_DEG[m.role],
      // `SurfaceChannel` は 'elevator' | 'aileron' | 'rudder' の 3 つ。
      // 全遊動の水平尾翼はピッチの指令を読むので elevator へ寄せる
      channel: m.role === 'stabilator' ? 'elevator' : m.role,
      sign: SIGN[m.role],
    })
  }
  return hinges
}

/**
 * 最大舵角まで回したとき、継ぎ目の頂点が固定の部品からどれだけ離れるか（m）。
 *
 * 継ぎ目は「静止時に固定の部品の頂点から 2 cm 以内にある舵面の頂点」。それを ±最大舵角
 * で回し、いちばん近い固定の頂点までの距離を測る（60 cm で打ち切る）。**軸が付け根に
 * 沿っていれば継ぎ目はほとんど動かない。**ずれていると付け根ごと振れて大きくなる。
 * 2026-10-07 の実測は、外接箱から作っていた軸でエルロン 11〜15 cm・ラダー 8〜30 cm、
 * 頂点から作る軸で 5〜6 cm
 *
 * @returns ノード名から `{ seam, max, mean }`
 */
export function seamDeparture(gltfPath, hinges) {
  const { matched } = identifyParts(gltfPath)
  const moving = new Set(matched.map((m) => m.node))
  const { parts } = readGltfParts(gltfPath, { vertices: true })

  // 固定の部品の頂点を 5 cm の格子に入れて、近いものだけ引く
  const cell = 0.05
  const grid = new Map()
  const key = (i, j, k) => `${i},${j},${k}`
  for (const p of parts) {
    if (moving.has(p.parent ?? p.name)) continue
    for (const raw of p.vertices) {
      const v = raw.map((x) => x * SCALE)
      const k = key(...v.map((x) => Math.floor(x / cell)))
      if (!grid.has(k)) grid.set(k, [])
      grid.get(k).push(v)
    }
  }
  const nearest = (p, radius) => {
    const n = Math.ceil(radius / cell)
    const c = p.map((x) => Math.floor(x / cell))
    let best = radius
    for (let i = -n; i <= n; i++)
      for (let j = -n; j <= n; j++)
        for (let k = -n; k <= n; k++) {
          for (const q of grid.get(key(c[0] + i, c[1] + j, c[2] + k)) ?? []) {
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
            if (d < best) best = d
          }
        }
    return best
  }

  const vertices = surfaceVertices(gltfPath)
  const out = {}
  for (const h of hinges) {
    const v = vertices.get(h.sourceNode)
    const seam = v.filter((p) => nearest(p, 0.1) < 0.02)
    const d = [0, 1, 2].map((k) => h.to[k] - h.from[k])
    const len = Math.hypot(...d)
    const u = d.map((x) => x / len)
    let max = 0
    let sum = 0
    let n = 0
    for (const sign of [1, -1]) {
      const a = (sign * h.maxDeg * Math.PI) / 180
      for (const p of seam) {
        const g = nearest(rotateAbout(p, h.from, u, a), 0.6)
        max = Math.max(max, g)
        sum += g
        n++
      }
    }
    out[h.node] = { seam: seam.length, max, mean: n > 0 ? sum / n : 0 }
  }
  return out
}

/** 点 p を、点 o を通る単位ベクトル u の軸まわりに角 a 回す（ロドリゲスの公式） */
function rotateAbout(p, o, u, a) {
  const v = [p[0] - o[0], p[1] - o[1], p[2] - o[2]]
  const c = Math.cos(a)
  const s = Math.sin(a)
  const dot = v[0] * u[0] + v[1] * u[1] + v[2] * u[2]
  const cross = [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]
  return [0, 1, 2].map((k) => o[k] + v[k] * c + cross[k] * s + u[k] * dot * (1 - c))
}

/**
 * 脚が格納まで回る角度 deg（Phase 9 の段 6）。
 *
 * **推測と簡略化。**F/A-18 の前脚は前へ、主脚は後ろへ畳まれる。前脚・主脚とも 90 度に
 * 置いた。実機の主脚は畳むときに車輪を 90 度ひねって寝かせるが、その 2 段目の回転は
 * 省いた。上げ切ると脚は隠すので、絵に出るのは 5 秒の途中だけ（ADR 0018）
 */
export const GEAR_RETRACT_DEG = { nose: 90, left: 90, right: 90 }

/**
 * 脚とフックのヒンジ。座標はモデルの元の軸（機首 −X、上 +Y、+Z が左）で m。
 *
 * 脚はいちばん上の頂点の付近（上から 5 cm）の中心を付け根にし、横（Z）の軸で回す。
 * 軸の向きは、正の角で畳む向きに回るように選ぶ。右手の規則で、+Z の軸を正に回すと
 * 下向きの脚は後ろ（+X）へ振れる。前脚は前へ畳むので −Z、主脚は後ろへ畳むので +Z。
 *
 * フックは前端（いちばん前の頂点から 5 cm）の中心を付け根にする。横の軸。動かすのは段 8
 */
export function buildGearHinges(gltfPath) {
  const { legs, hook } = identifyParts(gltfPath)
  const { parts } = readGltfParts(gltfPath, { vertices: true })
  const verticesOf = (members) => {
    const names = new Set(members.map((m) => m.raw.parent ?? m.name))
    return parts
      .filter((p) => names.has(p.parent ?? p.name))
      .flatMap((p) => p.vertices.map((v) => v.map((x) => x * SCALE)))
  }
  const centerOf = (vs) => [0, 1, 2].map((k) => vs.reduce((s, v) => s + v[k], 0) / vs.length)

  const gear = legs.map((l) => {
    const v = verticesOf(l.parts)
    const top = Math.max(...v.map((p) => p[1]))
    const origin = centerOf(v.filter((p) => p[1] >= top - 0.05))
    origin[1] = top
    return {
      node: l.name,
      leg: l.leg,
      sourceNodes: [...new Set(l.parts.map((p) => p.raw.parent ?? p.name))],
      origin,
      axis: l.leg === 'nose' ? [0, 0, -1] : [0, 0, 1],
      retractDeg: GEAR_RETRACT_DEG[l.leg],
    }
  })

  const hv = verticesOf(hook)
  const front = Math.min(...hv.map((p) => p[0]))
  const hookOrigin = centerOf(hv.filter((p) => p[0] <= front + 0.05))
  hookOrigin[0] = front
  return {
    gear,
    hook: {
      node: 'Hook',
      sourceNodes: [...new Set(hook.map((p) => p.raw.parent ?? p.name))],
      origin: hookOrigin,
      axis: [0, 0, 1],
    },
  }
}
