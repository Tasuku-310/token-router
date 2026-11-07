# token-router

Claude Code の依頼ごとに、重さを判定してモデルと effort(考える深さ)を自動で切り替えるプラグインです。VS Code でも端末でも動きます。

**大事な依頼は最初から Opus / high で動かす**ことを優先しています。費用の節約が第一の目的ではありません。

*English summary: A Claude Code plugin (mod) that scores each request with a small Haiku call and switches the main conversation's model and effort. It favors quality: important requests start on Opus/high. The scoring prompt and messages are in Japanese. Personal project; support is not guaranteed.*

> 個人用に作ったものの公開です。質問や不具合への対応は保証しません。判定の指示は、日本語の依頼と作者の使い方に合わせて調整しています。指示の中に作者の使い方の説明があり、他の人の判定は重い側に寄る可能性があります(測定はしていません)。

**動作を確かめた環境:** Arch Linux、Claude Pro、Claude Code 2.1.318〜319(端末と VS Code 拡張)。モデル ID は Claude 5.5 系に固定しているので、新しいモデルが出たらコードの修正が必要です。Team や Enterprise の環境では、組織の設定で mod の動作が制限される場合があります。

## 導入
Claude Code の版は、端末 2.1.287 以降、VS Code 拡張 2.1.299 以降が必要です。端末で次を実行し、新しい会話を始めます。

```bash
claude plugin marketplace add Tasuku-310/token-router
claude plugin install token-router@token-optimization --scope user
```

判定の記録を残したいときは、記録用のフォルダを作ります。依頼文は残らず、長さと判定の結果だけが残ります。

```bash
mkdir -p ~/.claude/token-router
```

端末に枠の使用率を出すには、[token-status-guide.md](docs/guide/token-status-guide.md) を参照してください。

## 仕組み
1. 依頼を送ると、Haiku が「影響の大きさ」「取り返しのつかなさ」「正確さの必要度」「難しさ」を 0〜2 点で採点します。
2. コードが点数から重さを決めます。どれかが2点か合計4点以上なら重い、合計2〜3点なら中、1点以下なら軽いです。
3. 重さに応じて、モデルと effort を切り替えます。

| 重さ | Linux の相談、コーディング | 技術や AI の質問、調べもの |
|---|---|---|
| 軽い | Sonnet / medium | Haiku / low |
| 中 | Sonnet / high | Sonnet / high |
| 重い | Opus / high | Opus / high |

判定に失敗したときは Opus / high で進みます。`rm -rf` のような危険な操作は、採点せず Opus / high にします。

## 普段やること
**何もしなくて大丈夫です。** 普段どおりに依頼を送ると、判定が済んだ時点で、応答の前に1行が出ます。

```
ルーター: 行4 技術AI・重い → opus/high(影響1、正確さ1、難しさ2)
```

判定のために毎回 Haiku を1回呼びます。1〜3秒ほど待ち、枠も少し使います。

## 1行の読み方
| 部分 | 意味 |
|---|---|
| `行4 技術AI・重い` | 依頼の種類と重さ。種類は Linux、技術AI、コーディング、調べもの。`迷い` は「中くらい」という意味で、失敗ではない |
| `opus/high` | 実際に使うモデルと effort |
| `影響1、正確さ1、難しさ2` | 判定の理由。影響の大きさ、取り返しのつかなさ、正確さの必要度、難しさを 0〜2 点で採点したもの。`全項目0` はすべて0点 |
| `下限L1` など | 軽くなりすぎないよう、仕組みが引き上げた印。L1 は「前の話の続きなので同じ重さにした」。L3 は「重い話の直後の短い依頼なので中にした」 |
| `規則: 危険な操作` | `rm -rf` などを見つけたので、採点せず Opus/high にした |
| `規則: 深く考える指定` | 依頼に `ultrathink` や「opus で」があったので、Opus/high にした |
| `指定: opus` | 先頭の `[opus]` などに従った。このとき `行2 Linux・重い` のように出る種類は内部の都合なので、気にしなくてよい |
| `モデルは据え置き` | 会話が大きいので、読み直しを避けるためにモデルを替えず、effort だけ下げた。Opus/medium、Opus/low、Sonnet/low になるのはこの場合だけ |
| `判定できず(…)` | 判定に失敗したので、安全側の Opus/high で進めた。そのまま使ってよい |

