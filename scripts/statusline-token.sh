#!/usr/bin/env bash
# ステータスライン用: 5時間・週の使用率と文脈の使用率を1行で出す。
# 入力: stdin にステータスライン JSON。ルーターの判定は mod が入力欄のそばに出すので、ここでは出さない。
# 読めない・壊れているときは、その部分を -- にして正常終了する(エラーを出さない)。
input="$(cat 2>/dev/null)"
command -v jq >/dev/null 2>&1 || exit 0

pct() { # 使用率(0〜100)を整数にして、80%以上は ! を付ける。無ければ -- 
  local v="$1"
  if [[ "$v" =~ ^[0-9]+(\.[0-9]+)?$ ]]; then
    v="${v%%.*}"; [ "$v" -ge 80 ] && echo "${v}%!" || echo "${v}%"
  else echo "--"; fi
}

five="$(jq -r '.rate_limits.five_hour.used_percentage // empty' <<<"$input" 2>/dev/null)"
week="$(jq -r '.rate_limits.seven_day.used_percentage // empty' <<<"$input" 2>/dev/null)"
ctx="$(jq -r '.context_window.used_percentage // empty' <<<"$input" 2>/dev/null)"

l1="5時間 $(pct "$five") | 週 $(pct "$week")"
[ -n "$ctx" ] && l1="$l1 | 文脈 $(pct "$ctx")"
echo "$l1"

exit 0
