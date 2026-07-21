import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { DateTime15Input } from '@/components/ui/datetime15-input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { VisitReportApi, CaseApi } from '@/lib/api'
import { LOST_REASONS, CONTRACT_PRODUCTS, PAYMENT_METHODS, contractTotals, hpSplitInfo } from '@/lib/constants'
import { useAuth } from '@/context/AuthContext'
import { useToast } from '@/components/ui/toast'
import { jpError } from '@/lib/utils'
import type { Case, VisitReport } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  selectedCase: Case | null
  appointmentId?: string | null
  editing?: VisitReport | null
  onSaved: () => void
}

const NONE = '__none__'
const num = (v: string): number | null => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && v.trim() !== '' ? Math.round(n) : null
}

export default function VisitReportModal({ open, onClose, selectedCase, appointmentId, editing, onSaved }: Props) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const toast = useToast()
  const [busy, setBusy] = useState(false)
  const [visitedAt, setVisitedAt] = useState(() => moment().format('YYYY-MM-DDTHH:mm'))
  const [result, setResult] = useState<'成約' | '失注'>('成約')
  const [lostReason, setLostReason] = useState('')
  const [memo, setMemo] = useState('')
  // 成約時
  const [prices, setPrices] = useState<Record<string, string>>({})
  const [contractDate, setContractDate] = useState('')
  const [minMonths, setMinMonths] = useState('')
  const [payment, setPayment] = useState('')
  const [hpPayType, setHpPayType] = useState<'一括' | '分割'>('一括')
  const [hpInstallments, setHpInstallments] = useState('')

  useEffect(() => {
    if (!open) return
    if (editing) {
      setVisitedAt(moment(editing.visited_at).format('YYYY-MM-DDTHH:mm'))
      setResult(editing.result)
      setLostReason(editing.lost_reason ?? '')
      setMemo(editing.memo ?? '')
      setContractDate(editing.contract_date ?? '')
      setMinMonths(editing.min_contract_months != null ? String(editing.min_contract_months) : '')
      setPayment(editing.payment_method ?? '')
      setPrices(Object.fromEntries(CONTRACT_PRODUCTS.map((p) => [p.key, editing[p.key as keyof VisitReport] != null ? String(editing[p.key as keyof VisitReport]) : ''])))
      setHpPayType(editing.hp_payment_type === '分割' ? '分割' : '一括')
      setHpInstallments(editing.hp_installments != null ? String(editing.hp_installments) : '')
    } else {
      setVisitedAt(moment().format('YYYY-MM-DDTHH:mm'))
      setResult('成約')
      setLostReason('')
      setMemo('')
      setPrices({})
      setContractDate(moment().format('YYYY-MM-DD'))
      setMinMonths('')
      setPayment('')
      setHpPayType('一括')
      setHpInstallments('')
    }
  }, [open, editing])

  const priceNums = {
    ...Object.fromEntries(CONTRACT_PRODUCTS.map((p) => [p.key, num(prices[p.key] ?? '') ?? 0])),
    hp_payment_type: hpPayType,
    hp_installments: num(hpInstallments),
  }
  const { initial: initialTotal, monthly: monthlyTotal } = contractTotals(priceNums)
  const total = initialTotal + monthlyTotal
  const hpSplit = hpSplitInfo(priceNums)

  async function handleSave() {
    if (!selectedCase) return
    setBusy(true)
    try {
      const payload: Partial<VisitReport> = {
        case_id: selectedCase.id,
        case_name: selectedCase.name,
        appointment_id: appointmentId ?? editing?.appointment_id ?? null,
        visited_at: moment(visitedAt).toISOString(),
        result,
        memo: memo.trim() || null,
        created_by_id: user?.id ?? null,
      }
      if (result === '成約') {
        Object.assign(payload, {
          lost_reason: null,
          contract_date: contractDate || null,
          min_contract_months: num(minMonths),
          payment_method: payment || null,
          hp_price: num(prices.hp_price ?? ''),
          hp_payment_type: num(prices.hp_price ?? '') ? hpPayType : null,
          hp_installments: hpPayType === '分割' ? num(hpInstallments) : null,
          maintenance_price: num(prices.maintenance_price ?? ''),
          seo_price: num(prices.seo_price ?? ''),
          meo_price: num(prices.meo_price ?? ''),
          total_price: total || null,
        })
      } else {
        if (!lostReason) { toast.error('失注理由を選択してください'); setBusy(false); return }
        Object.assign(payload, {
          lost_reason: lostReason,
          contract_date: null, min_contract_months: null, payment_method: null,
          hp_price: null, maintenance_price: null, seo_price: null, meo_price: null, total_price: null,
        })
      }
      if (editing) await VisitReportApi.update(editing.id, payload)
      else await VisitReportApi.create(payload)
      // 案件ステータスも訪問結果に合わせて更新
      await CaseApi.update(selectedCase.id, { status: result })
      toast.success(`訪問結果（${result}）を登録しました`)
      onSaved()
      onClose()
      if (result === '成約') navigate('/deals')
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
            {editing ? '訪問結果を編集' : '訪問結果を登録'}
            {selectedCase && <span className="ml-2 text-2xs font-normal text-muted-foreground">{selectedCase.name}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          <div className="space-y-1">
            <Label>訪問日時</Label>
            <DateTime15Input value={visitedAt} onChange={setVisitedAt} />
          </div>

          <div className="space-y-1">
            <Label>結果</Label>
            <div className="flex gap-2">
              {(['成約', '失注'] as const).map((r) => (
                <Button
                  key={r}
                  type="button"
                  size="sm"
                  variant={result === r ? 'default' : 'outline'}
                  className={result === r && r === '成約' ? 'flex-1 bg-emerald-600 hover:bg-emerald-700' : 'flex-1'}
                  onClick={() => setResult(r)}
                >
                  {r}
                </Button>
              ))}
            </div>
          </div>

          {result === '失注' ? (
            <div className="space-y-1">
              <Label>失注理由</Label>
              <Select value={lostReason || NONE} onValueChange={(v) => setLostReason(v === NONE ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="選択" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>選択</SelectItem>
                  {LOST_REASONS.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
          ) : (
            <div className="space-y-2 rounded-md bg-emerald-50 p-2 dark:bg-emerald-500/10">
              <Label className="text-emerald-700 dark:text-emerald-400">契約内容（契約したサービスに金額を入力）</Label>
              <div className="grid grid-cols-2 gap-2">
                {CONTRACT_PRODUCTS.map((p) => (
                  <div key={p.key} className="space-y-1">
                    <Label className="text-2xs">{p.label}（{p.key === 'hp_price' ? '初期/分割' : (p.kind as string) === 'initial' ? '初期' : '月額'}・円）</Label>
                    <Input
                      inputMode="numeric"
                      placeholder="—"
                      value={prices[p.key] ?? ''}
                      onChange={(e) => setPrices((s) => ({ ...s, [p.key]: e.target.value }))}
                    />
                  </div>
                ))}
              </div>
              {/* HP制作の支払い: 一括 / 分割 */}
              {num(prices.hp_price ?? '') != null && (
                <div className="flex flex-wrap items-center gap-2 rounded bg-emerald-100/60 px-2 py-1 dark:bg-emerald-500/15">
                  <span className="text-2xs font-medium">HP制作の支払い</span>
                  {(['一括', '分割'] as const).map((t) => (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setHpPayType(t)}
                      className={`rounded-full border px-2 py-0.5 text-2xs ${hpPayType === t ? 'border-emerald-600 bg-emerald-600 text-white' : 'text-muted-foreground hover:bg-accent'}`}
                    >
                      {t}
                    </button>
                  ))}
                  {hpPayType === '分割' && (
                    <div className="flex items-center gap-1">
                      <Input inputMode="numeric" placeholder="回数" className="h-7 w-16 text-2xs" value={hpInstallments} onChange={(e) => setHpInstallments(e.target.value)} />
                      <span className="text-2xs text-muted-foreground">回{hpSplit ? `（¥${hpSplit.monthly.toLocaleString()}/月）` : ''}</span>
                    </div>
                  )}
                </div>
              )}
              <div className="flex justify-end gap-3 text-2xs text-muted-foreground">
                <span>初期費用合計: <span className="font-bold text-foreground">{initialTotal.toLocaleString()}円</span></span>
                <span>月額合計: <span className="font-bold text-foreground">{monthlyTotal.toLocaleString()}円/月</span></span>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-2xs">契約日</Label>
                  <Input type="date" value={contractDate} onChange={(e) => setContractDate(e.target.value)} />
                </div>
                <div className="space-y-1">
                  <Label className="text-2xs">最低契約期間（月）</Label>
                  <Input inputMode="numeric" placeholder="例: 12" value={minMonths} onChange={(e) => setMinMonths(e.target.value)} />
                </div>
              </div>
              <div className="space-y-1">
                <Label className="text-2xs">支払方法</Label>
                <Select value={payment || NONE} onValueChange={(v) => setPayment(v === NONE ? '' : v)}>
                  <SelectTrigger><SelectValue placeholder="選択" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value={NONE}>選択</SelectItem>
                    {PAYMENT_METHODS.map((m) => <SelectItem key={m} value={m}>{m}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}

          <div className="space-y-1">
            <Label>メモ</Label>
            <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button onClick={handleSave} disabled={busy || !selectedCase}>{busy ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
