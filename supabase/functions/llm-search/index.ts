// ============================================================
// Supabase Edge Function: llm-search
// Base44 の InvokeLLM(add_context_from_internet=true) の置換。
//
// 入力(JSON): { prompt: string, json_schema?: object, search_enabled?: boolean }
// 処理:
//   1. search_enabled=true なら Serper API でWeb検索 → 結果をプロンプトに埋め込み
//   2. Anthropic API(Claude) を呼び出し、json_schema があれば tool_use で構造化出力を強制
// 出力(JSON): json_schema に準拠したオブジェクト（無指定時は { text } ）
//
// 必要なシークレット（supabase secrets set ...）:
//   ANTHROPIC_API_KEY, SERPER_API_KEY
// ============================================================
// @ts-nocheck  (Deno 環境。ローカルの tsc 対象外)

const ANTHROPIC_API_KEY = Deno.env.get('ANTHROPIC_API_KEY') ?? ''
const SERPER_API_KEY = Deno.env.get('SERPER_API_KEY') ?? ''
const MODEL = 'claude-sonnet-4-6'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers':
    'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  })
}

/** Serper(Google検索API) で上位結果を取得し、テキストに整形 */
async function webSearch(query: string): Promise<string> {
  if (!SERPER_API_KEY) return ''
  try {
    const res = await fetch('https://google.serper.dev/search', {
      method: 'POST',
      headers: {
        'X-API-KEY': SERPER_API_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ q: query, gl: 'jp', hl: 'ja', num: 10 }),
    })
    if (!res.ok) return ''
    const data = await res.json()
    const organic = (data.organic ?? []) as Array<{
      title?: string
      link?: string
      snippet?: string
    }>
    return organic
      .map((o) => `- ${o.title ?? ''}\n  ${o.link ?? ''}\n  ${o.snippet ?? ''}`)
      .join('\n')
  } catch (_e) {
    return ''
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { prompt, json_schema, search_enabled } = await req.json()
    if (!prompt) return json({ error: 'prompt is required' }, 400)
    if (!ANTHROPIC_API_KEY) {
      return json({ error: 'ANTHROPIC_API_KEY is not configured' }, 500)
    }

    let context = ''
    if (search_enabled) {
      // プロンプトをそのまま検索クエリとして使用（先頭120文字）
      const q = String(prompt).slice(0, 120)
      const results = await webSearch(q)
      if (results) {
        context = `\n\n【Web検索結果（参考情報）】\n${results}\n`
      }
    }

    const fullPrompt = `${prompt}${context}`

    // Anthropic Messages API
    const body: Record<string, unknown> = {
      model: MODEL,
      max_tokens: 4096,
      messages: [{ role: 'user', content: fullPrompt }],
    }

    // json_schema 指定時は tool_use で構造化出力を強制
    if (json_schema) {
      body.tools = [
        {
          name: 'output',
          description: '抽出結果を構造化して返す',
          input_schema: json_schema,
        },
      ]
      body.tool_choice = { type: 'tool', name: 'output' }
    }

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    })

    if (!res.ok) {
      const errText = await res.text()
      return json({ error: `Anthropic API error: ${errText}` }, 502)
    }

    const data = await res.json()

    if (json_schema) {
      const toolUse = (data.content ?? []).find(
        (c: { type: string }) => c.type === 'tool_use',
      )
      return json(toolUse?.input ?? {})
    }

    const text = (data.content ?? [])
      .filter((c: { type: string }) => c.type === 'text')
      .map((c: { text: string }) => c.text)
      .join('\n')
    return json({ text })
  } catch (e) {
    return json({ error: String(e) }, 500)
  }
})
