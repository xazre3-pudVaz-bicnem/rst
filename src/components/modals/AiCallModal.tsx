import { useCallback, useEffect, useState } from 'react'
import moment from 'moment'
import { Phone, PhoneOff, Bot, CalendarPlus, Save, Plus, FileText, Ban } from 'lucide-react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { cn, jpError } from '@/lib/utils'
import { AiCallScriptApi, AiCallJobApi, runTestCall, createInterestAppointment } from '@/lib/aiCall'
import type { Case, AiCallScript, AiCallJob, AiCallStatus } from '@/lib/types'

const STATUS_COLOR: Record<string, string> = {
  未架電: 'bg-zinc-200 text-zinc-700', 発信中: 'bg-blue-500 text-white animate-pulse',
  通話完了: 'bg-sky-100 text-sky-700', 不在: 'bg-zinc-200 text-zinc-600', 担当者不在: 'bg-amber-100 text-amber-700',
  興味あり: 'bg-green-500 text-white', 興味なし: 'bg-zinc-300 text-zinc-600', 再架電: 'bg-yellow-100 text-yellow-800', NG: 'bg-red-500 text-white',
}
const TEMP_COLOR: Record<string, string> = { 高: 'text-red-600', 中: 'text-amber-600', 低: 'text-sky-600' }
const FORCE_OPTIONS: (AiCallStatus | 'ランダム')[] = ['ランダム', '興味あり', '再架電', '興味なし', '不在', '担当者不在', 'NG']

interface Props { open: boolean; onClose: () => void; selectedCase: Case | null; canWrite: boolean; onChanged?: () => void }

