import { Input } from '@/components/ui/input'

/**
 * 日時入力（ネイティブ datetime-local）。
 * 以前は独自ピッカー化を試みたが、操作性が悪く元のネイティブ入力に戻した。
 * value / onChange は "YYYY-MM-DDTHH:mm" 文字列。
 */
export interface DateTime15InputProps {
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  className?: string
}

export function DateTime15Input({ value, onChange, disabled, className }: DateTime15InputProps) {
  return (
    <Input
      type="datetime-local"
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
      className={className}
    />
  )
}
