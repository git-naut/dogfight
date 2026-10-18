/**
 * オートパイロット（Phase 10 の段 B6、録画に合わせた）。**純関数。**
 *
 * 録画（ACE COMBAT 7 の講座 lesson 2）では、ヨーの 2 つのボタンを同時に押すと機体が水平に戻り、
 * 照準の下に AUTO PILOT が出る（「上下が分からなくなったらオートパイロットを使おう」）。入れたあとは
 * ロールかピッチを入れるまで続ける。翼を水平にし、機首を水平線へ戻す
 */

/** ロールの指令をいっぱいに入れる傾き rad。これより小さい傾きでは比例して弱める */
const ROLL_FULL = (30 * Math.PI) / 180
/** ピッチの指令をいっぱいに入れる上下の角 rad */
const PITCH_FULL = (10 * Math.PI) / 180
/** 機首を水平線へ戻し始める傾き rad。これより傾いていれば、まず翼を水平にする */
const PITCH_BANK_LIMIT = (45 * Math.PI) / 180
/** パイロットの操作とみなす入力の大きさ。これを超えるとオートパイロットが切れる */
export const AUTOPILOT_OVERRIDE = 0.1

function clamp1(v: number): number {
  return v < -1 ? -1 : v > 1 ? 1 : v
}

/**
 * 水平に戻すための操縦の指令。
 *
 * @param bank 機体の傾き rad。右へ傾いて正（`InputState.roll` の +1 が右バンク）
 * @param climb 飛んでいる向きの上下の角 rad。上り坂で正
 */
export function autopilotCommand(bank: number, climb: number): { roll: number; pitch: number } {
  const roll = clamp1(-bank / ROLL_FULL)
  // 大きく傾いているあいだは引かない。引くと水平ではなく横へ曲がる
  const pitch = Math.abs(bank) < PITCH_BANK_LIMIT ? clamp1(-climb / PITCH_FULL) * Math.cos(bank) : 0
  return { roll, pitch }
}
