# 枠の使用率の見方

Opus / high を安心して使えるかを判断するための、端末の表示の読み方です。token-router 全体の使い方は [README.md](../../README.md) にあります。

## 1. どこに出るか
```
5時間 23% | 週 84%! | 文脈 12%
```

- **端末:** `claude` の画面の下に自動で出ます。最初の応答のあとに数字が入ります。
- **VS Code:** チャット欄には出ません。`/usage` を送ると、使用量のバーで見られます。

**設定の手順:** プラグインを入れただけでは出ません。`jq`(JSON を扱うコマンド)が必要です。Arch Linux なら `sudo pacman -S jq` で入ります。次のコマンドでスクリプトを置き、設定に追加します(`mktemp` は一時ファイルを安全に作るコマンド)。すでに `statusLine` を設定している場合は上書きされます。

```bash
git clone https://github.com/Tasuku-310/token-router.git
cp token-router/scripts/statusline-token.sh ~/.claude/statusline-token.sh
chmod +x ~/.claude/statusline-token.sh
t=$(mktemp) && jq '.statusLine={type:"command",command:"~/.claude/statusline-token.sh"}' ~/.claude/settings.json > "$t" && cat "$t" > ~/.claude/settings.json; rm -f "$t"
```

## 2. 数字の意味
数字はすべて**使った割合**です。`23%` は「残り 23%」ではなく「23% 使った」という意味です。

| 表示 | 意味 |
|---|---|
| `5時間` | 直近の5時間枠の使用率。使い切ると次の区切りまで待ちます |
| `週` | 1週間の枠の使用率。5時間枠とは別にあります |
| `文脈` | 今の会話(コンテキスト)が入れ物の何%を占めるか。大きいほど、1回の応答で使う量が増えます |
| `!` | 80% 以上の印 |
| `--` | まだ数字がありません。最初の応答の前によく出ます。壊れてはいません |

## 3. 何%で気をつけるか
目安は **80%** です。公式の数字ではなく、作者が決めた暫定の目安なので、使いながら変えられます。

**token-router は枠の残りを見ません。** 枠が減っても、自動で軽いモデルには切り替わらないので、次のように対応します。

| 状況 | 対応 |
|---|---|
| 5時間が 80% 以上 | 重い作業は次の区切りまで待つ。急がない依頼には先頭に `[sonnet]` や `[haiku]` を付ける |
| 週が 80% 以上 | 週の残りを考えて、重くない依頼に `[sonnet]` を付ける |
| 文脈が大きい | 話題が変わるときは新しい会話を始める |

両方に余裕があれば、重い依頼は気にせず送って大丈夫です。

## 4. 表示がおかしいとき
| 症状 | 考えられること | 確かめ方 |
|---|---|---|
| 表示全体が出ない | `jq` がない、またはスクリプト(表示用の小さなプログラム)を実行できない | `command -v jq` と、下の「手で試す」 |
| ずっと `--` | Pro / Max 以外の契約、または数字が渡されない版 | `/usage` と比べる |
| 判定の1行が出ない | token-router(mod という Claude Code の拡張機能)が読み込まれていない | `claude plugin list` |
| 1行と実際のモデルが違う気がする | 切り替えが効いていない | 下の「実際のモデルを照合する」 |

**手で試す:**
```bash
echo '{"rate_limits":{"five_hour":{"used_percentage":23.5},"seven_day":{"used_percentage":84.2}}}' | ~/.claude/statusline-token.sh
```
`5時間 23% | 週 84%!` と出れば、スクリプトは正常です。

**実際のモデルを照合する:** 判定の記録と Claude Code の会話記録を比べます。依頼文は表示しません。
```bash
cd token-router   # 取得したリポジトリのフォルダへ移動する
bash scripts/audit-routes.sh ~/.claude/token-router "$(ls -t ~/.claude/projects/*/*.jsonl | head -1)"
```

| 結果 | 意味 |
|---|---|
| `一致` | 判定どおりに動いています |
| `不一致` | 切り替えが効いていません。[README](../../README.md) の「動かなくなったとき」へ |
| `照合不可` | その会話の判定の記録がありません。token-router が動く前の会話や、token-router を読み込まない会話で出ます |
| `エラー: 会話記録を読めません` | Claude Code の更新で記録の形式が変わった可能性があります。Claude に調査を頼みます |

判定の記録は `~/.claude/token-router/` にあります。依頼文は残らず、長さだけが残ります。

## 5. 公式の情報か
公式の機能だけを使っています(非公式の取得方法は使っていません)。

- ステータス表示に使用率(`rate_limits`)が渡されること。Pro / Max の契約者だけで、最初の応答のあとに出ること: https://code.claude.com/docs/en/statusline (確認日 2026-11-07)
- Pro の枠が Web、端末、IDE で共有されること: https://support.claude.com/en/articles/11145838 (確認日 2026-11-06)
- VS Code の `/usage`: https://code.claude.com/docs/en/vs-code (確認日 2026-11-07)
- 枠の具体的な量、Opus が Sonnet の何倍使うかは公開されていません。表示される%だけが頼りです(確認日 2026-11-06)。
- 項目名が変わると `--` になるだけで、作業は止まりません。戻し方は [rollback-guide.md](rollback-guide.md) にあります。
