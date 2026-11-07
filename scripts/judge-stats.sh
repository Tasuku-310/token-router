#!/usr/bin/env bash
# 判定の集計(routes-*.jsonl の judge 項目から)。使い方: scripts/judge-stats.sh [記録先ディレクトリ]
# 記録先の既定は環境変数 TOKEN_ROUTER_DIR、なければ ~/.claude/token-router。jq だけを使う。読むだけで、何も書き換えない。
# 出すもの: 回数、失敗率、所要時間(中央値と95%点)、平均トークン、キャッシュの当たり、重さの内訳、S1〜S4 の計算し直し。
# 依頼文は記録に無いので表示しない。壊れた行は飛ばす。
set -u
dir="${1:-${TOKEN_ROUTER_DIR:-$HOME/.claude/token-router}}"
command -v jq >/dev/null 2>&1 || { echo "エラー: jq が必要です" >&2; exit 2; }
[ -d "$dir" ] || { echo "エラー: 記録先がありません: $dir" >&2; exit 2; }
shopt -s nullglob
files=("$dir"/routes-*.jsonl)
[ "${#files[@]}" -gt 0 ] || { echo "記録なし: $dir に routes-*.jsonl がありません" >&2; exit 1; }

cat "${files[@]}" | jq -R 'fromjson? | select(type=="object" and (.judge | type == "object"))' | jq -s -r '
  def tier($s; $a):
    ($a | any(. == 2)) as $two | ($a | add) as $n
    | if $s == "S1" then (if $two or $n >= 3 then "重" elif $n == 2 then "中" else "軽" end)
      elif $s == "S2" then (if $two or $n >= 4 then "重" elif $n >= 2 then "中" else "軽" end)
      elif $s == "S3" then (if $two then "重" elif $n >= 2 then "中" else "軽" end)
      else (if $two or $n >= 4 then "重" elif $n == 3 then "中" else "軽" end) end;
  def pct($p): if length == 0 then "-" else (sort | .[(((length - 1) * $p) | floor)]) end;
  def avg: if length == 0 then "-" else ((add / length) * 10 | round / 10) end;
  def cnt(f): group_by(f) | map("\(.[0] | f) \(length)") | join(" / ");
  . as $all
  | ($all | length) as $n
  | ($all | map(select(.judge.source == "model" or .judge.source == "failed"))) as $called
  | ($called | map(select(.judge.source == "failed"))) as $bad
  | ($called | map(select(.judge.ms != null) | .judge.ms)) as $ms
  | ($called | map(select(.judge.in != null))) as $u
  | ($all | map(select(.judge.source == "model" and (.judge.axes | type == "array")))) as $m
  | "ターン数: \($n)(判定の種類: \($all | cnt(.judge.source)))",
    "モデルを呼んだ回数: \($called | length)  失敗: \($bad | length)  失敗率: \(if ($called | length) == 0 then "-" else (($bad | length) * 1000 / ($called | length) | round / 10 | tostring) + "%" end)(5% を超えたら見直す)",
    "失敗の内訳: \(if ($bad | length) == 0 then "なし" else ($bad | cnt(.judge.fail)) end)",
    "所要時間 ms: 中央値 \($ms | pct(0.5))  95%点 \($ms | pct(0.95))  最大 \($ms | max // "-")",
    "平均トークン: 入力 \($u | map(.judge.in) | avg)  出力 \($u | map(.judge.out) | avg)  キャッシュ読み \($u | map(.judge.cacheRead) | avg)  キャッシュ書き \($u | map(.judge.cacheWrite) | avg)",
    "キャッシュの当たり(読み/(入力+読み+書き)): \(($u | map(.judge.in + .judge.cacheRead + .judge.cacheWrite) | add) as $t | if ($t // 0) == 0 then "-" else (($u | map(.judge.cacheRead) | add) * 1000 / $t | round / 10 | tostring) + "%" end)",
    "重さの内訳(採用した結果): \($all | map(select(.judge.tier != null)) | cnt(.judge.tier))",
    "Opus/high になった回数: \($all | map(select(.model == "claude-opus-5-5" and .effort == "high")) | length) / \($n)",
    "下限が効いた回数: \($all | map(.judge.floors // []) | add // [] | if length == 0 then "なし" else (group_by(.) | map("\(.[0]) \(length)") | join(" / ")) end)",
    "",
    "しきい値の計算し直し(モデルの採点があったターンだけ: \($m | length) 件。下限は含まない)",
    "| 案 | 重 | 中 | 軽 | 合計点だけで重 |",
    "|---|---|---|---|---|",
    (["S1","S2","S3","S4"][] as $s
      | ($m | map(tier($s; .judge.axes))) as $t
      | ($m | map(select((.judge.axes | any(. == 2) | not) and tier($s; .judge.axes) == "重")) | length) as $only
      | "| \($s) | \($t | map(select(. == "重")) | length) | \($t | map(select(. == "中")) | length) | \($t | map(select(. == "軽")) | length) | \($only) |")
'
