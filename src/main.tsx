import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { initTheme } from '@/lib/theme'

// 保存済みテーマ（ライト/ダーク）を描画前に適用
initTheme()

const rootEl = document.getElementById('root')

if (!rootEl) {
  document.body.innerHTML =
    '<div style="padding:24px;font-family:sans-serif">root 要素が見つかりません。index.html を確認してください。</div>'
} else {
  try {
    createRoot(rootEl).render(
      <StrictMode>
        <App />
      </StrictMode>,
    )
  } catch (e) {
    // 描画開始前のクラッシュでも白画面にしない
    rootEl.innerHTML = `<div style="padding:24px;font-family:sans-serif;color:#b91c1c">
      アプリの初期化に失敗しました。<br/><pre style="white-space:pre-wrap">${
        e instanceof Error ? e.message : String(e)
      }</pre></div>`
  }
}
