import { useCallback, useEffect, useState } from 'react'
import { Bot, Plus, Save, Trash2, Star, PhoneOutgoing, ShieldAlert, FileText } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Input } from '@/components/ui/input'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { AiCallScriptApi, TwilioApi } from '@/lib/aiCall'
import { jpError } from '@/lib/utils'
import type { AiCallScript } from '@/lib/types'

// 編集する構造化項目（キー・ラベル・プレースホルダ・行数）。DBのカラム名と一致させる。
type FieldKey = keyof AiCallScript
const FIELDS: { key: FieldKey; label: string; placeholder: string; rows: number }[] = [
  { key: 'target_product', label: '対象商材', placeholder: '例: Googleマップ(MEO)・ホームページ・SEOによる集客改善の無料診断', rows: 2 },
  { key: 'opening_talk', label: '冒頭トーク（AIの最初の発話）', placeholder: '例: お忙しいところ失礼いたします。株式会社サイプレスのAI営業担当です。…ご担当の方はいらっしゃいますでしょうか。', rows: 3 },
  { key: 'contact_talk', label: '担当者につながった時のトーク', placeholder: '担当者に代わったときに話す内容', rows: 3 },
  { key: 'reception_talk', label: '受付対応トーク', placeholder: '受付の方への取次ぎ依頼の言い方', rows: 2 },
  { key: 'interest_talk', label: '興味あり時のトーク', placeholder: '前向きな反応があったときの展開', rows: 3 },
  { key: 'pricing_answer', label: '料金を聞かれた時の回答', placeholder: '費用について聞かれたときの答え方', rows: 2 },
  { key: 'rejection_handling', label: '断られた時の対応', placeholder: '断られたときの引き際の言い方（深追いしない）', rows: 2 },
  { key: 'absent_handling', label: '担当者不在時の対応', placeholder: '担当者が不在だったときの対応', rows: 2 },
  { key: 'appointment_confirm_talk', label: 'アポ取得時の確認トーク', placeholder: '例: では、〇月〇日〇曜日の〇時から10分ほど、無料診断のご説明ということでよろしいでしょうか。', rows: 2 },
  { key: 'conversation_goal', label: '会話のゴール', placeholder: '例: 無料診断（10分程度）のアポイントを取得する', rows: 2 },
  { key: 'temperature_rule', label: '温度感判定ルール', placeholder: '高/中/低 の判定基準', rows: 2 },
  { key: 'appointment_rule', label: 'アポ登録ルール', placeholder: '例: 日時を復唱しOKをもらえたときのみ登録。曖昧なら聞き直す。', rows: 2 },
  { key: 'ng_words', label: '禁止ワード', placeholder: '使ってはいけない言葉（カンマ区切り）例: 絶対・必ず儲かる・保証', rows: 2 },
  { key: 'forbidden_actions', label: 'AIに絶対させない行動', placeholder: 'このスクリプト固有でさせない行動（システム固定の禁止行動とは別）', rows: 3 },
]

// 管理画面の内容に関わらず常にシステム側で固定される禁止行動（realtimeサーバーのFIXED_GUARDRAILSと対応・表示のみ）。
const FIXED_RULES = [
  '必ず日本語で話す（英語で話さない）',
  '嘘をつかない',
  '人間の営業担当だと偽らない',
  'Google公式・行政機関を装わない',
  '契約が取れると断言しない',
  '断られたら深追いしない',
  '「電話しないで」と言われたらNG候補にする',
  '確認なしで勝手にアポ登録しない',
  '聞き取れていない日時を推測で登録しない',
]

const empty = (): Partial<AiCallScript> => ({ id: '', name: '', body: '' })

