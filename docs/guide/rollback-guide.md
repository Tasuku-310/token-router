# token-router の止め方と戻し方

token-router や残量表示をやめたいときの手順。端末で実行する。実行したあとは、Claude Code を開き直す(新しい会話から反映される)。

## 1. 一時的に止める
記録も残量表示もそのままで、自動の切り替えだけを止める。いつでも再開できる。

```bash
claude plugin disable token-router@token-optimization --scope user
```

再開するとき:

```bash
claude plugin enable token-router@token-optimization --scope user
```

止めている間は `settings.json` の設定どおりのモデルで動く。判定の待ち時間はなくなるが、すべての依頼が同じモデルになるので、枠の減り方が変わる。

## 2. すべて元に戻す
上から順に実行する。順番を守る理由は、先にスクリプトを消すと、存在しないスクリプトを指す設定が残るため。

1. 残量表示の設定を外す。`jq` は JSON を編集するコマンドで、`del` が項目を消す。
   ```bash
   t=$(mktemp) && jq 'del(.statusLine)' ~/.claude/settings.json > "$t" && cat "$t" > ~/.claude/settings.json; rm -f "$t"
   ```
2. 残量表示のスクリプトを消す。
   ```bash
   rm ~/.claude/statusline-token.sh
   ```
3. 判定の記録を消す。**元に戻せない。** 残したい記録があれば先に別の場所へ移す。`-r` はフォルダごと消すオプション。
   ```bash
   rm -r ~/.claude/token-router
   ```
4. token-router を外す。
   ```bash
   claude plugin uninstall token-router@token-optimization --scope user
   ```
5. 入手元の登録を外す。
   ```bash
   claude plugin marketplace remove token-optimization
   ```

6. 導入時のコピーが `~/.claude/plugins/cache/token-optimization/` に残る。動作には影響しないので、そのままでもよい。消すなら次を実行する(取得したリポジトリは消えない)。
   ```bash
   rm -r ~/.claude/plugins/cache/token-optimization
   ```

## 3. 戻ったことを確かめる
```bash
claude plugin list
jq '{model, modelSettings, statusLine, enabledPlugins}' ~/.claude/settings.json
```

- `claude plugin list` に `token-router` が出ない。
- `model` と `modelSettings` は導入前の値、`statusLine` は `null`。`enabledPlugins` は空の `{}` が残ることがあるが、無害。
- `claude` を起動して、1行の表示が出ず、普通に応答する。