`行4` の番号は内部の番号です。そのほかの印(L2、L4〜L7 など)も仕組みの補足で、対応は要りません。

## 判定が合わないとき
重さの判定は完璧ではありません。試験では **3〜4回に1回は期待と違いました**(未公開の依頼12件中8〜9件が一致)。

**依頼の先頭に指定を付けて送り直します。** その回だけ効きます。


| 付けるもの | 使うモデル | 使う場面 |
|---|---|---|
| `[opus]` | Opus / high | 軽すぎたとき。「仕組みから深く説明して」のような依頼は軽く判定されやすいので、最初から付けると確実 |
| `[sonnet]` | Sonnet / medium | 重すぎたとき。枠を節約したいとき |
| `[haiku]` | Haiku / low | 用語の確認など、簡単なとき |

例: `[opus] Claude Code のキャッシュの仕組みを、腑に落ちるまで説明して`

`/model` は上書きされるので効きません。

外れの報告や不具合は [Issue](https://github.com/Tasuku-310/token-router/issues) に書けます。記録に依頼文は残らないので、依頼の要約と画面の1行を添えてください。パスワードや個人情報は書かないでください。

## 残りの枠を見る
- **端末:** 画面の下に `5時間 23% | 週 84%! | 文脈 12%` と出ます。数字は**使った割合**です(残りではありません)。
- **VS Code:** 自動では出ません。`/usage` を送ると見られます。

詳しくは [token-status-guide.md](docs/guide/token-status-guide.md) にあります。

## 止めたいとき
おかしいと思ったら、端末で次を実行して Claude Code を開き直します。切り替えが止まり、`~/.claude/settings.json` の設定どおりのモデルで動きます。すべての依頼が同じモデルになるので、枠の減り方が変わります。

```bash
claude plugin disable token-router@token-optimization --scope user
```

再開は `disable` を `enable` に変えるだけです。撤去の手順は [rollback-guide.md](docs/guide/rollback-guide.md) にあります。

## 動かなくなったとき
Claude Code の更新で動かなくなることがあります。1行が出なくなったら、次の順に進めます。

1. `claude plugin list` で状態を見る。`token-router` が disabled なら、`enable` で再開する
2. enabled なのに出ないときは、更新を試す
   ```bash
   claude plugin marketplace update token-optimization
   claude plugin update token-router@token-optimization --scope user
   ```
3. 新しい会話を始めて、1行が出るか確かめる
4. 直らなければ、上の手順で止める。作業はそのまま続けられる

## 知っておいてほしいこと
- **判定の精度:** 未公開の依頼12件での一致は8〜9件で、作者の基準(10件)に届いていません。作者は承知のうえで使いながら直しています。
- **枠の消費:** 依頼ごとに Haiku を1回呼びます。実測は、入力 約80〜400、出力は中央値 約40、平均 約90〜210(長いと300超)、キャッシュの読み出しか書き込み 約1,800 トークンです。Pro の枠にどう数えられるかは公開されていません。
- **更新で壊れる可能性:** Claude Code の mod は変更の速い機能です。
- **データ:** 判定のために、依頼文がお使いの Claude のログインで Haiku に送られます(長い依頼は先頭1,500字と末尾500字)。短い依頼、重い話の続き、前の判定の記録がないときは、前回の回答の末尾(最大300字)も送ります。Anthropic 以外のサーバーには送りません。token-router にネットワークのコードはありません。

## 似たプロジェクト
作者が読んだ範囲での違いです。

| 名前 | 違い |
|---|---|
| [AutoMode](https://github.com/mralexivy/AutoMode) | 設計が近く、機能が多い。既定では難しい依頼も Sonnet で始め、費用の節約に強い(2026-11-07、v0.10.0 時点) |
| [jev-router](https://github.com/dominicrico/jev-router) | 外部の判定サービスを使う(キーが必要) |

## 開発
```bash
node scripts/check-classify.mjs
```

単体確認です。モデルは呼びません。Node.js が必要です(22.23.4 で確認)。

## ライセンス
[MIT](LICENSE)
