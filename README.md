# RST CRM — 新規開業店舗 営業リスト管理システム

Base44 で稼働していた営業CRM「RST」を、Base44 非依存の独立アプリとして
**React + Vite + TypeScript + Tailwind CSS + shadcn/ui + Supabase** で再構築したものです。

- entities → Supabase テーブル（`@/lib/api.ts`）
- integrations(InvokeLLM) → Supabase Edge Function `llm-search`（Anthropic API + Serper Web検索）
- auth → Supabase Auth（メール+パスワード）
- スマホ連動 → Supabase Realtime（`call_sessions`）

---

## 1. 画面・機能

| ルート | 画面 | 内容 |
|---|---|---|
| `/` | Dashboard | メインCRM。PCは3カラム、スマホはタブ切替。案件一覧／詳細／コール履歴／再コール予定／クリックコールを統合 |
| `/appointments` | 訪問予定 | 担当者×時間（0-23時）グリッドのアポタイムライン |
| `/analytics` | 分析 | 担当者別KPI（架電・接触・アポ・成約）の集計とグラフ |
| `/mobile-call` | スマホコール | PCで選んだ案件をRealtimeで受信しタップ発信 |
| `/login` | ログイン | Supabase Auth |

主な機能: 案件CRUD・CSV的な URL取込・ステータス/担当のインライン変更・コール履歴の自動サマリー・
再コール予定（緊急赤強調）・KPI・MAP/タウンページ/自動のLLM収集・スマホ連動クリックコール。

---

## 2. 必要環境

- Node.js 18 以上（推奨 20+）
- Supabase アカウント（無料枠で可）
- （任意）Anthropic API キー / Serper API キー … LLM収集機能を使う場合のみ

---

## 3. セットアップ手順（ローカル起動）

```bash
# 1. 依存インストール
npm install

# 2. 環境変数を用意
cp .env.example .env
#   .env を開いて VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY を設定

# 3. 開発サーバ起動
npm run dev
#   → http://localhost:5173
```

> `.env` 未設定でも起動はしますが、画面上部に「Supabase未設定」と表示され、
> データの読み書きはできません。まず次の Supabase 設定を行ってください。

---

## 4. Supabase 設定手順

### 4-1. プロジェクト作成
1. <https://supabase.com> でプロジェクトを作成
2. **Project Settings → API** から以下を控える
   - `Project URL` → `VITE_SUPABASE_URL`
   - `anon public` key → `VITE_SUPABASE_ANON_KEY`
3. `.env` に貼り付け

### 4-2. テーブル作成（スキーマ投入）
1. Supabase ダッシュボード左メニュー **SQL Editor** を開く
2. リポジトリ同梱の [`schema.sql`](./schema.sql) の中身を全文貼り付けて **Run**
   - `cases / appointments / recalls / call_logs / call_sessions` の5テーブル
   - `updated_date` 自動更新トリガー
   - インデックス
   - Realtime publication への追加（スマホ連動に必須）

### 4-3. 認証を有効化
1. **Authentication → Providers → Email** を有効化
2. 動作確認だけなら **Authentication → Settings** で
   「Confirm email」を一時的に OFF にすると確認メールなしでログインできます
3. 利用者は `/login` 画面の「新規登録」からアカウント作成、
   または **Authentication → Users → Add user** で手動追加

### 4-4. （任意）LLM収集機能 — Edge Function
MAP / TP / 自動 / URL取込 はWeb検索＋AI抽出を使います。使わない場合はスキップ可。

```bash
# Supabase CLI を導入後
supabase login
supabase link --project-ref <your-project-ref>

# シークレット登録（フロントには露出しません）
supabase secrets set ANTHROPIC_API_KEY=sk-ant-xxx
supabase secrets set SERPER_API_KEY=xxx

# デプロイ
supabase functions deploy llm-search
```

関数本体は [`supabase/functions/llm-search/index.ts`](./supabase/functions/llm-search/index.ts)。
未デプロイでもアプリは動作し、収集系ボタンは「0件」または静かにスキップされます。

---

## 5. Vercel 公開手順

