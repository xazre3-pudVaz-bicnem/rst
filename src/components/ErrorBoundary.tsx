import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
}
interface State {
  hasError: boolean
  message: string
}

/**
 * 画面描画中の JS エラーを捕捉し、白画面ではなくエラー内容を表示する。
 * （モジュール読込時のエラーは捕捉できないため、root側でも try/catch する）
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { hasError: false, message: '' }

  static getDerivedStateFromError(error: unknown): State {
    return {
      hasError: true,
      message: error instanceof Error ? error.message : String(error),
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('[ErrorBoundary]', error, info)
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex min-h-screen flex-col items-center justify-center gap-3 bg-background p-6 text-center">
          <div className="text-lg font-bold text-destructive">
            エラーが発生しました
          </div>
          <pre className="max-w-lg overflow-auto whitespace-pre-wrap rounded-md bg-muted p-3 text-2xs text-muted-foreground">
            {this.state.message}
          </pre>
          <button
            className="rounded-md bg-primary px-4 py-2 text-xs font-medium text-primary-foreground"
            onClick={() => window.location.reload()}
          >
            再読み込み
          </button>
        </div>
      )
    }
    return this.props.children
  }
}
