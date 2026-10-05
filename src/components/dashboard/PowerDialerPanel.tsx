// ============================================================
// 自動ダイヤラー（パワーダイヤラー）
//   「繋がるまでは自動・話すのは人」。先に自分のケータイが鳴り、出たらそのまま待機。
//   その裏でリストへ1件ずつ発信し、相手が人として出た瞬間だけ自分に繋がる。
//   留守電・不在・話中は自動で次へ進み、コール履歴（非接触/不在）もこの画面が書く。
//   電話側の進行はサーバー(dialer_sessions)が持つため、画面を閉じても通話は続く。
// ============================================================
import { useCallback, useEffect, useRef, useState } from 'react'
import moment from 'moment'
import { Phone, PhoneOff, SkipForward, X, Loader2, Voicemail, ChevronDown, ChevronUp, Headphones, Mic, MicOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { DialerApi, TwilioApi, type DialerOutcome, type DialerSession } from '@/lib/aiCall'
import { CallLogApi } from '@/lib/api'
import { useToast } from '@/components/ui/toast'
import { useAuth } from '@/context/AuthContext'
import { jpError } from '@/lib/utils'
import type { Case } from '@/lib/types'

const LS_REP_PHONE = 'rst_dialer_rep_phone'
const LS_TEST_NUMBER = 'rst_dialer_test_number'
const LS_TEST_MODE = 'rst_dialer_test_mode'
const LS_AMD = 'rst_dialer_amd'
const LS_REP_MODE = 'rst_dialer_rep_mode'
/** 1回で仕込むリストの上限。これ以上は絞り込みを変えて掛け直す（キューは1行に持つため） */
const QUEUE_MAX = 1000

/** 自動で付いた結果 → コール履歴に書く内容。発信していないもの(skip/error)は履歴を作らない。 */
const AUTO_LOG: Record<string, { result: string; memo: string } | null> = {
  machine: { result: '不在', memo: '留守番電話（自動判定）' },
  noanswer: { result: '不在', memo: '呼び出し無応答（自動発信）' },
  busy: { result: '不在', memo: '話中（自動発信）' },
  skip: null,
  error: null,
}

const STATUS_STYLE: Record<string, string> = {
  待機中: 'bg-muted text-muted-foreground',
  接続中: 'bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-300',
  通話待機: 'bg-sky-100 text-sky-800 dark:bg-sky-500/20 dark:text-sky-300',
  発信中: 'bg-indigo-100 text-indigo-800 dark:bg-indigo-500/20 dark:text-indigo-300',
  通話中: 'bg-emerald-100 text-emerald-800 dark:bg-emerald-500/20 dark:text-emerald-300',
  結果待ち: 'bg-orange-100 text-orange-800 dark:bg-orange-500/20 dark:text-orange-300',
  停止: 'bg-slate-200 text-slate-600 dark:bg-slate-700 dark:text-slate-300',
}

interface Props {
  open: boolean
  onClose: () => void
  /** 発信するリスト（絞り込み後の案件一覧の順番でそのまま掛ける） */
  queue: Case[]
  /** 発信した案件を画面で選択状態にする（詳細・コール履歴を出すため） */
  onSelectCase: (id: string) => void
  /** コール結果の登録画面を開く */
  onRequestLog: (id: string) => void
  /** コール履歴が保存された回数。結果待ちのときに増えたら自動で次へ進む */
  logSavedSignal: number
  canWrite: boolean
}

export default function PowerDialerPanel({ open, onClose, queue, onSelectCase, onRequestLog, logSavedSignal, canWrite }: Props) {
  const toast = useToast()
  const { displayName } = useAuth()
  const [session, setSession] = useState<DialerSession | null>(null)
  const [busy, setBusy] = useState(false)
  const [minimized, setMinimized] = useState(false)
  // 開始に失敗した理由と対処法。Twilioのトライアル制限などはトーストだけだと読み切れないため画面に残す
  const [startError, setStartError] = useState<{ msg: string; guide?: string } | null>(null)
  const [history, setHistory] = useState<DialerOutcome[]>([])

  // 待機先。browser=パソコンのヘッドセット（通話料が携帯の約1/25） / phone=自分のケータイを呼ぶ
  const [repMode, setRepMode] = useState<'browser' | 'phone'>(() => (localStorage.getItem(LS_REP_MODE) as any) || 'browser')
  const [browserReady, setBrowserReady] = useState(false)   // Voice SDKが着信待ちになっているか
  const [muted, setMuted] = useState(false)
  const [browserVoice, setBrowserVoice] = useState<{ configured: boolean; missingEnv: string[] } | null>(null)
  const deviceRef = useRef<any>(null)
  const callRef = useRef<any>(null)

  const [repPhone, setRepPhone] = useState(() => localStorage.getItem(LS_REP_PHONE) || '')
  const [testMode, setTestMode] = useState(() => localStorage.getItem(LS_TEST_MODE) !== '0')
  const [testNumber, setTestNumber] = useState(() => localStorage.getItem(LS_TEST_NUMBER) || '')
  const [amdMode, setAmdMode] = useState<'sync' | 'async' | 'off'>(() => (localStorage.getItem(LS_AMD) as any) || 'sync')

  const active = !!session && session.status !== '停止'
  const drainingRef = useRef(false)
  const lastCaseRef = useRef<string | null>(null)
  const logSignalRef = useRef(logSavedSignal)

  // サーバー側でブラウザ通話の環境変数が揃っているか（揃っていなければケータイ待機だけ出す）
  useEffect(() => {
    if (!open || browserVoice) return
    TwilioApi.status().then((st: any) => {
      const bv = st?.browserVoice
      if (bv) {
        setBrowserVoice(bv)
        if (!bv.configured) setRepMode('phone')
      }
    }).catch(() => {})
  }, [open])

  /** ブラウザ（ヘッドセット）を着信待ちにする。サーバーが client:〜 宛に掛けてくるので先に用意する。 */
  const prepareBrowser = useCallback(async (): Promise<string | null> => {
    const t = await DialerApi.token()
    if (!t.ok || !t.token) return t.error || 'ブラウザ通話のトークンを取得できませんでした'
    try {
      // マイクの許可は先に取っておく（着信時に初めて聞かれると、その間に相手を待たせてしまう）
      await navigator.mediaDevices.getUserMedia({ audio: true }).then((st) => st.getTracks().forEach((x) => x.stop()))
    } catch {
      return 'マイクの使用が許可されていません。ブラウザのアドレスバーのマイク設定を許可にしてください。'
    }
    try {
      const { Device } = await import('@twilio/voice-sdk')
      deviceRef.current?.destroy?.()
      const dev = new Device(t.token, { codecPreferences: ['opus', 'pcmu'] as any, logLevel: 'error' })
      dev.on('incoming', (call: any) => {
        callRef.current = call
        call.on('disconnect', () => { callRef.current = null; setMuted(false) })
        call.accept()   // ダイヤラーからの着信だけなので自動で出る
      })
      dev.on('tokenWillExpire', async () => {
        const nt = await DialerApi.token()
        if (nt.ok && nt.token) dev.updateToken(nt.token)
      })
      dev.on('error', (e: any) => console.warn('[Dialer] Voice SDK', e?.message || e))
      dev.on('unregistered', () => setBrowserReady(false))
      await dev.register()
      deviceRef.current = dev
      setBrowserReady(true)
      return null
    } catch (e: any) {
      return e?.message ? String(e.message) : 'ブラウザ通話を準備できませんでした'
    }
  }, [])

  const teardownBrowser = useCallback(() => {
    try { callRef.current?.disconnect?.() } catch { /* 既に切れている */ }
    try { deviceRef.current?.destroy?.() } catch { /* 既に破棄済み */ }
    callRef.current = null
    deviceRef.current = null
    setBrowserReady(false)
    setMuted(false)
  }, [])

  // 画面を離れるときは必ず回線を片付ける（通話が残ると課金され続ける）
  useEffect(() => () => teardownBrowser(), [teardownBrowser])

  // ---- 自動で付いた結果をコール履歴に書き、書けたものだけサーバー側の待ち行列から外す ----
  const drain = useCallback(async (s: DialerSession) => {
    const pending = s.pending_outcomes || []
    if (!pending.length || drainingRef.current) return
    drainingRef.current = true
    const done: string[] = []
    try {
      for (const o of pending) {
        const spec = AUTO_LOG[o.kind]
        if (spec && o.caseId && canWrite) {
          try {
            await CallLogApi.create({
              case_id: o.caseId, case_name: o.caseName || '', call_at: o.at, contact_type: '非接触',
              result: spec.result, memo: spec.memo, sales_rep: displayName || null,
            })
          } catch (e) {
            console.warn('[Dialer] 自動結果の記録に失敗', e)
            continue   // 書けなかったものは残し、次の巡回で再挑戦する
          }
        }
        done.push(o.id)
      }
      setHistory((h) => [...pending.filter((o) => done.includes(o.id)), ...h].slice(0, 30))
      if (done.length) await DialerApi.ack(s.id, done)
    } finally {
      drainingRef.current = false
    }
  }, [canWrite, displayName])

  // ---- 進行状況の巡回取得（電話側はサーバーが進めるので、画面は見に行くだけ） ----
  const poll = useCallback(async (sessionId?: string | null) => {
    const r = await DialerApi.state(sessionId)
    if (!r.ok || !r.session) { if (!sessionId) setSession(null); return }
    setSession(r.session)
    if (r.session.status === '停止' && deviceRef.current) teardownBrowser()
    if (r.session.pending_outcomes?.length) drain(r.session).catch(() => {})
  }, [drain, teardownBrowser])

  useEffect(() => { if (open) poll(session?.id ?? null).catch(() => {}) }, [open])

  useEffect(() => {
    if (!open || !active || !session) return
    const t = setInterval(() => { poll(session.id).catch(() => {}) }, 2000)
    return () => clearInterval(t)
  }, [open, active, session?.id, poll])

  // 発信した案件を画面でも選択しておく（詳細・コール履歴がすぐ見えるように）
  useEffect(() => {
    const id = session?.current_case_id || null
    if (id && id !== lastCaseRef.current) { lastCaseRef.current = id; onSelectCase(id) }
    if (!id) lastCaseRef.current = null
  }, [session?.current_case_id])

  // 結果待ちの間にコール履歴が保存されたら、そのまま次の1件へ
  useEffect(() => {
    if (logSavedSignal === logSignalRef.current) return
    logSignalRef.current = logSavedSignal
    if (session && session.status === '結果待ち') handleNext()
  }, [logSavedSignal])

  async function handleStart() {
    const ids = queue.slice(0, QUEUE_MAX).map((c) => c.id)
    if (!ids.length) { toast.error('発信するリストが空です。絞り込みを確認してください。'); return }
    if (repMode === 'phone' && !repPhone.trim()) { toast.error('あなたのケータイ番号を入力してください。'); return }
    if (testMode && !testNumber.trim()) { toast.error('テストモードONです。確認用の番号を入力してください。'); return }
    // 待機に使う電話と確認用の発信先が同じだと、2本目が話中になってテストにならない
    const last10 = (v: string) => v.replace(/[^\d]/g, '').slice(-10)
    if (repMode === 'phone' && testMode && last10(repPhone) === last10(testNumber)) {
      toast.error('確認用の番号は、待機に使う電話とは別の番号にしてください（同じ番号だと2本目が話中になります）。')
      return
    }
    localStorage.setItem(LS_REP_PHONE, repPhone.trim())
    localStorage.setItem(LS_TEST_NUMBER, testNumber.trim())
    localStorage.setItem(LS_TEST_MODE, testMode ? '1' : '0')
    localStorage.setItem(LS_AMD, amdMode)
    localStorage.setItem(LS_REP_MODE, repMode)
    setBusy(true)
    setStartError(null)
    try {
      // ブラウザ待機は、着信待ちになってから発信させる（未登録だと「繋がらない」で終わる）
      if (repMode === 'browser') {
        const err = await prepareBrowser()
        if (err) { setStartError({ msg: err }); toast.error(err); return }
      }
      const r = await DialerApi.start({
        repMode, repPhone: repPhone.trim(), caseIds: ids, testMode, testNumber: testNumber.trim(),
        amdMode, autoNext: true, repName: displayName || '',
      })
      if (!r.ok) {
        teardownBrowser()
        setStartError({ msg: r.error || '開始できませんでした', guide: r.guidance || (Array.isArray(r.errors) ? r.errors.join(' / ') : '') })
        toast.error(r.error || '開始できませんでした')
        return
      }
      setHistory([])
      toast.success(repMode === 'browser'
        ? `ヘッドセットを繋ぎました。このままお待ちください（${ids.length}件）`
        : `あなたのケータイに発信しました。出たらそのままお待ちください（${ids.length}件）`)
      await poll(r.sessionId)
    } catch (e) {
      teardownBrowser()
      setStartError({ msg: jpError(e) })
      toast.error(jpError(e))
    } finally { setBusy(false) }
  }

  async function handleNext() {
    if (!session) return
    setBusy(true)
    try {
      const r = await DialerApi.next(session.id)
      if (!r.ok) toast.error(r.error || '次へ進めませんでした')
      else if (r.done) toast.info('リストの最後まで発信しました')
      await poll(session.id)
    } finally { setBusy(false) }
  }

  async function handleSkip() {
    if (!session) return
    setBusy(true)
    try {
      const r = await DialerApi.skip(session.id)
      if (!r.ok) toast.error(r.error || 'スキップできませんでした')
      await poll(session.id)
    } finally { setBusy(false) }
  }

  async function handleStop() {
    if (!session) return
    setBusy(true)
    try {
      await DialerApi.stop(session.id)
      teardownBrowser()
      await poll(session.id)
      toast.info('ダイヤラーを終了しました')
    } finally { setBusy(false) }
  }

  if (!open) return null

  const total = session ? (session.queue?.length || 0) : queue.length
  const doneCount = session ? Math.min(session.cursor || 0, total) : 0
  const stats = session?.stats || {}

  return (
    <div className="fixed bottom-3 right-3 z-50 w-[340px] max-w-[calc(100vw-1.5rem)] overflow-hidden rounded-xl border bg-card shadow-2xl">
      {/* ヘッダー */}
      <div className="flex items-center gap-2 border-b bg-primary/5 px-3 py-2">
        <Phone className="h-4 w-4 text-primary" />
        <span className="text-sm font-bold">自動ダイヤラー</span>
        {session && <span className={`rounded px-1.5 py-0.5 text-2xs font-bold ${STATUS_STYLE[session.status] || ''}`}>{session.status}</span>}
        <div className="ml-auto flex items-center gap-0.5">
          <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={() => setMinimized((m) => !m)} title={minimized ? '開く' : '畳む'}>
            {minimized ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}
          </button>
          <button className="rounded p-1 text-muted-foreground hover:bg-accent" onClick={onClose} title="閉じる（通話は続きます）">
            <X className="h-4 w-4" />
          </button>
        </div>
      </div>

      {!minimized && (
        <div className="max-h-[70vh] space-y-2.5 overflow-y-auto p-3">
          {!active ? (
            // ---- 開始前の設定 ----
            <>
              <div className="rounded-lg bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
                {repMode === 'browser'
                  ? <>このパソコンの<b className="text-foreground">ヘッドセット</b>が受話器になります。その裏でリストへ自動発信し、<b className="text-foreground">人が出た瞬間だけ</b>あなたに繋がります。</>
                  : <>まず<b className="text-foreground">あなたのケータイ</b>が鳴ります。出たらそのまま待機してください。その裏でリストへ自動発信し、<b className="text-foreground">人が出た瞬間だけ</b>あなたに繋がります。</>}
                {' '}留守電・不在・話中は自動で「不在」を記録して次へ進みます。
              </div>

              <div className="space-y-1">
                <Label>あなたの待機先</Label>
                <Select value={repMode} onValueChange={(v) => setRepMode(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="browser" disabled={browserVoice ? !browserVoice.configured : false}>
                      パソコン＋ヘッドセット（通話料が安い・推奨）
                    </SelectItem>
                    <SelectItem value="phone">自分のケータイを呼ぶ（待機中もずっと通話料）</SelectItem>
                  </SelectContent>
                </Select>
                {repMode === 'browser' && browserVoice && !browserVoice.configured && (
                  <div className="rounded border border-amber-300 bg-amber-50 p-1.5 text-2xs text-amber-800 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-300">
                    ブラウザ通話が未設定です。Vercelに {browserVoice.missingEnv.join('、')} を設定して再デプロイしてください。
                  </div>
                )}
                {repMode === 'browser' && (
                  <div className="text-2xs text-muted-foreground">ヘッドセット（またはPCのマイクとスピーカー）を繋いでから開始してください。マイクの許可を聞かれたら「許可」を押します。</div>
                )}
              </div>

              {repMode === 'phone' && (
                <div className="space-y-1">
                  <Label>あなたのケータイ番号</Label>
                  <Input value={repPhone} onChange={(e) => setRepPhone(e.target.value)} placeholder="090-1234-5678" inputMode="tel" />
                </div>
              )}

              <div className="space-y-1">
                <Label>留守電の判定</Label>
                <Select value={amdMode} onValueChange={(v) => setAmdMode(v as any)}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="sync">判定してから繋ぐ（留守電に繋がらない・2〜4秒の無音）</SelectItem>
                    <SelectItem value="async">すぐ繋いで後から判定（無音なし・留守電に一瞬繋がる）</SelectItem>
                    <SelectItem value="off">判定しない（留守電にも繋がる）</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <label className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 p-2 text-2xs dark:border-amber-500/40 dark:bg-amber-500/10">
                <input type="checkbox" className="mt-0.5" checked={testMode} onChange={(e) => setTestMode(e.target.checked)} />
                <span>
                  <b>テストモード</b>（お店には鳴らさず、下の確認用番号だけに発信します）
                  <Input className="mt-1" value={testNumber} onChange={(e) => setTestNumber(e.target.value)} placeholder="確認用の番号（待機用とは別の電話）" inputMode="tel" disabled={!testMode} />
                  {repMode === 'phone' && <span className="text-muted-foreground">※上の待機用とは別の電話にしてください（同じ番号だと話中になります）</span>}
                </span>
              </label>

              <div className="text-2xs text-muted-foreground">
                発信するリスト: <b className="text-foreground">{Math.min(queue.length, QUEUE_MAX)}件</b>（いま絞り込んでいる案件一覧の順番）
                {queue.length > QUEUE_MAX && <span className="text-amber-700 dark:text-amber-400">／{queue.length}件のうち先頭{QUEUE_MAX}件</span>}
                <br />電話番号なし・NG指定・対象外案件は自動で飛ばします。
              </div>

              <Button className="w-full" size="lg" onClick={handleStart} disabled={busy || !canWrite || !queue.length}>
                {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : repMode === 'browser' ? <Headphones className="h-4 w-4" /> : <Phone className="h-4 w-4" />}
                {repMode === 'browser' ? 'ヘッドセットで開始' : '自分のケータイを呼んで開始'}
              </Button>
              {startError && (
                <div className="space-y-1 rounded-lg border border-destructive/40 bg-destructive/10 p-2 text-2xs">
                  <div className="font-bold text-destructive">{startError.msg}</div>
                  {startError.guide && <div className="leading-relaxed text-foreground">{startError.guide}</div>}
                </div>
              )}
              {!startError && session?.last_note && <div className="text-2xs text-destructive">{session.last_note}</div>}
            </>
          ) : (
            // ---- 進行中 ----
            <>
              {session!.test_mode && (
                <div className="rounded bg-amber-100 px-2 py-1 text-2xs font-bold text-amber-800 dark:bg-amber-500/20 dark:text-amber-300">
                  テストモード中（お店には鳴っていません）
                </div>
              )}

              <div className="flex items-center justify-between text-2xs text-muted-foreground">
                <span>進捗 <b className="text-foreground">{doneCount}/{total}</b></span>
                <span>
                  繋がった {Number(stats.talked || 0)} / 留守電 {Number(stats.machine || 0)} / 不在 {Number(stats.noanswer || 0)}
                  {Number(stats.skipped || 0) > 0 && ` / 除外 ${Number(stats.skipped)}`}
                </span>
              </div>

              {/* いまの相手 */}
              <div className={`rounded-lg border p-2 ${session!.status === '通話中' ? 'border-emerald-400 bg-emerald-50 dark:bg-emerald-500/10' : session!.status === '結果待ち' ? 'border-orange-400 bg-orange-50 dark:bg-orange-500/10' : 'bg-muted/40'}`}>
                {session!.status === '接続中' ? (
                  <div className="flex items-center gap-2 text-sm">
                    <Loader2 className="h-4 w-4 animate-spin text-primary" />
                    {session!.rep_mode === 'browser' ? 'ヘッドセットに接続しています…' : 'あなたのケータイを呼び出しています…'}
                  </div>
                ) : session!.current_case_name || session!.current_case_id ? (
                  <>
                    <div className="truncate text-sm font-bold">{session!.current_case_name || '（案件名なし）'}</div>
                    <div className="text-2xs text-muted-foreground">{session!.current_phone || ''}</div>
                    <div className="mt-1 text-2xs">
                      {session!.status === '発信中' && '呼び出し中…（人が出たら繋がります）'}
                      {session!.status === '通話中' && <b className="text-emerald-700 dark:text-emerald-300">通話中 — どうぞお話しください</b>}
                      {session!.status === '結果待ち' && <b className="text-orange-700 dark:text-orange-300">通話が終わりました。結果を登録してください</b>}
                    </div>
                  </>
                ) : (
                  <div className="text-sm text-muted-foreground">待機中（次の発信を待っています）</div>
                )}
              </div>

              {(session!.status === '通話中' || session!.status === '結果待ち') && session!.current_case_id && (
                <Button className="w-full" onClick={() => onRequestLog(session!.current_case_id!)} disabled={!canWrite}>
                  コール結果を登録
                </Button>
              )}

              {session!.rep_mode === 'browser' && (
                <div className="flex items-center gap-2 rounded bg-muted/50 px-2 py-1 text-2xs">
                  <Headphones className={`h-3.5 w-3.5 ${browserReady ? 'text-emerald-600' : 'text-muted-foreground'}`} />
                  <span className={browserReady ? '' : 'text-destructive'}>{browserReady ? 'ヘッドセット接続中' : 'ヘッドセット未接続'}</span>
                  <Button
                    className="ml-auto h-6 px-2 text-2xs"
                    variant={muted ? 'destructive' : 'outline'}
                    size="sm"
                    onClick={() => { const m = !muted; callRef.current?.mute?.(m); setMuted(m) }}
                    disabled={!callRef.current}
                  >
                    {muted ? <MicOff className="h-3 w-3" /> : <Mic className="h-3 w-3" />}{muted ? 'ミュート中' : 'ミュート'}
                  </Button>
                </div>
              )}

              <div className="flex gap-1.5">
                <Button className="flex-1" variant="outline" size="sm" onClick={handleNext} disabled={busy || session!.status === '通話中'}>
                  <Phone className="h-3.5 w-3.5" />次へ
                </Button>
                <Button className="flex-1" variant="outline" size="sm" onClick={handleSkip} disabled={busy || session!.status === '通話中'}>
                  <SkipForward className="h-3.5 w-3.5" />スキップ
                </Button>
                <Button variant="destructive" size="sm" onClick={handleStop} disabled={busy}>
                  <PhoneOff className="h-3.5 w-3.5" />停止
                </Button>
              </div>

              {session!.last_note && <div className="text-2xs text-muted-foreground">{session!.last_note}</div>}

              <div className="rounded bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
                {session!.rep_mode === 'browser'
                  ? <>話し終わってもこの<b className="text-foreground">画面（タブ）は閉じないでください</b>。閉じるとダイヤラーごと終了します。</>
                  : <>話し終わっても<b className="text-foreground">自分の電話は切らないでください</b>。切るとダイヤラーごと終了します。</>}
                {' '}終わるときは「停止」を押してください。
              </div>

              {/* 自動で処理した分の記録 */}
              {history.length > 0 && (
                <div className="space-y-1 border-t pt-2">
                  <div className="text-2xs font-bold text-muted-foreground">自動で処理した分</div>
                  {history.slice(0, 8).map((o) => (
                    <div key={o.id} className="flex items-start gap-1.5 text-2xs">
                      <Voicemail className="mt-0.5 h-3 w-3 shrink-0 text-muted-foreground" />
                      <span className="truncate font-medium">{o.caseName || '（案件名なし）'}</span>
                      <span className="ml-auto shrink-0 text-muted-foreground">{o.note}</span>
                      <span className="shrink-0 text-muted-foreground">{moment(o.at).format('HH:mm')}</span>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}
