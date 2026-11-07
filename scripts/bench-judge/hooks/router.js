// token-router の判定ロジック(外部を呼ばない関数だけ。API なしで試験できる)。
// 設計: docs/team/03-design.md 6.1(判定)、6.5(失敗)。判断表: docs/research/routing-table-v1.md(v2 の内容)。
// モデルが採点し、コードが重さを決める。規則やキーワードで「軽い」と決める経路はない。
// 下限(L1〜L7)は上げる方向だけ。ネットワーク・プロセス・環境変数は使わない。

export const MODELS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}
const MODEL_RANK = { 'claude-haiku-5-5': 0, 'claude-sonnet-5-5': 1, 'claude-opus-5-5': 2 }

// 判断表の行(routing-table v2 の 1 章)。[モデル, effort, ラベル, 重さ]
export const ROWS = {
  1: ['sonnet', 'medium', 'Linux・軽い', 'light'],
  2: ['opus', 'high', 'Linux・重い', 'heavy'],
  3: ['haiku', 'low', '技術AI・軽い', 'light'],
  4: ['opus', 'high', '技術AI・重い', 'heavy'],
  5: ['sonnet', 'medium', 'コーディング・軽い', 'light'],
  6: ['opus', 'high', 'コーディング・重い', 'heavy'],
  7: ['haiku', 'low', '調べもの・軽い', 'light'],
  8: ['opus', 'high', '調べもの・重い', 'heavy'],
  9: ['sonnet', 'high', '迷い', 'mid'],
}
export const KINDS = ['linux', 'coding', 'research', 'tech']
const HEAVY_ROW = { linux: 2, tech: 4, coding: 6, research: 8 }
const LIGHT_ROW = { linux: 1, tech: 3, coding: 5, research: 7 }
const RANK = { light: 0, mid: 1, heavy: 2 }

export const AXES = ['impact', 'undo', 'precision', 'difficulty']
const AXIS_WORD = ['影響', '取り返し', '正確さ', '難しさ']

export const rowTier = (row) => ROWS[row]?.[3]

// 行から決定の形を作る。extra は source などの追加項目
export function make(row, extra = {}) {
  const r = ROWS[row] ? row : 9
  const [m, effort, label, tier] = ROWS[r]
  return { row: r, model: MODELS[m], effort, label, tier, ...extra }
}

// ---- 規則で先に決める範囲(6.1.5)。上げるか、利用者の明示に従うだけ ----

const TEST_NOTE = /〔試験:[^〕]*〕/g
export const stripNote = (text) => String(text ?? '').replace(TEST_NOTE, '')

const TAG = /^\[(opus|sonnet|haiku)\]/i
const TAG_ROW = { opus: 2, sonnet: 1, haiku: 3 }
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

