// ============================================================
// TimeRex連携UI。
//  <TimeRexShare/>   … 各画面（ホーム/案件詳細/訪問予定）で 空き日程URL の確認・コピー・共有文コピー
//  <TimeRexManager/> … 管理者用の 登録/編集/有効化/削除（設定・管理画面）
// アポ代行会社に「こちらの空き日程」を共有する用途。営業先に送るものではない。
// ============================================================
import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useToast } from '@/components/ui/toast'
import { copyToClipboard, jpError, cn } from '@/lib/utils'
import { useAuth } from '@/context/AuthContext'
import { TimeRexApi, buildAgencyShareText, type TimeRexSetting, type ShareVariant } from '@/lib/timerex'
import { CalendarApi, type CalStatus } from '@/lib/calendarSync'
import { Copy, ExternalLink, Calendar, Plus, Trash2, CalendarCheck } from 'lucide-react'

const SHARE_TABS: { key: ShareVariant; label: string }[] = [
  { key: 'normal', label: 'アポ代行 通常文' }, { key: 'short', label: '短文' }, { key: 'slack', label: 'Slack/チャット' }, { key: 'mail', label: 'メール' },
]

/** 各画面に埋め込む表示・コピー用。compact=省スペース表示。 */
export function TimeRexShare({ compact = false }: { compact?: boolean }) {
  const toast = useToast()
  const [rows, setRows] = useState<TimeRexSetting[]>([])
  const [loading, setLoading] = useState(true)
  const [openShare, setOpenShare] = useState<string | null>(null)
  const [variant, setVariant] = useState<ShareVariant>('normal')

  useEffect(() => { TimeRexApi.listEnabled().then((r) => { setRows(r); setLoading(false) }).catch(() => setLoading(false)) }, [])

  async function copy(text: string, label: string) {
    const ok = await copyToClipboard(text)
    ok ? toast.success(`${label}をコピーしました`) : toast.error('コピーに失敗しました')
  }
  if (loading) return null
  if (rows.length === 0) return null

  return (
    <div className={cn('rounded-xl border border-sky-300 bg-sky-50/50 p-3 dark:border-sky-500/30 dark:bg-sky-500/10', compact && 'p-2')}>
      <div className="flex items-center gap-1.5 text-sm font-bold text-sky-700 dark:text-sky-300"><Calendar className="h-4 w-4" />アポ代行会社向け 空き日程（TimeRex）</div>
      <div className="mt-0.5 text-[10px] text-muted-foreground">このURLは、アポ代行会社がこちらの空き日程を確認するためのものです。営業先へ直接送るものではありません。</div>
      <div className="mt-2 space-y-2">
        {rows.map((r) => (
          <div key={r.id} className="rounded-lg border bg-card p-2">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs font-bold">{r.name}</span>
              <a href={r.timerex_schedule_url || '#'} target="_blank" rel="noreferrer" className="max-w-[240px] truncate text-[11px] text-primary hover:underline">{r.timerex_schedule_url}</a>
              <div className="ml-auto flex flex-wrap gap-1">
                <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => copy(r.timerex_schedule_url || '', 'URL')}><Copy className="h-3 w-3" />URLコピー</Button>
                <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => window.open(r.timerex_schedule_url || '#', '_blank')}><ExternalLink className="h-3 w-3" />TimeRexで開く</Button>
                <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => setOpenShare(openShare === r.id ? null : r.id)}>アポ代行向け共有文</Button>
              </div>
            </div>
            {r.memo && <div className="mt-0.5 text-[10px] text-muted-foreground">{r.memo}</div>}
            {openShare === r.id && (
              <div className="mt-1.5 rounded border bg-muted/30 p-1.5">
                <div className="flex flex-wrap gap-1">
                  {SHARE_TABS.map((t) => <button key={t.key} onClick={() => setVariant(t.key)} className={cn('rounded border px-1.5 py-0.5 text-[10px]', variant === t.key ? 'border-primary bg-primary text-primary-foreground' : 'border-input hover:bg-accent')}>{t.label}</button>)}
                  <Button size="sm" className="ml-auto h-6 text-2xs" onClick={() => copy(buildAgencyShareText(r.timerex_schedule_url || '', variant, r.name), '共有文')}><Copy className="h-3 w-3" />この文をコピー</Button>
                </div>
                <pre className="mt-1 whitespace-pre-wrap font-sans text-[10px] leading-relaxed text-muted-foreground">{buildAgencyShareText(r.timerex_schedule_url || '', variant, r.name)}</pre>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  )
}

const EMPTY: Partial<TimeRexSetting> = { name: '', timerex_schedule_url: '', memo: '', is_enabled: false }

/** 管理者用: TimeRex URLの登録・編集・有効化・削除。 */
export function TimeRexManager() {
  const toast = useToast()
  const { user, isAdmin } = useAuth()
  const [rows, setRows] = useState<TimeRexSetting[]>([])
  const [form, setForm] = useState<Partial<TimeRexSetting> | null>(null)
  const [busy, setBusy] = useState(false)

  const [cal, setCal] = useState<CalStatus | null>(null)
  const load = useCallback(() => { TimeRexApi.list().then(setRows).catch(() => {}); CalendarApi.status().then(setCal).catch(() => {}) }, [])
  useEffect(() => { load() }, [load])
  async function toggleCal() { const next = !cal?.enabled; try { await CalendarApi.setEnabled(next); setCal((p) => p ? { ...p, enabled: next } : p); toast.success(`訪問登録のGoogleカレンダー反映を${next ? 'ON' : 'OFF'}にしました`) } catch (e) { toast.error(jpError(e)) } }

  async function save() {
    if (!form?.name?.trim()) { toast.error('表示名は必須です'); return }
    const url = (form.timerex_schedule_url || '').trim()
    if (url && !/^https?:\/\//i.test(url)) { toast.error('URLは http(s):// から入力してください'); return }
    if (form.is_enabled && !url) { toast.error('有効にするにはTimeRex URLが必要です'); return }
    setBusy(true)
    try {
      const payload = { name: form.name.trim(), timerex_schedule_url: url || null, memo: form.memo?.trim() || null, is_enabled: !!form.is_enabled }
      if (form.id) await TimeRexApi.update(form.id, payload, user?.id ?? null)
      else await TimeRexApi.create({ ...payload, user_id: user?.id ?? null }, user?.id ?? null)
      toast.success('保存しました'); setForm(null); load()
    } catch (e) { toast.error('保存に失敗しました: ' + jpError(e)) } finally { setBusy(false) }
  }
  async function toggle(r: TimeRexSetting) {
    if (!r.is_enabled && !r.timerex_schedule_url) { toast.error('有効にするにはURLが必要です'); return }
    try { await TimeRexApi.update(r.id, { is_enabled: !r.is_enabled }, user?.id ?? null); toast.success(!r.is_enabled ? '有効にしました' : '無効にしました'); load() } catch (e) { toast.error(jpError(e)) }
  }
  async function remove(r: TimeRexSetting) {
    if (!window.confirm(`「${r.name}」を削除しますか？`)) return
    try { await TimeRexApi.remove(r.id); toast.success('削除しました'); load() } catch (e) { toast.error(jpError(e)) }
  }

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="flex items-center gap-1.5 text-sm font-bold"><Calendar className="h-4 w-4 text-sky-600" />TimeRex連携（アポ代行会社向け 空き日程URL）</div>
          <div className="text-[10px] text-muted-foreground">アポ代行会社がこちらの空き日程を確認し、確定アポをRSTの訪問予定へ登録する運用を想定。営業先へ送るURLではありません。Googleカレンダー連携は行いません（TimeRex側で管理）。</div>
        </div>
        {isAdmin && <Button size="sm" onClick={() => setForm({ ...EMPTY })}><Plus className="h-3.5 w-3.5" />URLを追加</Button>}
      </div>

      {!isAdmin && <div className="mt-2 rounded bg-muted/40 px-2 py-1 text-[10px] text-muted-foreground">閲覧・コピーのみ可能です（登録・編集・削除は管理者のみ）。</div>}

      {/* 訪問登録→Googleカレンダー反映 */}
      <div className="mt-2 rounded-lg border border-emerald-300 bg-emerald-50/50 p-2 dark:border-emerald-500/30 dark:bg-emerald-500/10">
        <div className="flex flex-wrap items-center gap-2">
          <span className="flex items-center gap-1 text-xs font-bold text-emerald-700 dark:text-emerald-300"><CalendarCheck className="h-3.5 w-3.5" />訪問登録をGoogleカレンダーに反映</span>
          {isAdmin && <button onClick={toggleCal} className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', cal?.enabled ? 'bg-green-500 text-white' : 'bg-zinc-300 text-zinc-600 dark:bg-zinc-700')}>{cal?.enabled ? 'ON' : 'OFF'}</button>}
          <span className="text-[10px] text-muted-foreground">
            {cal == null ? '確認中…' : !cal.configured ? '未設定（サーバーにサービスアカウント/カレンダーID未設定）' : cal.reachable ? `接続OK（${cal.calendarId}）` : `接続エラー: ${cal.error || '要確認'}`}
          </span>
        </div>
        <div className="mt-0.5 text-[10px] text-muted-foreground">
          RSTで訪問予定を登録すると、TimeRexが連携しているGoogleカレンダーに予定を作成し、その時間帯を自動で空き枠から外します（二重予約防止）。
          {cal && !cal.configured && <span className="mt-0.5 block text-amber-700 dark:text-amber-300">設定手順: ①GoogleサービスアカウントJSONを作成 ②対象カレンダーを その サービスアカウントのメールに『予定の変更』権限で共有 ③TimeRexを同じカレンダーに連携 ④Vercelの環境変数に GOOGLE_CALENDAR_ID / GOOGLE_SA_CLIENT_EMAIL / GOOGLE_SA_PRIVATE_KEY を設定。</span>}
        </div>
      </div>

      <div className="mt-2 space-y-1.5">
        {rows.length === 0 && <div className="text-xs text-muted-foreground">まだ登録がありません。{isAdmin ? '「URLを追加」から登録してください。' : ''}</div>}
        {rows.map((r) => (
          <div key={r.id} className="flex flex-wrap items-center gap-2 rounded-lg border bg-background p-2 text-xs">
            <span className={cn('rounded-full px-2 py-0.5 text-[10px] font-bold', r.is_enabled ? 'bg-green-500 text-white' : 'bg-zinc-300 text-zinc-600 dark:bg-zinc-700')}>{r.is_enabled ? '有効' : '無効'}</span>
            <span className="font-bold">{r.name}</span>
            <a href={r.timerex_schedule_url || '#'} target="_blank" rel="noreferrer" className="max-w-[260px] truncate text-primary hover:underline">{r.timerex_schedule_url || '（URL未登録）'}</a>
            {r.memo && <span className="text-[10px] text-muted-foreground">{r.memo}</span>}
            <span className="text-[10px] text-muted-foreground">更新 {r.updated_at ? new Date(r.updated_at).toLocaleString('ja-JP', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) : '—'}</span>
            <div className="ml-auto flex gap-1">
              <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => copyToClipboard(r.timerex_schedule_url || '').then((ok) => ok && toast.success('URLをコピーしました'))} disabled={!r.timerex_schedule_url}><Copy className="h-3 w-3" />コピー</Button>
              {isAdmin && <><Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => toggle(r)}>{r.is_enabled ? '無効化' : '有効化'}</Button>
              <Button size="sm" variant="outline" className="h-6 text-2xs" onClick={() => setForm({ ...r })}>編集</Button>
              <Button size="sm" variant="outline" className="h-6 text-2xs text-red-600" onClick={() => remove(r)}><Trash2 className="h-3 w-3" /></Button></>}
            </div>
          </div>
        ))}
      </div>

      {form && isAdmin && (
        <div className="mt-2 space-y-2 rounded-lg border border-primary/40 bg-primary/5 p-2">
          <div className="text-xs font-bold">{form.id ? 'TimeRex URLを編集' : 'TimeRex URLを追加'}</div>
          <label className="block text-[11px]">表示名<input value={form.name || ''} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="例: 織田 訪問可能日程" className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs" /></label>
          <label className="block text-[11px]">TimeRex URL<input value={form.timerex_schedule_url || ''} onChange={(e) => setForm({ ...form, timerex_schedule_url: e.target.value })} placeholder="https://timerex.net/s/xxxxx/yyyyy" className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs" /></label>
          <label className="block text-[11px]">補足メモ<input value={form.memo || ''} onChange={(e) => setForm({ ...form, memo: e.target.value })} placeholder="例: アポ代行会社が訪問アポ取得時に確認する日程調整URL" className="mt-0.5 w-full rounded border border-input bg-background px-2 py-1 text-xs" /></label>
          <label className="flex items-center gap-1.5 text-[11px]"><input type="checkbox" checked={!!form.is_enabled} onChange={(e) => setForm({ ...form, is_enabled: e.target.checked })} />有効にする（URL登録後にON）</label>
          <div className="flex gap-1.5">
            <Button size="sm" onClick={save} disabled={busy}>{busy ? '保存中...' : '保存'}</Button>
            <Button size="sm" variant="outline" onClick={() => setForm(null)}>キャンセル</Button>
          </div>
        </div>
      )}
    </div>
  )
}
