import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { Handshake, Pencil, Trash2, Plus, Printer } from 'lucide-react'
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

const yen = (n?: number | null) => (n != null ? '¥' + n.toLocaleString() : '—')

export default function Deals() {
  const navigate = useNavigate()
  const toast = useToast()
  const confirm = useConfirm()
  const [reports, setReports] = useState<VisitReport[]>([])
  const [caseMap, setCaseMap] = useState<Map<string, Case>>(new Map())
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState<VisitReport | null>(null)
  const [creating, setCreating] = useState(false)  // 案件未登録の直接成約登録

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

  async function handleDelete(r: VisitReport) {
    if (!(await confirm({ title: '成約記録を削除しますか？', body: `${r.case_name} の訪問結果（成約）を削除します。`, confirmLabel: '削除する', danger: true }))) return
    try { await VisitReportApi.remove(r.id); toast.success('削除しました'); load() } catch (e) { toast.error('削除に失敗: ' + jpError(e)) }
  }

  return (
    <div className="min-h-screen bg-background">
      <div className="print:hidden"><TopBar /></div>
      <div className="mx-auto max-w-[1400px] p-3 print:max-w-none print:p-2">
        <div className="mb-3 flex items-center gap-2">
          <Handshake className="h-5 w-5 text-emerald-600" />
          <h1 className="text-lg font-bold">成約案件管理</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {totals.count}件 / 初期 {yen(totals.initial)} ・ 月額 {yen(totals.monthly)}/月
          </span>
          {/* 印刷(PDF)時のみ出力日を表示 */}
          <span className="ml-2 hidden text-2xs text-muted-foreground print:inline">出力日: {moment().format('YYYY/MM/DD')}</span>
          <div className="ml-auto flex gap-2 print:hidden">
            <Button size="sm" variant="outline" onClick={() => window.print()}>
              <Printer className="mr-1 h-4 w-4" /> PDF出力
            </Button>
            {/* 案件未登録でも成約を直接登録できる */}
            <Button size="sm" className="bg-emerald-600 hover:bg-emerald-700" onClick={() => setCreating(true)}>
              <Plus className="mr-1 h-4 w-4" /> 成約を直接登録
            </Button>
          </div>
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card print:overflow-visible print:rounded-none print:border-0">
          <table className="w-full min-w-[1000px] text-xs print:min-w-0 print:text-[9px]">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-2 py-2 text-left">店舗名</th>
                <th className="px-2 py-2 text-left">契約日</th>
                <th className="px-2 py-2 text-left">営業担当</th>
                {CONTRACT_PRODUCTS.map((p) => <th key={p.key} className="px-2 py-2 text-right">{p.label}<span className="block text-[9px] font-normal opacity-70">{p.kind === 'initial' ? '初期' : '月額'}</span></th>)}
                <th className="px-2 py-2 text-right">初期費用計</th>
                <th className="px-2 py-2 text-right">月額計</th>
                <th className="px-2 py-2 text-right">最低契約期間</th>
                <th className="px-2 py-2 text-left">支払方法</th>
                <th className="px-2 py-2 text-left">メモ</th>
                <th className="px-2 py-2 text-right print:hidden">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={CONTRACT_PRODUCTS.length + 9}><SkeletonRows count={5} /></td></tr>}
              {!loading && reports.length === 0 && (
                <tr><td colSpan={CONTRACT_PRODUCTS.length + 9} className="py-8 text-center text-muted-foreground">成約案件はまだありません（訪問予定から訪問結果を「成約」で登録すると表示されます）</td></tr>
              )}
              {reports.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="px-2 py-1.5">
                    {/* 案件に紐づく成約は案件詳細へ、案件未登録の直接成約は編集を開く */}
                    <button className="font-medium text-primary hover:underline" onClick={() => (r.case_id ? navigate(`/?case=${r.case_id}`) : setEditing(r))}>
                      {(r.case_id ? caseMap.get(r.case_id)?.name : null) || r.case_name}
                      {!r.case_id && <span className="ml-1 text-2xs font-normal text-muted-foreground">(案件未登録)</span>}
                    </button>
                    <div className="text-2xs text-muted-foreground">{(r.case_id ? caseMap.get(r.case_id)?.address : '') || ''}</div>
                  </td>
                  <td className="px-2 py-1.5">{r.contract_date ? moment(r.contract_date).format('YYYY/MM/DD') : '—'}</td>
                  <td className="px-2 py-1.5">
                    {r.sales_rep
                      ? (r.sales_rep === '販売代理店'
                          ? <span className="rounded bg-violet-100 px-1.5 py-px text-2xs font-bold text-violet-700 dark:bg-violet-500/20 dark:text-violet-300">販売代理店</span>
                          : <span className="font-medium">{r.sales_rep}</span>)
                      : <span className="text-muted-foreground/40">—</span>}
                  </td>
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
                  <td className="px-2 py-1.5 text-right print:hidden">
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
