// token-router: 作業の段に応じて主会話の model / effort を切り替える(配線)。
// 判定: 明示の指定と危険な操作は規則、残りは Haiku が作業の段と危険度を答え、コードが行を決める(ADR-0007)。
// 失敗したら Opus/medium にする。ネットワーク・プロセス・環境変数は使わない。
// モデルの呼び出しは complete の1か所(下の judgeTurn)だけ。
import {
  preRule, explicitTag, stripNote, parseJudge, decide, failed, fallbackFor, guard, make, rowTier, isUpperRow,
} from './router.js'
import { JUDGE_DEFAULTS, JUDGE_SYSTEM, buildUserText, callJudge, makeMarker, summarizeAttachments, tailOf } from './judge.js'

const short = (m) => String(m).replace('claude-', '').replace(/-5-5$/, '')
const REAL_USER = new Set(['composer', 'sdk', 'bridge'])
const SID = /^[A-Za-z0-9_-]{1,64}$/
const LEAD_TAG = /^(\s*(?:\/\S+\s+)?)\[(?:opus|sonnet|haiku)\]\s*/i
const SHORT_REQUEST = 80 // これ以下の依頼は、前回の回答の末尾を添える(設計 6.1.2)

const day = (iso) => iso.slice(0, 10)
const argsOf = (text) => /^\/\S+\s+(\S[\s\S]*)$/.exec(String(text ?? '').trim())?.[1]
const safeModel = (m) => (/^[\w.:/-]{1,60}$/.test(String(m)) ? String(m) : 'unknown')

// 記録。保存先が無ければ何も書かない(mkdir しない)。失敗は無視して続行(設計 6.5)。
async function record($, dir, sid, rec, last) {
  try {
    if (!dir || !SID.test(String(sid)) || !(await $.fs.exists(dir))) return
    const f = dir + '/routes-' + day(rec.ts) + '-' + sid + '.jsonl'
    const old = (await $.fs.exists(f)) ? await $.fs.read(f) : ''
    await $.fs.write(f, old + JSON.stringify(rec) + '\n')
    if (last) await $.fs.write(dir + '/last-' + sid + '.json', JSON.stringify(last)) // 判定しなかったターンは書かない(再開用の行を消さないため)
  } catch {}
}

// 記録の judge 項目。許可リストの語、整数、真偽値だけ(自由文を入れない)
function judgeRecord(d, model, ms) {
  const j = { source: d.source }
  if (d.source === 'model' || d.source === 'failed') j.model = safeModel(model)
  if (ms !== undefined) j.ms = ms
  const u = d.usage
  if (u && typeof u === 'object') {
    j.in = u.input_tokens | 0
    j.out = u.output_tokens | 0
    j.cacheRead = u.cache_read_input_tokens | 0
    j.cacheWrite = u.cache_creation_input_tokens | 0
  }
  if (d.work) j.work = d.work
  if (Number.isInteger(d.stakes)) j.stakes = d.stakes
  if (d.kind) j.kind = d.kind
  if (typeof d.followup === 'boolean') j.followup = d.followup
  if (d.tier) j.tier = d.tier
  if (d.fail) j.fail = d.fail
  if (d.floors?.length) j.floors = d.floors
  return j
}

// 状態はひとつの S にまとめる(`$` を渡せる関数は、ファイル先頭に宣言したものだけという検査の決まりのため)
const newState = (options, deps) => ({
  D: { decide, guard, preRule, callJudge, ...Object.fromEntries(Object.entries(deps).filter(([, v]) => typeof v === 'function')) },
  optDir: String(options?.dataDir ?? '').replace(/\/+$/, ''),
  judgeModel: String(options?.judgeModel || JUDGE_DEFAULTS.model),
  system: JUDGE_SYSTEM,
  claudeDir: '', // 設定フォルダ。環境変数を使わず、会話記録のパス(.../projects/...)から割り出す
  ccVersion: '',
  line: '',
})

const dataDir = (S) => S.optDir || (S.claudeDir ? S.claudeDir + '/token-router' : '')

// 会話ごとの状態を消す(session.start、/clear、/resume)
function wipe(S) {
  // pending: まだ判定していない依頼 { kind: prompt | command | other | fail, text?, tag?, attachments? }。ファイルには書かない
  // prevRow: 直前の判定の行(下限 L1、L3 に使う) / prevLoaded: 再開時に last-<ID>.json を読んだか
  // applied: 直近に適用した { model, effort, row, label, reason, held, source } / turnId: applied が決まったターン(applied を更新した後に書く。判定の途中で止まったとき、前のターンの applied を使い回さないため)
  // turnTag: tagTurn のターンの依頼に明示の指定があれば、その語(失敗時に守る) / turnInfo: そのターンの記録用
  S.pending = S.prevRow = S.applied = S.turnId = S.turnTag = S.tagTurn = S.turnInfo = undefined
  S.prevLoaded = false
  S.contextTokens = 0 // 直近の応答の入力側トークン(切替ガード用)
  S.lastDoneAt = 0 // 直近の主会話ターンの終了時刻(ms)
  S.line = ''
  S.actualModel = '' // 直近の主会話ステップの応答モデル(usage.model)
}

