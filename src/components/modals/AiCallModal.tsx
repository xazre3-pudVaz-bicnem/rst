import { useCallback, useEffect, useState } from 'react'
import moment from 'moment'
import { Phone, PhoneOff, Bot, CalendarPlus, Save, Plus, FileText, Ban, Unlock, Clock, CheckCircle2, XCircle, PhoneOutgoing } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { cn, jpError } from '@/lib/utils'
import { AiCallScriptApi, AiCallJobApi, TwilioApi, runTestCall, createInterestAppointment, setNextCall, releaseNg } from '@/lib/aiCall'
import type { Case, AiCallScript, AiCallJob, AiCallStatus } from '@/lib/types'
import type { SyncResult } from '@/lib/calendarSync'

const STATUS_COLOR: Record<string, string> = {
  未架電: 'bg-zinc-200 text-zinc-700', 発信中: 'bg-blue-500 text-white animate-pulse',
  通話完了: 'bg-sky-100 text-sky-700', 不在: 'bg-zinc-200 text-zinc-600', 担当者不在: 'bg-amber-100 text-amber-700',
  興味あり: 'bg-green-500 text-white', 興味なし: 'bg-zinc-300 text-zinc-600', 再架電: 'bg-yellow-100 text-yellow-800', NG: 'bg-red-500 text-white',
}
const TEMP_COLOR: Record<string, string> = { 高: 'text-red-600', 中: 'text-amber-600', 低: 'text-sky-600' }
// モック結果を選びやすいボタン（この結果になったと仮定して発信）
const OUTCOMES: { s: AiCallStatus; label: string; cls: string }[] = [
  { s: '興味あり', label: '興味あり', cls: 'border-green-400 text-green-700 hover:bg-green-50' },
  { s: '再架電', label: '再架電', cls: 'border-yellow-400 text-yellow-700 hover:bg-yellow-50' },
  { s: '担当者不在', label: '担当者不在', cls: 'border-amber-400 text-amber-700 hover:bg-amber-50' },
  { s: '不在', label: '不在', cls: 'border-zinc-300 text-zinc-600 hover:bg-zinc-50' },
  { s: '興味なし', label: '興味なし', cls: 'border-zinc-300 text-zinc-600 hover:bg-zinc-50' },
  { s: 'NG', label: 'NG（拒否）', cls: 'border-red-400 text-red-700 hover:bg-red-50' },
]
const NEXT_STATUSES: AiCallStatus[] = ['不在', '担当者不在', '再架電']

interface Props { open: boolean; onClose: () => void; selectedCase: Case | null; canWrite: boolean; onChanged?: () => void }

