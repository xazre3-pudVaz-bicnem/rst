import { isSupabaseConfigured } from '@/lib/supabaseClient'

/** env 未設定時に全画面共通で表示する警告バー */
export default function EnvWarning() {
  if (isSupabaseConfigured) return null
  return (
    <div className="w-full bg-amber-100 px-3 py-1.5 text-center text-2xs text-amber-900 dark:bg-amber-500/20 dark:text-amber-200">
      ⚠️ Supabase 環境変数が未設定です。
      <span className="font-mono"> VITE_SUPABASE_URL</span> /
      <span className="font-mono"> VITE_SUPABASE_ANON_KEY</span>{' '}
      を設定してください（Vercel: Project → Settings → Environment Variables）。
    </div>
  )
}
