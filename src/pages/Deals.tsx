import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { Handshake, Pencil, Trash2, Plus, Printer, ChevronLeft, ChevronRight, Coins } from 'lucide-react'
import { Button } from '@/components/ui/button'
import TopBar from '@/components/layout/TopBar'
import { SkeletonRows } from '@/components/ui/skeleton'
import { VisitReportApi, CaseApi } from '@/lib/api'
import { CONTRACT_PRODUCTS, contractTotals, hpSplitInfo } from '@/lib/constants'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { useToast } from '@/components/ui/toast'
import { useConfirm } from '@/components/ui/confirm'
import { jpError } from '@/lib/utils'
import VisitReportModal from '@/components/modals/VisitReportModal'
import type { Case, VisitReport } from '@/lib/types'
import {
  summarizeCommission, contractStartMonth, monthlyCommission, payrollInfo,
  COMMISSION_RATE, COMMISSION_SPLIT, COMMISSION_PAY_DAY, type PayStatus,
} from '@/lib/commission'

const yen = (n?: number | null) => (n != null ? '¥' + n.toLocaleString() : '—')
const pct = (n: number) => `${Math.round(n * 100)}%`

/** 支払状態のバッジ色 */
const PAY_STATUS_CLASS: Record<PayStatus, string> = {
  集計中: 'bg-sky-100 text-sky-700 dark:bg-sky-500/20 dark:text-sky-300',
  支払予定: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  支払済み: 'bg-slate-100 text-slate-600 dark:bg-slate-700/60 dark:text-slate-300',
}
const md = (d: string) => moment(d).format('M/D')

/** 担当者名のセル表示（販売代理店はバッジ、未設定は薄いダッシュ） */
function RepCell({ name }: { name?: string | null }) {
  if (!name) return <span className="text-muted-foreground/40">—</span>
  if (name === '販売代理店') return <span className="rounded bg-violet-100 px-1.5 py-px text-2xs font-bold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">販売代理店</span>
  return <span className="font-medium">{name}</span>
}

