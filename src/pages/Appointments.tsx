import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { ChevronLeft, ChevronRight, Trash2 } from 'lucide-react'
import TopBar from '@/components/layout/TopBar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { DateTime15Input } from '@/components/ui/datetime15-input'
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
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { AppointmentApi, CaseApi } from '@/lib/api'
import { useAssignableUsers } from '@/hooks/useAssignableUsers'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { cn, jpError, roundTo15 } from '@/lib/utils'
import type { Appointment, Case } from '@/lib/types'
import { syncAppointment, deleteAppointmentEvent } from '@/lib/calendarSync'
import VisitReportModal from '@/components/modals/VisitReportModal'

// 時間の列は1時間ごと（8時〜23時。深夜〜早朝の0〜7時は営業時間外のため非表示）。
// アポのバーは所要2時間として、開始時刻のセルから隣の列まで伸ばして表示する（VISIT_SPAN_HOURS）。
const HOUR_START = 8
const HOURS = Array.from({ length: 24 - HOUR_START }, (_, i) => i + HOUR_START)
/** アポ形式ごとの所要時間（枠の幅）。Zoomは1時間、対面（既定）は2時間。 */
const spanHoursOf = (a: Appointment) => (a.meeting_type === 'zoom' ? 1 : 2)
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
  // 訪問結果登録モーダル
  const [visitCase, setVisitCase] = useState<Case | null>(null)
  const [visitApptId, setVisitApptId] = useState<string | null>(null)
  const [form, setForm] = useState({
    case_id: '',
    title: '',
    sales_rep: '',
    appo_at: '',
    meeting_type: '対面' as 'zoom' | '対面',
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
    const list = set.size ? Array.from(set) : ['']
    // 担当が未設定のアポ（コール履歴から自動作成され担当を選ばなかった等）は列が無いと画面から消えるため、
    // 該当があるときだけ「担当未設定」列を出す。※これが無く「訪問予定に登録されない」ように見えていた。
    if (dayAppos.some((a) => !a.sales_rep) && !list.includes('')) list.push('')
    return list
  }, [filterRep, assignableNames, dayAppos])

  function openNew(rep: string, hour: number) {
    setEditing(null)
    setForm({
      case_id: '',
      title: '',
      sales_rep: rep,
      appo_at: moment(currentDate).hour(hour).minute(0).format('YYYY-MM-DDTHH:mm'),
      meeting_type: '対面',
      memo: '',
    })
    setShowModal(true)
  }

  function openEdit(a: Appointment) {
    setEditing(a)
    setForm({
      case_id: a.case_id ?? '',
      // 案件なし予定は case_name を件名として編集できるようにする
      title: a.case_id ? '' : (a.case_name ?? ''),
      sales_rep: a.sales_rep ?? '',
      appo_at: moment(a.appo_at).format('YYYY-MM-DDTHH:mm'),
      meeting_type: a.meeting_type === 'zoom' ? 'zoom' : '対面',
      memo: a.memo ?? '',
    })
    setShowModal(true)
  }

  async function handleSave() {
    if (!form.appo_at) {
      toast.error('日時を入力してください')
      return
    }
    const c = form.case_id ? cases.find((x) => x.id === form.case_id) : null
    // 案件なしのときは件名（用件）を必須にする
    if (!c && !form.title.trim()) {
      toast.error('案件を選択するか、件名を入力してください')
      return
    }
    try {
      const payload: Partial<Appointment> = {
        case_id: c ? c.id : null,
        case_name: c ? c.name : form.title.trim(),
        address: c ? c.address : null,
        sales_rep: form.sales_rep || null,
        appo_at: moment(roundTo15(form.appo_at)).toISOString(),
        meeting_type: form.meeting_type,
        memo: form.memo || null,
      }
      if (editing) {
        await AppointmentApi.update(editing.id, payload)
        syncAppointment({ ...editing, ...payload } as any, c)  // Googleカレンダー反映（設定ONかつ設定済みのときのみ）
      } else {
        const created = await AppointmentApi.create(payload)
        syncAppointment(created, c)
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
      deleteAppointmentEvent(editing)  // カレンダー予定も削除（枠を空きに戻す）
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
        {/* table-fixed + w-full で画面幅いっぱいに広げ、時間列を均等割りにする（バーの2時間幅を正確にするためにも均等が必要） */}
        <table className="w-full table-fixed border-collapse text-2xs">
          {/* 縦軸=営業担当 / 横軸=時間 */}
          <thead className="sticky top-0 z-10 bg-card">
            <tr>
              <th className="sticky left-0 z-20 w-24 border bg-muted/50 p-1">担当</th>
              {HOURS.map((h) => (
                <th key={h} className="border bg-muted/50 p-1 font-medium text-muted-foreground">
                  {h}:00
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {reps.map((r) => (
              <tr key={r || '__none__'}>
                <td className="sticky left-0 z-10 w-24 border bg-muted/30 p-1 text-center font-medium">
                  {r || '担当未設定'}
                </td>
                {HOURS.map((h) => {
                  const cellAppos = dayAppos.filter((a) => {
                    if ((a.sales_rep ?? '') !== r) return false
                    const ah = moment(a.appo_at).hour()
                    // 開始時刻のセルにだけ置く（バーは幅で2時間分に伸ばす）。
                    // 表示範囲外(0〜7時)のアポが無言で消えないよう先頭枠にまとめて表示する。
                    return ah === h || (h === HOUR_START && ah < HOUR_START)
                  })
                  return (
                    <td
                      key={h}
                      className="relative h-14 cursor-pointer border align-top hover:bg-accent/40"
                      onClick={() => openNew(r, h)}
                    >
                      {cellAppos.map((a) => {
                        const c = cases.find((x) => x.id === a.case_id)
                        const phone = c?.phone1
                        return (
                          <div
                            key={a.id}
                            // 列は1時間刻みのまま、バーだけ所要時間ぶん（対面2時間 / Zoom1時間）に伸ばす。
                            // border-collapse では隣接セルが境界線1pxを共有するため、2列以上のときだけ +1px して端を合わせる。
                            style={{ width: spanHoursOf(a) > 1 ? `calc(${spanHoursOf(a) * 100}% + 1px)` : '100%' }}
                            className={cn(
                              'relative z-10 my-0.5 rounded-sm border p-0.5',
                              a.meeting_type === 'zoom' ? 'border-sky-400/50 bg-sky-400/20' : 'border-primary/30 bg-primary/15',
                            )}
                            onClick={(e) => e.stopPropagation()}
                          >
                            {a.meeting_type === 'zoom' && (
                              <span className="absolute right-0.5 top-0.5 rounded bg-sky-500 px-1 text-[8px] font-bold text-white">Zoom</span>
                            )}
                            <DropdownMenu>
                              <DropdownMenuTrigger asChild>
                                <button className="block w-full truncate text-left font-bold text-primary hover:underline">
                                  {moment(a.appo_at).format('HH:mm')} {a.case_name}
                                </button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="start">
                                {a.case_id && (
                                  <>
                                    <DropdownMenuItem onClick={() => navigate(`/?case=${a.case_id}`)}>案件詳細を開く</DropdownMenuItem>
                                    <DropdownMenuItem
                                      onClick={() => { setVisitCase(c ?? { id: a.case_id!, name: a.case_name ?? '' } as Case); setVisitApptId(a.id) }}
                                    >
                                      訪問結果を登録
                                    </DropdownMenuItem>
                                  </>
                                )}
                                <DropdownMenuItem onClick={() => openEdit(a)}>予定を編集</DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                            {phone && (
                              <a href={`tel:${phone}`} className="text-[9px] text-muted-foreground hover:underline" onClick={(e) => e.stopPropagation()}>
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
              <Label>案件（任意）</Label>
              <Select value={form.case_id || NONE} onValueChange={(v) => setForm((f) => ({ ...f, case_id: v === NONE ? '' : v }))}>
                <SelectTrigger>
                  <SelectValue placeholder="案件を選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（案件なし・その他の予定）</SelectItem>
                  {cases.map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {c.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {!form.case_id && (
              <div className="space-y-1">
                <Label>件名</Label>
                <Input
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="例: 社内MTG / 内見同行 / 出張"
                />
              </div>
            )}
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
              <DateTime15Input
                value={form.appo_at}
                onChange={(v) => setForm((f) => ({ ...f, appo_at: v }))}
              />
            </div>
            {/* アポ形式で枠の幅が変わる（対面=2時間 / Zoom=1時間） */}
            <div className="space-y-1">
              <Label>アポ形式</Label>
              <div className="flex gap-2">
                {(['対面', 'zoom'] as const).map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="sm"
                    variant={form.meeting_type === m ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setForm((f) => ({ ...f, meeting_type: m }))}
                  >
                    {m === 'zoom' ? 'Zoom（1時間）' : '対面（2時間）'}
                  </Button>
                ))}
              </div>
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

      <VisitReportModal
        open={!!visitCase}
        onClose={() => { setVisitCase(null); setVisitApptId(null) }}
        selectedCase={visitCase}
        appointmentId={visitApptId}
        onSaved={load}
      />
    </div>
  )
}
