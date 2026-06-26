import { createClient } from '@supabase/supabase-js'

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL as string | undefined
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined

/** 環境変数が両方そろっているか */
export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey)

/**
 * 新規登録（サインアップ）を許可するか。
 * VITE_ALLOW_SIGNUP=false を設定すると、ログイン画面から新規登録導線を隠す。
 * 未設定時はデフォルト許可（true）。
 */
export const allowSignup =
  (import.meta.env.VITE_ALLOW_SIGNUP as string | undefined)?.toLowerCase() !== 'false'

if (!isSupabaseConfigured) {
  // 本番(Vercel)で env 未設定でも白画面で落ちないように警告のみ
  console.warn(
    '[RST] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY が未設定です。' +
      'Vercel の Environment Variables もしくはローカルの .env を確認してください。',
  )
}

/**
 * 重要:
 * createClient に空文字を渡すと `new URL('')` で例外が発生し、
 * モジュール読み込み時にアプリ全体がクラッシュ（白画面）する。
 * env 未設定時は有効な形式のプレースホルダを渡してクラッシュを回避し、
 * 実際のデータ操作は isSupabaseConfigured で各画面が制御する。
 */
const FALLBACK_URL = 'https://placeholder.supabase.co'
const FALLBACK_KEY = 'placeholder-anon-key'

export const supabase = createClient(
  supabaseUrl || FALLBACK_URL,
  supabaseAnonKey || FALLBACK_KEY,
  {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
    },
  },
)