export default function Deals() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const [reports, setReports] = useState<VisitReport[]>([])
  const [caseMap, setCaseMap] = useState<Map<string, Case>>(new Map())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<VisitReport | null>(null)
  const [creating, setCreating] = useState(false)  // 案件未登録の直接成約登録
  const [pdfBusy, setPdfBusy] = useState(false)
  // 歩合の表示期間（既定=今月）。累計は「最も古い契約月〜今月」
  const [commMonth, setCommMonth] = useState(() => moment().format('YYYY-MM'))
  const [commAll, setCommAll] = useState(false)
  // 月別の歩合一覧: 既定は直近12ヶ月、全期間も表示可
  const [showAllMonths, setShowAllMonths] = useState(false)
  const pdfRef = useRef<HTMLDivElement>(null)

  // 印刷ダイアログを出さずにPDFを直接ダウンロード（html2canvasで画像化→jsPDFに配置）。
  // 日本語も画像なので確実に出る。生成中は操作列/ボタンを隠し、ダークモードは一時的に解除して白背景に。
  async function handlePdf() {
    const el = pdfRef.current
    if (!el || pdfBusy) return
    setPdfBusy(true)
    const root = document.documentElement
    const wasDark = root.classList.contains('dark')
    if (wasDark) root.classList.remove('dark')
    // 操作列/ボタン非表示の再描画を待つ
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(() => r(null))))
    try {
      const [{ default: html2canvas }, { jsPDF }] = await Promise.all([import('html2canvas'), import('jspdf')])
      const canvas = await html2canvas(el, { scale: 2, backgroundColor: '#ffffff', windowWidth: el.scrollWidth })
      const pdf = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' })
      const margin = 8
      const pw = pdf.internal.pageSize.getWidth() - margin * 2
      const ph = pdf.internal.pageSize.getHeight() - margin * 2
      const imgW = pw
      const imgH = (canvas.height * imgW) / canvas.width
      const img = canvas.toDataURL('image/png')
      let heightLeft = imgH
      let position = 0
      pdf.addImage(img, 'PNG', margin, margin + position, imgW, imgH)
      heightLeft -= ph
      while (heightLeft > 0) {
        position -= ph
        pdf.addPage()
        pdf.addImage(img, 'PNG', margin, margin + position, imgW, imgH)
        heightLeft -= ph
      }
      pdf.save(`成約案件_${moment().format('YYYY-MM-DD')}.pdf`)
    } catch (e) {
      toast.error('PDF生成に失敗しました: ' + jpError(e))
    } finally {
      if (wasDark) root.classList.add('dark')
      setPdfBusy(false)
    }
  }

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    try {
      const [all, cases] = await Promise.all([VisitReportApi.listAll(), CaseApi.listAll()])
      // 契約日の新しい順（降順）。契約日が無いものは末尾。
      const deals = all.filter((r) => r.result === '成約')
        .sort((a, b) => String(b.contract_date || '').localeCompare(String(a.contract_date || '')))
      setReports(deals)
      setCaseMap(new Map(cases.map((c) => [c.id, c])))
    } catch (e) {
      console.error('[Deals]', e)
      toast.error('成約案件の取得に失敗しました: ' + jpError(e))
    } finally {
      setLoading(false)
    }
  }, [toast])

  useEffect(() => { load() }, [load])

  const totals = useMemo(() => {
    const t = { count: reports.length, initial: 0, monthly: 0 }
    for (const r of reports) { const { initial, monthly } = contractTotals(r); t.initial += initial; t.monthly += monthly }
    return t
  }, [reports])

  // 担当者ごとの歩合（売上20%を リスト10% / アポ40% / 営業50%。未払い・解約後の月は除外）
  const commission = useMemo(() => {
    if (!commAll) return summarizeCommission(reports, commMonth, commMonth)
    const starts = reports.map((r) => contractStartMonth(r)).filter(Boolean) as string[]
    const from = starts.length ? [...starts].sort()[0] : moment().format('YYYY-MM')
    return summarizeCommission(reports, from, moment().format('YYYY-MM'))
  }, [reports, commMonth, commAll])
  const isFutureMonth = !commAll && commMonth > moment().format('YYYY-MM')
  const selectedPay = payrollInfo(commMonth)
  // 月別の歩合（月末締め→翌月25日払い）。新しい月から並べる
  const monthlyRows = useMemo(() => {
    const now = moment().format('YYYY-MM')
    const starts = reports.map((r) => contractStartMonth(r)).filter(Boolean) as string[]
    const earliest = starts.length ? [...starts].sort()[0] : now
    const from = showAllMonths ? earliest : moment().subtract(11, 'months').format('YYYY-MM')
    return monthlyCommission(reports, from < earliest ? earliest : from, now)
  }, [reports, showAllMonths])
  // 月別表の列: 表示中の月のどこかで歩合が出た担当者（合計の多い順）
  const monthlyPeople = useMemo(() => {
    const tot = new Map<string, number>()
    for (const row of monthlyRows) for (const pp of row.summary.people) tot.set(pp.name, (tot.get(pp.name) || 0) + pp.total)
    return [...tot.entries()].sort((a, b) => b[1] - a[1]).map(([n]) => n)
  }, [monthlyRows])
  const shiftMonth = (d: number) => { setCommAll(false); setCommMonth(moment(commMonth + '-01').add(d, 'month').format('YYYY-MM')) }

  async function handleDelete(r: VisitReport) {
    if (!(await confirm({ title: '成約記録を削除しますか？', body: `${r.case_name} の訪問結果（成約）を削除します。`, confirmLabel: '削除する', danger: true }))) return
    try { await VisitReportApi.remove(r.id); toast.success('削除しました'); load() } catch (e) { toast.error('削除に失敗: ' + jpError(e)) }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="print:hidden"><TopBar /></div>
      <div ref={pdfRef} className="mx-auto max-w-[1400px] bg-background p-3 print:max-w-none print:p-2">
        <div className="mb-3 flex items-center gap-2">
          <Handshake className="h-5 w-5 text-emerald-600" />
          <h1 className="text-lg font-bold">成約案件管理</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {totals.count}件 / 初期 {yen(totals.initial)} ・ 月額 {yen(totals.monthly)}/月
          </span>
          {/* PDF生成中・印刷時のみ出力日を表示 */}
          <span className={`ml-2 text-2xs text-muted-foreground print:inline ${pdfBusy ? 'inline' : 'hidden'}`}>出力日: {moment().format('YYYY/MM/DD')}</span>
          <div className={`ml-auto gap-2 print:hidden ${pdfBusy ? 'hidden' : 'flex'}`}>
            <Button size="sm" variant="outline" onClick={handlePdf} disabled={pdfBusy}>
              <Printer className="mr-1 h-4 w-4" /> {pdfBusy ? '生成中...' : 'PDF出力'}
            </Button>
            {/* 案件未登録でも成約を直接登録できる */}
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> 成約を直接登録
            </Button>
          </div>
        </div>

        {/* 担当者ごとの歩合（全員に公開） */}
        <div className="mb-3 rounded-xl border bg-card p-3 print:break-inside-avoid">
          <div className="mb-2 flex flex-wrap items-center gap-2">
            <Coins className="h-4 w-4 text-amber-500" />
            <h2 className="text-sm font-bold">担当者ごとの歩合</h2>
            <span className="text-2xs text-muted-foreground">
              売上の{pct(COMMISSION_RATE)}を リスト{pct(COMMISSION_SPLIT.list)} / アポ{pct(COMMISSION_SPLIT.appo)} / 営業{pct(COMMISSION_SPLIT.sales)} で分配・月額は毎月の入金ごと
            </span>
            <div className={`ml-auto items-center gap-1 print:hidden ${pdfBusy ? 'hidden' : 'flex'}`}>
              <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => shiftMonth(-1)} title="前月"><ChevronLeft className="h-4 w-4" /></Button>
              <input
                type="month" value={commMonth}
                onChange={(e) => { setCommAll(false); setCommMonth(e.target.value || moment().format('YYYY-MM')) }}
                className="h-7 rounded border border-input bg-background px-2 text-xs"
              />
              <Button size="icon" variant="outline" className="h-7 w-7" onClick={() => shiftMonth(1)} title="翌月"><ChevronRight className="h-4 w-4" /></Button>
              <Button size="sm" variant={commAll ? 'default' : 'outline'} className="h-7 text-2xs" onClick={() => setCommAll((v) => !v)}>累計</Button>
            </div>
          </div>
          <div className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-muted-foreground">
            <span className="font-medium text-foreground">
              {commAll ? '累計（最初の契約月〜今月）' : (
                <>
                  {selectedPay.label}
                  <span className="ml-1 font-normal text-muted-foreground">（{md(selectedPay.closeDate)}締め・{md(selectedPay.payDate)}支払）</span>
                  <span className={`ml-1 rounded px-1 text-[9px] ${PAY_STATUS_CLASS[selectedPay.status]}`}>{isFutureMonth ? '見込み' : selectedPay.status}</span>
                </>
              )}
            </span>
            <span>売上 <b className="tabular-nums text-foreground">{yen(commission.revenue)}</b></span>
            <span>歩合原資 <b className="tabular-nums text-foreground">{yen(commission.pool)}</b></span>
            <span>計上 {commission.activeDeals}件</span>
            {commission.unpaidDeals > 0 && <span className="text-red-600 dark:text-red-400">未払い設定 {commission.unpaidDeals}件（該当月は除外）</span>}
            {commission.unassigned > 0 && <span className="text-amber-700 dark:text-amber-400">担当未設定で未配分 {yen(commission.unassigned)}</span>}
          </div>
          {commission.people.length === 0 ? (
            <p className="py-3 text-center text-xs text-muted-foreground">この期間に歩合が発生した案件はありません</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b text-2xs text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">担当者</th>
                    <th className="px-2 py-1 text-right font-medium">リスト分</th>
                    <th className="px-2 py-1 text-right font-medium">アポ分</th>
                    <th className="px-2 py-1 text-right font-medium">営業分</th>
                    <th className="px-2 py-1 text-right font-medium">歩合合計</th>
                    <th className="px-2 py-1 text-right font-medium">対象案件</th>
                  </tr>
                </thead>
                <tbody>
                  {commission.people.map((p) => (
                    <tr key={p.name} className="border-b last:border-0">
                      <td className="px-2 py-1.5"><RepCell name={p.name} /></td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.list ? yen(p.list) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.appo ? yen(p.appo) : '—'}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.sales ? yen(p.sales) : '—'}</td>
                      <td className="px-2 py-1.5 text-right text-sm font-bold tabular-nums text-amber-700 dark:text-amber-400">{yen(p.total)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">{p.deals}件</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {commission.unassigned > 0 && (
            <p className={`mt-2 text-[10px] text-muted-foreground print:hidden ${pdfBusy ? 'hidden' : ''}`}>
              リスト担当・アポ担当が未設定の案件は、その分が誰にも配分されません。各案件の操作欄のえんぴつから設定してください。
            </p>
          )}

          {/* 月別の歩合（月末締め → 翌月{COMMISSION_PAY_DAY}日の給与で支払い） */}
          <div className="mt-4 border-t pt-3">
            <div className="mb-1.5 flex flex-wrap items-center gap-2">
              <h3 className="text-xs font-bold">月別の歩合</h3>
              <span className="text-2xs text-muted-foreground">月末締め・翌月{COMMISSION_PAY_DAY}日の給与と一緒に支払い（行を押すと上に内訳を表示）</span>
              <Button
                size="sm" variant="ghost" className={`ml-auto h-6 text-2xs print:hidden ${pdfBusy ? 'hidden' : ''}`}
                onClick={() => setShowAllMonths((v) => !v)}
              >
                {showAllMonths ? '直近12ヶ月だけ表示' : '全期間を表示'}
              </Button>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-xs">
                <thead>
                  <tr className="border-b bg-muted/40 text-2xs text-muted-foreground">
                    <th className="px-2 py-1 text-left font-medium">対象</th>
                    <th className="px-2 py-1 text-left font-medium">締め日</th>
                    <th className="px-2 py-1 text-left font-medium">支払日</th>
                    <th className="px-2 py-1 text-left font-medium">状態</th>
                    {monthlyPeople.map((n) => <th key={n} className="px-2 py-1 text-right font-medium">{n}</th>)}
                    <th className="px-2 py-1 text-right font-medium">合計</th>
                  </tr>
                </thead>
                <tbody>
                  {monthlyRows.map((row) => {
                    const byName = new Map(row.summary.people.map((pp) => [pp.name, pp.total]))
                    const total = row.summary.people.reduce((a, pp) => a + pp.total, 0)
                    const active = !commAll && row.month === commMonth
                    return (
                      <tr
                        key={row.month}
                        onClick={() => { setCommAll(false); setCommMonth(row.month) }}
                        className={`cursor-pointer border-b last:border-0 hover:bg-accent/40 ${active ? 'bg-amber-50 dark:bg-amber-500/10' : ''}`}
                      >
                        <td className="whitespace-nowrap px-2 py-1.5 font-medium">{row.label}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground">{moment(row.closeDate).format('YYYY/M/D')}</td>
                        <td className="whitespace-nowrap px-2 py-1.5 tabular-nums">{moment(row.payDate).format('YYYY/M/D')}</td>
                        <td className="px-2 py-1.5"><span className={`rounded px-1.5 py-px text-[10px] ${PAY_STATUS_CLASS[row.status]}`}>{row.status}</span></td>
                        {monthlyPeople.map((n) => (
                          <td key={n} className="whitespace-nowrap px-2 py-1.5 text-right tabular-nums">{byName.get(n) ? yen(byName.get(n)) : '—'}</td>
                        ))}
                        <td className="whitespace-nowrap px-2 py-1.5 text-right font-bold tabular-nums text-amber-700 dark:text-amber-400">{total ? yen(total) : '—'}</td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <div className={`rounded-xl border bg-card print:overflow-visible print:rounded-none print:border-0 ${pdfBusy ? 'overflow-visible' : 'overflow-x-auto'}`}>
          <table className="w-full min-w-[1000px] text-xs print:min-w-0 print:text-[9px]">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-2 py-2 text-left">店舗名</th>
                <th className="px-2 py-2 text-left">契約日</th>
                <th className="px-2 py-2 text-left">リスト担当</th>
                <th className="px-2 py-2 text-left">アポ担当</th>
                <th className="px-2 py-2 text-left">営業担当</th>
                {CONTRACT_PRODUCTS.map((p) => <th key={p.key} className="px-2 py-2 text-right">{p.label}<span className="block text-[9px] font-normal opacity-70">{p.kind === 'initial' ? '初期' : '月額'}</span></th>)}
                <th className="px-2 py-2 text-right">初期費用計</th>
                <th className="px-2 py-2 text-right">月額計</th>
                <th className="px-2 py-2 text-right">最低契約期間</th>
                <th className="px-2 py-2 text-left">支払方法</th>
                <th className="px-2 py-2 text-left">メモ</th>
                <th className={`px-2 py-2 text-right print:hidden ${pdfBusy ? 'hidden' : ''}`}>操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={CONTRACT_PRODUCTS.length + 11}><SkeletonRows count={5} /></td></tr>}
              {!loading && reports.length === 0 && (
                <tr><td colSpan={CONTRACT_PRODUCTS.length + 11} className="py-8 text-center text-muted-foreground">成約案件はまだありません（訪問予定から訪問結果を「成約」で登録すると表示されます）</td></tr>
              )}
              {reports.map((r) => (
                <tr key={r.id} className={`border-b last:border-0 hover:bg-accent/40 ${r.commission_unpaid ? 'bg-red-50/60 dark:bg-red-500/5' : ''}`}>
                  <td className="px-2 py-1.5">
                    {/* 案件に紐づく成約は案件詳細へ、案件未登録の直接成約は編集を開く */}
                    <button className="font-medium text-primary hover:underline" onClick={() => (r.case_id ? navigate(`/?case=${r.case_id}`) : setEditing(r))}>
                      {(r.case_id ? caseMap.get(r.case_id)?.name : null) || r.case_name}
                      {!r.case_id && <span className="ml-1 text-2xs font-normal text-muted-foreground">(案件未登録)</span>}
                    </button>
                    <div className="text-2xs text-muted-foreground">{(r.case_id ? caseMap.get(r.case_id)?.address : '') || ''}</div>
                  </td>
                  <td className="px-2 py-1.5">
                    {r.contract_date ? moment(r.contract_date).format('YYYY/MM/DD') : '—'}
                    {r.commission_unpaid && (
                      <span className="mt-0.5 block"><span className="rounded bg-red-100 px-1 py-px text-[9px] font-bold text-red-700 dark:bg-red-500/20 dark:text-red-300">未払い{r.unpaid_since ? ` ${moment(r.unpaid_since).format('YYYY/M')}〜` : ''}</span></span>
                    )}
                    {r.contract_end_month && (
                      <span className="mt-0.5 block"><span className="rounded bg-slate-200 px-1 py-px text-[9px] font-bold text-slate-600 dark:bg-slate-700 dark:text-slate-300">解約 {moment(r.contract_end_month).format('YYYY/M')}</span></span>
                    )}
                  </td>
                  <td className="px-2 py-1.5"><RepCell name={r.list_rep} /></td>
                  <td className="px-2 py-1.5"><RepCell name={r.appo_rep} /></td>
                  <td className="px-2 py-1.5"><RepCell name={r.sales_rep} /></td>
                  {CONTRACT_PRODUCTS.map((p) => {
                    const v = r[p.key as keyof VisitReport] as number | null | undefined
                    const split = p.key === 'hp_price' ? hpSplitInfo(r) : null
                    return (
                      <td key={p.key} className={`px-2 py-1.5 text-right tabular-nums ${v != null ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground/40'}`}>
                        {yen(v)}
                        {/* HP制作の支払区分を一目で分かるバッジで表示（分割=琥珀 / 一括=青） */}
                        {p.key === 'hp_price' && v != null && (
                          split
                            ? <span className="mt-0.5 block"><span className="rounded bg-amber-100 px-1 py-px text-[9px] font-bold text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">分割</span><span className="ml-1 text-[9px] font-normal text-muted-foreground">¥{split.monthly.toLocaleString()}×{split.months}回</span></span>
                            : <span className="mt-0.5 block"><span className="rounded bg-sky-100 px-1 py-px text-[9px] font-bold text-sky-700 dark:bg-sky-500/20 dark:text-sky-300">一括</span></span>
                        )}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums">{yen(contractTotals(r).initial || null)}</td>
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{(() => { const m = contractTotals(r).monthly; return m ? `${yen(m)}/月` : '—' })()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.min_contract_months != null ? `${r.min_contract_months}ヶ月` : '—'}</td>
                  <td className="px-2 py-1.5">{r.payment_method || '—'}</td>
                  <td className="px-2 py-1.5 max-w-[220px] truncate text-muted-foreground" title={r.memo || ''}>{r.memo || '—'}</td>
                  <td className={`px-2 py-1.5 text-right print:hidden ${pdfBusy ? 'hidden' : ''}`}>
                    <div className="flex justify-end gap-1">
                      <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => setEditing(r)} title="編集"><Pencil className="h-3.5 w-3.5" /></button>
                      <button className="rounded p-1 text-red-500 hover:bg-accent" onClick={() => handleDelete(r)} title="削除"><Trash2 className="h-3.5 w-3.5" /></button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <VisitReportModal
        open={!!editing || creating}
        onClose={() => { setEditing(null); setCreating(false) }}
        // 案件に紐づく既存成約の編集は該当caseを渡す（案件未登録の直接成約はnull＝店舗名を手入力）
        selectedCase={editing && editing.case_id ? (caseMap.get(editing.case_id) ?? ({ id: editing.case_id, name: editing.case_name } as Case)) : null}
        editing={editing}
        onSaved={load}
      />

      {/* PDF出力(ブラウザ印刷)用スタイル: A4横・余白・背景色/バッジ色を維持し、行が途中で切れないように */}
      <style>{`
        @media print {
          @page { size: A4 landscape; margin: 10mm; }
          html, body { background: #fff !important; }
          * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
          tr, td, th { break-inside: avoid; }
        }
      `}</style>
    </div>
  )
}