export default function AiCallModal({ open, onClose, selectedCase, canWrite, onChanged }: Props) {
  const { user, isAdmin, displayName } = useAuth()
  const toast = useToast()
  const [scripts, setScripts] = useState<AiCallScript[]>([])
  const [scriptId, setScriptId] = useState<string>('')
  const [force, setForce] = useState<string>('ランダム')
  const [running, setRunning] = useState(false)
  const [job, setJob] = useState<AiCallJob | null>(null)
  const [past, setPast] = useState<AiCallJob[]>([])
  const [appoAt, setAppoAt] = useState('')
  const [appoBusy, setAppoBusy] = useState(false)
  // スクリプト編集（管理者）
  const [editScript, setEditScript] = useState<AiCallScript | null>(null)
  const [showScripts, setShowScripts] = useState(false)

  const load = useCallback(async () => {
    const s = await AiCallScriptApi.list().catch(() => [])
    setScripts(s)
    setScriptId((prev) => prev || s.find((x) => x.is_default)?.id || s[0]?.id || '')
    if (selectedCase) setPast(await AiCallJobApi.listByCase(selectedCase.id).catch(() => []))
  }, [selectedCase])

  useEffect(() => { if (open) { setJob(null); setAppoAt(moment().add(1, 'day').hour(11).minute(0).format('YYYY-MM-DDTHH:mm')); load() } }, [open, load])

  const dnc = !!(selectedCase as any)?.do_not_call
  const script = scripts.find((s) => s.id === scriptId) || null

  async function call() {
    if (!selectedCase) return
    setRunning(true); setJob(null)
    try {
      const forceStatus = force === 'ランダム' ? undefined : (force as AiCallStatus)
      const j = await runTestCall(selectedCase, script, { userId: user?.id ?? null, forceStatus })
      setJob(j)
      toast.success(`架電完了: ${j.status}`)
      onChanged?.(); if (selectedCase) setPast(await AiCallJobApi.listByCase(selectedCase.id).catch(() => []))
    } catch (e) { toast.error(jpError(e)) } finally { setRunning(false) }
  }

  async function registerAppo() {
    if (!job || !selectedCase || !appoAt) return
    setAppoBusy(true)
    try {
      await createInterestAppointment(job, selectedCase, moment(appoAt).toISOString(), displayName || null, user?.id ?? null)
      toast.success('訪問予定を登録しました（Googleカレンダー連携ONなら反映されます）')
      setJob({ ...job, appointment_id: 'done' }); onChanged?.()
    } catch (e) { toast.error(jpError(e)) } finally { setAppoBusy(false) }
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
      <DialogContent className="max-h-[90vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-1.5"><Bot className="h-4 w-4 text-primary" />AI架電テスト（モック）{selectedCase && <span className="text-sm font-normal text-muted-foreground">— {selectedCase.name}</span>}</DialogTitle>
        </DialogHeader>

        {dnc ? (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700 dark:bg-red-500/10"><Ban className="mr-1 inline h-4 w-4" />この会社はNG（再架電しない）に設定されています。架電できません。</div>
        ) : (
          <div className="space-y-3">
            <div className="rounded bg-amber-50 px-2 py-1 text-[10px] text-amber-700 dark:bg-amber-500/10">現在は実通話なしの<b>モック</b>です（画面・DB・処理フロー検証用）。Twilio/音声AIは環境変数設定＋プロバイダ差し替えで有効化します。</div>

            {/* スクリプト選択＋テスト結果指定＋発信 */}
            <div className="flex flex-wrap items-end gap-2">
              <div className="min-w-[180px] flex-1">
                <label className="text-[10px] font-bold text-muted-foreground">トークスクリプト</label>
                <Select value={scriptId} onValueChange={setScriptId}>
                  <SelectTrigger className="h-8"><SelectValue placeholder="スクリプト" /></SelectTrigger>
                  <SelectContent>{scripts.map((s) => <SelectItem key={s.id} value={s.id}>{s.name}{s.is_default ? '（既定）' : ''}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <div>
                <label className="text-[10px] font-bold text-muted-foreground">モック結果（テスト用）</label>
                <Select value={force} onValueChange={setForce}>
                  <SelectTrigger className="h-8 w-[130px]"><SelectValue /></SelectTrigger>
                  <SelectContent>{FORCE_OPTIONS.map((o) => <SelectItem key={o} value={o}>{o}</SelectItem>)}</SelectContent>
                </Select>
              </div>
              <Button onClick={call} disabled={running || !selectedCase?.phone1}>{running ? <><PhoneOff className="h-4 w-4 animate-pulse" />発信中…</> : <><Phone className="h-4 w-4" />発信する</>}</Button>
              {isAdmin && <Button variant="outline" size="sm" onClick={() => setShowScripts((v) => !v)}><FileText className="h-3.5 w-3.5" />スクリプト編集</Button>}
            </div>
            {!selectedCase?.phone1 && <div className="text-[11px] text-red-600">電話番号が未登録のため発信できません。</div>}

            {/* 結果 */}
            {job && (
              <div className="space-y-2 rounded-lg border p-3">
                <div className="flex flex-wrap items-center gap-2 text-xs">
                  結果: {badge(job.status)}
                  {job.temperature && <span className={cn('font-bold', TEMP_COLOR[job.temperature])}>温度感 {job.temperature}</span>}
                  <span className="text-muted-foreground">通話 {job.duration_sec ?? 0}秒 ・ {job.called_at ? moment(job.called_at).format('MM/DD HH:mm') : ''}</span>
                </div>
                {job.ai_summary && <div className="text-xs"><b>AI要約:</b> {job.ai_summary}</div>}
                {job.next_action && <div className="text-xs"><b>次回アクション:</b> {job.next_action}</div>}
                {job.transcript && <details className="text-[11px]"><summary className="cursor-pointer text-muted-foreground">文字起こしを表示</summary><pre className="mt-1 whitespace-pre-wrap rounded bg-muted/40 p-2 font-sans">{job.transcript}</pre></details>}

                {/* 興味あり → 訪問予定登録（既存カレンダー連携を再利用） */}
                {job.status === '興味あり' && (
                  job.appointment_id ? (
                    <div className="rounded bg-green-50 px-2 py-1 text-xs text-green-700 dark:bg-green-500/10">✅ 訪問予定を登録しました。</div>
                  ) : (
                    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-green-300 bg-green-50/50 p-2 dark:bg-green-500/10">
                      <div><label className="text-[10px] font-bold text-green-700 dark:text-green-300">訪問/商談 日時</label><Input type="datetime-local" step={900} value={appoAt} onChange={(e) => setAppoAt(e.target.value)} className="h-8" /></div>
                      <Button size="sm" onClick={registerAppo} disabled={appoBusy || !canWrite}><CalendarPlus className="h-3.5 w-3.5" />{appoBusy ? '登録中…' : '訪問予定を登録'}</Button>
                    </div>
                  )
                )}
                {job.status === 'NG' && <div className="rounded bg-red-50 px-2 py-1 text-xs text-red-700 dark:bg-red-500/10"><Ban className="mr-1 inline h-3.5 w-3.5" />NG判定のため、この会社は今後の架電対象から除外しました（再架電しない）。</div>}
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
                  <div key={p.id} className="flex flex-wrap items-center gap-2 rounded border bg-background px-2 py-1 text-[11px]">
                    {badge(p.status)}
                    <span className="text-muted-foreground">{p.called_at ? moment(p.called_at).format('MM/DD HH:mm') : moment(p.created_date).format('MM/DD HH:mm')}</span>
                    {p.temperature && <span className={cn('font-bold', TEMP_COLOR[p.temperature])}>{p.temperature}</span>}
                    {p.ai_summary && <span className="flex-1 truncate text-muted-foreground" title={p.ai_summary}>{p.ai_summary}</span>}
                    {p.appointment_id && <span className="text-green-600">📅予定登録</span>}
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
