import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'
import { SignupRequestApi } from '@/lib/api'
import { jpError } from '@/lib/utils'

export default function Login() {
  const { signIn } = useAuth()
  const navigate = useNavigate()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  // 新規登録申請モーダル
  const [reqOpen, setReqOpen] = useState(false)
  const [reqEmail, setReqEmail] = useState('')
  const [reqName, setReqName] = useState('')
  const [reqMemo, setReqMemo] = useState('')
  const [reqBusy, setReqBusy] = useState(false)
  const [reqError, setReqError] = useState('')
  const [reqDone, setReqDone] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      await signIn(email, password)
      navigate('/')
    } catch (err) {
      setError(jpError(err))
    } finally {
      setBusy(false)
    }
  }

  function openRequest() {
    setReqEmail(email)
    setReqName('')
    setReqMemo('')
    setReqError('')
    setReqDone(false)
    setReqOpen(true)
  }

  async function submitRequest() {
    setReqError('')
    setReqBusy(true)
    try {
      await SignupRequestApi.create({ email: reqEmail, display_name: reqName, memo: reqMemo })
      setReqDone(true)
    } catch (err) {
      setReqError(jpError(err))
    } finally {
      setReqBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-xs rounded-lg border bg-card p-6 shadow-sm">
        <div className="mb-5 text-center">
          <div className="text-xl font-bold text-primary">RST</div>
          <div className="text-2xs text-muted-foreground">新規開業店舗CRM</div>
        </div>

        {!isSupabaseConfigured && (
          <div className="mb-3 rounded-md bg-amber-50 p-2 text-2xs text-amber-800 dark:bg-amber-500/15 dark:text-amber-300">
            Supabase が未設定です。.env に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください。
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="email">メールアドレス</Label>
            <Input id="email" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoComplete="email" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">パスワード</Label>
            <Input id="password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="current-password" />
          </div>

          {error && <div className="text-2xs text-destructive">{error}</div>}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '処理中...' : 'ログイン'}
          </Button>
        </form>

        <Button type="button" variant="outline" className="mt-2 w-full" onClick={openRequest}>
          新規登録申請
        </Button>
        <p className="mt-2 text-center text-[10px] text-muted-foreground">
          アカウントは管理者が発行します。利用希望の方は「新規登録申請」から申請してください。
        </p>
      </div>

      {/* 新規登録申請モーダル */}
      <Dialog open={reqOpen} onOpenChange={(o) => !o && setReqOpen(false)}>
        <DialogContent className="max-w-xs">
          <DialogHeader>
            <DialogTitle>新規登録申請</DialogTitle>
          </DialogHeader>
          {reqDone ? (
            <div className="space-y-3">
              <div className="rounded-md bg-green-50 p-3 text-xs text-green-800 dark:bg-green-500/10 dark:text-green-300">
                申請を送信しました。管理者が確認後、ログイン情報を発行します。
              </div>
              <DialogFooter>
                <Button onClick={() => setReqOpen(false)}>閉じる</Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="space-y-2">
              <div className="space-y-1">
                <Label>メールアドレス</Label>
                <Input type="email" value={reqEmail} onChange={(e) => setReqEmail(e.target.value)} placeholder="you@example.com" />
              </div>
              <div className="space-y-1">
                <Label>希望表示名 / 氏名</Label>
                <Input value={reqName} onChange={(e) => setReqName(e.target.value)} placeholder="例: 織田春樹" />
              </div>
              <div className="space-y-1">
                <Label>メモ（任意）</Label>
                <Textarea value={reqMemo} onChange={(e) => setReqMemo(e.target.value)} rows={2} placeholder="所属・用途など" />
              </div>
              {reqError && <div className="text-2xs text-destructive">{reqError}</div>}
              <DialogFooter className="justify-between">
                <Button variant="outline" onClick={() => setReqOpen(false)}>キャンセル</Button>
                <Button onClick={submitRequest} disabled={reqBusy || !reqEmail.trim()}>
                  {reqBusy ? '送信中...' : '管理者へ送信'}
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}