export default function AiCallModal({ open, onClose, selectedCase, canWrite, onChanged }: Props) {
  const { user, isAdmin, displayName } = useAuth()
  const toast = useToast()
  const [scripts, setScripts] = useState<AiCallScript[]>([])
  const [scriptId, setScriptId] = useState<string>('')
  const [running, setRunning] = useState(false)
  const [job, setJob] = useState<AiCallJob | null>(null)
  const [past, setPast] = useState<AiCallJob[]>([])
  const [appoAt, setAppoAt] = useState('')
  const [appoBusy, setAppoBusy] = useState(false)
  const [sync, setSync] = useState<SyncResult | null>(null)
  const [nextAt, setNextAt] = useState('')
  const [nextBusy, setNextBusy] = useState(false)
  const [editScript, setEditScript] = useState<AiCallScript | null>(null)
  const [showScripts, setShowScripts] = useState(false)
  const [ngReleased, setNgReleased] = useState(false)
  // Twilio接続テスト（管理者・テスト番号への実発信）
  const [showTwilio, setShowTwilio] = useState(false)
  const [twStatus, setTwStatus] = useState<any>(null)
  const [twNumber, setTwNumber] = useState('')
  const [twMsg, setTwMsg] = useState('こちらはアールエスティーのテスト発信です。')
  const [twBusy, setTwBusy] = useState(false)
  const [twResult, setTwResult] = useState<any>(null)

  const load = useCallback(async () => {
    const s = await AiCallScriptApi.list().catch(() => [])
    setScripts(s)
    setScriptId((prev) => prev || s.find((x) => x.is_default)?.id || s[0]?.id || '')
    if (selectedCase) setPast(await AiCallJobApi.listByCase(selectedCase.id).catch(() => []))
  }, [selectedCase])

  useEffect(() => {
    if (open) {
      setJob(null); setSync(null); setNgReleased(false)
      setAppoAt(moment().add(1, 'day').hour(11).minute(0).format('YYYY-MM-DDTHH:mm'))
      setNextAt(moment().add(3, 'day').hour(11).minute(0).format('YYYY-MM-DDTHH:mm'))
      load()
    }
  }, [open, load])

  const dnc = !!(selectedCase as any)?.do_not_call && !ngReleased
  const script = scripts.find((s) => s.id === scriptId) || null
  const provider = 'mock' // MVPはモック固定。twilio化時はここを切替＋発信前confirm。

  async function call(forceStatus?: AiCallStatus) {
    if (!selectedCase) return
    // 実発信(twilio)の場合は必ず確認ダイアログ。モックは不要。
    if (provider !== 'mock' && !window.confirm(`実際に ${selectedCase.phone1} へ電話をかけます。よろしいですか？`)) return
    setRunning(true); setJob(null); setSync(null)
    try {
      const j = await runTestCall(selectedCase, script, { userId: user?.id ?? null, forceStatus, provider })
      setJob(j)
      toast.success(`架電完了: ${j.status}`)
      onChanged?.(); if (selectedCase) setPast(await AiCallJobApi.listByCase(selectedCase.id).catch(() => []))
    } catch (e) { toast.error(jpError(e)) } finally { setRunning(false) }
  }

  async function registerAppo() {
    if (!job || !selectedCase || !appoAt) return
    setAppoBusy(true); setSync(null)
    try {
      const { sync: sr } = await createInterestAppointment(job, selectedCase, moment(appoAt).toISOString(), displayName || null, user?.id ?? null)
      setSync(sr)
      setJob({ ...job, appointment_id: 'done' }); onChanged?.()
      if (sr.synced) toast.success('訪問予定を登録し、Googleカレンダーに反映しました')
      else if (sr.skipped) toast.success('訪問予定を登録しました（カレンダー反映はOFF/未設定）')
      else toast.error('訪問予定は登録しましたが、カレンダー反映に失敗しました')
    } catch (e) { toast.error(jpError(e)) } finally { setAppoBusy(false) }
  }

  async function saveNext() {
    if (!job || !selectedCase || !nextAt) return
    setNextBusy(true)
    try {
      await setNextCall(selectedCase, job, moment(nextAt).toISOString())
      toast.success('次回架電予定日を設定しました（一覧の「本日再架電(AI)」で絞り込めます）')
      onChanged?.(); if (selectedCase) setPast(await AiCallJobApi.listByCase(selectedCase.id).catch(() => []))
    } catch (e) { toast.error(jpError(e)) } finally { setNextBusy(false) }
  }

  async function unlockNg() {
    if (!selectedCase) return
    try { await releaseNg(selectedCase.id); setNgReleased(true); toast.success('NG指定を解除しました（架電可能）'); onChanged?.() }
    catch (e) { toast.error(jpError(e)) }
  }

  async function openTwilio() {
    const next = !showTwilio; setShowTwilio(next)
    if (next && !twStatus) setTwStatus(await TwilioApi.status())
  }
  async function twilioTest() {
    if (!twNumber.trim()) { toast.error('テスト発信先の電話番号を入力してください'); return }
    // 実際に電話がかかるため必ず確認
    if (!window.confirm(`【実発信】${twNumber} に実際に電話をかけます（Twilio）。よろしいですか？\n※営業先ではなくテスト番号にかけてください。`)) return
    setTwBusy(true); setTwResult(null)
    try {
      const r = await TwilioApi.testCall(twNumber.trim(), twMsg)
      setTwResult(r)
      if (r?.ok) toast.success(`発信しました（SID: ${r.sid ?? '—'}）。通話結果はTwilioのWebhookで反映されます。`)
      else toast.error(r?.error || '発信に失敗しました')
    } catch (e) { toast.error(jpError(e)) } finally { setTwBusy(false) }
  }

  async function saveScript() {
    if (!editScript) return
    try {
      if (editScript.id) await AiCallScriptApi.update(editScript.id, { name: editScript.name, body: editScript.body })
      else await AiCallScriptApi.create({ name: editScript.name, body: editScript.body, created_by_id: user?.id ?? null })
      toast.success('スクリプトを保存しました'); setEditScript(null); load()
    } catch (e) { toast.error(jpError(e)) }
  }

  const badge = (s?: string | null) => <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', STATUS_COLOR[s || ''] || 'bg-zinc-200 text-zinc-600')}>{s || '—'}</span>

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-h-[92vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5"><Bot className="h-4 w-4 text-primary" />AI架電テスト（モック）{selectedCase && <span className="truncate text-sm font-normal text-muted-foreground">— {selectedCase.name}</span>}</DialogTitle>
        </DialogHeader>

        {dnc ? (
          <div className="space-y-2 rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10">
            <div><Ban className="mr-1 inline h-4 w-4" />この案件はNG指定のため架電できません。</div>
            {isAdmin && <Button size="sm" variant="outline" onClick={unlockNg}><Unlock className="h-3.5 w-3.5" />NG指定を解除（管理者）</Button>}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-500/10">現在は実通話なしの<b>モック</b>です（画面・DB・処理フロー検証用）。実発信(Twilio)化時は発信前に確認ダイアログが入ります。</div>

            {/* スクリプト選択 */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] flex-1">
                <label className="text-[10px] font-bold text-muted-foreground">トークスクリプト</label>
                <Select value={scriptId} onValueChange={setScriptId}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="スクリプト" /></SelectTrigger>
                  <SelectContent>{scripts.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}{s.is_default ? '（既定）' : ''}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowScripts((v) => !v)}><FileText className="h-3.5 w-3.5" />スクリプト編集</Button>}
              {isAdmin && <Button variant="outline" size="sm" onClick={openTwilio}><PhoneOutgoing className="h-3.5 w-3.5" />Twilio接続テスト</Button>}
            </div>
            {!selectedCase?.phone1 && <div className="text-[11px] text-red-600">電話番号が未登録のため発信できません。</div>}

            {/* 発信: 結果を選びやすいボタン（モック） */}
            <div className="rounded-lg border p-2">
              <div className="mb-1 text-[10px] font-bold text-muted-foreground">発信する（モック結果を選択）</div>
              <div className="flex flex-wrap gap-1.5">
                {OUTCOMES.map((o) => (
                  <Button key={o.s} variant="outline" size="sm" disabled={running || !selectedCase?.phone1} onClick={() => call(o.s)} className={cn('border', o.cls)}>
                    {running ? <PhoneOff className="h-3.5 w-3.5 animate-pulse" /> : <Phone className="h-3.5 w-3.5" />}{o.label}
                  </Button>
                ))}
                <Button size="sm" disabled={running || !selectedCase?.phone1} onClick={() => call(undefined)}><Phone className="h-3.5 w-3.5" />ランダム発信</Button>
              </div>
            </div>

            {/* Twilio接続テスト（管理者・テスト番号への"実発信"。営業先への発信とは分離） */}
            {isAdmin && showTwilio && (
              <div className="space-y-2 rounded-lg border-2 border-purple-300 bg-purple-50/50 p-2.5 dark:border-purple-500/30 dark:bg-purple-500/10">
                <div className="flex items-center gap-1.5 text-xs font-bold text-purple-700 dark:text-purple-300"><PhoneOutgoing className="h-3.5 w-3.5" />Twilio接続テスト（実発信・テスト番号のみ）</div>
                <div className="space-y-0.5 text-[10px] text-muted-foreground">
                  <div>接続状態: プロバイダ=<b>{twStatus?.provider ?? '確認中'}</b> ／ Twilio設定={twStatus?.configured ? '✅' : '未設定'} ／ 実発信可否={twStatus?.realCallEnabled ? '✅可能' : '不可'}</div>
                  {twStatus && (
                    <div className="font-mono text-[9px]">
                      SID={twStatus.accountSidMasked} ({twStatus.checks?.sidPrefixOk ? 'AC✓' : 'AC✗'} {twStatus.checks?.sidLen}文字{twStatus.checks?.sidLenOk ? '✓' : '✗'}) ／ token={twStatus.checks?.tokenPresent ? `${twStatus.checks?.tokenLen}文字` : '空'} ／ 発信元env=<b>{twStatus.fromEnvUsed}</b>={twStatus.from || '(空)'}{twStatus.checks?.fromE164 ? '✓' : '✗E.164'}
                    </div>
                  )}
                </div>
                {twStatus && !twStatus.realCallEnabled && (
                  <div className="rounded bg-amber-100 px-2 py-1 text-[10px] text-amber-800 dark:bg-amber-500/15">
                    実発信するには Vercel環境変数が必要です{twStatus.provider !== 'twilio' && '（AI_CALL_PROVIDER=twilio）'}{twStatus.missingEnv?.length ? `。未設定: ${twStatus.missingEnv.join(', ')}` : ''}。設定＆再デプロイ後に発信できます。
                  </div>
                )}
                <div className="flex flex-wrap items-end gap-2">
                  <div><label className="text-[10px] font-bold text-purple-700 dark:text-purple-300">テスト発信先（あなたの番号）</label><Input value={twNumber} onChange={(e) => setTwNumber(e.target.value)} placeholder="09012345678" className="h-8 w-[160px]" /></div>
                  <div className="min-w-[180px] flex-1"><label className="text-[10px] font-bold text-purple-700 dark:text-purple-300">読み上げメッセージ</label><Input value={twMsg} onChange={(e) => setTwMsg(e.target.value)} className="h-8" /></div>
                  <Button size="sm" onClick={twilioTest} disabled={twBusy || !twStatus?.realCallEnabled} className="bg-purple-600 hover:bg-purple-700"><PhoneOutgoing className="h-3.5 w-3.5" />{twBusy ? '発信中…' : '実発信テスト'}</Button>
                </div>
                <div className="text-[10px] text-red-600">⚠️ 実際に電話がかかります。必ず自分/自社のテスト番号にかけてください（営業先は不可）。発信前に確認ダイアログが出ます。</div>
                {twResult && (
                  twResult.ok ? (
                    <div className="rounded bg-green-50 px-2 py-1 text-[11px] text-green-700 dark:bg-green-500/10">
                      <CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />発信しました（発信先 {twResult.to} / SID {twResult.sid}）。通話終了後にログへ反映されます。
                    </div>
                  ) : (
                    <div className="space-y-1 rounded bg-red-50 px-2 py-1.5 text-[11px] text-red-700 dark:bg-red-500/10">
                      <div><XCircle className="mr-1 inline h-3.5 w-3.5" />{twResult.error}</div>
                      {Array.isArray(twResult.errors) && twResult.errors.length > 0 && <ul className="ml-4 list-disc">{twResult.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
                      {(twResult.status || twResult.code || twResult.moreInfo || twResult.detail) && (
                        <div className="font-mono text-[9px] text-red-600">
                          {twResult.status != null && <div>status: {twResult.status}</div>}
                          {twResult.code != null && <div>code: {twResult.code}</div>}
                          {twResult.moreInfo && <div>moreInfo: {twResult.moreInfo}</div>}
                          {twResult.detail && <div>detail: {twResult.detail}</div>}
                        </div>
                      )}
                      {twResult.debug && (
                        <details className="text-[9px]">
                          <summary className="cursor-pointer">送信直前デバッグ（秘密情報マスク済み）</summary>
                          <div className="mt-0.5 font-mono">
                            <div>accountSidMasked: {twResult.debug.accountSidMasked}</div>
                            <div>from: {twResult.debug.from}（env: {twResult.debug.fromEnvUsed}）</div>
                            <div>to: {twResult.debug.to}</div>
                            <div>provider: {twResult.debug.provider}</div>
                            <div>endpoint: {twResult.debug.endpoint}</div>
                          </div>
                        </details>
                      )}
                    </div>
                  )
                )}
              </div>
            )}

            {/* 結果（見やすく） */}
            {job && (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3">
                  <div className="flex items-center gap-1">結果: {badge(job.status)}</div>
                  <div>温度感: {job.temperature ? <span className={cn('font-bold', TEMP_COLOR[job.temperature])}>{job.temperature}</span> : '—'}</div>
                  <div className="text-muted-foreground">通話 {job.duration_sec ?? 0}秒</div>
                  <div className="col-span-2 text-muted-foreground sm:col-span-3">架電日時: {job.called_at ? moment(job.called_at).format('YYYY/MM/DD HH:mm') : '—'}</div>
                </div>
                {job.ai_summary && <div className="rounded bg-muted/30 p-1.5 text-xs"><b>AI要約:</b> {job.ai_summary}</div>}
                {job.next_action && <div className="text-xs"><b>次回アクション:</b> {job.next_action}</div>}
                {job.transcript && <details className="text-[11px]"><summary className="cursor-pointer text-muted-foreground">文字起こしを表示</summary><pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans">{job.transcript}</pre></details>}

                {/* 興味あり → 訪問予定登録（既存カレンダー連携を再利用・成否表示） */}
                {job.status === '興味あり' && (
                  job.appointment_id ? (
                    <div className="space-y-1">
                      <div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700 dark:bg-green-500/10"><CheckCircle2 className="mr-1 inline h-3.5 w-3.5" />訪問予定を登録しました。</div>
                      {sync?.synced && <div className="rounded bg-green-50 px-2 py-1 text-[11px] text-green-700 dark:bg-green-500/10">📅 Googleカレンダーに反映しました。</div>}
                      {sync?.skipped && <div className="rounded bg-zinc-100 px-2 py-1 text-[11px] text-zinc-600 dark:bg-zinc-700/40">カレンダー反映は{sync.reason || 'OFF/未設定'}のためスキップ（訪問予定は登録済み）。</div>}
                      {sync && !sync.synced && !sync.skipped && <div className="rounded bg-red-50 px-2 py-1 text-[11px] text-red-700 dark:bg-red-500/10"><XCircle className="mr-1 inline h-3.5 w-3.5" />カレンダー反映に失敗: {sync.error}</div>}
                    </div>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-green-300 bg-green-50/50 p-2 dark:bg-green-500/10">
                      <div><label className="text-[10px] font-bold text-green-700 dark:text-green-300">訪問/商談 日時</label><Input type="datetime-local" step={900} value={appoAt} onChange={(e) => setAppoAt(e.target.value)} className="h-8" /></div>
                      <Button size="sm" onClick={registerAppo} disabled={appoBusy || !canWrite}><CalendarPlus className="h-3.5 w-3.5" />{appoBusy ? '登録中…' : '訪問予定を登録'}</Button>
                    </div>
                  )
                )}

                {/* 不在/担当者不在/再架電 → 次回架電予定日 */}
                {NEXT_STATUSES.includes(job.status) && (
                  <div className="flex flex-wrap items-end gap-2 rounded-lg border border-amber-300 bg-amber-50/50 p-2 dark:bg-amber-500/10">
                    <div><label className="text-[10px] font-bold text-amber-700 dark:text-amber-300"><Clock className="mr-0.5 inline h-3 w-3" />次回架電予定日</label><Input type="datetime-local" step={900} value={nextAt} onChange={(e) => setNextAt(e.target.value)} className="h-8" /></div>
                    <Button size="sm" variant="outline" onClick={saveNext} disabled={nextBusy || !canWrite}><Save className="h-3.5 w-3.5" />{nextBusy ? '設定中…' : '次回予定を設定'}</Button>
                  </div>
                )}

                {job.status === 'NG' && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-500/10"><Ban className="mr-1 inline h-3.5 w-3.5" />NG判定のため、この会社は今後の架電対象から除外しました（再架電しない）。{isAdmin && <button onClick={unlockNg} className="ml-1 underline">解除する</button>}</div>}
              </div>
            )}

            {/* スクリプト編集（管理者） */}
            {showScripts && isAdmin && (
              <div className="space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
                <div className="flex items-center justify-between"><span className="text-xs font-bold">トークスクリプト</span><Button size="sm" variant="outline" onClick={() => setEditScript({ id: '', name: '', body: '' } as AiCallScript)}><Plus className="h-3.5 w-3.5" />新規</Button></div>
                {scripts.map((s) => <div key={s.id} className="flex items-center gap-2 text-xs"><span className="flex-1 truncate">{s.name}{s.is_default ? '（既定）' : ''}</span><Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => setEditScript(s)}>編集</Button></div>)}
                {editScript && (
                  <div className="space-y-1.5 rounded border bg-background p-2">
                    <Input value={editScript.name} onChange={(e) => setEditScript({ ...editScript, name: e.target.value })} placeholder="スクリプト名" className="h-8" />
                    <Textarea value={editScript.body} onChange={(e) => setEditScript({ ...editScript, body: e.target.value })} placeholder="トーク内容（{店名}{地域}{担当者}{会社名} を差し込み可）" rows={8} className="text-xs" />
                    <div className="flex gap-1.5"><Button size="sm" onClick={saveScript}><Save className="h-3.5 w-3.5" />保存</Button><Button size="sm" variant="outline" onClick={() => setEditScript(null)}>キャンセル</Button></div>
                  </div>
                )}
              </div>
            )}

            {/* 架電ログ（この案件） */}
            <div>
              <div className="mb-1 text-[10px] font-bold text-muted-foreground">この案件の架電ログ（{past.length}）</div>
              <div className="space-y-1">
                {past.length === 0 && <div className="text-[11px] text-muted-foreground">まだ架電履歴はありません。</div>}
                {past.map((p) => (
                  <details key={p.id} className="rounded border bg-background px-2 py-1 text-[11px]">
                    <summary className="flex cursor-pointer flex-wrap items-center gap-2">
                      {badge(p.status)}
                      <span className="text-muted-foreground">{p.called_at ? moment(p.called_at).format('MM/DD HH:mm') : moment(p.created_date).format('MM/DD HH:mm')}</span>
                      {p.duration_sec != null && <span className="text-muted-foreground">{p.duration_sec}秒</span>}
                      {p.temperature && <span className={cn('font-bold', TEMP_COLOR[p.temperature])}>{p.temperature}</span>}
                      {p.appointment_id && <span className="text-green-600">📅予定登録</span>}
                      {p.ai_summary && <span className="flex-1 truncate text-muted-foreground">{p.ai_summary}</span>}
                    </summary>
                    <div className="mt-1 space-y-0.5 border-t pt-1">
                      {p.ai_summary && <div><b>AI要約:</b> {p.ai_summary}</div>}
                      {p.next_action && <div><b>次回アクション:</b> {p.next_action}</div>}
                      {p.transcript && <pre className="mt-0.5 whitespace-pre-wrap rounded bg-muted/40 p-1.5 font-sans">{p.transcript}</pre>}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
