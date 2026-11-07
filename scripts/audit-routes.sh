#!/usr/bin/env bash
# 照合: mod の記録(routes-*.jsonl)と、Claude Code の会話記録(セッション jsonl)を突き合わせる。会話記録を正とする。
# 使い方: audit-routes.sh <記録先ディレクトリ> <会話記録.jsonl> [...]
# 表示するもの: 何ターン目か、判定した行、mod が適用したモデル/effort、会話記録の実際のモデル/effort、一致。
# 依頼文は表示しない。形式が読めないときはエラーで止まる(終了コード 2)。一致しない行があれば終了コード 1。
set -u
die() { echo "エラー: $*" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || die "jq がありません"
[ $# -ge 2 ] || die "使い方: $0 <記録先ディレクトリ> <会話記録.jsonl> [...]"
dir="$1"; shift
[ -d "$dir" ] || die "記録先がありません: $dir"
short() { sed -E 's/^claude-//; s/-5-5$//'; }
bad=0
echo "| セッション | ターン | 行 | mod の適用 | 実際(会話記録) | 一致 |"
echo "|---|---|---|---|---|---|"
for t in "$@"; do
  [ -r "$t" ] || die "読めません: $t"
  sid="$(basename "$t" .jsonl)"
  # 会話記録: 本物の利用者入力(sidechain でも meta でも tool_result でもない user 行)でターンを区切り、
  # 各ターンの最後の主会話 assistant 行の model と perTurnEffort(なければ effort)を取る。
  actual="$(jq -s -c '
    reduce .[] as $r ({n:0, out:[]};
      if $r.type=="user" and ($r.isSidechain!=true) and ($r.isMeta!=true)
         and (($r.message.content|type)=="string" or (($r.message.content|map(.type))|index("tool_result")|not))
      then .n+=1 | .out+=[null]
      elif $r.type=="assistant" and ($r.isSidechain!=true) and .n>0
      then .out[-1]={model:$r.message.model, effort:($r.perTurnEffort // $r.effort)}
      else . end) | .out' "$t" 2>/dev/null)" || die "会話記録を読めません(形式が変わった可能性): $t"
  [ "$(jq 'type' <<<"$actual" 2>/dev/null)" = '"array"' ] || die "会話記録の形式が想定と違います: $t"
  routes="$(cat "$dir"/routes-*-"$sid".jsonl 2>/dev/null | jq -s -c 'sort_by(.ts)' 2>/dev/null)" || die "routes の記録を読めません: $dir"
  [ -n "$routes" ] || routes='[]'
  nr="$(jq 'length' <<<"$routes")"; na="$(jq 'length' <<<"$actual")"
  [ "$nr" -eq 0 ] && { echo "| ${sid:0:8} | - | - | (記録なし) | ${na}ターン | 照合不可 |"; bad=1; continue; }
  if [ "$nr" -ne "$na" ]; then
    echo "注意: ${sid:0:8} は mod の記録が ${nr} ターン、会話記録が ${na} ターン。ターン数が違うため、順に対応づけた結果は参考値" >&2
  fi
  rows="$(jq -r -n --argjson r "$routes" --argjson a "$actual" --arg s "${sid:0:8}" '
    def sh: if .==null then "-" else (sub("^claude-";"")|sub("-5-5$";"")) end;
    range(0; ($r|length)) as $i | $r[$i] as $x | ($a[$i] // null) as $y |
    ($x.model|sh) as $m | (if $y==null then "-" else ($y.model|sh) end) as $am |
    "| \($s) | \($i+1) | \($x.row) | \($m)/\($x.effort) | \($am)/\($y.effort // "-") | "
    + (if $y!=null and $y.model==$x.model and $y.effort==$x.effort then "一致" else "不一致" end) + " |"')" || die "照合に失敗: $t"
  echo "$rows"
  grep -q "不一致" <<<"$rows" && bad=1
done
exit $bad
