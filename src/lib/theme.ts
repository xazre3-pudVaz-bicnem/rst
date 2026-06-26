export type Theme = 'light' | 'dark'

const KEY = 'rst_theme'

export function getTheme(): Theme {
  try {
    return localStorage.getItem(KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(t: Theme): void {
  document.documentElement.classList.toggle('dark', t === 'dark')
  try {
    localStorage.setItem(KEY, t)
  } catch {
    /* noop */
  }
}

/** 起動時に保存済みテーマを適用（描画前に呼ぶ） */
export function initTheme(): void {
  applyTheme(getTheme())
}
