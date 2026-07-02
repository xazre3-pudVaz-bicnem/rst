// ============================================================
// RST AIテレアポ リアルタイム音声中継サーバー
//   Twilio Media Streams (G.711 μ-law 8kHz) ⇄ OpenAI Realtime API を橋渡しする。
//   - Twilioの <Connect><Stream> からのWebSocket接続を受ける (/twilio-stream)
//   - 相手の音声をOpenAI Realtimeへ送り、AIの音声をTwilioへ返す（双方向）
//   - 会話中にツール(get_case_context/get_available_slots/create_appointment/
//     schedule_callback/mark_no_interest/save_call_summary)を呼び、RST APIへ反映
//   - 通話終了時にRSTへ結果をPOST
// Vercelの通常APIとは別の「常時起動サーバー」として Render/Railway/Fly.io/Cloud Run 等で動かす。
// ============================================================
import http from 'node:http'
import { WebSocketServer, WebSocket } from 'ws'

const PORT = Number(process.env.PORT || 8080)
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
const OPENAI_REALTIME_MODEL = process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime'
const OPENAI_REALTIME_VOICE = process.env.OPENAI_REALTIME_VOICE || 'marin'
const RST_API_BASE = (process.env.RST_API_BASE || '').replace(/\/+$/, '') // 例: https://rst-chi.vercel.app
const AI_CALL_SERVER_SECRET = process.env.AI_CALL_SERVER_SECRET || ''      // RST側と共有するサーバー間シークレット

const log = (...a) => console.log(new Date().toISOString(), ...a)

// ---- RST APIツール呼び出し（サーバー間・Bearerシークレット） ----
async function rstTool(action, body) {
  if (!RST_API_BASE || !AI_CALL_SERVER_SECRET) return { ok: false, error: 'RST_API_BASE / AI_CALL_SERVER_SECRET 未設定' }
  try {
    const r = await fetch(`${RST_API_BASE}/api/ai-call/twilio?action=${action}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${AI_CALL_SERVER_SECRET}` },
      body: JSON.stringify(body || {}),
    })
    const j = await r.json().catch(() => ({}))
    return j
  } catch (e) { return { ok: false, error: String(e?.message || e) } }
}

// ---- 営業トークのシステムプロンプト ----
function buildInstructions(ctx) {
  const c = ctx || {}
  return `あなたは「株式会社サイプレス」の電話営業担当です。Googleマップ(MEO)・ホームページ・SEO・AI活用による集客改善の「無料診断」の案内をします。

【話し方】
- 自然で丁寧な日本語。機械っぽくしない。長く話しすぎない。相手の話を遮らない。
- 最初に会社名と用件を短く伝える。受付/担当者/代表で話し方を変える。
- 無理に売り込まない。目的はアポ獲得。断られたら深追いしない。相手が忙しそうなら再架電にする。
- 相手が「不要」「かけないでください」と言ったら丁重に謝辞を述べ、興味なし/NG候補として終える（深追い禁止）。

【最初のトーク】
「お忙しいところ失礼いたします。株式会社サイプレスのAI営業担当です。Googleマップやホームページからの集客状況を無料で診断している件でお電話しました。ご担当の方はいらっしゃいますでしょうか。」

【担当者につながったら】
「ありがとうございます。今のホームページやGoogleマップの表示状況を確認したうえで、改善できそうな点を無料でお伝えしているのですが、10分ほどオンラインかお電話でご説明できるお時間をいただけますか。」

【アポ取得の流れ】
- 相手が前向きなら自然に日程を聞く（例：明日か明後日、午前か午後）。
- 相手が希望日時を言ったら get_available_slots で空きを確認し、空いていれば create_appointment でアポを登録する。
- 登録できたら日時を復唱して感謝を述べ、通話を締める。

【ツールの使い方】
- 会話開始時に必要なら get_case_context で相手先情報を把握する。
- アポ確定: create_appointment(datetime, contactName, memo)
- 再度かけ直し: schedule_callback(datetime, reason)
- 興味なし: mark_no_interest(reason)  ※完全NGは登録しない（人が確認する）
- 通話の最後に save_call_summary(result, summary, nextAction) で必ず結果を残す。

【相手先情報】
店名: ${c.name || '不明'} / 業種: ${c.industry || '不明'} / 住所: ${c.address || '不明'} / 電話: ${c.phone || '不明'}
公式サイト: ${c.website || 'なし'} / メモ: ${(c.memo || '').slice(0, 200)}
`
}

