import { useEffect, useMemo, useState } from 'react'
import moment from 'moment'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DateTime15Input } from '@/components/ui/datetime15-input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { AppointmentApi, CallLogApi, CaseApi, RecallApi, TemplateApi } from '@/lib/api'
import { syncAppointment } from '@/lib/calendarSync'
import type { Template } from '@/lib/types'
import {
  AGES,
  CONTACT_RESULTS,
  GENDERS,
  NO_CONTACT_RESULTS,
  RECEIVER_ATTRS,
} from '@/lib/constants'
import { useAssignableUsers, withCurrent } from '@/hooks/useAssignableUsers'
import { generateSummary } from '@/lib/summary'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { jpError, roundTo15 } from '@/lib/utils'
import type { Case, CallLog } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  selectedCase: Case | null
  editingLog: CallLog | null
  onSaved: () => void
  /** 代表者名入力時に Case.representative をリアルタイム更新 */
  onRepNameChange: (caseId: string, name: string) => void
}

const NONE = '__none__'
/** アポ形式。訪問予定の枠幅に反映（対面=2時間 / zoom=1時間） */
const MEETING_TYPES = ['対面', 'zoom'] as const

function nowLocal() {
  return moment().format('YYYY-MM-DDTHH:mm')
}

export default function CallLogFormModal({
  open,
  onClose,
  selectedCase,
  editingLog,
  onSaved,
  onRepNameChange,
}: Props) {
  const [contactType, setContactType] = useState<'接触' | '非接触'>('接触')
  const [callAt, setCallAt] = useState(nowLocal())
  const [repName, setRepName] = useState('')
  const [receiverAttr, setReceiverAttr] = useState('')
  const [gender, setGender] = useState('')
  const [age, setAge] = useState('')
  const [result, setResult] = useState('')
  const [appoAt, setAppoAt] = useState('')
  const [appoRep, setAppoRep] = useState('')
  // アポ形式（既定は対面）。訪問予定の枠幅に使う: 対面=2時間 / zoom=1時間
  const [meetingType, setMeetingType] = useState<'zoom' | '対面'>('対面')
  const [recallAt, setRecallAt] = useState('')
  const [memo, setMemo] = useState('')
  const [logRep, setLogRep] = useState('')
  const [newStatus, setNewStatus] = useState('')
  const [busy, setBusy] = useState(false)
  const [templates, setTemplates] = useState<Template[]>([])
  const { user, displayName } = useAuth()
  const { names: assignableNames } = useAssignableUsers()
  const toast = useToast()

  useEffect(() => {
    if (open) TemplateApi.list().then(setTemplates).catch(() => setTemplates([]))
  }, [open])

  useEffect(() => {
    if (!open) return
    if (editingLog) {
      setContactType(editingLog.contact_type)
      setCallAt(moment(editingLog.call_at).format('YYYY-MM-DDTHH:mm'))
      setResult(editingLog.result ?? '')
      setMemo(editingLog.memo ?? '')
      setRepName(selectedCase?.representative ?? '')
      setReceiverAttr('')
      setGender('')
      setAge('')
      setAppoAt('')
      setAppoRep(selectedCase?.sales_rep ?? '')
      setRecallAt('')
      setLogRep(editingLog.sales_rep ?? selectedCase?.sales_rep ?? '')
      setNewStatus(selectedCase?.status ?? '')
    } else {
      setContactType('接触')
      setCallAt(nowLocal())
      setRepName(selectedCase?.representative ?? '')
      setReceiverAttr('')
      setGender('')
      setAge('')
      setResult('')
      setAppoAt('')
      setAppoRep(selectedCase?.sales_rep ?? '')
      setRecallAt('')
      setMemo('')
      // 記録者はログイン中ユーザーを初期値に（原則ログインユーザーで自動設定）
      setLogRep(displayName || selectedCase?.sales_rep || '')
      setNewStatus(selectedCase?.status ?? '')
    }
  }, [open, editingLog, selectedCase, displayName])

  const summary = useMemo(
    () =>
      generateSummary({
        contactType,
        repName,
        receiverAttr,
        gender,
        age,
        result,
      }),
    [contactType, repName, receiverAttr, gender, age, result],
  )

  const results = contactType === '接触' ? CONTACT_RESULTS : NO_CONTACT_RESULTS
  const showAppo = result === 'アポ'

  async function handleRelease() {
    if (!selectedCase) return
    setBusy(true)
    try {
      // 入力中のコール結果があれば、まずコール履歴として保存してから解放（履歴を残す）。
      const hasEntry = !!(result || (memo && memo.trim()))
      if (hasEntry) {
        const effectiveStatus = showAppo && appoAt ? 'アポ獲得' : newStatus
        const statusChanged = effectiveStatus && effectiveStatus !== selectedCase.status
        const logPayload: Partial<CallLog> = {
          case_id: selectedCase.id, case_name: selectedCase.name,
          call_at: moment(roundTo15(callAt)).toISOString(),
          contact_type: contactType, result: result || null, memo: memo || null, summary: summary || null,
          sales_rep: logRep || selectedCase.sales_rep || null,
          prev_status: statusChanged ? selectedCase.status : null, next_status: statusChanged ? effectiveStatus : null,
          next_recall_at: recallAt ? moment(roundTo15(recallAt)).toISOString() : null,
          appo_at: showAppo && appoAt ? moment(roundTo15(appoAt)).toISOString() : null,
          created_by_id: user?.id ?? null,
        }
        if (editingLog) await CallLogApi.update(editingLog.id, logPayload)
        else await CallLogApi.create(logPayload)
        // 解放＝案件を手放す操作なので、残っている再コール予定も消す（この案件を追わなくなるため）。
        // ※新たに再コール日時を入力した場合は、消したうえで作り直す（下のcreate）。
        await RecallApi.doneByCase(selectedCase.id)
        if (recallAt) await RecallApi.create({ case_id: selectedCase.id, case_name: selectedCase.name, target_at: moment(roundTo15(recallAt)).toISOString(), created_by_id: user?.id ?? null })
        // ステータスは反映しつつ担当者だけ解除
        await CaseApi.update(selectedCase.id, { ...(statusChanged ? { status: effectiveStatus } : {}), sales_rep: null })
        toast.success('コール履歴を保存し、案件を解放しました（担当者を解除・再コール予定も削除）')
      } else {
        // 入力が無くても解放時は再コール予定を残さない
        await RecallApi.doneByCase(selectedCase.id)
        await CaseApi.update(selectedCase.id, { sales_rep: null })
        toast.success('案件を解放しました（担当者を解除・再コール予定も削除。コール履歴は保持）')
      }
      onSaved()
      onClose()
    } catch (e) {
      toast.error('解放に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  async function handleSave() {
    if (!selectedCase) return
    setBusy(true)
    try {
      // アポ時はステータスを「アポ獲得」に寄せる
      const effectiveStatus = showAppo && appoAt ? 'アポ獲得' : newStatus
      const statusChanged = effectiveStatus && effectiveStatus !== selectedCase.status
      const logPayload: Partial<CallLog> = {
        case_id: selectedCase.id,
        case_name: selectedCase.name,
        call_at: moment(roundTo15(callAt)).toISOString(),
        contact_type: contactType,
        result: result || null,
        memo: memo || null,
        summary: summary || null,
        sales_rep: logRep || selectedCase.sales_rep || null,
        prev_status: statusChanged ? selectedCase.status : null,
        next_status: statusChanged ? effectiveStatus : null,
        next_recall_at: recallAt ? moment(roundTo15(recallAt)).toISOString() : null,
        appo_at: showAppo && appoAt ? moment(roundTo15(appoAt)).toISOString() : null,
        created_by_id: user?.id ?? null,
      }
      if (editingLog) {
        await CallLogApi.update(editingLog.id, logPayload)
      } else {
        await CallLogApi.create(logPayload)
      }

      // アポ日時があれば Appointment 作成 → Googleカレンダー反映（設定ON時のみ・TimeRexの空き枠に反映）
      if (showAppo && appoAt) {
        const appt = await AppointmentApi.create({
          case_id: selectedCase.id,
          case_name: selectedCase.name,
          address: selectedCase.address,
          // 担当未選択でも null にしない（訪問予定は担当者ごとの列で表示するため、nullだと画面に出ない）
          sales_rep: appoRep || logRep || selectedCase.sales_rep || displayName || null,
          appo_at: moment(roundTo15(appoAt)).toISOString(),
          meeting_type: meetingType,
          memo: null,
        })
        syncAppointment(appt, selectedCase)
      }

      // ステータス / 担当の更新
      if (statusChanged || logRep) {
        await CaseApi.update(selectedCase.id, {
          ...(statusChanged ? { status: effectiveStatus } : {}),
          ...(showAppo && appoAt
            ? { sales_rep: appoRep || logRep || selectedCase.sales_rep || null }
            : logRep
              ? { sales_rep: logRep }
              : {}),
        })
      }

      // 再コール予定があれば Recall 作成
      if (recallAt) {
        await RecallApi.create({
          case_id: selectedCase.id,
          case_name: selectedCase.name,
          target_at: moment(roundTo15(recallAt)).toISOString(),
          created_by_id: user?.id ?? null,
        })
      }

      toast.success('コール履歴を保存しました')
      onSaved()
      onClose()
    } catch (e) {
      toast.error('保存に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>
            {editingLog ? 'コール履歴を編集' : 'コール履歴を登録'}
            {selectedCase && (
              <span className="ml-2 text-2xs font-normal text-muted-foreground">
                {selectedCase.name}
              </span>
            )}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {/* 接触種別 */}
          <div className="flex gap-3">
            {(['接触', '非接触'] as const).map((t) => (
              <label key={t} className="flex items-center gap-1 text-xs">
                <input
                  type="radio"
                  name="contactType"
                  checked={contactType === t}
                  onChange={() => {
                    setContactType(t)
                    setResult('')
                  }}
                />
                {t}
              </label>
            ))}
          </div>

          <div className="space-y-1">
            <Label>コール日時</Label>
            <DateTime15Input
              value={callAt}
              onChange={setCallAt}
            />
          </div>

          {contactType === '接触' ? (
            <div className="space-y-1">
              <Label>代表者名</Label>
              <Input
                value={repName}
                onChange={(e) => {
                  setRepName(e.target.value)
                  if (selectedCase) onRepNameChange(selectedCase.id, e.target.value)
                }}
              />
            </div>
          ) : (
            <div className="space-y-1">
              <Label>受電者属性</Label>
              <Select
                value={receiverAttr || NONE}
                onValueChange={(v) => setReceiverAttr(v === NONE ? '' : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（なし）</SelectItem>
                  {RECEIVER_ATTRS.map((r) => (
                    <SelectItem key={r} value={r}>
                      {r}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label>性別</Label>
              <div className="flex gap-2">
                {GENDERS.map((g) => (
                  <Button
                    key={g}
                    type="button"
                    size="sm"
                    variant={gender === g ? 'default' : 'outline'}
                    className="flex-1"
                    onClick={() => setGender((cur) => (cur === g ? '' : g))}
                  >
                    {g}
                  </Button>
                ))}
              </div>
            </div>
            <div className="space-y-1">
              <Label>年齢</Label>
              <Select value={age || NONE} onValueChange={(v) => setAge(v === NONE ? '' : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（なし）</SelectItem>
                  {AGES.map((a) => (
                    <SelectItem key={a} value={a}>
                      {a}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1">
            <Label>結果</Label>
            <Select value={result || NONE} onValueChange={(v) => setResult(v === NONE ? '' : v)}>
              <SelectTrigger>
                <SelectValue placeholder="選択" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>（なし）</SelectItem>
                {results.map((r) => (
                  <SelectItem key={r} value={r}>
                    {r}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {showAppo && (
            <div className="grid grid-cols-2 gap-2 rounded-md bg-green-50 p-2 dark:bg-green-500/10">
              <div className="space-y-1">
                <Label>アポ日時</Label>
                <DateTime15Input
                  value={appoAt}
                  onChange={setAppoAt}
                />
              </div>
              <div className="space-y-1">
                <Label>担当者</Label>
                <Select value={appoRep || NONE} onValueChange={(v) => setAppoRep(v === NONE ? '' : v)}>
                  <SelectTrigger>
                    <SelectValue placeholder="選択" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>（なし）</SelectItem>
                    {withCurrent(assignableNames, appoRep).map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {/* アポ形式。訪問予定の枠幅が変わる（対面=2時間 / Zoom=1時間） */}
              <div className="col-span-2 space-y-1">
                <Label>アポ形式</Label>
                <div className="flex gap-2">
                  {MEETING_TYPES.map((m) => (
                    <Button
                      key={m}
                      type="button"
                      size="sm"
                      variant={meetingType === m ? 'default' : 'outline'}
                      className="flex-1"
                      onClick={() => setMeetingType(m)}
                    >
                      {m === 'zoom' ? 'Zoom（1時間）' : '対面（2時間）'}
                    </Button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label>再コール予定（任意）</Label>
            <DateTime15Input
              value={recallAt}
              onChange={setRecallAt}
            />
          </div>

          <div className="space-y-1">
            <Label>メモ</Label>
            {templates.length > 0 && (
              <div className="flex flex-wrap gap-1">
                {templates
                  .filter((t) => !newStatus || !t.status || t.status === newStatus)
                  .slice(0, 8)
                  .map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      onClick={() => setMemo((m) => (m ? m + '\n' : '') + t.body)}
                      className="rounded-full border border-input bg-card px-2 py-0.5 text-2xs text-muted-foreground hover:bg-accent"
                      title={t.body}
                    >
                      + {t.title}
                    </button>
                  ))}
              </div>
            )}
            <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>

          <div className="space-y-1">
            <Label>自動サマリー（プレビュー）</Label>
            <div className="whitespace-pre-wrap rounded-md border bg-muted/50 px-2 py-1 text-xs font-bold">
              {summary || '—'}
            </div>
          </div>
        </div>

        <DialogFooter className="justify-between">
          <Button variant="destructive" onClick={handleRelease} disabled={!selectedCase}>
            開放
          </Button>
          <div className="flex gap-2">
            <Button variant="outline" onClick={onClose}>
              キャンセル
            </Button>
            <Button onClick={handleSave} disabled={busy || !selectedCase}>
              {busy ? '保存中...' : '保存'}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
