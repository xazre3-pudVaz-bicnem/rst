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
import { VisitReportApi, CaseApi, TravelExpenseApi, EmployeeApi } from '@/lib/api'
import { TRANSPORT_TYPES } from '@/lib/labor'
import { creatorNameOf, AI_CREATOR_LABEL } from '@/lib/caseCreator'
import { COMMISSION_RATE, COMMISSION_SPLIT } from '@/lib/commission'
import { LOST_REASONS, CONTRACT_PRODUCTS, PAYMENT_METHODS, contractTotals, hpSplitInfo } from '@/lib/constants'
import { useAuth } from '@/context/AuthContext'
import { useAssignableUsers } from '@/hooks/useAssignableUsers'
import { useToast } from '@/components/ui/toast'
import { jpError } from '@/lib/utils'
import type { Case, VisitReport, TravelExpense } from '@/lib/types'

interface Props {
  open: boolean
  onClose: () => void
  selectedCase: Case | null
  appointmentId?: string | null
  editing?: VisitReport | null
  onSaved: () => void
}

const NONE = '__none__'
const AGENCY = '販売代理店'  // ユーザー登録外の営業担当（固定選択肢）
const num = (v: string): number | null => {
  const n = Number(String(v).replace(/[^\d.-]/g, ''))
  return Number.isFinite(n) && v.trim() !== '' ? Math.round(n) : null
}