// ---- OpenAI Realtime に渡すツール定義 ----
const TOOLS = [
  { type: 'function', name: 'get_case_context', description: '相手先(案件)の情報を取得する', parameters: { type: 'object', properties: {}, required: [] } },
  { type: 'function', name: 'get_available_slots', description: 'Googleカレンダーの空き枠を取得する', parameters: { type: 'object', properties: {}, required: [] } },
  { type: 'function', name: 'create_appointment', description: '訪問/商談アポをRSTとGoogleカレンダーに登録する', parameters: { type: 'object', properties: { datetime: { type: 'string', description: 'ISO8601の日時' }, contactName: { type: 'string' }, memo: { type: 'string' } }, required: ['datetime'] } },
  { type: 'function', name: 'schedule_callback', description: '再架電予定日を登録する', parameters: { type: 'object', properties: { datetime: { type: 'string' }, reason: { type: 'string' } }, required: ['datetime'] } },
  { type: 'function', name: 'mark_no_interest', description: '興味なし候補として登録する（完全NGにはしない）', parameters: { type: 'object', properties: { reason: { type: 'string' } }, required: [] } },
  { type: 'function', name: 'save_call_summary', description: '通話結果を案件ログに保存する', parameters: { type: 'object', properties: { result: { type: 'string' }, summary: { type: 'string' }, nextAction: { type: 'string' } }, required: ['result'] } },
]

// ---- ツール実行（RSTへ中継） ----
async function runTool(name, args, session) {
  const { jobId, caseId } = session
  switch (name) {
    case 'get_case_context': {
      const r = await rstTool('tool-context', { jobId, caseId })
      session.context = r.context || session.context
      return r
    }
    case 'get_available_slots': return await rstTool('tool-slots', { jobId, caseId })
    case 'create_appointment': {
      const r = await rstTool('tool-appointment', { jobId, caseId, datetime: args.datetime, contactName: args.contactName || null, memo: args.memo || null })
      if (r.ok) { session.result = 'アポ確定'; session.appoAt = args.datetime }
      return r
    }
    case 'schedule_callback': {
      const r = await rstTool('tool-callback', { jobId, caseId, datetime: args.datetime, reason: args.reason || null })
      if (r.ok) session.result = '再架電'
      return r
    }
    case 'mark_no_interest': {
      const r = await rstTool('tool-nointerest', { jobId, caseId, reason: args.reason || null })
      if (r.ok) session.result = '興味なし'
      return r
    }
    case 'save_call_summary': {
      if (args.result) session.result = args.result
      session.summary = args.summary || session.summary
      session.nextAction = args.nextAction || session.nextAction
      return await rstTool('tool-summary', { jobId, caseId, result: args.result, summary: args.summary, nextAction: args.nextAction })
    }
    default: return { ok: false, error: `unknown tool: ${name}` }
  }
}

// ---- OpenAI Realtime へ接続 ----
function connectOpenAI(session, onReady) {
  const url = `wss://api.openai.com/v1/realtime?model=${encodeURIComponent(OPENAI_REALTIME_MODEL)}`
  const oa = new WebSocket(url, { headers: { Authorization: `Bearer ${OPENAI_API_KEY}`, 'OpenAI-Beta': 'realtime=v1' } })
  session.openai = oa

  oa.on('open', () => {
    log('[openai] connected', session.jobId)
    // セッション設定: G.711 μ-law（Twilioと同形式）・server VAD・音声・ツール・プロンプト
    oa.send(JSON.stringify({
      type: 'session.update',
      session: {
        modalities: ['audio', 'text'],
        instructions: buildInstructions(session.context),
        voice: OPENAI_REALTIME_VOICE,
        input_audio_format: 'g711_ulaw',
        output_audio_format: 'g711_ulaw',
        turn_detection: { type: 'server_vad', silence_duration_ms: 600 },
        tools: TOOLS,
        tool_choice: 'auto',
      },
    }))
    // 最初にAIから話し始める
    oa.send(JSON.stringify({ type: 'response.create' }))
    if (onReady) onReady()
  })

  oa.on('message', (raw) => {
    let msg
    try { msg = JSON.parse(raw.toString()) } catch { return }
    switch (msg.type) {
      // AI音声（Twilioへ返す）。beta=response.audio.delta / GA=response.output_audio.delta を両対応
      case 'response.audio.delta':
      case 'response.output_audio.delta': {
        if (session.streamSid && msg.delta && session.twilio?.readyState === WebSocket.OPEN) {
          session.twilio.send(JSON.stringify({ event: 'media', streamSid: session.streamSid, media: { payload: msg.delta } }))
        }
        break
      }
      // 相手が話し始めたらAI音声を止める（バージイン）
      case 'input_audio_buffer.speech_started': {
        if (session.streamSid && session.twilio?.readyState === WebSocket.OPEN) {
          session.twilio.send(JSON.stringify({ event: 'clear', streamSid: session.streamSid }))
        }
        break
      }
      // ツール呼び出し
      case 'response.function_call_arguments.done': {
        ;(async () => {
          let args = {}
          try { args = JSON.parse(msg.arguments || '{}') } catch {}
          log('[tool]', msg.name, args)
          const out = await runTool(msg.name, args, session)
          oa.send(JSON.stringify({ type: 'conversation.item.create', item: { type: 'function_call_output', call_id: msg.call_id, output: JSON.stringify(out).slice(0, 4000) } }))
          oa.send(JSON.stringify({ type: 'response.create' }))
        })()
        break
      }
      case 'error': log('[openai][error]', JSON.stringify(msg.error || msg)); break
      default: break
    }
  })

  oa.on('close', () => log('[openai] closed', session.jobId))
  oa.on('error', (e) => log('[openai] error', String(e?.message || e)))
}

