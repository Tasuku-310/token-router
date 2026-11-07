// token-router の判定ロジック(外部を呼ばない関数だけ。API なしで試験できる)。
// 判断表: docs/research/routing-table-v3.md。方針: docs/team/decisions/0007-route-by-work-stage.md。
// モデルが作業の段(work)と危険度(stakes)を答え、コードがモデルと effort を決める。
// 危険度だけではモデルを上げない。未決の判断があるときだけ一段上げる。
// 下限(L1〜L7)は上げる方向だけ。ネットワーク・プロセス・環境変数は使わない。

export const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}
const MODEL_RANK = { 'claude-haiku-5-5': 0, 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 2 }

// 判断表の行(routing-table v3 の 1 章)。[モデル, effort, ラベル, 段]
// 番号は記録と再開のために残している。v2 の行 4、6、8 は熟考(行2)にまとめたので欠番
export const ROWS = {
  1: ['sonnet', 'medium', 'Linux・軽い質問', 'chat'],
  2: ['opus', 'high', '熟考', 'deep'],
  3: ['haiku', 'low', '技術AI・軽い質問', 'chat'],
  5: ['sonnet', 'medium', 'コーディング・軽い質問', 'chat'],
  7: ['haiku', 'low', '調べもの・軽い質問', 'chat'],
  9: ['sonnet', 'high', '迷い', 'mid'],
  10: ['sonnet', 'low', '作業', 'chore'],
  11: ['sonnet', 'medium', '実装', 'build'],
  12: ['opus', 'medium', '通常の推論', 'think'],
}
export const KINDS = ['linux', 'coding', 'research', 'tech']
export const WORKS = ['chat', 'chore', 'build', 'think', 'deep']
const WORK_WORD = { chat: '軽い質問', chore: '作業', build: '実装', think: '通常の推論', deep: '熟考' }
const CHAT_ROW = { linux: 1, tech: 3, coding: 5, research: 7 }
const WORK_ROW = { chore: 10, build: 11, think: 12, deep: 2 }
const RANK = { chat: 0, chore: 1, build: 2, mid: 3, think: 4, deep: 5 }

export const rowTier = (row) => ROWS[row]?.[3]
export const rowOf = (work, kind) => (work === 'chat' ? CHAT_ROW[kind] ?? 1 : WORK_ROW[work] ?? 9)
// Opus の段か(短い依頼の下限 L3 と、前回の回答の末尾を添える条件に使う)
export const isUpperRow = (row) => RANK[rowTier(row)] >= RANK.think

// 行から決定の形を作る。extra は source などの追加項目
export function make(row, extra = {}) {
  const r = ROWS[row] ? row : 9
  const [m, effort, label, tier] = ROWS[r]
  return { row: r, model: MODELS[m], effort, label, tier, ...extra }
}

// ---- 規則で先に決める範囲。利用者の明示に従うか、危険なコマンドを Opus に上げるだけ ----

const TEST_NOTE = /〔試験:[^〕]*〕/g
export const stripNote = (text) => String(text ?? '').replace(TEST_NOTE, '')

const TAG = /^\[(opus|sonnet|haiku)\]/i
const TAG_ROW = { opus: 2, sonnet: 11, haiku: 3 }
const ULTRA = /\bultrathink\b|opus\s*で/i

// コマンドなら引数の先頭、そうでなければ依頼文の先頭を見る
function headOf(text) {
  const t = String(text ?? '').trim()
  const m = /^\/\S+\s+([\s\S]*)$/.exec(t)
  return (m ? m[1] : t).trimStart()
}

// 先頭の [opus] [sonnet] [haiku]。なければ undefined。失敗時の指定の確認にも使う
export function explicitTag(text) {
  return TAG.exec(headOf(stripNote(text)))?.[1].toLowerCase()
}

// 被害の大きい操作のコマンドの形(単語だけでは当てない)
const DANGER = [
  /\brm\s+(?:-\S*\s+)*-[a-zA-Z]*[rR]/,
  /\brm\s+(?:\S+\s+)*--recursive/,
  /\bdd\s+(?:\w+=\S+\s+)*(?:if|of)=/,
  /\bmkfs/,
  /\b(?:fdisk|sgdisk|gdisk|cfdisk|parted|wipefs|shred)\b/,
  /\bpacman\s+(?:--remove|-[a-zA-Z]*R)/, // -R… (大文字小文字を区別する)
  /\bpacman\s+-[a-zA-Z]*S[a-zA-Z]*u/, // -Syu など
  /\bgit\s+push\s+(?:\S+\s+)*(?:--force\b|--force-with-lease|-f\b)/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+(?:\S+\s+)*-[a-zA-Z]*f/,
  /\bgit\s+filter-(?:repo|branch)/,
  /\b(?:chmod|chown)\s+(?:\S+\s+)*-[a-zA-Z]*R/,
  /\bcurl\b[^\n|]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/,
]

