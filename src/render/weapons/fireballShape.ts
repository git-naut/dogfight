/**
 * 火の玉の板の形の定数（段 29b）。**材質と配置の両方が読む。**
 *
 * 材質（`fireballNodes.ts`）は three/webgpu を読むので、GLSL 経路でも読まれる
 * `explosions.ts` からは値を引かない。共有する数だけをここに置く
 */

/** 輪郭のうねりの振れ幅。ノイズ（おおむね −1..1）に掛けて中心からの距離に足す */
export const SHAPE_AMPLITUDE = 0.3

/**
 * 板の中心からの距離に掛ける倍率。輪郭のうねり（ノイズ × `SHAPE_AMPLITUDE`）が
 * −0.3 まで振れても、輪郭が板の端より内側で閉じる値。見た目の大きさは板のほうで補う
 * （`explosions.ts` の `FIREBALL_BODY_SCALE`）
 */
export const BALL_INSET = 1.4
