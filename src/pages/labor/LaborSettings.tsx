import { useCallback, useEffect, useMemo, useState } from 'react'
import { Save, Building2, Clock, CalendarDays, AlertTriangle, ShieldCheck, FileSpreadsheet, Lock } from 'lucide-react'
import LaborLayout from '@/components/layout/LaborLayout'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Select, SelectTrigger, SelectValue, SelectContent, SelectItem,
} from '@/components/ui/select'
import { SkeletonRows } from '@/components/ui/skeleton'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { LaborSettingsApi, LaborAuditApi } from '@/lib/api'
import { laborPerms, CSV_FORMATS } from '@/lib/labor'
import { cn } from '@/lib/utils'
import type { LaborSettings as LaborSettingsRow } from '@/lib/types'

const WEEKDAY_LABELS = ['日', '月', '火', '水', '木', '金', '土'] as const

/** 編集用のローカル状態（すべて文字列/配列で保持し、保存時に変換） */
interface SettingsForm {
  company_name: string
  standard_work_start: string
  standard_work_end: string
  standard_break_minutes: string
  scheduled_daily_minutes: string
  holiday_weekdays: number[]
  closing_day: string
  payment_day: string
  overtime_alert_monthly_hours: string
  overtime_alert_weekly_hours: string
  paid_leave_grant_rule: string
  require_approval_attendance_edit: boolean
  require_approval_leave: boolean
  gps_clock_enabled: boolean
  ip_restriction_enabled: boolean
  csv_format: string
}

function str(v: number | string | null | undefined): string {
  return v == null ? '' : String(v)
}

function toForm(row: LaborSettingsRow): SettingsForm {
  return {
    company_name: row.company_name ?? '',
    standard_work_start: row.standard_work_start ?? '',
    standard_work_end: row.standard_work_end ?? '',
    standard_break_minutes: str(row.standard_break_minutes),
    scheduled_daily_minutes: str(row.scheduled_daily_minutes),
    holiday_weekdays: Array.isArray(row.holiday_weekdays) ? [...row.holiday_weekdays] : [],
    closing_day: str(row.closing_day),
    payment_day: str(row.payment_day),
    overtime_alert_monthly_hours: str(row.overtime_alert_monthly_hours),
    overtime_alert_weekly_hours: str(row.overtime_alert_weekly_hours),
    paid_leave_grant_rule: row.paid_leave_grant_rule ?? '',
    require_approval_attendance_edit: !!row.require_approval_attendance_edit,
    require_approval_leave: !!row.require_approval_leave,
    gps_clock_enabled: !!row.gps_clock_enabled,
    ip_restriction_enabled: !!row.ip_restriction_enabled,
    csv_format: row.csv_format ?? 'generic',
  }
}

/** 空文字 → null、それ以外は数値（NaN は null） */
function numOrNull(v: string): number | null {
  const raw = v.trim()
  if (raw === '') return null
  const n = Number(raw)
  return Number.isNaN(n) ? null : n
}

function toPayload(f: SettingsForm): Partial<LaborSettingsRow> {
  return {
    company_name: f.company_name.trim() === '' ? null : f.company_name.trim(),
    standard_work_start: f.standard_work_start === '' ? null : f.standard_work_start,
    standard_work_end: f.standard_work_end === '' ? null : f.standard_work_end,
    standard_break_minutes: numOrNull(f.standard_break_minutes),
    scheduled_daily_minutes: numOrNull(f.scheduled_daily_minutes),
    holiday_weekdays: [...f.holiday_weekdays].sort((a, b) => a - b),
    closing_day: numOrNull(f.closing_day),
    payment_day: numOrNull(f.payment_day),
    overtime_alert_monthly_hours: numOrNull(f.overtime_alert_monthly_hours),
    overtime_alert_weekly_hours: numOrNull(f.overtime_alert_weekly_hours),
    paid_leave_grant_rule: f.paid_leave_grant_rule.trim() === '' ? null : f.paid_leave_grant_rule.trim(),
    require_approval_attendance_edit: f.require_approval_attendance_edit,
    require_approval_leave: f.require_approval_leave,
    gps_clock_enabled: f.gps_clock_enabled,
    ip_restriction_enabled: f.ip_restriction_enabled,
    csv_format: f.csv_format || null,
  }
}