export default function AiScripts() {
  const { isAdmin, user } = useAuth()
  const toast = useToast()
  const confirm = useConfirm()
  const [scripts, setScripts] = useState<AiCallScript[]>([])
  const [loading, setLoading] = useState(true)
  const [sel, setSel] = useState<Partial<AiCallScript> | null>(null)
  const [busy, setBusy] = useState(false)
  // テスト発信
  const [testNumber, setTestNumber] = useState('')
  const [testBusy, setTestBusy] = useState(false)
  const [testResult, setTestResult] = useState<any>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const s = await AiCallScriptApi.list()
      setScripts(s)
      setSel((prev) => prev ?? (s.find((x) => x.is_default) || s[0] || null))
    } catch (e) { toast.error(jpError(e)) } finally { setLoading(false) }
  }, [toast])

  useEffect(() => { load() }, [load])

  if (!isAdmin) {
    return (
      <div className="flex h-screen flex-col"><TopBar />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          <div className="rounded-lg border p-6 text-center"><ShieldAlert className="mx-auto mb-2 h-6 w-6 text-amber-500" />このページは管理者のみ利用できます。</div>
        </div>
      </div>
    )
  }

  const set = (k: FieldKey, v: string) => setSel((p) => (p ? { ...p, [k]: v } : p))

  async function save() {
    if (!sel) return
    if (!sel.name?.trim()) { toast.error('スクリプト名を入力してください'); return }
    setBusy(true)
    try {
      const payload: Record<string, any> = { name: sel.name }
      for (const f of FIELDS) payload[f.key as string] = ((sel[f.key] as string) ?? null)
      payload.body = sel.body ?? '' // 互換のため保持（mockプロバイダ用）
      if (sel.id) { await AiCallScriptApi.update(sel.id, payload); toast.success('スクリプトを保存しました') }
      else { const created = await AiCallScriptApi.create({ ...payload, created_by_id: user?.id ?? null }); setSel(created); toast.success('スクリプトを作成しました') }
      await load()
    } catch (e) { toast.error(jpError(e)) } finally { setBusy(false) }
  }

  async function makeDefault() {
    if (!sel?.id) { toast.error('先に保存してください'); return }
    setBusy(true)
    try { await AiCallScriptApi.setDefault(sel.id); toast.success('既定スクリプトに設定しました'); setSel((p) => (p ? { ...p, is_default: true } : p)); await load() }
    catch (e) { toast.error(jpError(e)) } finally { setBusy(false) }
  }

  async function removeScript() {
    if (!sel?.id) return
    if (sel.is_default) { toast.error('既定スクリプトは削除できません。先に別のスクリプトを既定にしてください。'); return }
    if (!(await confirm({ title: 'スクリプトを削除', body: `「${sel.name}」を削除します（論理削除）。よろしいですか？`, confirmLabel: '削除', danger: true }))) return
    setBusy(true)
    try { await AiCallScriptApi.remove(sel.id); toast.success('削除しました'); setSel(null); await load() }
    catch (e) { toast.error(jpError(e)) } finally { setBusy(false) }
  }

  async function testCall() {
    if (!sel?.id) { toast.error('先にスクリプトを保存してください'); return }
    if (!testNumber.trim()) { toast.error('テスト発信先（あなたの番号）を入力してください'); return }
    if (!(await confirm({ title: 'このスクリプトでテスト発信', body: `${testNumber} に実際に電話をかけます（realtime AI会話）。必ず自分のテスト番号にかけてください。よろしいですか？`, confirmLabel: '発信する', danger: true }))) return
    setTestBusy(true); setTestResult(null)
    try {
      const r = await TwilioApi.testCall(testNumber.trim(), '', null, { scriptId: sel.id, mode: 'realtime' })
      setTestResult(r)
      if (r?.ok) toast.success(`発信しました（SID ${r.sid ?? '—'} / モード ${r.mode ?? '—'}）`)
      else toast.error(r?.error || '発信に失敗しました')
    } catch (e) { toast.error(jpError(e)) } finally { setTestBusy(false) }
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar />
      <div className="flex-1 overflow-y-auto p-3">
        <div className="mx-auto max-w-5xl space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <h1 className="flex items-center gap-1.5 text-lg font-bold"><Bot className="h-5 w-5 text-primary" />AIトークスクリプト</h1>
              <p className="text-2xs text-muted-foreground">AIテレアポ（リアルタイム音声）の話し方・冒頭トーク・切り返し・アポ取得ルールをコードなしで編集します。realtime発信時に選択したスクリプトが反映されます。</p>
            </div>
            <Button size="sm" onClick={() => setSel(empty())}><Plus className="h-3.5 w-3.5" />新規スクリプト</Button>
          </div>

          <div className="grid gap-3 md:grid-cols-[240px_1fr]">
            {/* 一覧 */}
            <div className="space-y-1">
              <div className="text-[10px] font-bold text-muted-foreground">スクリプト一覧（{scripts.length}）</div>
              {loading ? <SkeletonRows count={4} /> : scripts.map((s) => (
                <button key={s.id} onClick={() => setSel(s)}
                  className={`flex w-full items-center gap-1.5 rounded border px-2 py-1.5 text-left text-xs transition-colors ${sel?.id === s.id ? 'border-primary bg-primary/10 font-medium' : 'hover:bg-accent'}`}>
                  <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="flex-1 truncate">{s.name}</span>
                  {s.is_default && <span title="既定" className="shrink-0 rounded-full bg-amber-100 px-1.5 py-0.5 text-[9px] font-bold text-amber-700"><Star className="inline h-2.5 w-2.5" /> 既定</span>}
                </button>
              ))}
              {!loading && scripts.length === 0 && <div className="text-[11px] text-muted-foreground">スクリプトがありません。「新規スクリプト」で作成してください。</div>}
            </div>

            {/* エディタ */}
            {sel ? (
              <div className="space-y-3 rounded-lg border p-3">
                <div className="flex flex-wrap items-end gap-2">
                  <div className="min-w-[200px] flex-1">
                    <label className="text-[10px] font-bold text-muted-foreground">スクリプト名</label>
                    <Input value={sel.name ?? ''} onChange={(e) => setSel({ ...sel, name: e.target.value })} placeholder="例: デフォルト（MEO/Web提案）" className="h-8" />
                  </div>
                  <Button size="sm" onClick={save} disabled={busy}><Save className="h-3.5 w-3.5" />{busy ? '保存中…' : '保存'}</Button>
                  <Button size="sm" variant="outline" onClick={makeDefault} disabled={busy || !sel.id || !!sel.is_default}><Star className="h-3.5 w-3.5" />{sel.is_default ? '既定です' : '既定にする'}</Button>
                  {sel.id && !sel.is_default && <Button size="sm" variant="outline" onClick={removeScript} disabled={busy} className="border-red-300 text-red-600 hover:bg-red-50"><Trash2 className="h-3.5 w-3.5" />削除</Button>}
                </div>

                {/* システム固定の禁止行動（編集不可・常に適用） */}
                <div className="rounded-lg border border-amber-300 bg-amber-50/60 p-2 text-[11px] text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-200">
                  <div className="mb-1 flex items-center gap-1 font-bold"><ShieldAlert className="h-3.5 w-3.5" />システム固定の禁止行動（編集内容に関わらず常に適用）</div>
                  <ul className="grid list-disc gap-x-4 gap-y-0.5 pl-4 sm:grid-cols-2">{FIXED_RULES.map((r) => <li key={r}>{r}</li>)}</ul>
                </div>

                {/* 各項目 */}
                <div className="grid gap-2.5">
                  {FIELDS.map((f) => (
                    <div key={String(f.key)}>
                      <label className="text-[10px] font-bold text-muted-foreground">{f.label}</label>
                      <Textarea value={(sel[f.key] as string) ?? ''} onChange={(e) => set(f.key, e.target.value)} placeholder={f.placeholder} rows={f.rows} className="text-xs" />
                    </div>
                  ))}
                </div>

                {/* テスト発信 */}
                <div className="space-y-2 rounded-lg border-2 border-orange-300 bg-orange-50/50 p-2.5 dark:border-orange-500/30 dark:bg-orange-500/10">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-orange-700 dark:text-orange-300"><PhoneOutgoing className="h-3.5 w-3.5" />このスクリプトでテスト発信（realtime AI会話）</div>
                  <div className="text-[10px] text-muted-foreground">保存した内容で自分の番号にAIから発信し、実際の話し方を確認できます。realtime音声サーバーが有効な場合のみAI会話になります（未設定なら固定音声）。</div>
                  <div className="flex flex-wrap items-end gap-2">
                    <div><label className="text-[10px] font-bold text-orange-700 dark:text-orange-300">テスト発信先（あなたの番号）</label><Input value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="09012345678" className="h-8 w-[180px]" /></div>
                    <Button size="sm" onClick={testCall} disabled={testBusy || !sel.id} className="bg-orange-600 hover:bg-orange-700"><PhoneOutgoing className="h-3.5 w-3.5" />{testBusy ? '発信中…' : 'テスト発信'}</Button>
                  </div>
                  <div className="text-[10px] text-red-600">⚠️ 実際に電話がかかります。必ず自分/自社のテスト番号にかけてください。発信前に確認が出ます。</div>
                  {testResult && (testResult.ok
                    ? <div className="rounded bg-green-50 px-2 py-1 text-[11px] text-green-700 dark:bg-green-500/10">発信しました（SID {testResult.sid} / モード {testResult.mode}）。</div>
                    : <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-500/10">{testResult.error}{testResult.guidance && <div className="mt-0.5">💡 {testResult.guidance}</div>}</div>)}
                </div>
              </div>
            ) : (
              <div className="flex items-center justify-center rounded-lg border border-dashed p-8 text-sm text-muted-foreground">左の一覧から選択、または「新規スクリプト」で作成してください。</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