// 再開した会話では直前の行を last-<ID>.json から読む。読めなければ undefined
async function readLastRow(S, $) {
  try {
    const dir = dataDir(S)
    const sid = await $.session.id()
    if (!dir || !SID.test(String(sid))) return undefined
    const f = dir + '/last-' + sid + '.json'
    if (!(await $.fs.exists(f))) return undefined
    const row = JSON.parse(await $.fs.read(f))?.row
    return Number.isInteger(row) && rowTier(row) ? row : undefined
  } catch {
    return undefined
  }
}

// 下限に使う直前の状況と、前回の回答の末尾
async function priorOf(S, $, textLen) {
  if (S.prevRow === undefined && !S.prevLoaded) {
    S.prevLoaded = true
    S.prevRow = await readLastRow(S, $)
  }
  let tail = ''
  let unreadable = false
  let hasAssistant = false
  const needTail = S.prevRow === undefined || textLen <= SHORT_REQUEST || isUpperRow(S.prevRow)
  if (needTail) {
    try {
      const msgs = await $.session.messages()
      hasAssistant = Array.isArray(msgs) && msgs.some((m) => m?.role === 'assistant')
      tail = tailOf(msgs)
    } catch {
      unreadable = true
    }
  }
  const prevUnknown = S.prevRow === undefined && (hasAssistant || unreadable) // 前のターンがあるのに行を読めない(L4)
  return { prevUnknown, tail }
}

// そのターンの判定。失敗は failed() で返す(理由つき)。ここでの例外は decideTurn が受ける
async function judgeTurn(S, $, p) {
  if (!p || p.kind === 'other') {
    return S.applied ? { ...S.applied, source: 'none', reason: '直前の判定を使用' } : make(9, { source: 'none', reason: 'その他の入力(行9)' })
  }
  if (p.kind === 'fail') return fallbackFor(p.tag)
  if (p.kind === 'command' && !argsOf(p.text)) return make(9, { source: 'none', reason: 'コマンド(引数なし)' })
  const text = stripNote(p.text).trim()
  const { hit, flags } = S.D.preRule(text)
  if (hit) return hit
  flags.commandArgs = p.kind === 'command'
  const { prevUnknown, tail } = await priorOf(S, $, text.length)
  const user = buildUserText(text, { tail, attachments: p.attachments, marker: makeMarker(text + tail) })
  const t0 = await $.clock.now()
  const r = await S.D.callJudge((req, o) => $.model.complete(req, o), { system: S.system, prompt: user }, { model: S.judgeModel })
  const ms = Math.max(0, Math.round((await $.clock.now()) - t0))
  const parsed = r.ok ? parseJudge(r.text) : null
  const d = r.ok
    ? parsed ? S.D.decide(parsed, { prevRow: S.prevRow, prevUnknown, textLen: text.length, flags }) : failed('format')
    : failed(r.why)
  return { ...d, usage: r.usage, ms }
}

// ターンの最初の step で呼ぶ。例外は出さない(出ても fallbackFor で Opus/medium か明示の指定)
async function decideTurn(S, $, e) {
  const p = S.pending
  S.pending = undefined
  S.tagTurn = e.turnId
  S.turnTag = p?.tag
  const meta = { promptLen: String(p?.text ?? '').length, promptKind: p?.kind === 'prompt' || p?.kind === 'command' ? p.kind : 'other' }
  let d
  let g
  try {
    d = await judgeTurn(S, $, p)
    const idleMin = S.lastDoneAt ? ((await $.clock.now()) - S.lastDoneAt) / 60000 : 0
    // 明示の指定は切替ガードを通さない。引数のないコマンドも通すので、温かい会話で読み直しを起こさない
    g = d.explicit ? { model: d.model, effort: d.effort, held: false } : S.D.guard(d, S.applied, { contextTokens: S.contextTokens, idleMin })
  } catch {
    d = fallbackFor(S.turnTag)
    g = { model: d.model, effort: d.effort, held: false }
  }
  S.applied = { model: g.model, effort: g.effort, held: g.held, row: d.row, label: d.label, reason: d.reason, source: d.source }
  if (d.source !== 'none') S.prevRow = d.row // 判定した行を残す(ガードで据え置いたモデルではなく)。判定しなかったターンは埋めない(再開時に last を読めるように)
  S.turnInfo = { ...meta, judge: judgeRecord(d, S.judgeModel, d.ms) }
  S.turnId = e.turnId // 最後に書く
  S.line = d.source === 'failed'
    ? 'ルーター: ' + d.reason + ' → ' + short(g.model) + '/' + g.effort
    : 'ルーター: 行' + d.row + ' ' + d.label + ' → ' + short(g.model) + '/' + g.effort + '(' + d.reason + (g.held ? '、文脈が大きいので ' + short(g.model) + ' のまま' : '') + ')'
}

// 判定の直後に1行を出す(応答の途中でも、今のモデルが分かるように)。表示の失敗で切り替えを止めない
function showLine(S, $) {
  try {
    if (!S.line) return
    $.ui.log(S.line)
    $.ui.status(S.line)
    $.ui.toast(S.line)
  } catch {}
}

