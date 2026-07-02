import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import moment from 'moment'
import { Calendar, ChevronLeft, ChevronRight, X } from 'lucide-react'
import { cn } from '@/lib/utils'

/**
 * 日時ピッカー（1つの入力欄 → 1つのポップアップでカレンダー＋15分刻みの時刻を選択）。
 *
 * 背景: Windows系ブラウザのネイティブ datetime-local / time は step 属性を分に
 * 反映しないため、15分刻みが保証できない。本コンポーネントは自前UIで確実に15分刻みにする。
 * value / onChange は従来どおり "YYYY-MM-DDTHH:mm" 文字列。
 */
export interface DateTime15InputProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土']
const MINUTES = [0, 15, 30, 45]

function parse(value: string): { date: string; time: string } {
  if (!value) return { date: '', time: '' }
  const [d = '', t = ''] = value.split('T')
  return { date: d, time: t.slice(0, 5) }
}

export function DateTime15Input({ value, onChange, disabled, className }: DateTime15InputProps) {
  const { date, time } = parse(value)
  const [open, setOpen] = useState(false)
  const [viewMonth, setViewMonth] = useState(() => moment(date || undefined).startOf('month'))
  const triggerRef = useRef<HTMLButtonElement>(null)
  const popRef = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null)

  // 開いたときに選択中の月へ合わせる
  useEffect(() => {
    if (open) setViewMonth(moment(date || undefined).startOf('month'))
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps

  // ポップアップ位置（トリガー基準・画面下端なら上に出す）
  useLayoutEffect(() => {
    if (!open || !triggerRef.current) return
    const r = triggerRef.current.getBoundingClientRect()
    const popH = 320
    const below = window.innerHeight - r.bottom
    const top = below < popH && r.top > below ? Math.max(8, r.top - popH - 4) : r.bottom + 4
    setPos({ top, left: Math.min(r.left, window.innerWidth - 300) })
  }, [open])

  // 外側クリック / Escで閉じる
  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => {
      if (popRef.current?.contains(e.target as Node) || triggerRef.current?.contains(e.target as Node)) return
      setOpen(false)
    }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  function pickDay(d: moment.Moment) {
    const newDate = d.format('YYYY-MM-DD')
    onChange(`${newDate}T${time || '00:00'}`)
  }
  function pickTime(hh: number, mm: number) {
    const t = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
    const base = date || moment().format('YYYY-MM-DD')
    onChange(`${base}T${t}`)
    setOpen(false) // 時刻選択で確定して閉じる
  }
  function clear() { onChange(''); setOpen(false) }

  // カレンダーのマス目（前月の余白 + 当月日数）
  const firstDow = viewMonth.day()
  const daysInMonth = viewMonth.daysInMonth()
  const cells: (moment.Moment | null)[] = [
    ...Array(firstDow).fill(null),
    ...Array.from({ length: daysInMonth }, (_, i) => viewMonth.clone().date(i + 1)),
  ]
  const today = moment().format('YYYY-MM-DD')

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 rounded-md border border-input bg-background px-2 py-1 text-left text-xs shadow-sm transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50',
          className,
        )}
      >
        <Calendar className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <span className={cn('flex-1 truncate', !value && 'text-muted-foreground')}>
          {value ? `${moment(value).format('YYYY/MM/DD')} (${WEEKDAYS[moment(value).day()]}) ${moment(value).format('HH:mm')}` : '日時を選択'}
        </span>
        {value && !disabled && (
          <X
            className="h-3.5 w-3.5 shrink-0 text-muted-foreground hover:text-foreground"
            onClick={(e) => { e.stopPropagation(); clear() }}
          />
        )}
      </button>

      {open && pos && createPortal(
        <div
          ref={popRef}
          style={{ position: 'fixed', top: pos.top, left: pos.left, width: 288 }}
          className="z-[100] rounded-md border bg-popover p-2 text-popover-foreground shadow-lg"
        >
          <div className="flex gap-2">
            {/* カレンダー */}
            <div className="flex-1">
              <div className="mb-1 flex items-center justify-between">
                <button type="button" className="rounded p-1 hover:bg-accent" onClick={() => setViewMonth((m) => m.clone().subtract(1, 'month'))}>
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <span className="text-xs font-bold">{viewMonth.format('YYYY年 M月')}</span>
                <button type="button" className="rounded p-1 hover:bg-accent" onClick={() => setViewMonth((m) => m.clone().add(1, 'month'))}>
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
              <div className="grid grid-cols-7 gap-0.5 text-center">
                {WEEKDAYS.map((w, i) => (
                  <div key={w} className={cn('text-[10px] font-medium', i === 0 && 'text-red-500', i === 6 && 'text-blue-500')}>{w}</div>
                ))}
                {cells.map((c, i) => {
                  if (!c) return <div key={`e${i}`} />
                  const ds = c.format('YYYY-MM-DD')
                  const selected = ds === date
                  const isToday = ds === today
                  return (
                    <button
                      key={ds}
                      type="button"
                      onClick={() => pickDay(c)}
                      className={cn(
                        'aspect-square rounded text-[11px] hover:bg-accent',
                        selected && 'bg-primary text-primary-foreground hover:bg-primary',
                        !selected && isToday && 'ring-1 ring-primary/50',
                        !selected && c.day() === 0 && 'text-red-500',
                        !selected && c.day() === 6 && 'text-blue-500',
                      )}
                    >
                      {c.date()}
                    </button>
                  )
                })}
              </div>
            </div>

            {/* 時刻（15分刻み・スクロール） */}
            <div className="w-[68px] shrink-0 border-l pl-2">
              <div className="mb-1 text-center text-[10px] font-medium text-muted-foreground">時刻</div>
              <div className="max-h-[232px] space-y-0.5 overflow-y-auto pr-0.5">
                {Array.from({ length: 24 }, (_, hh) => hh).map((hh) =>
                  MINUTES.map((mm) => {
                    const t = `${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`
                    const selected = t === time
                    return (
                      <button
                        key={t}
                        type="button"
                        onClick={() => pickTime(hh, mm)}
                        className={cn(
                          'block w-full rounded px-1 py-0.5 text-center text-[11px] hover:bg-accent',
                          selected && 'bg-primary text-primary-foreground hover:bg-primary',
                        )}
                      >
                        {t}
                      </button>
                    )
                  }),
                )}
              </div>
            </div>
          </div>
          <div className="mt-1.5 flex justify-between border-t pt-1.5">
            <button type="button" className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent" onClick={clear}>クリア</button>
            <button type="button" className="rounded px-2 py-0.5 text-[11px] text-muted-foreground hover:bg-accent" onClick={() => setOpen(false)}>閉じる</button>
          </div>
        </div>,
        document.body,
      )}
    </>
  )
}
