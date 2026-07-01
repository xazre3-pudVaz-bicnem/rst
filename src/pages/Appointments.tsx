import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AppointmentApi, CaseApi } from '@/lib/api'
import { useAssignableUsers } from '@/hooks/useAssignableUsers'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { jpError, roundTo15 } from '@/lib/utils'
import type { Appointment, Case } from '@/lib/types'
import { TimeRexShare } from '@/components/TimeRex'

const HOURS = Array.from({ length: 24 }, (_, i) => i)
const ALL = '__all__'
const NONE = '__none__'

export default function Appointments() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const { names: assignableNames } = useAssignableUsers()
  const [appointments, setAppointments] = useState<Appointment[]>([])
  const [cases, setCases] = useState<Case[]>([])
  const [currentDate, setCurrentDate] = useState(moment().format('YYYY-MM-DD'))
  const [filterRep, setFilterRep] = useState('')

  const [showModal, setShowModal] = useState(false)
  const [editing, setEditing] = useState<Appointment | null>(null)
  const [form, setForm] = useState({
    case_id: '',
    sales_rep: '',
    appo_at: '',
    memo: '',
  })

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) return
    try {
      const [a, c] = await Promise.all([AppointmentApi.list(500), CaseApi.list(500)])
      setAppointments(a)
      setCases(c)
    } catch (e) {
      console.error('[Appointments]', e)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const dayAppos = useMemo(
    () => appointments.filter((a) => moment(a.appo_at).isSame(currentDate, 'day')),
    [appointments, currentDate],
  )

  // 担当列: ユーザー管理の候補＋当日アポの担当を統合。空でも未割当列を1つ出して操作可能に
  const reps = useMemo(() => {
    if (filterRep) return [filterRep]
    const set = new Set<string>()
    assignableNames.forEach((n) => set.add(n))
    dayAppos.forEach((a) => { if (a.sales_rep) set.add(a.sales_rep) })
    return set.size ? Array.from(set) : ['']
  }, [filterRep, assignableNames, dayAppos])

  function openNew(rep: string, hour: number) {
    setEditing(null)
    setForm({
      case_id: '',
      sales_rep: rep,
      appo_at: moment(currentDate).hour(hour).minute(0).format('YYYY-MM-DDTHH:mm'),
      memo: '',
    })
    setShowModal(true)
  }

  function openEdit(a: Appointment) {
    setEditing(a)
    setForm({
      case_id: a.case_id,
      sales_rep: a.sales_rep ?? '',
      appo_at: moment(a.appo_at).format('YYYY-MM-DDTHH:mm'),
      memo: a.memo ?? '',
    })
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.case_id) {
      toast.error('案件を選択してください')
      return
    }
    if (!form.appo_at) {
      toast.error('日時を入力してください')
      return
    }
    const c = cases.find((x) => x.id === form.case_id)
    if (!c) return
    try {
      const payload: Partial<Appointment> = {
        case_id: c.id,
        case_name: c.name,
        address: c.address,
        sales_rep: form.sales_rep || null,
        appo_at: moment(roundTo15(form.appo_at)).toISOString(),
        memo: form.memo || null,
      }
      if (editing) {
        await AppointmentApi.update(editing.id, payload)
      } else {
        await AppointmentApi.create(payload)
      }
      toast.success('訪問予定を保存しました')
      setShowModal(false)
      load()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    }
  }

  async function handleDelete() {
    if (!editing) return
    if (!(await confirm({ title: 'このアポを削除しますか？', confirmLabel: '削除する', danger: true }))) return
    try {
      await AppointmentApi.remove(editing.id)
      toast.success('削除しました')
      setShowModal(false)
      load()
    } catch (e) {
      toast.error('削除に失敗しました: ' + jpError(e))
    }
  }

  return (
    <div className="flex h-screen flex-col">
      <TopBar />

      {/* コントロール */}
      <div className="flex flex-wrap items-center gap-2 border-b bg-card p-2">
        <Button variant="outline" size="icon" onClick={() => setCurrentDate(moment(currentDate).subtract(1, 'day').format('YYYY-MM-DD'))}>
          <ChevronLeft className="h-3.5 w-3.5" />
        </Button>
        <Input
          type="date"
          value={currentDate}
          onChange={(e) => setCurrentDate(e.target.value)}
          className="w-36"
        />
        <Button variant="outline" size="icon" onClick={() => setCurrentDate(moment(currentDate).add(1, 'day').format('YYYY-MM-DD'))}>
          <ChevronRight className="h-3.5 w-3.5" />
        </Button>
        <Button variant="outline" size="sm" onClick={() => setCurrentDate(moment().format('YYYY-MM-DD'))}>
          今日
        </Button>
        <span className="text-xs font-bold">
          {moment(currentDate).format('YYYY年M月D日 (ddd)')}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <span className="text-2xs text-muted-foreground">担当:</span>
          <Select value={filterRep || ALL} onValueChange={(v) => setFilterRep(v === ALL ? '' : v)}>
            <SelectTrigger className="w-28">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL}>全員</SelectItem>
              {assignableNames.map((r) => (
                <SelectItem key={r} value={r}>
                  {r}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* タイムライングリッド */}
      <div className="flex-1 overflow-auto">
        <div className="p-2"><TimeRexShare compact /></div>
        <table className="w-full border-collapse text-2xs">
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="w-12 border bg-muted/50 p-1">時</th>
              {reps.map((r) => (
                <th key={r} className="border bg-muted/50 p-1 font-medium">
                  {r || '担当未設定'}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {HOURS.map((h) => (
              <tr key={h}>
                <td className="border bg-muted/30 p-1 text-center text-muted-foreground">
                  {h}:00
                </td>
                {reps.map((r) => {
                  const cellAppos = dayAppos.filter(
                    (a) => (a.sales_rep ?? '') === r && moment(a.appo_at).hour() === h,
                  )
                  return (
                    <td
                      key={r}
                      className="h-10 cursor-pointer border align-top hover:bg-accent/40"
                      onClick={() => openNew(r, h)}
                    >
                      {cellAppos.map((a) => {
                        const c = cases.find((x) => x.id === a.case_id)
                        const phone = c?.phone1
                        return (
                          <div
                            key={a.id}
                            className="m-0.5 rounded-sm bg-primary/15 p-0.5"
                            onClick={(e) => {
                              e.stopPropagation()
                              openEdit(a)
                            }}
                          >
                            <button
                              className="block w-full truncate text-left font-bold text-primary hover:underline"
                              onClick={(e) => {
                                e.stopPropagation()
                                navigate(`/?case=${a.case_id}`)
                              }}
                            >
                              {moment(a.appo_at).format('HH:mm')} {a.case_name}
                            </button>
                            {phone && (
                              <a
                                href={`tel:${phone}`}
                                className="text-[9px] text-muted-foreground hover:underline"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {phone}
                              </a>
                            )}
                          </div>
                        )
                      })}
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* アポ登録/編集モーダル */}
      <Dialog open={showModal} onOpenChange={setShowModal}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{editing ? 'アポを編集' : 'アポを登録'}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2">
            <div className="space-y-1">
              <Label>案件</Label>
              <Select value={form.case_id || undefined} onValueChange={(v) => setForm((f) => ({ ...f, case_id: v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="案件を選択" />
                </SelectTrigger>
                <SelectContent>
                  {cases.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>担当者</Label>
              <Select value={form.sales_rep || NONE} onValueChange={(v) => setForm((f) => ({ ...f, sales_rep: v === NONE ? '' : v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（なし）</SelectItem>
                  {assignableNames.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>日時</Label>
              <Input
                type="datetime-local"
                step={900}
                value={form.appo_at}
                onChange={(e) => setForm((f) => ({ ...f, appo_at: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label>メモ</Label>
              <Textarea value={form.memo} onChange={(e) => setForm((f) => ({ ...f, memo: e.target.value }))} rows={2} />
            </div>
          </div>
          <DialogFooter className="justify-between">
            {editing ? (
              <Button variant="destructive" onClick={handleDelete}>
                <Trash2 className="h-3 w-3" />
                削除
              </Button>
            ) : (
              <span />
            )}
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => setShowModal(false)}>
                キャンセル
              </Button>
              <Button onClick={handleSave}>保存</Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
