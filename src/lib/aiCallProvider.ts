// ============================================================
// AIテレアポ 通話プロバイダ抽象層（音声AI/電話APIを後から差し替え可能にする）
//  - MockCallProvider   … 実通話なしでフロー検証（MVP既定）
//  - TwilioCallProvider … Twilio+音声AIの差し込み口（サーバー側 /api/ai-call で実装予定・キーはVercel環境変数）
// フロント/サーバーどちらからも同じ interface で呼べる。既定は 'mock'。
// ============================================================
import type { AiCallStatus } from './types'

export interface CallProviderInput {
  phone: string
  caseName: string
  script: string
  /** テスト用: モックの結果を固定したい場合に指定（未指定はランダム） */
  forceStatus?: AiCallStatus
}

export interface CallProviderResult {
  status: AiCallStatus         // 終端ステータス（不在/担当者不在/通話完了/興味あり/興味なし/再架電/NG）
  durationSec: number
  transcript: string
  aiSummary: string
  temperature: '高' | '中' | '低' | null
  nextAction: string
  providerCallSid?: string
  provider: string
  error?: string | null
}

export interface CallProvider {
  name: string
  placeCall(input: CallProviderInput): Promise<CallProviderResult>
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)]

// 結果テンプレート（モック用。実運用ではAIが文字起こし→要約→温度感を返す）
const RESULT_TEMPLATES: Record<string, { temperature: '高' | '中' | '低' | null; summary: string; next: string; lines: string[] }> = {
  興味あり: {
    temperature: '高',
    summary: 'MEO/Web集客に前向き。担当者が対応し「詳しい話を聞きたい」との反応。訪問アポ打診に好感触。',
    next: '訪問予定を登録し、提案資料を持参して訪問',
    lines: ['AI: Googleマップの集客についてご案内しております。', '相手: ちょうど気にしていたところです。', 'AI: よろしければ担当が詳しくご説明に伺えます。', '相手: はい、来週なら大丈夫です。'],
  },
  興味なし: {
    temperature: '低',
    summary: '担当者は対応したが「今は不要」と明確に辞退。強い拒否ではないが当面ニーズなし。',
    next: '3〜6ヶ月後に状況変化を見て再アプローチ検討',
    lines: ['AI: Web集客のご案内でお電話しました。', '相手: 今は間に合っています。', 'AI: 承知しました。'],
  },
  再架電: {
    temperature: '中',
    summary: '担当者は在席だが多忙で「改めて」との事。関心は否定されず、タイミング次第。',
    next: '指定された時間帯に再架電',
    lines: ['AI: ご担当者さまはいらっしゃいますか。', '相手: 今立て込んでいて…また今度で。', 'AI: では改めてご連絡します。'],
  },
  NG: {
    temperature: '低',
    summary: '「二度と電話しないで」等の強い拒否／同業・営業お断り。再架電不可。',
    next: '再架電しない（NGリスト）',
    lines: ['AI: Web集客のご案内で…', '相手: そういう営業は結構です。二度とかけないでください。'],
  },
  不在: {
    temperature: null,
    summary: '呼び出したが応答なし（不在）。',
    next: '時間帯を変えて再架電',
    lines: ['（応答なし）'],
  },
  担当者不在: {
    temperature: null,
    summary: '電話は繋がったが決裁権のある担当者が不在。',
    next: '担当者の在席時間を確認して再架電',
    lines: ['AI: ご担当者さまはいらっしゃいますか。', '相手: 本日は外出しております。'],
  },
  通話完了: {
    temperature: '中',
    summary: '通話は完了。温度感は要人手確認。',
    next: '内容を確認し温度感を分類',
    lines: ['AI: ご案内ありがとうございました。'],
  },
}

/** モック: 実通話なしで結果を生成（MVPのフロー検証用）。forceStatus指定でテスト可能。 */
export const MockCallProvider: CallProvider = {
  name: 'mock',
  async placeCall(input: CallProviderInput): Promise<CallProviderResult> {
    await sleep(1200) // 発信〜通話をシミュレート
    const status: AiCallStatus = input.forceStatus
      ?? pick<AiCallStatus>(['興味あり', '興味なし', '再架電', 'NG', '不在', '担当者不在'])
    const t = RESULT_TEMPLATES[status] || RESULT_TEMPLATES['通話完了']
    const connected = status !== '不在'
    const header = `【モック通話 / ${input.caseName || '案件'} / ${input.phone || '番号なし'}】\n（このスクリプトで発信）\n${(input.script || '').slice(0, 120)}...\n\n--- 会話 ---\n`
    return {
      status,
      durationSec: connected ? 40 + Math.floor(Math.random() * 120) : 0,
      transcript: header + t.lines.join('\n'),
      aiSummary: t.summary,
      temperature: t.temperature,
      nextAction: t.next,
      providerCallSid: 'MOCK-' + Math.random().toString(36).slice(2, 10).toUpperCase(),
      provider: 'mock',
      error: null,
    }
  },
}

/** Twilio+音声AI 差し込み口。実装はサーバー側(/api/ai-call)で行い、キーはVercel環境変数
 *  (TWILIO_ACCOUNT_SID / TWILIO_AUTH_TOKEN / TWILIO_FROM_NUMBER / 音声AIのキー)で管理する。
 *  クライアントからは呼ばず、サーバーendpoint追加時にこの実体を差し替える。 */
export const TwilioCallProvider: CallProvider = {
  name: 'twilio',
  async placeCall(): Promise<CallProviderResult> {
    throw new Error('Twilioプロバイダは未実装です。サーバー側 /api/ai-call を実装し、Vercel環境変数(TWILIO_*)を設定してください。現状はモックで動作します。')
  },
}

/** provider名から実体を取得（既定はmock）。'twilio'はサーバー実装後に有効化。 */
export function getCallProvider(name?: string | null): CallProvider {
  return name === 'twilio' ? TwilioCallProvider : MockCallProvider
}