// 例外: 短い「〜って何?」の形は、規則でなくモデルに回す(最低でも中。L6)
const EXCEPTION_TAIL = /(?:とは|って何|ってなに|の意味|どういう意味|何をする)[?？の。]*\s*$/
const EXCEPTION_MAX = 60

// 分類に向けた文面の検出語(上げる方向だけの下限 L5 に使う)
const INJECT = [
  /\b(?:chat|chore|build|think|deep)\b\s*(?:と|に)\s*(?:答え|判定|分類)/i,
  /\b(?:work|stakes|followup)["']?\s*[:=：＝]/i,
  /JSON\s*(?:だけ|のみ)|only\s+JSON|JSON\s+only/i,
  /\bignore\s+(?:the\s+)?(?:all\s+|any\s+)?(?:previous|above|prior|all)\b/i,
  /指示を無視|system\s*prompt|システムプロンプト/i,
]

// 戻り値: { hit, flags }。hit は規則で決まったとき { ...make(row), source, reason, explicit? }、なければ null
// flags: { inject, exception }(L5、L6 に使う)
export function preRule(text) {
  const t = stripNote(text).trim()
  const inject = INJECT.some((re) => re.test(t))
  const danger = DANGER.some((re) => re.test(t))
  const exception = danger && t.length <= EXCEPTION_MAX && EXCEPTION_TAIL.test(t)
  const flags = { inject, exception }
  const tag = TAG.exec(headOf(t))?.[1].toLowerCase()
  if (tag) return { hit: make(TAG_ROW[tag], { source: 'tag', reason: '指定: ' + tag, explicit: true }), flags }
  if (ULTRA.test(t)) return { hit: make(2, { source: 'rule', reason: '規則: 深く考える指定' }), flags }
  if (danger && !exception) return { hit: make(12, { source: 'rule', reason: '規則: 危険な操作' }), flags }
  return { hit: null, flags }
}

// ---- モデルの答えの検証。記録に自由文を入れないための関門 ----

// 戻り値: { kind, work, stakes, followup } か、読めなければ null
export function parseJudge(reply) {
  try {
    const s = String(reply ?? '')
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    const o = JSON.parse(s.slice(a, b + 1))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    if (!WORKS.includes(o.work)) return null
    if (!Number.isInteger(o.stakes) || o.stakes < 0 || o.stakes > 2) return null
    return { kind: KINDS.includes(o.kind) ? o.kind : 'linux', work: o.work, stakes: o.stakes, followup: o.followup === true }
  } catch {
    return null
  }
}

// ---- 段と危険度から行へ ----

// 危険度2のとき、未決の判断がある段だけ一段上げる。作業(chore)と熟考(deep)は変えない。
// 軽い質問は、外れると困るなら Haiku で答えない(実装の段に上げる)
const STAKES_UP = { chat: 'build', build: 'think', think: 'deep' }

export function raisedWork(work, stakes) {
  return stakes === 2 ? STAKES_UP[work] ?? work : work
}

// ---- 下限 L1〜L7 を当てて行を決める。どれも上げる方向だけ ----
// ctx: { prevRow?, prevUnknown?, textLen?, flags?: { inject, exception, commandArgs } }
//   prevRow: 直前の判定の行。prevUnknown: 前のターンがあるのに prevRow を読めない(L4)
export function decide(parsed, ctx = {}) {
  const { prevRow, prevUnknown = false, textLen = 0, flags = {} } = ctx
  const work = raisedWork(parsed.work, parsed.stakes)
  let best = { id: null, row: rowOf(work, parsed.kind) }
  const rankOf = (row) => RANK[rowTier(row)]

  const unknown = prevRow === undefined && prevUnknown
  const pRow = prevRow ?? (unknown ? WORK_ROW.deep : undefined) // 読めないときは熟考とみなす
  const noPrev = pRow === undefined
  const id = (n) => (unknown ? 'L4' : n)
  const floors = []
  // 中身の分からない返事を軽い質問にしない(Haiku で計画を実行しない)。作業や実装と判定できたものは、その中身を信じる
  if (parsed.followup && !noPrev && parsed.work === 'chat') floors.push({ id: id('L1'), row: WORK_ROW.build })
  if (parsed.followup && noPrev) floors.push({ id: 'L2', row: 9 }) // 分からない続きは中
  if (!parsed.followup && !noPrev && isUpperRow(pRow) && textLen <= 80 && parsed.work === 'chat') floors.push({ id: id('L3'), row: WORK_ROW.build })
  if (flags.inject) floors.push({ id: 'L5', row: 9 })
  if (flags.exception) floors.push({ id: 'L6', row: 9 })
  if (flags.commandArgs) floors.push({ id: 'L7', row: 9 })

  const applied = []
  for (const f of floors) {
    if (rankOf(f.row) > rankOf(best.row)) {
      applied.push(f.id)
      best = f
    }
  }
  const reason = reasonOf(parsed, work) + (applied.length ? '、下限' + applied.join('・') : '')
  return make(best.row, { source: 'model', kind: parsed.kind, work: parsed.work, stakes: parsed.stakes, followup: parsed.followup, reason, floors: applied })
}

// 理由はコードが作る(モデルの文章は使わない)
export function reasonOf(parsed, work = parsed.work) {
  return '判定 ' + WORK_WORD[parsed.work] + '、危険度' + parsed.stakes + (work !== parsed.work ? 'で' + WORK_WORD[work] + 'に引き上げ' : '')
}

// ---- 判定できなかったとき。公式の既定と同じ Opus/medium で進める ----

const FAIL_WORD = { timeout: '時間切れ', empty: '空の答え', format: '形式', refused: '送信不可', internal: '内部エラー' }

// why: 'timeout' | 'api-error:<status>:<error>' | 'empty' | 'format' | 'refused' | 'internal'
export function failWord(why) {
  const w = String(why ?? '')
  if (FAIL_WORD[w]) return FAIL_WORD[w]
  if (w.startsWith('api-error:')) {
    const e = w.split(':')[2]
    return e && e !== 'unknown' ? e : 'APIエラー'
  }
  return FAIL_WORD.internal
}

export function failed(why) {
  const known = FAIL_WORD[why] || /^api-error:(\d{1,3}|none):[a-z_]{1,40}$/.test(String(why))
  const fail = known ? why : 'internal'
  return make(12, { source: 'failed', fail, reason: '判定できず(' + failWord(fail) + ')' })
}

// 判定の処理が例外になったとき。依頼に明示の指定があれば守り、なければ失敗(Opus/medium)
export function fallbackFor(tag) {
  if (TAG_ROW[tag]) {
    return make(TAG_ROW[tag], { source: 'failed', fail: 'internal', explicit: true, reason: '判定できず(内部エラー)、指定を守る' })
  }
  return failed('internal')
}

// api-error の理由を記録用の短い語にする。エラー本文は使わない
export function apiFail(status, error) {
  const s = Number.isInteger(status) && status >= 100 && status <= 599 ? String(status) : 'none'
  const e = typeof error === 'string' && /^[a-z_]{1,40}$/.test(error) ? error : 'unknown'
  return 'api-error:' + s + ':' + e
}

// ---- 切替ガード(ADR-0002、ADR-0007)。上げるのは自由、下げるのは得になるときだけ ----
// モデルを替えると会話全体を読み直すが、effort を替えてもキャッシュは保たれる。
// 短い仕事ほど読み直しの費用を取り戻せないので、段ごとに据え置く文脈の大きさを変える。

// 文脈がこのトークン数以上で温かければ、モデルを据え置いて effort だけ下げる
export const HOLD_TOKENS = {
  haiku: 80000, // Haiku への切り替え。損得が未確定なので v2 の値のまま(routing-review-20261107.md 4章)
  short: 10000, // 短く終わる段(作業、軽い質問)
  long: 40000, // 出力が長くなりうる段(実装など)
}
export const COLD_MINUTES = 60 // キャッシュの寿命(サブスクの主会話は1時間)

export function holdLimit(d) {
  if (d.model === MODELS.haiku) return HOLD_TOKENS.haiku
  return d.tier === 'chore' || d.tier === 'chat' ? HOLD_TOKENS.short : HOLD_TOKENS.long
}

// d: 判定の結果、prev: 直前に適用した { model, effort }(なければ undefined)
// st: { contextTokens?, idleMin? }
export function guard(d, prev, st = {}) {
  const out = { model: d.model, effort: d.effort, held: false }
  if (!prev || (MODEL_RANK[d.model] ?? 0) >= (MODEL_RANK[prev.model] ?? 0)) return out
  const small = (st.contextTokens ?? 0) < holdLimit(d)
  const cold = (st.idleMin ?? 0) >= COLD_MINUTES
  if (small || cold) return out
  // 温かい会話: モデルは替えず、effort だけ下げる(キャッシュは保たれる)。
  // 判定の effort をそのまま Opus に持ち込むと Sonnet/high が Opus/high に化けるので、据え置きでは medium までにする
  return { model: prev.model, effort: d.effort === 'low' ? 'low' : 'medium', held: true }
}
