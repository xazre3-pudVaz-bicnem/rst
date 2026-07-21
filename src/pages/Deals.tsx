import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import moment from 'moment'
import { Handshake, Pencil, Trash2 } from 'lucide-react'
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

  const load = useCallback(async () => {
    if (!isSupabaseConfigured) { setLoading(false); return }
    try {
      const [all, cases] = await Promise.all([VisitReportApi.listAll(), CaseApi.listAll()])
      setReports(all.filter((r) => r.result === '成約'))
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
      <TopBar />
      <div className="mx-auto max-w-[1400px] p-3">
        <div className="mb-3 flex items-center gap-2">
          <Handshake className="h-5 w-5 text-emerald-600" />
          <h1 className="text-lg font-bold">成約案件管理</h1>
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-700 dark:bg-emerald-500/20 dark:text-emerald-300">
            {totals.count}件 / 初期 {yen(totals.initial)} ・ 月額 {yen(totals.monthly)}/月
          </span>
        </div>

        <div className="overflow-x-auto rounded-xl border bg-card">
          <table className="w-full min-w-[1000px] text-xs">
            <thead>
              <tr className="border-b bg-muted/40 text-muted-foreground">
                <th className="px-2 py-2 text-left">店舗名</th>
                <th className="px-2 py-2 text-left">契約日</th>
                {CONTRACT_PRODUCTS.map((p) => <th key={p.key} className="px-2 py-2 text-right">{p.label}<span className="block text-[9px] font-normal opacity-70">{p.kind === 'initial' ? '初期' : '月額'}</span></th>)}
                <th className="px-2 py-2 text-right">初期費用計</th>
                <th className="px-2 py-2 text-right">月額計</th>
                <th className="px-2 py-2 text-right">最低契約期間</th>
                <th className="px-2 py-2 text-left">支払方法</th>
                <th className="px-2 py-2 text-left">メモ</th>
                <th className="px-2 py-2 text-right">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading && <tr><td colSpan={CONTRACT_PRODUCTS.length + 8}><SkeletonRows count={5} /></td></tr>}
              {!loading && reports.length === 0 && (
                <tr><td colSpan={CONTRACT_PRODUCTS.length + 8} className="py-8 text-center text-muted-foreground">成約案件はまだありません（訪問予定から訪問結果を「成約」で登録すると表示されます）</td></tr>
              )}
              {reports.map((r) => (
                <tr key={r.id} className="border-b last:border-0 hover:bg-accent/40">
                  <td className="px-2 py-1.5">
                    <button className="font-medium text-primary hover:underline" onClick={() => navigate(`/?case=${r.case_id}`)}>
                      {caseMap.get(r.case_id)?.name || r.case_name}
                    </button>
                    <div className="text-2xs text-muted-foreground">{caseMap.get(r.case_id)?.address || ''}</div>
                  </td>
                  <td className="px-2 py-1.5">{r.contract_date ? moment(r.contract_date).format('YYYY/MM/DD') : '—'}</td>
                  {CONTRACT_PRODUCTS.map((p) => {
                    const v = r[p.key as keyof VisitReport] as number | null | undefined
                    const split = p.key === 'hp_price' ? hpSplitInfo(r) : null
                    return (
                      <td key={p.key} className={`px-2 py-1.5 text-right tabular-nums ${v != null ? 'font-medium text-emerald-700 dark:text-emerald-400' : 'text-muted-foreground/40'}`}>
                        {yen(v)}
                        {split && <span className="block text-[9px] font-normal text-muted-foreground">分割 ¥{split.monthly.toLocaleString()}×{split.months}回</span>}
                        {p.key === 'hp_price' && v != null && !split && <span className="block text-[9px] font-normal text-muted-foreground">一括</span>}
                      </td>
                    )
                  })}
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums">{yen(contractTotals(r).initial || null)}</td>
                  <td className="px-2 py-1.5 text-right font-bold tabular-nums text-emerald-700 dark:text-emerald-400">{(() => { const m = contractTotals(r).monthly; return m ? `${yen(m)}/月` : '—' })()}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{r.min_contract_months != null ? `${r.min_contract_months}ヶ月` : '—'}</td>
                  <td className="px-2 py-1.5">{r.payment_method || '—'}</td>
                  <td className="px-2 py-1.5 max-w-[220px] truncate text-muted-foreground" title={r.memo || ''}>{r.memo || '—'}</td>
                  <td className="px-2 py-1.5 text-right">
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
        open={!!editing}
        onClose={() => setEditing(null)}
        selectedCase={editing ? (caseMap.get(editing.case_id) ?? ({ id: editing.case_id, name: editing.case_name } as Case)) : null}
        editing={editing}
        onSaved={load}
      />
    </div>
  )
}
