import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { CheckCircle2, XCircle, Info, X } from 'lucide-react'
import { cn } from '@/lib/utils'

type ToastType = 'success' | 'error' | 'info'

interface Toast {
  id: number
  type: ToastType
  message: string
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
  success: (message: string) => void
  error: (message: string) => void
  info: (message: string) => void
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined)

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const idRef = useRef(0)

  const remove = useCallback((id: number) => {
    setToasts((ts) => ts.filter((t) => t.id !== id))
  }, [])

  const toast = useCallback(
    (message: string, type: ToastType = 'info') => {
      const id = ++idRef.current
      setToasts((ts) => [...ts, { id, type, message }])
      const ttl = type === 'error' ? 6000 : 3500
      setTimeout(() => remove(id), ttl)
    },
    [remove],
  )

  // ここを毎レンダー新しいオブジェクトにすると useToast() の参照が変わり、
  // useCallback(load, [toast]) → useEffect(load) を持つ画面が
  // 「取得失敗→トースト表示→Provider再レンダー→参照変化→再取得→失敗…」の無限ループに入る
  // （労務の各画面でエラートーストが延々と積み上がっていた原因）。参照を固定する。
  const success = useCallback((m: string) => toast(m, 'success'), [toast])
  const error = useCallback((m: string) => toast(m, 'error'), [toast])
  const info = useCallback((m: string) => toast(m, 'info'), [toast])
  const value: ToastContextValue = useMemo(
    () => ({ toast, success, error, info }),
    [toast, success, error, info],
  )

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[100] flex w-[min(92vw,360px)] flex-col gap-2">
        {toasts.map((t) => (
          <div
            key={t.id}
            className={cn(
              'pointer-events-auto flex items-start gap-2 rounded-lg border px-3 py-2.5 text-sm shadow-lg',
              t.type === 'success' && 'border-green-200 bg-green-50 text-green-900 dark:border-green-500/30 dark:bg-green-500/15 dark:text-green-200',
              t.type === 'error' && 'border-red-200 bg-red-50 text-red-900 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200',
              t.type === 'info' && 'border-border bg-card text-card-foreground',
            )}
          >
            {t.type === 'success' && <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-green-600" />}
            {t.type === 'error' && <XCircle className="mt-0.5 h-4 w-4 shrink-0 text-red-600" />}
            {t.type === 'info' && <Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-500" />}
            <span className="flex-1 whitespace-pre-wrap break-words leading-snug">{t.message}</span>
            <button
              className="shrink-0 rounded p-0.5 text-current/60 hover:bg-black/5"
              onClick={() => remove(t.id)}
            >
              <X className="h-3.5 w-3.5" />
            </button>
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}

// eslint-disable-next-line react-refresh/only-export-components
export function useToast() {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