// 採点に向けた文面の検出語(上げる方向だけの下限 L5 に使う)
const INJECT = [
  /採点|全項目|点数を/,
  /(?:impact|undo|precision|difficulty|followup)["']?\s*[:=：＝]/i,
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
  if (danger && !exception) return { hit: make(2, { source: 'rule', reason: '規則: 危険な操作' }), flags }
  return { hit: null, flags }
}

// ---- モデルの答えの検証(6.1.2)。記録に自由文を入れないための関門 ----

// 戻り値: { kind, impact, undo, precision, difficulty, followup } か、読めなければ null
export function parseJudge(reply) {
  try {
    const s = String(reply ?? '')
    const a = s.indexOf('{')
    const b = s.lastIndexOf('}')
    if (a < 0 || b <= a) return null
    const o = JSON.parse(s.slice(a, b + 1))
    if (!o || typeof o !== 'object' || Array.isArray(o)) return null
    const out = {}
    for (const k of AXES) {
      if (!Number.isInteger(o[k]) || o[k] < 0 || o[k] > 2) return null
      out[k] = o[k]
    }
    out.kind = KINDS.includes(o.kind) ? o.kind : 'linux'
    out.followup = o.followup === true
    return out
  } catch {
    return null
  }
}

// ---- 点数から重さへ(6.1.4)。しきい値 S1〜S4 は切り替えられる ----

export const SCHEMES = ['S1', 'S2', 'S3', 'S4']
export const schemeOf = (s) => (SCHEMES.includes(s) ? s : 'S1')

// axes: [impact, undo, precision, difficulty]。戻り値: 'heavy' | 'mid' | 'light'
export function tierOf(axes, scheme = 'S1') {
  const two = axes.includes(2)
  const sum = axes.reduce((a, b) => a + b, 0)
  switch (schemeOf(scheme)) {
    case 'S2':
      return two || sum >= 4 ? 'heavy' : sum >= 2 ? 'mid' : 'light'
    case 'S3':
      return two ? 'heavy' : sum >= 2 ? 'mid' : 'light'
    case 'S4':
      return two || sum >= 4 ? 'heavy' : sum >= 3 ? 'mid' : 'light'
    default: // S1
      return two || sum >= 3 ? 'heavy' : sum >= 2 ? 'mid' : 'light'
  }
}

// どの項目も 2 点でなく、合計点だけで重になったか(7.2 の報告用)
export const heavyBySumOnly = (axes, scheme) => !axes.includes(2) && tierOf(axes, scheme) === 'heavy'

export function rowOf(tier, kind) {
  if (tier === 'heavy') return HEAVY_ROW[kind] ?? 2
  if (tier === 'light') return LIGHT_ROW[kind] ?? 1
  return 9
}

// ---- 下限 L1〜L7 を当てて行を決める(6.1.6)。どれも上げる方向だけ ----
// ctx: { prevRow?, prevUnknown?, textLen?, flags?: { inject, exception, commandArgs }, scheme? }
//   prevRow: 直前の判定の行。prevUnknown: 前のターンがあるのに prevRow を読めない(L4)
export function decide(parsed, ctx = {}) {
  const { prevRow, prevUnknown = false, textLen = 0, flags = {}, scheme = 'S1' } = ctx
  const axes = AXES.map((k) => parsed[k])
  const baseTier = tierOf(axes, scheme)
  let best = { id: null, row: rowOf(baseTier, parsed.kind) }
  const rankOf = (row) => RANK[rowTier(row)]

  const unknown = prevRow === undefined && prevUnknown
  const pRow = prevRow ?? (unknown ? HEAVY_ROW[parsed.kind] ?? 2 : undefined) // 読めないときは重とみなす
  const noPrev = pRow === undefined
  const id = (n) => (unknown ? 'L4' : n)
  const floors = []
  if (parsed.followup && pRow !== undefined) floors.push({ id: id('L1'), row: pRow, wins: true }) // 続きを下げない。種類も直前のもの
  if (parsed.followup && noPrev) floors.push({ id: 'L2', row: 9 }) // 分からない続きは中
  if (pRow !== undefined && rowTier(pRow) === 'heavy' && textLen <= 80) floors.push({ id: id('L3'), row: 9 })
  if (flags.inject) floors.push({ id: 'L5', row: 9 })
  if (flags.exception) floors.push({ id: 'L6', row: 9 })
  if (flags.commandArgs) floors.push({ id: 'L7', row: 9 })

  const applied = []
  for (const f of floors) {
    const higher = rankOf(f.row) > rankOf(best.row)
    if (higher || (f.wins && rankOf(f.row) === rankOf(best.row))) {
      if (higher) applied.push(f.id)
      best = f
    }
  }
  const reason = reasonOf(axes) + (applied.length ? '、下限' + applied.join('・') : '')
  return make(best.row, { source: 'model', kind: parsed.kind, axes, followup: parsed.followup, reason, floors: applied })
}

// 理由はコードが点数から作る(モデルの文章は使わない)。1 点以上の項目だけ書く
export function reasonOf(axes) {
  const w = axes.map((v, i) => (v > 0 ? AXIS_WORD[i] + v : '')).filter(Boolean)
  return w.length ? w.join('、') : '全項目0'
}

// ---- 判定できなかったとき(6.5)。重いものを軽く扱わないので Opus/high ----

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
  return make(2, { source: 'failed', fail, reason: '判定できず(' + failWord(fail) + ')' })
}

// 判定の処理が例外になったとき。依頼に明示の [sonnet] [haiku] があれば守り、なければ失敗(Opus/high)
export function fallbackFor(tag) {
  if (tag === 'sonnet' || tag === 'haiku') {
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

// ---- 切替ガード(ADR-0002)。上げるのは自由、下げるのは条件つき ----
// d: 判定の結果、prev: 直前に適用した { model, effort }(なければ undefined)
// st: { contextTokens?, idleMin? }
export function guard(d, prev, st = {}, limits = { tokens: 80000, idleMin: 60 }) {
  const out = { model: d.model, effort: d.effort, held: false }
  if (!prev || (MODEL_RANK[d.model] ?? 0) >= (MODEL_RANK[prev.model] ?? 0)) return out
  const small = (st.contextTokens ?? 0) < limits.tokens
  const cold = (st.idleMin ?? 0) >= limits.idleMin
  if (small || cold) return out
  // 大きく温かい会話: モデルは替えず、effort だけ下げる(キャッシュは保たれる)
  return { model: prev.model, effort: d.effort, held: true }
}
