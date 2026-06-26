import { Phone } from 'lucide-react'
import type { Case } from '@/lib/types'

interface Props {
  selectedCase: Case | null
}

/** スマホ用クリックコール（Dashboard のコールタブ内） */
export default function MobileCallPanel({ selectedCase }: Props) {
  if (!selectedCase) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        案件を選択してください
      </div>
    )
  }

  const phones = [selectedCase.phone1, selectedCase.phone2, selectedCase.phone3].filter(
    Boolean,
  ) as string[]

  return (
    <div className="flex h-full flex-col items-center gap-3 p-4">
      <div className="text-center">
        <div className="text-base font-bold">{selectedCase.name}</div>
        <div className="text-2xs text-muted-foreground">{selectedCase.address}</div>
      </div>
      <div className="flex w-full max-w-xs flex-col gap-2">
        {phones.length === 0 && (
          <div className="text-center text-xs text-muted-foreground">
            電話番号がありません
          </div>
        )}
        {phones.map((p, i) => (
          <a
            key={i}
            href={`tel:${p}`}
            className="flex items-center justify-center gap-2 rounded-lg bg-green-600 px-4 py-3 text-base font-bold text-white shadow active:bg-green-700"
          >
            <Phone className="h-5 w-5" />
            {p}
          </a>
        ))}
      </div>
    </div>
  )
}
