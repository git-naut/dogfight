#!/usr/bin/env bash
# 実 GPU の計測を負荷の低いときに 1 本ずつ、前後を交互に流す（段 S0a）。
#
# Phase 10 の govgate.sh の一般化。**実機の計測は WSL の負荷に振られる。**ほかの
# セッションの検査で負荷が 20〜40 になると、medium 固定でも 35〜40 fps に落ちる。
# 1 回ずつ負荷 1 未満を待ち、終わりの負荷も記録して、低い回だけを採る。
# **前後は交互に測る。**同じ版でも GPU 時間は 8〜17 ms 揺れる（A/A）ので、前を
# まとめて測ってから後を測ると、揺れの波を差と取り違える。
#
#   tools/perfgate.sh A 'http://…/dogfight/?debug=1&script=level' B 'http://…:4416/dogfight/?debug=1&script=level'
#   tools/perfgate.sh base 'URL'                     # 1 本だけ（基準取り）
#
# 環境変数: ROUNDS（採る回数、既定 4）、TRIES（1 本あたりの試行の上限、既定 12）、
# MEASURE_SECONDS（既定 20）は計る道具の SECONDS へ、VIEW_W・VIEW_H・DPR・WARMUP は
# そのまま渡す。**bash の SECONDS は組み込みの変数**（シェルが始まってからの秒）で、
# 同じ名前で受けると経過秒が計る長さとして渡る。
# DEST（結果の写し先、既定 ~/.claude/plans/dogfight-ocean-ref/measure）。
# TOOL（計る道具、既定 win-pass-perf.mjs）。パスの内訳を持たない古い版と比べる
# ときは TOOL=win-perf.mjs（fps・GPU 時間・降格だけ。出力は記録のテキストへ）。
#
# 結果は 1 回ごとに 2 行の JSON: 計測（win-pass-perf.mjs）と、門の記録
# `{"gate":{label,try,before,after,accepted}}`。並び順で対にする。
set -u
cd "$(dirname "$0")/.."

if [ $# -lt 2 ] || [ $(($# % 2)) -ne 0 ]; then
  echo "使い方: tools/perfgate.sh LABEL URL [LABEL URL ...]" >&2
  exit 2
fi

ROUNDS=${ROUNDS:-4}
TRIES=${TRIES:-12}
WIN=/mnt/c/Windows/Temp/dg-pw
DEST=${DEST:-$HOME/.claude/plans/dogfight-ocean-ref/measure}
STAMP=$(date +%Y%m%d-%H%M%S)
OUT_NAME=pass-perf-$STAMP.jsonl

TOOL=${TOOL:-win-pass-perf.mjs}
LOG=$WIN/perfgate-$STAMP.txt
cp tools/win-pass-perf.mjs tools/pass-stats.mjs tools/win-perf.mjs "$WIN/"

labels=()
urls=()
while [ $# -gt 0 ]; do
  labels+=("$1")
  urls+=("$2")
  shift 2
done
n=${#labels[@]}
declare -a ok tries
for ((i = 0; i < n; i++)); do ok[i]=0; tries[i]=0; done

# 負荷が 1 未満（5 分平均は 2 未満）になるまで待つ。最長 60 分
wait_quiet() {
  for _ in $(seq 1 120); do
    read -r l1 l5 _ < /proc/loadavg
    awk "BEGIN{exit !($l1 < 1 && $l5 < 2)}" && return 0
    sleep 30
  done
  echo "負荷が下がらない（60 分）" >&2
  return 1
}

while :; do
  progressed=0
  for ((i = 0; i < n; i++)); do
    [ "${ok[i]}" -ge "$ROUNDS" ] && continue
    [ "${tries[i]}" -ge "$TRIES" ] && continue
    wait_quiet || exit 1
    tries[i]=$((tries[i] + 1))
    progressed=1
    printf '%s\n' "${urls[i]}" > "$WIN/cases.txt"
    before=$(cut -d' ' -f1-3 /proc/loadavg)
    # **cmd.exe の set は引用符ごと値に入れない形で書く**（`set "K=V"`）
    timeout 300 cmd.exe /c "cd /d C:\\Windows\\Temp\\dg-pw && set \"LABEL=${labels[i]}\" && set \"OUT=$OUT_NAME\" && set \"SECONDS=${MEASURE_SECONDS:-20}\" && set \"VIEW_W=${VIEW_W:-1600}\" && set \"VIEW_H=${VIEW_H:-789}\" && set \"DPR=${DPR:-1.5}\" && set \"WARMUP=${WARMUP:-3}\" && node $TOOL" 2>&1 | grep -v '^\s*$' | tee -a "$LOG"
    after=$(cut -d' ' -f1-3 /proc/loadavg)
    a1=${after%% *}
    accepted=false
    if awk "BEGIN{exit !($a1 < 2)}"; then
      accepted=true
      ok[i]=$((ok[i] + 1))
    fi
    printf '{"gate":{"label":"%s","try":%d,"before":"%s","after":"%s","accepted":%s}}\n' \
      "${labels[i]}" "${tries[i]}" "$before" "$after" "$accepted" >> "$WIN/$OUT_NAME"
    echo "--- ${labels[i]} 試行 ${tries[i]} $(date +%T) 前 $before 後 $after 採用 $accepted" | tee -a "$LOG"
  done
  [ "$progressed" -eq 0 ] && break
done

for ((i = 0; i < n; i++)); do
  echo "${labels[i]}: 採った回 ${ok[i]} / 試行 ${tries[i]}"
done
mkdir -p "$DEST"
[ -f "$WIN/$OUT_NAME" ] && cp "$WIN/$OUT_NAME" "$DEST/"
cp "$LOG" "$DEST/"
echo "記録: $DEST/$OUT_NAME（あれば）・$DEST/$(basename "$LOG")"