// deps は試験で差し替える用(本番では渡されない)
export function register(on, options, deps = {}) {
  const S = newState(options, deps)
  wipe(S)

  on('classic.UserPromptSubmit', async ($, e, next) => {
    try {
      const i = String(e.transcript_path ?? '').lastIndexOf('/projects/')
      if (i > 0) S.claudeDir = e.transcript_path.slice(0, i)
    } catch {}
    return next(e)
  })

  on('session.start', async ($, e, next) => {
    wipe(S)
    return next(e)
  })

  // /clear(reason clear)では session.start が来ない。別の会話への /resume でも、前の状態を持ち越さない
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear' || e.reason === 'resume') wipe(S)
    return next(e)
  })

  // 依頼の文字列は変数に預かるだけ(判定は turn.step)。ファイルには書かない
  on('prompt.submit', async ($, e, next) => {
    try {
      const text = String(e.text ?? '')
      if (e.command) {
        S.pending = { kind: 'command', text, tag: explicitTag(text) }
      } else if (!e.isMeta && REAL_USER.has(e.origin?.kind)) {
        // 実行中に打った依頼は、まだ使っていない依頼につなげる(軽い方で判定しないため)
        // 先頭の指定は、2件目にも同じ指定があるか [opus] のときだけ残す(軽くする指定を、2件目に効かせない)
        const first = e.turnId && S.pending?.kind === 'prompt' ? S.pending : undefined
        const keep = first?.tag === 'opus' || (first?.tag && first.tag === explicitTag(text))
        const head = first && first.tag && !keep ? stripNote(first.text).replace(LEAD_TAG, '$1') : first?.text
        const joined = first ? head + '\n' + text : text
        S.pending = { kind: 'prompt', text: joined, tag: explicitTag(joined), attachments: summarizeAttachments(e.attachments) }
      } else if (!['prompt', 'command', 'fail'].includes(S.pending?.kind)) {
        S.pending = { kind: 'other' } // 未使用の本物の依頼と失敗の印は、通知で置き換えない(軽い判定に流れないため)
      }
    } catch {
      S.pending = { kind: 'fail' }
    }
    return next(e)
  }).catch(async ($, e, next) => {
    let tag
    try {
      tag = explicitTag(e.text)
    } catch {}
    S.pending = { kind: 'fail', tag }
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    let e2 = e
    if (e.agentId === undefined) {
      if (e.turnId !== S.turnId) {
        await decideTurn(S, $, e)
        showLine(S, $)
      }
      if (S.applied) e2 = { ...e, model: S.applied.model, effort: S.applied.effort }
    }
    const result = yield* next(e2)
    try {
      const u = e.agentId === undefined ? result?.usage : undefined
      if (u?.model) S.actualModel = u.model
      if (u) S.contextTokens = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    } catch {}
    return result
  }).catch(async function* ($, e, next) {
    // フックが例外のまま抜けた、または時間を超えた。next の前なら Opus/medium(明示の指定があればそれ)で進む
    if (next.called || e.agentId !== undefined) return yield* next(e)
    if (e.turnId !== S.turnId || !S.applied) {
      const d = fallbackFor(S.pending?.tag ?? (e.turnId === S.tagTurn ? S.turnTag : undefined))
      S.turnTag = S.pending?.tag ?? (e.turnId === S.tagTurn ? S.turnTag : undefined)
      S.tagTurn = e.turnId
      S.turnId = e.turnId
      S.pending = undefined
      S.applied = { model: d.model, effort: d.effort, held: false, row: d.row, label: d.label, reason: d.reason, source: d.source }
      S.prevRow ??= d.row
      S.turnInfo = { promptLen: 0, promptKind: 'other', judge: judgeRecord(d, S.judgeModel) }
      S.line = 'ルーター: ' + d.reason + ' → ' + short(d.model) + '/' + d.effort
      showLine(S, $)
    }
    return yield* next({ ...e, model: S.applied.model, effort: S.applied.effort })
  })

  on('turn.complete', async ($, e, next) => {
    try {
      if (e.agentId === undefined) {
        S.lastDoneAt = await $.clock.now()
        try {
          if (S.applied && S.turnInfo) {
            if (!S.ccVersion) S.ccVersion = (await $.session.version()).version
            const ts = new Date().toISOString()
            const sid = await $.session.id()
            const rec = {
              ts, session: sid, turn: e.turnId, promptLen: S.turnInfo.promptLen, source: S.turnInfo.promptKind, row: S.applied.row,
              reason: S.applied.reason, model: S.applied.model, effort: S.applied.effort, held: S.applied.held, actualModel: S.actualModel, version: S.ccVersion,
              judge: S.turnInfo.judge,
            }
            await record($, dataDir(S), sid, rec, S.applied.source === 'none' ? undefined : {
              ts, row: S.applied.row, label: S.applied.label, model: S.applied.model, effort: S.applied.effort,
              reason: S.applied.reason, held: S.applied.held, actualModel: S.actualModel,
            })
          }
        } catch {}
      }
    } catch {}
    return next(e)
  })
}