// ---- HTTPサーバー（health）＋ WebSocket（/twilio-stream） ----
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end('ok'); return }
  res.writeHead(404); res.end('not found')
})

const wss = new WebSocketServer({ noServer: true })
server.on('upgrade', (req, socket, head) => {
  const { pathname, searchParams } = new URL(req.url, 'http://localhost')
  if (pathname !== '/twilio-stream') { socket.destroy(); return }
  wss.handleUpgrade(req, socket, head, (ws) => {
    ws._query = { jobId: searchParams.get('jobId') || '', caseId: searchParams.get('caseId') || '' }
    wss.emit('connection', ws, req)
  })
})

wss.on('connection', (twilioWs, req) => {
  const session = { twilio: twilioWs, openai: null, streamSid: null, jobId: twilioWs._query?.jobId || '', caseId: twilioWs._query?.caseId || '', context: null, result: null, summary: null, nextAction: null, appoAt: null, finalized: false }
  log('[twilio] connection', session.jobId, session.caseId)

  twilioWs.on('message', async (raw) => {
    let data
    try { data = JSON.parse(raw.toString()) } catch { return }
    switch (data.event) {
      case 'connected': break
      case 'start': {
        session.streamSid = data.start?.streamSid
        // customParameters からも jobId/caseId を補完（<Stream><Parameter>）
        const cp = data.start?.customParameters || {}
        session.jobId = session.jobId || cp.jobId || ''
        session.caseId = session.caseId || cp.caseId || ''
        // 案件コンテキストを取得してからOpenAIへ接続（プロンプトに反映）
        const ctx = await rstTool('tool-context', { jobId: session.jobId, caseId: session.caseId })
        session.context = ctx.context || null
        connectOpenAI(session)
        break
      }
      case 'media': {
        // 相手の音声（μ-law base64）をOpenAIへ
        if (session.openai?.readyState === WebSocket.OPEN && data.media?.payload) {
          session.openai.send(JSON.stringify({ type: 'input_audio_buffer.append', audio: data.media.payload }))
        }
        break
      }
      case 'stop': await finalize(session); break
      default: break
    }
  })

  twilioWs.on('close', () => finalize(session))
  twilioWs.on('error', () => finalize(session))
})

// ---- 通話終了時: 結果をRSTへ ----
async function finalize(session) {
  if (session.finalized) return
  session.finalized = true
  try { session.openai?.close() } catch {}
  log('[finalize]', session.jobId, 'result=', session.result)
  await rstTool('tool-result', {
    jobId: session.jobId, caseId: session.caseId,
    result: session.result || '通話完了', summary: session.summary || null,
    nextAction: session.nextAction || null, appoAt: session.appoAt || null, mode: 'realtime',
  })
}

server.listen(PORT, () => {
  log(`RST realtime voice server on :${PORT}  model=${OPENAI_REALTIME_MODEL} voice=${OPENAI_REALTIME_VOICE}`)
  if (!OPENAI_API_KEY) log('WARN: OPENAI_API_KEY 未設定')
  if (!RST_API_BASE || !AI_CALL_SERVER_SECRET) log('WARN: RST_API_BASE / AI_CALL_SERVER_SECRET 未設定（ツール連携が動きません）')
})