export default function VisitReportModal({ open, onClose, selectedCase, appointmentId, editing, onSaved }: Props) {
  const navigate = useNavigate()
  const { user } = useAuth()
  const { names: repNames } = useAssignableUsers()
  const [salesRep, setSalesRep] = useState('')
  // 歩合の分配先（売上20%を リスト10% / アポ40% / 営業50%）。営業担当は salesRep。
  const [listRep, setListRep] = useState('')
  const [appoRep, setAppoRep] = useState('')
  // 未払い（入金待ち）: 開始月以降の歩合を計上しない。解約月: その月まで月額の歩合を計上。
  const [unpaid, setUnpaid] = useState(false)
  const [unpaidSince, setUnpaidSince] = useState('')        // YYYY-MM
  const [contractEndMonth, setContractEndMonth] = useState('') // YYYY-MM
  const [caseName, setCaseName] = useState('')  // 案件未登録の直接成約登録用の店舗名（selectedCaseが無いとき使用）
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
  // 交通費（この訪問でかかった分。金額を入れたときだけ登録され、労務管理で担当者ごとに集計される）
  const [expense, setExpense] = useState<TravelExpense | null>(null)
  const [expAmount, setExpAmount] = useState('')
  const [expTransport, setExpTransport] = useState<string>('電車')
  const [expDeparture, setExpDeparture] = useState('')
  const [expDestination, setExpDestination] = useState('')
  const [expRoundTrip, setExpRoundTrip] = useState(true)

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
      setSalesRep(editing.sales_rep ?? '')
      setListRep(editing.list_rep ?? '')
      setAppoRep(editing.appo_rep ?? '')
      setUnpaid(!!editing.commission_unpaid)
      setUnpaidSince(editing.unpaid_since ? moment(editing.unpaid_since).format('YYYY-MM') : '')
      setContractEndMonth(editing.contract_end_month ? moment(editing.contract_end_month).format('YYYY-MM') : '')
      setCaseName(editing.case_name ?? '')
      // 既存の交通費を読み戻す（同じ行を更新するため）
      TravelExpenseApi.getByVisitReport(editing.id).then((x) => {
        setExpense(x)
        setExpAmount(x?.amount != null ? String(x.amount) : '')
        setExpTransport(x?.transport_type || '電車')
        setExpDeparture(x?.departure ?? '')
        setExpDestination(x?.destination ?? selectedCase?.address ?? '')
        setExpRoundTrip(x ? x.round_trip !== false : true)
      }, () => { /* 取得できなくても訪問結果の編集は続行 */ })
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
      setSalesRep('')
      setCaseName('')
      // リスト担当は「案件をリストに入れた人」を初期値に（AI自動投入なら人がいないので空）
      const listed = selectedCase ? creatorNameOf(selectedCase) : ''
      setListRep(listed && listed !== AI_CREATOR_LABEL ? listed : '')
      setAppoRep('')
      setUnpaid(false)
      setUnpaidSince('')
      setContractEndMonth('')
      setExpense(null)
      setExpAmount('')
      setExpTransport('電車')
      setExpDeparture('')
      setExpDestination(selectedCase?.address ?? '')   // 訪問先＝案件の住所を初期値に
      setExpRoundTrip(true)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, editing, selectedCase?.id])

  const priceNums = {
    ...Object.fromEntries(CONTRACT_PRODUCTS.map((p) => [p.key, num(prices[p.key] ?? '') ?? 0])),
    hp_payment_type: hpPayType,
    hp_installments: num(hpInstallments),
  }
  const { initial: initialTotal, monthly: monthlyTotal } = contractTotals(priceNums)
  const total = initialTotal + monthlyTotal
  const hpSplit = hpSplitInfo(priceNums)

  // 案件(selectedCase)がある通常フローと、案件未登録で直接成約を登録するフロー両対応。
  const effName = selectedCase?.name ?? caseName.trim()
  const effCaseId = selectedCase?.id ?? editing?.case_id ?? null

  /**
   * この訪問の交通費を保存する（訪問結果1件につき1行）。
   * 金額が空/0なら、既存行があれば削除＝「入力しなければ登録されない」。
   * 申請者は訪問した営業担当（未選択ならログインユーザー）。労務の集計キーに使う。
   */
  async function saveExpense(visitReportId: string, visitedAtIso: string) {
    const amount = Number(String(expAmount).replace(/[^0-9.-]/g, ''))
    const hasAmount = Number.isFinite(amount) && amount > 0
    if (!hasAmount) {
      if (expense) await TravelExpenseApi.remove(expense.id).catch(() => { /* 消せなくても訪問結果は保存済み */ })
      return
    }
    // 申請者の従業員レコード: 訪問担当者名で照合し、無ければログインユーザーで照合
    let employeeId: string | null = null
    let employeeName = (salesRep && salesRep !== AGENCY) ? salesRep : ''
    try {
      const emps = await EmployeeApi.listDirectory()
      const byName = employeeName ? emps.find((e) => (e.name || '').trim() === employeeName) : null
      const byUser = user?.id ? emps.find((e) => e.user_id === user.id) : null
      const me = byName ?? byUser ?? null
      if (me) { employeeId = me.id; employeeName = me.name || employeeName }
    } catch { /* 従業員マスタが読めなくても交通費は記録する */ }
    const body: Partial<TravelExpense> = {
      case_id: effCaseId,
      case_name: effName,
      visit_report_id: visitReportId,
      appointment_id: appointmentId ?? editing?.appointment_id ?? null,
      expense_date: moment(visitedAtIso).format('YYYY-MM-DD'),
      transport_type: expTransport || null,
      departure: expDeparture.trim() || null,
      destination: expDestination.trim() || null,
      round_trip: expRoundTrip,
      amount,
      purpose: `訪問（${result}）`,
    }
    if (expense) {
      // 金額や区間を直したら承認前に戻す（承認済みの金額が黙って変わらないようにする）
      await TravelExpenseApi.update(expense.id, {
        ...body, status: '申請中', approved_by: null, approved_at: null, rejected_reason: null,
      })
    } else {
      await TravelExpenseApi.create({
        ...body,
        employee_id: employeeId, employee_name: employeeName || null,
        user_id: user?.id ?? null, created_by_id: user?.id ?? null,
        status: '申請中',
      })
    }
  }

  async function handleSave() {
    if (!effName) { toast.error('店舗名を入力してください'); return }
    setBusy(true)
    try {
      const payload: Partial<VisitReport> = {
        case_id: effCaseId,
        case_name: effName,
        appointment_id: appointmentId ?? editing?.appointment_id ?? null,
        visited_at: moment(visitedAt).toISOString(),
        result,
        memo: memo.trim() || null,
        sales_rep: salesRep || null,
        created_by_id: user?.id ?? null,
      }
      if (result === '成約') {
        Object.assign(payload, {
          list_rep: listRep || null,
          appo_rep: appoRep || null,
          commission_unpaid: unpaid,
          // 開始月未指定で未払いにしたら今月から止める（過去の支払済み月は遡って消さない）
          unpaid_since: unpaid ? `${unpaidSince || moment().format('YYYY-MM')}-01` : null,
          contract_end_month: contractEndMonth ? `${contractEndMonth}-01` : null,
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
      const saved = editing
        ? (await VisitReportApi.update(editing.id, payload), editing)
        : await VisitReportApi.create(payload)
      await saveExpense(saved.id, payload.visited_at as string)
      // 案件ステータスも訪問結果に合わせて更新（案件未登録の直接成約はスキップ）
      if (effCaseId) await CaseApi.update(effCaseId, { status: result })
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
            {editing ? '訪問結果を編集' : (selectedCase ? '訪問結果を登録' : '成約を登録')}
            {effName && <span className="ml-2 text-2xs font-normal text-muted-foreground">{effName}</span>}
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-2">
          {/* 案件未登録の直接成約登録時は店舗名を手入力（selectedCaseがある通常フローでは非表示） */}
          {!selectedCase && (
            <div className="space-y-1">
              <Label>店舗名<span className="ml-1 text-2xs font-normal text-muted-foreground">（案件未登録）</span></Label>
              <Input placeholder="例: 〇〇カフェ" value={caseName} onChange={(e) => setCaseName(e.target.value)} />
            </div>
          )}
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
            <Label>営業担当</Label>
            <Select value={salesRep || NONE} onValueChange={(v) => setSalesRep(v === NONE ? '' : v)}>
              <SelectTrigger><SelectValue placeholder="選択" /></SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE}>選択</SelectItem>
                {/* ユーザー登録済みの営業担当（織田春樹・織田哲哉 等）＋編集中の値も欠落しないよう合流 */}
                {Array.from(new Set([...repNames, salesRep].filter((n) => n && n !== AGENCY))).map((n) => (
                  <SelectItem key={n} value={n}>{n}</SelectItem>
                ))}
                <SelectItem value={AGENCY}>販売代理店</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {/* 歩合の分配先と入金状況（成約のみ）。売上の20%を リスト10% / アポ40% / 営業50% で分配 */}
          {result === '成約' && (
            <div className="space-y-2 rounded-md border border-emerald-200 bg-emerald-50/50 p-2 dark:border-emerald-500/30 dark:bg-emerald-500/10">
              <Label className="text-emerald-700 dark:text-emerald-400">
                歩合の分配
                <span className="ml-1 text-2xs font-normal text-muted-foreground">
                  売上の{Math.round(COMMISSION_RATE * 100)}%を リスト{Math.round(COMMISSION_SPLIT.list * 100)}% / アポ{Math.round(COMMISSION_SPLIT.appo * 100)}% / 営業{Math.round(COMMISSION_SPLIT.sales * 100)}%（営業担当は上で選択）
                </span>
              </Label>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <Label className="text-2xs">リスト担当</Label>
                  <Select value={listRep || NONE} onValueChange={(v) => setListRep(v === NONE ? '' : v)}>
                    <SelectTrigger><SelectValue placeholder="未設定" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>未設定（配分なし）</SelectItem>
                      {Array.from(new Set([...repNames, listRep].filter((n) => n && n !== AGENCY))).map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                      <SelectItem value={AGENCY}>販売代理店</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-1">
                  <Label className="text-2xs">アポ担当</Label>
                  <Select value={appoRep || NONE} onValueChange={(v) => setAppoRep(v === NONE ? '' : v)}>
                    <SelectTrigger><SelectValue placeholder="未設定" /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>未設定（配分なし）</SelectItem>
                      {Array.from(new Set([...repNames, appoRep].filter((n) => n && n !== AGENCY))).map((n) => <SelectItem key={n} value={n}>{n}</SelectItem>)}
                      <SelectItem value={AGENCY}>販売代理店</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="space-y-1">
                  <label className="flex items-center gap-2 text-2xs font-medium">
                    <input type="checkbox" checked={unpaid} onChange={(e) => { setUnpaid(e.target.checked); if (e.target.checked && !unpaidSince) setUnpaidSince(moment().format('YYYY-MM')) }} />
                    未払い（入金待ち）
                  </label>
                  {unpaid && (
                    <div className="space-y-0.5">
                      <Input type="month" value={unpaidSince} onChange={(e) => setUnpaidSince(e.target.value)} />
                      <p className="text-[10px] leading-snug text-muted-foreground">この月以降の歩合を計上しません（支払済みの過去月はそのまま）</p>
                    </div>
                  )}
                </div>
                <div className="space-y-1">
                  <Label className="text-2xs">解約月（任意）</Label>
                  <div className="flex items-center gap-1">
                    <Input type="month" value={contractEndMonth} onChange={(e) => setContractEndMonth(e.target.value)} />
                    {contractEndMonth && (
                      <button type="button" className="shrink-0 text-2xs text-muted-foreground hover:underline" onClick={() => setContractEndMonth('')}>解除</button>
                    )}
                  </div>
                  <p className="text-[10px] leading-snug text-muted-foreground">この月まで月額の歩合を計上します</p>
                </div>
              </div>
            </div>
          )}

          {/* 交通費（任意）。金額を入れたときだけ登録され、労務管理で営業担当ごとに集計される */}
          <div className="space-y-2 rounded-md border bg-muted/30 p-2">
            <div className="flex items-center justify-between">
              <Label>交通費<span className="ml-1 text-2xs font-normal text-muted-foreground">この訪問でかかった分（空欄なら登録しません）</span></Label>
              {expense?.status && <span className="text-2xs text-muted-foreground">現在: {expense.status}</span>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-2xs">金額（円）</Label>
                <Input inputMode="numeric" placeholder="例: 1240" value={expAmount} onChange={(e) => setExpAmount(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-2xs">交通手段</Label>
                <Select value={expTransport} onValueChange={setExpTransport}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    {TRANSPORT_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1">
                <Label className="text-2xs">出発地</Label>
                <Input placeholder="例: 大宮駅" value={expDeparture} onChange={(e) => setExpDeparture(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label className="text-2xs">到着地</Label>
                <Input value={expDestination} onChange={(e) => setExpDestination(e.target.value)} />
              </div>
            </div>
            <label className="flex items-center gap-2 text-2xs">
              <input type="checkbox" checked={expRoundTrip} onChange={(e) => setExpRoundTrip(e.target.checked)} />
              往復（金額は往復の実費を入力）
            </label>
          </div>

          <div className="space-y-1">
            <Label>メモ</Label>
            <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>キャンセル</Button>
          <Button onClick={handleSave} disabled={busy || !effName}>{busy ? '保存中...' : '保存'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
