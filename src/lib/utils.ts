import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * クリック/フォーカス対象が「Select/Popover/メニュー/日付ピッカー」などの
 * ポップアップ内かを判定。Dialog の外側クリック誤検知を防ぐための共通判定。
 */
export function isInteractiveOverlayTarget(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.closest !== 'function') return false
  return !!el.closest(
    '[data-radix-popper-content-wrapper],[data-radix-select-content],[data-radix-select-viewport],[data-radix-popover-content],[data-radix-menu-content],[data-radix-dropdown-menu-content],[role="listbox"],[role="menu"],.react-datepicker',
  )
}

/** Radix の onInteractOutside 等から実際のDOMターゲットを取り出す（detail.originalEvent 優先） */
export function realOutsideTarget(e: { detail?: { originalEvent?: Event }; target?: EventTarget | null }): EventTarget | null {
  return e?.detail?.originalEvent?.target ?? e?.target ?? null
}

/**
 * datetime-local の値（YYYY-MM-DDTHH:mm）を最も近い15分単位に丸めて返す。
 * 空文字はそのまま返す。既存の13:07などが渡っても安全に丸める。
 */
export function roundTo15(local: string): string {
  if (!local) return local
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(local)
  if (!m) return local
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), 0, 0)
  if (Number.isNaN(d.getTime())) return local
  d.setMinutes(Math.round(d.getMinutes() / 15) * 15, 0, 0)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
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

/** 住所の正規化（重複チェック用。空白・記号を除去） */
export function normalizeAddress(input?: string | null): string {
  if (!input) return ''
  return input.replace(/\s+/g, '').replace(/[‐－―ー−-]/g, '').trim()
}

/** 6文字の大文字英数字セッションキーを生成 */
export function generateSessionKey(): string {
  return Math.random().toString(36).substring(2, 8).toUpperCase()
}

/** GoogleマップURLを住所（または店名）から生成 */
export function mapUrl(address?: string | null, name?: string | null): string {
  const q = [name, address].filter(Boolean).join(' ').trim() || (address ?? '')
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(q)}`
}

/** Google検索URL（店名＋住所など） */
export function googleSearchUrl(...terms: (string | null | undefined)[]): string {
  const q = terms.filter(Boolean).join(' ').trim()
  return `https://www.google.com/search?q=${encodeURIComponent(q)}`
}

/** URLを正規化（http補完・前後空白除去） */
export function normalizeUrl(input?: string | null): string {
  if (!input) return ''
  const t = input.trim()
  if (!t) return ''
  if (/^https?:\/\//i.test(t)) return t
  return `https://${t}`
}

/** クリップボードへコピー（成功可否を返す。非ブラウザ/未対応環境でも安全） */
export async function copyToClipboard(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text)
      return true
    }
    // フォールバック（clipboard API 非対応の古い環境）
    if (typeof document !== 'undefined') {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.focus()
      ta.select()
      let ok = false
      try {
        ok = document.execCommand('copy')
      } catch {
        ok = false
      }
      document.body.removeChild(ta)
      return ok
    }
    return false
  } catch {
    return false
  }
}

/** 1セルをCSV用にエスケープ */
function csvCell(v: unknown): string {
  const s = v == null ? '' : String(v)
  if (/[",\r\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"'
  return s
}

/** 行列データをCSV文字列に（先頭BOM付きでExcelの文字化け防止） */
export function toCsv(headers: string[], rows: (string | number | null | undefined)[][]): string {
  const head = headers.map(csvCell).join(',')
  const body = rows.map((r) => r.map(csvCell).join(',')).join('\r\n')
  return '﻿' + head + '\r\n' + body
}

/** CSV文字列をダウンロード（ブラウザ環境でのみ動作） */
export function downloadCsv(filename: string, csv: string): void {
  if (typeof document === 'undefined' || typeof URL === 'undefined') return
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * ファイルをテキストとして読み込む。UTF-8 を基本としつつ、
 * 文字化け（U+FFFD が多発）した場合は Shift-JIS で再デコードする。
 */
export async function readCsvFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  const utf8 = new TextDecoder('utf-8').decode(buf)
  // 置換文字が一定割合を超えたら Shift-JIS とみなす
  const replacements = (utf8.match(/�/g) || []).length
  if (replacements > 0 && replacements > utf8.length * 0.001) {
    try {
      return new TextDecoder('shift-jis').decode(buf)
    } catch {
      return utf8
    }
  }
  return utf8
}

/**
 * CSV 文字列を二次元配列にパースする。
 * - ダブルクオート囲み、フィールド内のカンマ・改行・"" エスケープに対応
 * - 先頭の BOM を除去
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  // BOM 除去
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1)

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        field += ch
      }
      continue
    }
    if (ch === '"') {
      inQuotes = true
    } else if (ch === ',') {
      row.push(field)
      field = ''
    } else if (ch === '\r') {
      // 無視（\r\n を 1 改行として扱う）
    } else if (ch === '\n') {
      row.push(field)
      rows.push(row)
      row = []
      field = ''
    } else {
      field += ch
    }
  }
  // 末尾フィールド
  if (field.length > 0 || row.length > 0) {
    row.push(field)
    rows.push(row)
  }
  // 完全な空行を除去
  return rows.filter((r) => r.some((c) => c.trim() !== ''))
}

/** Supabase / 認証エラーメッセージを日本語化 */
export function jpError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? '')
  const m = msg.toLowerCase()
  if (m.includes('invalid login credentials'))
    return 'メールアドレスまたはパスワードが正しくありません。'
  if (m.includes('email not confirmed'))
    return 'メールアドレスが未確認です。確認メールのリンクをクリックしてください。'
  if (m.includes('user already registered') || m.includes('already been registered'))
    return 'このメールアドレスは既に登録されています。'
  if (m.includes('password should be at least'))
    return 'パスワードは6文字以上で設定してください。'
  if (m.includes('signups not allowed') || m.includes('signup is disabled'))
    return '新規登録は現在停止されています。管理者にお問い合わせください。'
  if (m.includes('rate limit') || m.includes('too many requests'))
    return 'リクエストが多すぎます。しばらく待ってから再度お試しください。'
  if (m.includes('network') || m.includes('failed to fetch'))
    return '通信に失敗しました。ネットワーク接続を確認してください。'
  if (m.includes('jwt') || m.includes('not authenticated'))
    return '認証の有効期限が切れました。再度ログインしてください。'
  return msg || '不明なエラーが発生しました。'
}
