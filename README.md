# token-router

Claude Code の依頼ごとに、作業の段を判定してモデルと effort(考える深さ)を自動で切り替えるプラグインです。考える仕事は Opus、決まった作業は Sonnet や Haiku に振り分けます。VS Code でも端末でも動きます。

**判断が複数絡む依頼は最初から Opus / high、普通の判断は Opus / medium で動かす**ことを優先しています。手順が決まった作業には Opus / high を使いません。費用の節約が第一の目的ではありません。

*English summary: A Claude Code plugin (mod) that classifies each request with a small Haiku call and switches the main conversation's model and effort. Reasoning goes to Opus, settled execution goes to Sonnet or Haiku, and Opus/high is kept for hard judgment. The classifying prompt and messages are in Japanese. Personal project; support is not guaranteed.*

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
1. 依頼を送ると、Haiku が「作業の段」と「間違えたときの危険度」を答えます。危険度は 0(すぐやり直せる)から 2(環境が壊れる、データが消える、意図せず公開するなど)です。
2. コードが段からモデルと effort を決めます。

| 段 | 内容 | モデル / effort |
|---|---|---|
| 熟考 | 判断が複数絡む、原因が不明(設計、比較と推奨、原因不明の不具合) | Opus / high |
| 通常の推論 | 普通の判断がある(相談、方針選び、仕組みの説明) | Opus / medium |
| 実装 | 中身が決まった制作(合意済みの実装、内容が決まった文書の書き換え) | Sonnet / medium |
| 作業 | 手順が決まった実行(commit、push、導入) | Sonnet / low |
| 軽い質問 | 外れても困らない(用語の確認、雑談) | Haiku / low(Linux とコーディングは Sonnet / medium。画面には `Linux・軽い質問` のように出る) |

3. 危険度だけではモデルを上げません。危険度が2で、まだ決まっていない判断があるときだけ一段上げます。手順が決まった作業は、危険度が高くても上げません。実行前の確認は Claude Code の権限の確認に任せます。
4. 表は会話の最初や、文脈(これまでの会話の量)が小さいときの選び方です。モデルを替えると、キャッシュ(読み込み済みの会話の再利用)が使えず会話全体を読み直して高くつくので、文脈が大きいときはモデルを替えず effort だけ下げます。たとえば Opus の会話の途中の push は `opus/low` で動きます。

判定に失敗したときは Opus / medium で進みます。`rm -rf` のような危険な操作は、判定せず Opus / medium にします。

### 期待どおりの例
| 依頼 | 出る組み合わせ |
|---|---|
| 3案を比べて推奨を決めて | `opus/high` |
| モニタの左右を直したい。どうすればいい? | `opus/medium` |
| この計画で go(会話の途中で文脈が小さいとき) | `sonnet/medium` |
| push して(会話の最初) | `sonnet/low` |
| push して(Opus の会話の途中で文脈が大きいとき) | `opus/low` |
| temperature ってなに? | `haiku/low` |

## 普段やること
**何もしなくて大丈夫です。** 普段どおりに依頼を送ると、判定が済んだ時点で、応答の前に1行が出ます。

```
ルーター: 行12 通常の推論 → opus/medium(判定 通常の推論、危険度1)
```

判定のために毎回 Haiku を1回呼びます。1〜3秒ほど待ち、枠も少し使います。

## 1行の読み方
| 部分 | 意味 |
|---|---|
| `行12 通常の推論` | 最終の段。`迷い` は判定しなかった入力や、下限で引き上げた場合で、失敗ではない |
| `opus/medium` | 実際に使うモデルと effort |
| `判定 通常の推論、危険度1` | Haiku の答え。最終の段と違うときは、仕組みが上げた印。`危険度2で熟考に引き上げ` は危険度2で段を上げた印 |
| `下限L1` など | 軽くなりすぎないよう、仕組みが引き上げた印。L1 は「中身の分からない返事なので実装の段にした」。L3 は「Opus の話の直後の短い質問なので実装の段にした」 |
| `規則: 危険な操作` | `rm -rf` などを見つけたので、判定せず Opus/medium にした |
| `規則: 深く考える指定` | 依頼に `ultrathink` や「opus で」があったので、Opus/high にした |
| `指定: opus` | 先頭の `[opus]` などに従った |
| `文脈が大きいので opus のまま` | 読み直しを避けるためにモデルを替えず、effort だけ下げた。`opus/low` などはこの場合に出る。effort は medium 以下になる |
| `判定できず(…)` | 判定に失敗したので、Opus/medium で進めた。そのまま使ってよい |

`行12` の番号は内部の番号です。そのほかの印(L2、L4〜L7 など)も仕組みの補足で、対応は要りません。

## 判定が合わないとき
判定は完璧ではありません。未公開の依頼24件を各3回流した試験では、段の一致は 92% で、作業と実装と軽い質問が Opus/high になったのは0回でした。一方で、深い依頼が Opus/medium になることがあります(6件中1件が3回とも)。

**依頼の先頭に指定を付けて送り直します。** その回だけ効きます。


| 付けるもの | 使うモデル | 使う場面 |
|---|---|---|
| `[opus]` | Opus / high | 軽すぎたとき。大事な判断を確実に深く考えてほしいとき |
| `[sonnet]` | Sonnet / medium | 重すぎたとき。枠を節約したいとき。会話の途中でも必ず切り替わるので、文脈が大きいと読み直しの分だけ高くつく |
| `[haiku]` | Haiku / low | 用語の確認など、簡単なとき |

例: `[opus] この3つの設計案を比べて、推奨を決めて`

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
- **判定の精度:** 未公開の依頼24件(各3回、計72回)で段の一致は 92%(基準 80%)、期待が軽い依頼の Opus/high は0回でした。深い依頼の Opus/high は 15/18 回で、作者の基準(全件)に届いていません。作者は承知のうえで使いながら直しています。
- **費用の試算:** モデルを替えるかどうかの条件は、API の定価からの試算です。Pro の枠の数え方は公開されていません。
- **枠の消費:** 依頼ごとに Haiku を1回呼びます。実測は、入力 約80〜250、出力は中央値 約30、平均 約90(長いと400超)、キャッシュの読み出しか書き込み 約2,100 トークンです。Pro の枠にどう数えられるかは公開されていません。
- **更新で壊れる可能性:** Claude Code の mod は変更の速い機能です。
- **データ:** 判定のために、依頼文がお使いの Claude のログインで Haiku に送られます(長い依頼は先頭1,500字と末尾500字)。短い依頼、Opus の話の続き、前の判定の記録がないときは、前回の回答の末尾(最大300字)も送ります。Anthropic 以外のサーバーには送りません。token-router にネットワークのコードはありません。

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