export default function LaborSettings() {
  const toast = useToast()
  const { role, user, displayName } = useAuth()
  const perms = laborPerms(role)

  const [row, setRow] = useState<LaborSettingsRow | null>(null)
  const [form, setForm] = useState<SettingsForm | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    setLoading(true)
    try {
      const data = await LaborSettingsApi.get()
      setRow(data)
      setForm(data ? toForm(data) : null)
    } catch (e) {
      console.error('[LaborSettings]', e)
      toast.error(e instanceof Error ? e.message : '労務設定の取得に失敗しました')
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const canEdit = perms.canConfigure
  const disabled = !canEdit || saving

  const setField = <K extends keyof SettingsForm>(k: K, v: SettingsForm[K]) =>
    setForm((prev) => (prev ? { ...prev, [k]: v } : prev))

  const toggleWeekday = (d: number) => {
    if (!canEdit) return
    setForm((prev) => {
      if (!prev) return prev
      const has = prev.holiday_weekdays.includes(d)
      return {
        ...prev,
        holiday_weekdays: has
          ? prev.holiday_weekdays.filter((x) => x !== d)
          : [...prev.holiday_weekdays, d],
      }
    })
  }

  async function createDefault() {
    if (!canEdit) return
    setSaving(true)
    try {
      const created = await LaborSettingsApi.create({ company_name: '自社' })
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '労務設定変更', target_table: 'labor_settings', target_id: created.id, after_data: created,
      })
      toast.success('初期設定を作成しました')
      await load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '初期設定の作成に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  async function handleSave() {
    if (!canEdit || !form) return
    const payload = toPayload(form)
    setSaving(true)
    try {
      let targetId = row?.id ?? null
      if (row?.id) {
        await LaborSettingsApi.update(row.id, payload)
      } else {
        const created = await LaborSettingsApi.create(payload)
        targetId = created.id
        setRow(created)
      }
      await LaborAuditApi.log({
        actor_user_id: user?.id ?? null, actor_name: displayName,
        action: '労務設定変更', target_table: 'labor_settings', target_id: targetId, after_data: payload,
      })
      toast.success('労務設定を保存しました')
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : '保存に失敗しました')
    } finally {
      setSaving(false)
    }
  }

  const toggles = useMemo(
    () => [
      { key: 'require_approval_attendance_edit' as const, label: '打刻修正を承認制' },
      { key: 'require_approval_leave' as const, label: '休暇申請を承認制' },
      { key: 'gps_clock_enabled' as const, label: 'GPS打刻' },
      { key: 'ip_restriction_enabled' as const, label: 'IP制限' },
    ],
    [],
  )

  if (!isSupabaseConfigured) {
    return (
      <LaborLayout>
        <div className="rounded-lg border bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
          Supabase が未設定です。
        </div>
      </LaborLayout>
    )
  }

  return (
    <LaborLayout>
      <div className="mx-auto max-w-4xl space-y-3">
        {/* ヘッダー */}
        <div>
          <h1 className="text-lg font-bold">労務設定</h1>
          <p className="text-2xs text-muted-foreground">会社全体の勤務ルール・打刻・給与連携設定</p>
        </div>

        {!canEdit && (
          <div className="flex items-center gap-1.5 rounded-lg border border-amber-200 bg-amber-50 p-2 text-2xs text-amber-800 dark:border-amber-500/30 dark:bg-amber-500/10 dark:text-amber-300">
            <Lock className="h-3.5 w-3.5" />
            労務設定の変更は管理者のみ可能です。現在は閲覧のみ表示しています。
          </div>
        )}

        {loading ? (
          <div className="rounded-xl border bg-card p-3"><SkeletonRows count={10} /></div>
        ) : !form ? (
          <div className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">
            設定を登録してください。<br />
            {canEdit ? (
              <Button size="sm" className="mt-3" onClick={createDefault} disabled={saving}>
                {saving ? '作成中…' : '初期設定を作成'}
              </Button>
            ) : (
              <span className="text-2xs">（管理者による初期設定の登録が必要です）</span>
            )}
          </div>
        ) : (
          <div className="rounded-xl border bg-card">
            <div className="flex items-center gap-1.5 border-b px-3 py-2 text-sm font-bold">
              <Building2 className="h-4 w-4 text-muted-foreground" />会社設定
            </div>

            <div className="space-y-5 p-3">
              {/* 基本情報 */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <Building2 className="h-3.5 w-3.5" />基本情報
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1 sm:col-span-2">
                    <Label>会社名</Label>
                    <Input
                      value={form.company_name}
                      onChange={(e) => setField('company_name', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                </div>
              </section>

              {/* 勤務時間 */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />標準勤務時間
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>標準出勤時刻</Label>
                    <Input
                      type="time"
                      value={form.standard_work_start}
                      onChange={(e) => setField('standard_work_start', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>標準退勤時刻</Label>
                    <Input
                      type="time"
                      value={form.standard_work_end}
                      onChange={(e) => setField('standard_work_end', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>標準休憩時間（分）</Label>
                    <Input
                      type="number"
                      value={form.standard_break_minutes}
                      onChange={(e) => setField('standard_break_minutes', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>所定労働時間（分）</Label>
                    <Input
                      type="number"
                      value={form.scheduled_daily_minutes}
                      onChange={(e) => setField('scheduled_daily_minutes', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label>休日曜日</Label>
                    <div className="flex flex-wrap gap-1.5">
                      {WEEKDAY_LABELS.map((lbl, d) => {
                        const active = form.holiday_weekdays.includes(d)
                        return (
                          <button
                            key={d}
                            type="button"
                            onClick={() => toggleWeekday(d)}
                            disabled={disabled}
                            className={cn(
                              'h-8 w-8 rounded-md border text-xs font-medium transition-colors',
                              active
                                ? 'border-primary bg-primary text-primary-foreground'
                                : 'bg-background text-muted-foreground hover:bg-accent',
                              disabled && 'cursor-not-allowed opacity-60',
                            )}
                            aria-pressed={active}
                          >
                            {lbl}
                          </button>
                        )
                      })}
                    </div>
                  </div>
                </div>
              </section>

              {/* 締め・支払 */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <CalendarDays className="h-3.5 w-3.5" />締め・給与支払
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>締め日（1-31）</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={form.closing_day}
                      onChange={(e) => setField('closing_day', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>給与支払日（1-31）</Label>
                    <Input
                      type="number"
                      min={1}
                      max={31}
                      value={form.payment_day}
                      onChange={(e) => setField('payment_day', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                </div>
              </section>

              {/* アラート */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <AlertTriangle className="h-3.5 w-3.5" />残業アラート基準
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>月間残業（時間）</Label>
                    <Input
                      type="number"
                      value={form.overtime_alert_monthly_hours}
                      onChange={(e) => setField('overtime_alert_monthly_hours', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label>週間残業（時間）</Label>
                    <Input
                      type="number"
                      value={form.overtime_alert_weekly_hours}
                      onChange={(e) => setField('overtime_alert_weekly_hours', e.target.value)}
                      disabled={disabled}
                    />
                  </div>
                  <div className="space-y-1 sm:col-span-2">
                    <Label>有給付与ルール</Label>
                    <Input
                      value={form.paid_leave_grant_rule}
                      onChange={(e) => setField('paid_leave_grant_rule', e.target.value)}
                      placeholder="例: 入社6か月後に10日付与"
                      disabled={disabled}
                    />
                  </div>
                </div>
              </section>

              {/* 打刻・運用ルール */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <ShieldCheck className="h-3.5 w-3.5" />打刻・運用ルール
                </div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {toggles.map((t) => {
                    const active = form[t.key]
                    return (
                      <button
                        key={t.key}
                        type="button"
                        onClick={() => setField(t.key, !active)}
                        disabled={disabled}
                        className={cn(
                          'flex items-center justify-between rounded-md border px-3 py-2 text-xs font-medium transition-colors',
                          active
                            ? 'border-primary/40 bg-primary/10 text-foreground'
                            : 'bg-background text-muted-foreground hover:bg-accent',
                          disabled && 'cursor-not-allowed opacity-60',
                        )}
                        aria-pressed={active}
                      >
                        <span>{t.label}</span>
                        <span
                          className={cn(
                            'rounded-full px-1.5 py-0.5 text-2xs',
                            active
                              ? 'bg-primary text-primary-foreground'
                              : 'bg-muted text-muted-foreground',
                          )}
                        >
                          {active ? 'ON' : 'OFF'}
                        </span>
                      </button>
                    )
                  })}
                </div>
              </section>

              {/* 給与連携 */}
              <section className="space-y-2">
                <div className="flex items-center gap-1.5 text-2xs font-bold text-muted-foreground">
                  <FileSpreadsheet className="h-3.5 w-3.5" />給与連携
                </div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  <div className="space-y-1">
                    <Label>CSV出力フォーマット</Label>
                    <Select
                      value={form.csv_format || 'generic'}
                      onValueChange={(v) => setField('csv_format', v)}
                      disabled={disabled}
                    >
                      <SelectTrigger><SelectValue placeholder="フォーマット" /></SelectTrigger>
                      <SelectContent>
                        {CSV_FORMATS.map((c) => (
                          <SelectItem key={c.value} value={c.value}>{c.label}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                </div>
              </section>
            </div>

            {canEdit && (
              <div className="flex justify-end border-t px-3 py-2">
                <Button size="sm" onClick={handleSave} disabled={saving}>
                  <Save className="h-3.5 w-3.5" />{saving ? '保存中…' : '保存'}
                </Button>
              </div>
            )}
          </div>
        )}
      </div>
    </LaborLayout>
  )
}
