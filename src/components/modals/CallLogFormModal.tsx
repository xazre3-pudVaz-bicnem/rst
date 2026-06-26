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
import { AppointmentApi, CallLogApi, CaseApi, RecallApi } from '@/lib/api'
import {
  AGES,
  CONTACT_RESULTS,
  GENDERS,
  NO_CONTACT_RESULTS,
  RECEIVER_ATTRS,
  SALES_REPS,
} from '@/lib/constants'
import { generateSummary } from '@/lib/summary'
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
  const [recallAt, setRecallAt] = useState('')
  const [memo, setMemo] = useState('')
  const [busy, setBusy] = useState(false)

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
    }
  }, [open, editingLog, selectedCase])

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
    try {
      await CaseApi.update(selectedCase.id, { sales_rep: null, status: '新規' })
      onSaved()
      onClose()
    } catch (e) {
      alert('開放に失敗しました: ' + (e instanceof Error ? e.message : e))
    }
  }

  async function handleSave() {
    if (!selectedCase) return
    setBusy(true)
    try {
      const logPayload: Partial<CallLog> = {
        case_id: selectedCase.id,
        case_name: selectedCase.name,
        call_at: moment(callAt).toISOString(),
        contact_type: contactType,
        result: result || null,
        memo: memo || null,
        summary: summary || null,
      }
      if (editingLog) {
        await CallLogApi.update(editingLog.id, logPayload)
      } else {
        await CallLogApi.create(logPayload)
      }

      // アポ日時があれば Appointment 作成 + Case.status='アポ'
      if (showAppo && appoAt) {
        await AppointmentApi.create({
          case_id: selectedCase.id,
          case_name: selectedCase.name,
          address: selectedCase.address,
          sales_rep: appoRep || null,
          appo_at: moment(appoAt).toISOString(),
          memo: null,
        })
        await CaseApi.update(selectedCase.id, {
          status: 'アポ',
          sales_rep: appoRep || selectedCase.sales_rep || null,
        })
      }

      // 再コール予定があれば Recall 作成
      if (recallAt) {
        await RecallApi.create({
          case_id: selectedCase.id,
          case_name: selectedCase.name,
          target_at: moment(recallAt).toISOString(),
        })
      }

      onSaved()
      onClose()
    } catch (e) {
      alert('保存に失敗しました: ' + (e instanceof Error ? e.message : e))
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
            <Input
              type="datetime-local"
              value={callAt}
              onChange={(e) => setCallAt(e.target.value)}
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
              <Select value={gender || NONE} onValueChange={(v) => setGender(v === NONE ? '' : v)}>
                <SelectTrigger>
                  <SelectValue placeholder="選択" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（なし）</SelectItem>
                  {GENDERS.map((g) => (
                    <SelectItem key={g} value={g}>
                      {g}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
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
            <div className="grid grid-cols-2 gap-2 rounded-md bg-green-50 p-2">
              <div className="space-y-1">
                <Label>アポ日時</Label>
                <Input
                  type="datetime-local"
                  step={900}
                  value={appoAt}
                  onChange={(e) => setAppoAt(e.target.value)}
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
                    {SALES_REPS.map((r) => (
                      <SelectItem key={r} value={r}>
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label>再コール予定（任意）</Label>
            <Input
              type="datetime-local"
              step={900}
              value={recallAt}
              onChange={(e) => setRecallAt(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label>メモ</Label>
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