### 5-1. GitHub に push
```bash
git init
git add .
git commit -m "init: RST CRM (Supabase版)"
git branch -M main
git remote add origin https://github.com/<you>/<repo>.git
git push -u origin main
```
`.env` は `.gitignore` 済みなので公開されません。

### 5-2. Vercel でインポート
1. <https://vercel.com> → **Add New → Project** → 当リポジトリを選択
2. Framework は自動で **Vite** を検出（`vercel.json` 同梱済み）
   - Build Command: `npm run build`
   - Output Directory: `dist`
3. **Environment Variables** に以下を追加
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. **Deploy**

SPAルーティングは `vercel.json` の rewrites で対応済み（リロードしても404になりません）。

---

## 6. 操作手順（使い方）

### ログイン
1. `/login` でメール・パスワードを入力（初回は「新規登録」）

### 案件管理（Dashboard `/`）
- **新規**: 案件を登録（案件名・住所・電話1が必須／電話は全角→半角自動変換／電話重複チェック）
- **案件行クリック**: 選択 → PCは中央に詳細、スマホは「詳細」タブへ
- **詳細の担当・ステータス**: その場で変更し「保存」
- **検索**: 案件名・住所・電話（ハイフン無視）・業種・担当・ステータスで絞り込み
- **取込**: URLを貼ると Web から情報抽出 → 選択して一括登録（要 Edge Function）
- **MAP / TP / 自動**: 関東の新規開業店舗をAIで収集（要 Edge Function、停止可）

### コール履歴
- 案件選択中に「登録」→ 接触/非接触・性別・年齢・結果などを選ぶと
  自動でサマリーが生成され、保存されます
- 結果「アポ」を選ぶとアポ日時欄が出て、保存時に **訪問予定** を自動作成し
  案件ステータスを「アポ」に更新
- 「開放」ボタンで担当を外し「新規」に戻す

### 再コール予定
- 「登録」で予定追加。10分前を過ぎると赤くなり、1日経過で自動的に非表示
- 鉛筆ボタンでその場で日時編集

### 訪問予定（`/appointments`）
- 日付を移動し、空セルをクリックでアポ登録、ブロックをクリックで編集
- 案件名クリックでその案件のダッシュボードへ

### 分析（`/analytics`）
- 今日／今週／今月／全期間で、担当者別の架電・接触・アポ・成約を集計

### スマホ連動（`/mobile-call`）
1. PC画面上部に表示される **6文字のセッションキー** を確認
2. スマホで `/mobile-call` を開きキーを入力して「接続」
3. PCで案件を選ぶたびにスマホへ反映 → 緑の電話ボタンをタップで発信

---

## 7. 技術スタック / 構成

```
React 19 + Vite + TypeScript
Tailwind CSS v3 + shadcn/ui（Radix UI）
react-router-dom / moment / recharts / lucide-react
@supabase/supabase-js（DB・Auth・Realtime）
Supabase Edge Function（Deno）: Anthropic Claude + Serper
```

```
src/
├─ lib/        supabaseClient / api(データ層) / llm / constants / types / utils / summary
├─ context/    AuthContext
├─ components/
│  ├─ ui/      shadcn primitives
│  ├─ layout/  TopBar / KpiBar
│  ├─ dashboard/ CaseList / CaseDetail / CallLogPanel / RecallList / MobileCallPanel / AutoSearchRunner
│  └─ modals/  CaseForm / Search / CallLogForm / RecallForm / Import / AutoSearchSettings
└─ pages/      Dashboard / Appointments / Analytics / MobileCall / Login
schema.sql                         Supabase スキーマ
supabase/functions/llm-search/     Edge Function
```

---

## 8. スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバ（http://localhost:5173） |
| `npm run build` | 型チェック＋本番ビルド（`dist/`） |
| `npm run preview` | ビルド結果をローカル確認 |

---

## 9. 補足

- 開発簡略化のため **RLS は無効** です。本番運用では Supabase で
  Row Level Security ポリシーの追加を推奨します。
- 担当者一覧・ステータス等は [`src/lib/constants.ts`](./src/lib/constants.ts) で変更できます。
- タウンページ検索の対象開始日は `TOWNPAGE_CUTOFF`（既定 `2026-06-18`）。
