import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { useAuth } from '@/context/AuthContext'
import { isSupabaseConfigured } from '@/lib/supabaseClient'

export default function Login() {
  const { signIn, signUp } = useAuth()
  const navigate = useNavigate()
  const [mode, setMode] = useState<'signin' | 'signup'>('signin')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setInfo('')
    setBusy(true)
    try {
      if (mode === 'signin') {
        await signIn(email, password)
        navigate('/')
      } else {
        await signUp(email, password)
        setInfo('登録しました。確認メールを確認のうえログインしてください。')
        setMode('signin')
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
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
          <div className="mb-3 rounded-md bg-amber-50 p-2 text-2xs text-amber-800">
            Supabase が未設定です。.env に VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定してください。
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-3">
          <div className="space-y-1">
            <Label htmlFor="email">メールアドレス</Label>
            <Input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor="password">パスワード</Label>
            <Input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete={mode === 'signin' ? 'current-password' : 'new-password'}
            />
          </div>

          {error && <div className="text-2xs text-destructive">{error}</div>}
          {info && <div className="text-2xs text-green-700">{info}</div>}

          <Button type="submit" className="w-full" disabled={busy}>
            {busy ? '処理中...' : mode === 'signin' ? 'ログイン' : '新規登録'}
          </Button>
        </form>

        <button
          type="button"
          className="mt-3 w-full text-center text-2xs text-muted-foreground hover:text-foreground"
          onClick={() => {
            setMode(mode === 'signin' ? 'signup' : 'signin')
            setError('')
            setInfo('')
          }}
        >
          {mode === 'signin'
            ? 'アカウントをお持ちでない方はこちら'
            : 'ログインに戻る'}
        </button>
      </div>
    </div>
  )
}
