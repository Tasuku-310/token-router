#!/usr/bin/env bash
# plugins/token-router/hooks/ の router.js と judge.js をベンチへコピーし、sha256 が同じことを確かめる。
# 使い方: scripts/bench-judge/sync.sh          (コピーして確認)
#         scripts/bench-judge/sync.sh --check  (コピーせず、同じかだけ確認。違えば終了コード 1)
set -eu
here="$(cd "$(dirname "$0")" && pwd)"
src="$here/../../plugins/token-router/hooks"
dst="$here/hooks"
[ "${1:-}" = "--check" ] || cp "$src/router.js" "$src/judge.js" "$dst/"
bad=0
for f in router.js judge.js; do
  a="$(sha256sum < "$src/$f" | cut -d' ' -f1)"
  b="$(sha256sum < "$dst/$f" | cut -d' ' -f1)"
  if [ "$a" = "$b" ]; then echo "同じ: $f ${a:0:16}"; else echo "違う: $f" >&2; bad=1; fi
done
exit "$bad"
