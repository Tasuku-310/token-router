// bench-judge: token-router の判定だけを依頼一覧に対して流し、結果を jsonl に書く(03-design.md 7.2「ベンチ」)。
// prompt.submit で一覧を読み、順に判定し、最後に { drop } を返す。主会話のモデルは呼ばれない(-p で終わるかは最初の1回で確認)。
// 出力に依頼文・前回の回答・モデルの答えの文章は書かない。ネットワーク・プロセス・環境変数は使わない。
// router.js と judge.js は plugins/token-router/hooks/ のコピー(sync.sh で同期し sha256 を確かめる)。
import { preRule, parseJudge, decide, failed, stripNote, SCHEMES, rowTier } from './router.js'
import { buildSystem, buildUserText, callJudge, makeMarker, JUDGE_DEFAULTS } from './judge.js'

const SHORT_REQUEST = 80

// 1件を判定して、書く行(自由文なし)を返す
async function benchOne($, cfg, v, req, run) {
  const text = stripNote(req.text).trim() // register.js と同じく、試験用の注記を除いて判定する
  const out = { id: String(req.id ?? '').slice(0, 20), run, variant: v.name, model: cfg.model }
  const { hit, flags } = preRule(text)
  if (hit) return { ...out, source: hit.source, row: hit.row, tier: hit.tier }
  const prev = Number.isInteger(req.prev) && rowTier(req.prev) ? req.prev : undefined
  const unknown = req.unknown === true && prev === undefined
  const needTail = prev === undefined || text.length <= SHORT_REQUEST || rowTier(prev) === 'heavy'
  const tail = needTail && typeof req.tail === 'string' ? req.tail : ''
  const user = buildUserText(text, { tail, marker: makeMarker(text + tail) })
  const t0 = await $.clock.now()
  const r = await callJudge((q, o) => $.model.complete(q, o), { system: v.system, prompt: user }, { model: cfg.model })
  const ms = Math.max(0, Math.round((await $.clock.now()) - t0))
  const u = r.usage ?? {}
  const base = { ...out, source: 'model', ms, in: u.input_tokens | 0, out: u.output_tokens | 0, cacheRead: u.cache_read_input_tokens | 0, cacheWrite: u.cache_creation_input_tokens | 0 }
  const parsed = r.ok ? parseJudge(r.text) : null
  if (!parsed) return { ...base, ok: false, fail: r.ok ? 'format' : failed(r.why).fail }
  const rows = {}
  const tiers = {}
  const floors = {}
  const sumOnly = {}
  for (const s of SCHEMES) {
    const d = decide(parsed, { prevRow: prev, prevUnknown: unknown, textLen: text.length, flags: { inject: flags.inject, exception: flags.exception }, scheme: s })
    rows[s] = d.row
    tiers[s] = d.tier
    floors[s] = d.floors
    sumOnly[s] = !d.axes.includes(2) && d.tier === 'heavy'
  }
  return { ...base, ok: true, axes: [parsed.impact, parsed.undo, parsed.precision, parsed.difficulty], kind: parsed.kind, followup: parsed.followup, rows, tiers, floors, sumOnly }
}

async function readRequests($, file) {
  const list = []
  for (const l of String(await $.fs.read(file)).split('\n')) {
    if (!l.trim()) continue
    try {
      const o = JSON.parse(l)
      if (o && typeof o === 'object') list.push(o)
    } catch {}
  }
  return list
}

async function runBench($, cfg) {
  const list = await readRequests($, cfg.requestsFile)
  let lines = ''
  for (const v of cfg.variants) {
    for (let run = 1; run <= cfg.runs; run++) {
      for (const req of list) {
        let row
        try {
          row = await benchOne($, cfg, v, req, run)
        } catch {
          row = { id: String(req?.id ?? '').slice(0, 20), run, variant: v.name, source: 'error', ok: false, fail: 'internal' }
        }
        lines += JSON.stringify(row) + '\n'
        await $.fs.write(cfg.outFile, lines) // 追記の API が無いので、全体を書き直す(途中で止まっても、ここまでは残る)
      }
    }
  }
  return list.length * cfg.runs * cfg.variants.length
}

export function register(on, options) {
  const cfg = {
    requestsFile: String(options?.requestsFile ?? ''),
    outFile: String(options?.outFile ?? ''),
    // variant は "P1"、"P2"、"P1,P2"(両方を続けて流す。1回の起動で比べるため)
    variants: [...new Set(String(options?.variant ?? 'P1').split(',').map((x) => x.trim()).filter((x) => x === 'P1' || x === 'P2'))].map((name) => ({ name, system: buildSystem(name) })),
    model: String(options?.model || JUDGE_DEFAULTS.model),
    runs: Math.min(10, Math.max(1, parseInt(options?.runs, 10) || 1)),
  }
  if (!cfg.variants.length) cfg.variants = [{ name: 'P1', system: buildSystem('P1') }]
  on('prompt.submit', async ($, e, next) => {
    if (!cfg.requestsFile || !cfg.outFile) return { drop: 'ベンチの設定が空' }
    let done = 0
    try {
      done = await runBench($, cfg)
    } catch {}
    $.ui.log('ベンチ完了: ' + done + ' 行')
    return { drop: 'ベンチ完了' }
  })
}
