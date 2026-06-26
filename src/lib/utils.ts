import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/** 全角数字・記号を半角に変換し、電話番号として整形（数字・ハイフンのみ残す） */
export function normalizePhone(input: string): string {
  if (!input) return ''
  const halfWidth = input.replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0),
  )
  // ハイフン類を統一、それ以外の記号・空白を除去
  return halfWidth
    .replace(/[‐－―ー−]/g, '-')
    .replace(/[^0-9-]/g, '')
    .trim()
}

/** ハイフン等を除いた数字のみ（重複チェック・検索用） */
export function phoneDigits(input?: string | null): string {
  if (!input) return ''
  return normalizePhone(input).replace(/-/g, '')
}

/** 6文字の大文字英数字セッションキーを生成 */
export function generateSessionKey(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}
