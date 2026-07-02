import { Input } from '@/components/ui/input'
import { cn } from '@/lib/utils'

/**
 * 日付(type=date) ＋ 時刻(type=time step=900) を並べた日時入力。
 * ネイティブの datetime-local は分ホイールに step を反映しないが、
 * type=time は step を尊重するため、時刻ドロップダウンが 00/15/30/45 の
 * 15分刻みになる。value / onChange は従来どおり "YYYY-MM-DDTHH:mm" 文字列。
 */
export interface DateTime15InputProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

/** "YYYY-MM-DDTHH:mm" → ["YYYY-MM-DD", "HH:mm"] */
function splitLocal(value: string): [string, string] {
  if (!value) return ['', '']
  const [date = '', time = ''] = value.split('T')
  return [date, time.slice(0, 5)]
}

/** 日付・時刻を "YYYY-MM-DDTHH:mm" に結合。日付が空なら空文字。 */
function combine(date: string, time: string): string {
  if (!date) return ''
  return `${date}T${time || '00:00'}`
}

export function DateTime15Input({ value, onChange, disabled, className }: DateTime15InputProps) {
  const [date, time] = splitLocal(value)
  return (
    <div className="flex gap-1.5">
      <Input
        type="date"
        value={date}
        disabled={disabled}
        onChange={(e) => onChange(combine(e.target.value, time))}
        className={cn('flex-1', className)}
      />
      <Input
        type="time"
        step={900}
        value={time}
        disabled={disabled}
        onChange={(e) => onChange(combine(date, e.target.value))}
        className={cn('w-[7.5rem] shrink-0', className)}
      />
    </div>
  )
}
