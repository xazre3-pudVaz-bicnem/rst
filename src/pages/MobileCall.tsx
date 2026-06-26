import { useEffect, useRef, useState } from 'react'
import { Phone, Wifi, WifiOff, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import { CallSessionApi } from '@/lib/api'
import { LS_CALL_SESSION_KEY } from '@/lib/constants'
import type { CallSession } from '@/lib/types'

export default function MobileCall() {
  const [sessionKey, setSessionKey] = useState<string>(
    () => localStorage.getItem(LS_CALL_SESSION_KEY) ?? '',
  )
  const [inputKey, setInputKey] = useState('')
  const [session, setSession] = useState<CallSession | null>(null)
  const [connected, setConnected] = useState(false)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // 購読
  useEffect(() => {
    if (!sessionKey || !isSupabaseConfigured) return

    let cancelled = false

    // 初回取得
    CallSessionApi.getByKey(sessionKey)
      .then((s) => {
        if (!cancelled) setSession(s)
      })
      .catch((e) => console.warn('[MobileCall] fetch', e))

    // Realtime購読
    const channel = supabase
      .channel(`call_sessions_${sessionKey}`)
      .on(
        'postgres_changes',
        {
          event: '*',
          schema: 'public',
          table: 'call_sessions',
          filter: `session_key=eq.${sessionKey}`,
        },
        (payload) => {
          const next = payload.new as CallSession
          if (next && next.session_key === sessionKey) setSession(next)
        },
      )
      .subscribe((status) => {
        setConnected(status === 'SUBSCRIBED')
      })

    channelRef.current = channel

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
      setConnected(false)
    }
  }, [sessionKey])

  function connect() {
    const key = inputKey.trim().toUpperCase()
    if (!key) return
    localStorage.setItem(LS_CALL_SESSION_KEY, key)
    setSessionKey(key)
  }

  function changeSession() {
    setSessionKey('')
    setSession(null)
    setInputKey('')
    localStorage.removeItem(LS_CALL_SESSION_KEY)
  }

  // キー未入力 → 入力画面
  if (!sessionKey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-xs rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-4 text-center">
            <div className="text-xl font-bold text-primary">📞 RST コール</div>
            <div className="text-2xs text-muted-foreground">
              PCに表示されたセッションキーを入力
            </div>
          </div>
          {!isSupabaseConfigured && (
            <div className="mb-3 rounded-md bg-amber-50 p-2 text-2xs text-amber-800">
              Supabase が未設定です。.env を設定してください。
            </div>
          )}
          <div className="space-y-2">
            <Label>セッションキー（6文字）</Label>
            <Input
              value={inputKey}
              onChange={(e) => setInputKey(e.target.value.toUpperCase())}
              maxLength={6}
              placeholder="ABC123"
              className="text-center text-base font-mono tracking-widest"
            />
            <Button className="w-full" onClick={connect}>
              接続
            </Button>
          </div>
        </div>
      </div>
    )
  }

  const phones = session
    ? ([session.phone1, session.phone2, session.phone3].filter(Boolean) as string[])
    : []

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ヘッダ */}
      <div className="flex items-center justify-between border-b bg-card px-3 py-2">
        <div className="flex items-center gap-1.5">
          {connected ? (
            <Wifi className="h-4 w-4 text-green-600" />
          ) : (
            <WifiOff className="h-4 w-4 text-muted-foreground" />
          )}
          <span className="text-2xs text-muted-foreground">
            {connected ? '接続中' : '未接続'} / キー:{' '}
            <span className="font-mono font-bold">{sessionKey}</span>
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={changeSession}>
          <RefreshCw className="h-3 w-3" />
          変更
        </Button>
      </div>

      {/* 本体 */}
      <div className="flex flex-1 flex-col items-center justify-center gap-4 p-4">
        {!session || !session.case_id ? (
          <div className="text-center text-sm text-muted-foreground">
            PC側で案件を選択すると
            <br />
            ここに表示されます
          </div>
        ) : (
          <>
            <div className="text-center">
              <div className="text-xl font-bold">{session.case_name}</div>
            </div>
            <div className="flex w-full max-w-xs flex-col gap-3">
              {phones.length === 0 && (
                <div className="text-center text-xs text-muted-foreground">
                  電話番号がありません
                </div>
              )}
              {phones.map((p, i) => (
                <a
                  key={i}
                  href={`tel:${p}`}
                  className="flex items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-5 text-xl font-bold text-white shadow-lg active:bg-green-700"
                >
                  <Phone className="h-6 w-6" />
                  {p}
                </a>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
