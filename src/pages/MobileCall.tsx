import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import moment from 'moment'
import { Phone, Wifi, WifiOff, RefreshCw, Save } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { supabase, isSupabaseConfigured } from '@/lib/supabaseClient'
import { CallSessionApi, CallLogApi, RecallApi, CaseApi } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { LS_CALL_SESSION_KEY, CONTACT_RESULTS, NO_CONTACT_RESULTS, STATUSES } from '@/lib/constants'
import { jpError } from '@/lib/utils'
import type { CallSession } from '@/lib/types'

const NONE = '__none__'

export default function MobileCall() {
  const toast = useToast()
  const [searchParams] = useSearchParams()
  const [sessionKey, setSessionKey] = useState<string>(
    () => searchParams.get('key')?.toUpperCase() || localStorage.getItem(LS_CALL_SESSION_KEY) || '',
  )
  const [inputKey, setInputKey] = useState('')
  const [session, setSession] = useState<CallSession | null>(null)
  const [connected, setConnected] = useState(false)
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null)

  // フォーム
  const [contactType, setContactType] = useState<'接触' | '非接触'>('接触')
  const [result, setResult] = useState('')
  const [memo, setMemo] = useState('')
  const [recallAt, setRecallAt] = useState('')
  const [newStatus, setNewStatus] = useState('')
  const [busy, setBusy] = useState(false)

  // ?key= で自動接続したらローカルにも保存
  useEffect(() => {
    if (sessionKey) localStorage.setItem(LS_CALL_SESSION_KEY, sessionKey)
  }, [sessionKey])

  // 購読
  useEffect(() => {
    if (!sessionKey || !isSupabaseConfigured) return
    let cancelled = false
    CallSessionApi.getByKey(sessionKey)
      .then((s) => { if (!cancelled) setSession(s) })
      .catch((e) => console.warn('[MobileCall] fetch', e))

    const channel = supabase
      .channel(`call_sessions_${sessionKey}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'call_sessions', filter: `session_key=eq.${sessionKey}` },
        (payload) => {
          const next = payload.new as CallSession
          if (next && next.session_key === sessionKey) {
            setSession(next)
            setNewStatus('')
            setResult('')
            setMemo('')
            setRecallAt('')
          }
        },
      )
      .subscribe((status) => setConnected(status === 'SUBSCRIBED'))

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

  async function handleSave() {
    if (!session?.case_id || !session.case_name) {
      toast.error('案件が選択されていません')
      return
    }
    setBusy(true)
    try {
      const statusChanged = newStatus && newStatus !== (session.status ?? '')
      await CallLogApi.create({
        case_id: session.case_id,
        case_name: session.case_name,
        call_at: new Date().toISOString(),
        contact_type: contactType,
        result: result || null,
        memo: memo || null,
        summary: [contactType, result].filter(Boolean).join(' '),
        prev_status: statusChanged ? session.status ?? null : null,
        next_status: statusChanged ? newStatus : null,
        next_recall_at: recallAt ? moment(recallAt).toISOString() : null,
      })
      if (statusChanged) {
        await CaseApi.update(session.case_id, { status: newStatus })
      }
      if (recallAt) {
        await RecallApi.create({
          case_id: session.case_id,
          case_name: session.case_name,
          target_at: moment(recallAt).toISOString(),
        })
      }
      toast.success('通話結果を記録しました（PCに反映されます）')
      setResult(''); setMemo(''); setRecallAt(''); setNewStatus('')
    } catch (e) {
      toast.error('記録に失敗しました: ' + jpError(e))
    } finally {
      setBusy(false)
    }
  }

  // キー未入力 → 入力画面
  if (!sessionKey) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background px-4">
        <div className="w-full max-w-xs rounded-lg border bg-card p-6 shadow-sm">
          <div className="mb-4 text-center">
            <div className="text-xl font-bold text-primary">📞 RST コール</div>
            <div className="text-2xs text-muted-foreground">PCのセッションキーを入力 or QR読取</div>
          </div>
          {!isSupabaseConfigured && (
            <div className="mb-3 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
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
            <Button className="w-full" onClick={connect}>接続</Button>
          </div>
        </div>
      </div>
    )
  }

  const phones = session
    ? ([session.phone1, session.phone2, session.phone3].filter(Boolean) as string[])
    : []
  const results = contactType === '接触' ? CONTACT_RESULTS : NO_CONTACT_RESULTS

  return (
    <div className="flex min-h-screen flex-col bg-background">
      {/* ヘッダ */}
      <div className="flex items-center justify-between border-b bg-card px-3 py-2">
        <div className="flex items-center gap-1.5">
          {connected ? <Wifi className="h-4 w-4 text-green-600" /> : <WifiOff className="h-4 w-4 text-muted-foreground" />}
          <span className="text-2xs text-muted-foreground">
            {connected ? '接続中' : '未接続'} / キー: <span className="font-mono font-bold">{sessionKey}</span>
          </span>
        </div>
        <Button variant="ghost" size="sm" onClick={changeSession}>
          <RefreshCw className="h-3 w-3" />変更
        </Button>
      </div>

      {!session || !session.case_id ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-sm text-muted-foreground">
          PC側で案件を選択すると<br />ここに表示されます
        </div>
      ) : (
        <div className="flex-1 space-y-4 p-4">
          {/* 案件情報 */}
          <div className="text-center">
            <div className="text-xl font-bold">{session.case_name}</div>
            {session.address && <div className="text-2xs text-muted-foreground">{session.address}</div>}
            {session.status && (
              <div className="mt-1 inline-block rounded bg-primary/10 px-2 py-0.5 text-2xs text-primary">{session.status}</div>
            )}
          </div>

          {/* 電話をかける */}
          <div className="flex flex-col gap-2">
            {phones.length === 0 && <div className="text-center text-xs text-muted-foreground">電話番号がありません</div>}
            {phones.map((p, i) => (
              <a
                key={i}
                href={`tel:${p}`}
                className="flex items-center justify-center gap-2 rounded-xl bg-green-600 px-4 py-4 text-lg font-bold text-white shadow-lg active:bg-green-700"
              >
                <Phone className="h-5 w-5" />{p}
              </a>
            ))}
          </div>

          {/* 通話結果入力 */}
          <div className="space-y-3 rounded-xl border bg-card p-3">
            <div className="text-sm font-bold">通話結果を記録</div>
            <div className="flex gap-4">
              {(['接触', '非接触'] as const).map((t) => (
                <label key={t} className="flex items-center gap-1 text-sm">
                  <input type="radio" name="ct" checked={contactType === t} onChange={() => { setContactType(t); setResult('') }} />
                  {t}
                </label>
              ))}
            </div>
            <div className="space-y-1">
              <Label>結果</Label>
              <Select value={result || NONE} onValueChange={(v) => setResult(v === NONE ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="選択" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（なし）</SelectItem>
                  {results.map((r) => <SelectItem key={r} value={r}>{r}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>変更後ステータス</Label>
              <Select value={newStatus || NONE} onValueChange={(v) => setNewStatus(v === NONE ? '' : v)}>
                <SelectTrigger><SelectValue placeholder="変更なし" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>変更なし</SelectItem>
                  {STATUSES.map((s) => <SelectItem key={s} value={s}>{s}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1">
              <Label>メモ</Label>
              <Textarea value={memo} onChange={(e) => setMemo(e.target.value)} rows={2} />
            </div>
            <div className="space-y-1">
              <Label>再コール予定（任意）</Label>
              <Input type="datetime-local" step={900} value={recallAt} onChange={(e) => setRecallAt(e.target.value)} />
            </div>
            <Button className="w-full" onClick={handleSave} disabled={busy}>
              <Save className="h-4 w-4" />{busy ? '記録中...' : '記録する'}
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}
