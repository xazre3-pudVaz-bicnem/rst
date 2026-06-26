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
| `/home` | ホーム | 営業ダッシュボード。今日やる件数・期限切れ・未架電・本日架電/アポ、次に架電すべき案件、自分の担当、最近更新、注意案件、通知 |
| `/` | 案件（CRM） | メインCRM。PCは3カラム、スマホはタブ切替。案件一覧／詳細／コール履歴／再コール予定／クリックコールを統合 |
| `/appointments` | 訪問予定 | 担当者×時間（0-23時）グリッドのアポタイムライン |
| `/analytics` | 分析 | KPI（架電・アポ率・資料送付・見込み・失注・再コール・担当者/業種/エリア別）の集計とグラフ |
| `/users` | ユーザー管理 | 担当者名・ロール（管理者/営業/閲覧）の設定 |
| `/audit` | 監査ログ | 重要操作の履歴をリアルタイム表示（管理者ナビに表示） |
| `/mobile-call` | スマホコール | PCで選んだ案件をRealtimeで受信しタップ発信＋結果登録 |
| `/login` | ログイン | Supabase Auth |

### Phase 2（実運用強化）で追加した機能
- **ホーム営業ダッシュボード**（`/home`）＋ アプリ内通知/リマインド
- **タグ・優先度**（高/中/低）を案件に付与し、一覧・詳細で表示
- **一括操作**（複数選択 → ステータス/担当/優先度/タグ/再コールの一括変更・一括削除・CSV出力。確認ダイアログ付き）
- **CSVエクスポート**（表示中の検索結果 or 選択案件、BOM付きでExcel文字化け回避）
- **CSV取込の Shift-JIS / UTF-8 自動判定**
- **通話メモ定型文**（追加/編集/削除、ステータス連動、ワンクリック挿入。初回は既定文を自動投入）
- **案件詳細の強化**（電話/住所/URLのコピー、Google検索・ビジネスPF・地図リンク、作成日/更新日、データ品質警告）
- **再コール「完了済み」表示**＋完了時に `call_logs` へ履歴記録
- **監査ログ**（`audit_logs`：作成/編集/削除/ステータス変更/取込/一括/再コール完了）
- **ユーザー管理**（`/users`：担当者名・ロール）＋「自分の担当」クイックフィルター
- **キーボードショートカット**: `j`/`k` 次/前の案件、`/` 検索フォーカス、`n` 新規案件、`c` 通話履歴、`r` 再コール

### Phase 3（高速化・権限・監査）で追加した機能
- **ルート単位のコード分割**（`React.lazy`/`Suspense`）。初期JSを単一1.18MB → 約490KBへ分割し、各画面は遷移時にロード
- **サーバーサイドページング**（`CaseApi.listAll` 等が `range` で全件取得。Supabaseの1リクエスト1000行上限を超える案件も取得可能に）
- **案件一覧の仮想スクロール**（`react-window` v2）。数千件でも描画が軽量
- **ロール権限**（admin / member / viewer）。`viewer` は**閲覧専用**（UIで追加/編集/削除/取込/一括を無効化＋RLSでも強制）
- **段階的・本番RLS**: `migrations/2026-06-26_rls_roles.sql`（ロール権限＋組織分離の完成形ポリシー、ロールバック手順付き）
- **監査ログ画面**（`/audit`、管理者ナビ）＋ **Realtime** で新規ログを即時追記
- **通知ベル**（ヘッダー）: 期限切れ/今日の再コール件数をバッジ表示、Realtimeで自動更新、クリックで該当案件へ

### Phase 4（時短・操作性の便利機能）で追加した機能
- **コマンドパレット**（`Ctrl`/`⌘` + `K`）: 店舗名・電話・住所をサーバー検索して即ジャンプ、画面移動もここから
- **ショートカット一覧**（`?` キー）でいつでもヘルプ表示
- **ワンタップ結果記録**: 案件詳細から `不在 / 受付NG / 担当者不在 / 資料送付 / 折返し待ち / アポ獲得` を1クリックで状態変更＋履歴記録
- **案件ナビ**: 詳細ヘッダーに「前/次」＋「**次の未架電へ**」ボタン（パワーコール向け）
- **再コールのスヌーズ**: `+1h / 明日朝9時 / +3日` のワンクリック延期
- **保存ビュー**: よく使う検索条件（クイックフィルタ＋キーワード＋詳細検索）に名前を付けて保存・即適用
- **ダークモード**: ヘッダーの🌙/☀️で切替、`localStorage` に保存
- **本日の架電目標＆進捗バー**（ホーム、目標は±5件で調整・保存）
- **デスクトップ通知**（任意オプトイン）: 期限切れ/今日の再コールをブラウザ通知

### Phase 5（デザイン・操作性の仕上げ）で追加した機能
- **確認ダイアログの刷新**: ブラウザ標準の `confirm()` を全廃し、アプリ内の統一スタイル確認ダイアログ（危険操作は赤）に置換
- **ダークモードの作り込み**: ステータス/優先度の配色・各パネル・トースト・通知・スクロールバー・日付ピッカー（`color-scheme`）までダーク対応
- **案件一覧の並び替え**: 新着順 / 店舗名 / 最終架電が古い・新しい順 / 次回再コールが近い順 / 優先度が高い順（選択は保存）
- **ローディングのスケルトン表示**: ホーム/分析/ユーザー/監査/案件の初回読み込みをスケルトン化（空状態のチラつきも防止）
- **細部のブラッシュアップ**: ヘッダーの軽い影、セッションキーのピル表示、スムーズスクロール、フォーカスリングなど

### Phase 6（リアルタイム詳細KPI）で追加した機能
- **リアルタイムKPIダッシュボード**（`/analytics`＝「KPI」）: call_logs/appointments/cases/recalls を Realtime購読し自動更新（「更新中」インジケータ付き）
- **担当者ごとの詳細集計**: 全員 or 担当者を選んでドリルダウン
- **コール数ペース**: 直近1時間 / 本日 / 今週 / 今月 / 今年 のコール数を常時表示
- **コールファネル**: コール → 接続 → 代表接触 → アポ → 行動転換 と各段階の転換率
- **主要KPIカード**: リスト作成・コール数・接続数(率)・代表接触(率)・アポ数(率)・行動転換(率)・代表接触→アポ（有効商談率）
- **時間帯別コール**（本日・0〜23時）と **日別コール推移**（最大60日）のグラフ
- **担当者別 詳細テーブル**: リスト作成/コール/接続/接続率/代表接触/接触率/アポ/アポ率/行動転換/転換率
- **業種別・エリア別アポ率**、案件サマリ（保有/資料送付/見込み/失注/再コール残/期限切れ）
- 集計定義: 「コール数」＝実架電のみ（ステータス変更/再コール完了/通話メモは除外）、「接続」＝不在以外で応答、「代表接触」＝接触、「行動転換」＝アポ後に成約/契約に至った件数。ワンタップ結果（不在/受付NG等）も実コールとして算入されます。

主な機能:
- 初回ログイン時の**空状態ガイド**（CSV取込／案件追加／サンプルデータ追加）
- **CSV取込**（ファイル選択＋列マッピング＋重複チェック＋スキップ/上書き/別案件追加＋取込結果サマリー＋取込履歴 `import_batches`）
- 案件CRUD・URLからのAI取込
- **標準ステータス11種**（未架電／不在／受付NG／担当者不在／資料送付／折返し待ち／アポ獲得／見込み／失注／再コール／契約済み）と**変更履歴の自動記録**（`call_logs` に変更前/後・日時・担当を保存）
- 案件詳細（業種・電話・住所・公式サイト・GoogleマップURL・最終架電日・次回再コール・担当・メモ・通話メモ即時記録・地図で開く）
- コール履歴（日時／担当／結果／メモ／変更前後ステータス／次回再コール）
- 再コール予定を**今日／期限切れ（赤）／明日以降**に分割表示・完了/編集
- インスタント検索＋クイックフィルター（今日架電・未架電・期限切れ・アポ獲得・資料送付・見込み・失注以外）＋詳細検索
- **KPI/分析**（本日/今週/今月架電・アポ率・資料送付・見込み・失注・再コール残/期限切れ・担当者別・業種別/エリア別アポ率）
- **スマホ連動**（QRコード＋セッションキー、スマホから通話結果/メモ/再コールを登録→PCへRealtime即時反映）
- MAP/タウンページ/自動のLLM収集
- 成功/失敗の**トースト通知**・ログインエラーの日本語表示・接続エラー時も白画面にしない

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
   - 業務テーブル: `cases / appointments / recalls / call_logs / call_sessions / import_batches / templates / audit_logs`
   - マルチテナント用: `organizations / profiles`（各テーブルに `organization_id` を保持）
   - `cases` に `tags TEXT[]` / `priority`、`templates` に `status` / `sort_order`
   - `updated_date` 自動更新トリガー／新規ユーザー作成時の `profiles` 自動生成
   - インデックス・Realtime publication への追加（スマホ連動に必須）
   - **RLSポリシー案**（末尾にコメントで同梱。本番運用時に有効化）
   - すべて再実行安全（`IF NOT EXISTS` / 例外無視）。既存データを壊さず追加列のみ反映されます

   **すでに旧スキーマを適用済みの場合**は、差分のみのマイグレーションでもOK（結果は同じ）:
   - [`migrations/2026-06-26_phase2.sql`](./migrations/2026-06-26_phase2.sql) … タグ/優先度/監査ログ等の追加
   - [`migrations/2026-06-26_rls_optional.sql`](./migrations/2026-06-26_rls_optional.sql) … 緩い段階的RLS（任意・「ログイン済みなら全操作可」。まず塞ぎたい時）
   - [`migrations/2026-06-26_rls_roles.sql`](./migrations/2026-06-26_rls_roles.sql) … **本番向け厳格RLS**（ロール権限 viewer=読取専用 ＋ 組織分離）。適用前チェックリストに従ってください

### 4-3. 認証を有効化 / 初回ユーザー作成
1. **Authentication → Providers → Email** を有効化
2. 動作確認だけなら **Authentication → Settings** で
   「Confirm email」を一時的に OFF にすると確認メールなしでログインできます
3. **初回ユーザーの作り方（推奨）**: **Authentication → Users → Add user** で
   メール・パスワードを指定して手動作成（`profiles` は自動生成されます）
4. もしくは `VITE_ALLOW_SIGNUP=true`（既定）のときは `/login` の「新規登録」から作成可能
5. **本番運用では `VITE_ALLOW_SIGNUP=false` を推奨**。新規登録導線が非表示になり、
   ユーザーは管理者が上記4の手動追加でのみ発行します（誰でも登録できる状態を防止）

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
   - `VITE_ALLOW_SIGNUP`（本番は `false` 推奨）
4. **Deploy**

> 環境変数が未設定でも**白画面にはならず**、画面上部に設定を促す警告が表示されます。

SPAルーティングは `vercel.json` の rewrites で対応済み（リロードしても404になりません）。

---

## 6. 操作手順（使い方）

### ログイン
1. `/login` でメール・パスワードを入力（初回は「新規登録」）

### はじめて開いたとき（案件0件）
中央に空状態ガイドが表示されます。**CSVを取り込む / 新規案件を登録する / サンプルデータを追加する** から開始します。

### 案件管理（Dashboard `/`）
- **案件追加**: 案件を登録（店舗名・住所・電話1が必須／電話は全角→半角自動変換／電話重複チェック）
- **CSV取込**: CSVファイル選択 → 列マッピング（自動推定）→ 重複チェック → 重複時の動作（スキップ/上書き/別案件追加）→ 取込。完了後に「追加/重複/エラー件数」を表示し、`import_batches` に履歴を保存
- **インスタント検索 / クイックフィルター**: 一覧上部で店舗名・電話・住所を即時絞り込み、ワンタップで「今日架電・未架電・期限切れ再コール・アポ獲得・資料送付済み・見込み・失注以外」
- **詳細検索**: 店舗名・住所・電話・業種・担当・ステータス・最終架電日・再コール有無・未架電のみ・期限切れのみ
- **案件詳細**: 担当・ステータスをその場で変更し「保存」（ステータス変更は履歴を自動記録）。「通話履歴を登録」「再コール予定」「地図で開く」、通話メモの即時記録が可能
- **自動検索 / 地図検索 / 新規店検索**: 関東の新規開業店舗をAIで収集（要 Edge Function、停止可）。URL取込タブ（CSV取込モーダル内）でURLからAI抽出も可能

### コール履歴
- 案件選択中に「登録」→ 接触/非接触・結果・**変更後ステータス**・担当・再コールを選ぶと保存され、
  右カラムに日時／担当／結果／メモ／変更前後ステータス／次回再コールが表示されます
- 結果「アポ」を選ぶとアポ日時欄が出て、保存時に **訪問予定** を自動作成し案件を「アポ獲得」に更新
- 「開放」ボタンで担当を外し「未架電」に戻す

### 再コール予定
- 「登録」で予定追加。**今日／期限切れ（赤）／明日以降**に分かれて表示
- 完了ボタンで `done` 化（一覧から消える）、鉛筆ボタンでその場で日時編集

### 訪問予定（`/appointments`）
- 日付を移動し、空セルをクリックでアポ登録、ブロックをクリックで編集
- 案件名クリックでその案件のダッシュボードへ

### 分析（`/analytics`）
- 本日/今週/今月の架電数、再コール残・期限切れ、期間別のアポ率・資料送付・見込み・失注、
  担当者別実績（グラフ＋表）、業種別・エリア別アポ率を集計

### スマホ連動（`/mobile-call`）
1. PC画面上部に **6文字のセッションキー** と **QRコード** が表示されます
2. スマホでQRを読み取る（`?key=` で自動接続）か、`/mobile-call` でキーを入力して「接続」
3. PCで案件を選ぶたびにスマホへ反映 → 電話ボタンで発信
4. スマホで**通話結果・メモ・変更後ステータス・再コール予定**を登録すると、
   Realtime で **PC側に即時反映**されます

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
├─ lib/        supabaseClient / api(データ層) / llm / constants / types / utils / summary / theme
├─ context/    AuthContext
├─ components/
│  ├─ ui/      shadcn primitives + toast（トースト通知）
│  ├─ CommandPalette（⌘K / ? グローバル）
│  ├─ layout/  TopBar / KpiBar / NotificationBell / ThemeToggle
│  ├─ dashboard/ CaseList / CaseDetail / CallLogPanel / RecallList / MobileCallPanel / AutoSearchRunner
│  ├─ modals/  CaseForm / Search / CallLogForm / RecallForm / Import(CSV+URL) / Bulk / Templates / AutoSearchSettings
│  ├─ EnvWarning / ErrorBoundary / ProtectedRoute
└─ pages/      Home / Dashboard / Appointments / Analytics / Users / AuditLog / MobileCall / Login
schema.sql                         Supabase スキーマ（業務+組織+監査+RLS案）
migrations/                        差分マイグレーション（Phase2 / 緩いRLS / 厳格RLS+ロール）
supabase/functions/llm-search/     Edge Function
```

---

## 7-2. CSV取込フォーマット

- 文字コードは **UTF-8 / Shift-JIS** どちらでも可（自動判定）。
- 1行目はヘッダー（チェックで切替可）。列名は自動推定され、**列マッピング**で手動修正できます。
- 取込可能な項目: 店舗名(必須)・電話番号1〜3・住所・業種・代表者名・ステータス・営業担当・HP・Instagram・メモ。
- 重複は **電話番号 / 店舗名＋住所** で判定し、「スキップ / 上書き / 別案件として追加」を選べます。
- 取込結果（追加/重複/エラー件数）は完了時に表示され、`import_batches` に履歴が残ります。

最小例:
```csv
店舗名,電話番号,住所,業種
ABC食堂,03-1234-5678,東京都新宿区西新宿1-1-1,飲食
```

---

## 7-3. よくあるエラー / 白画面時の確認

| 症状 | 確認ポイント |
|---|---|
| 画面が真っ白 | ブラウザのコンソールを確認。多くは環境変数未設定。`ErrorBoundary` がエラー内容を表示します |
| 「Supabase未設定」警告 | Vercel/`.env` の `VITE_SUPABASE_URL` / `VITE_SUPABASE_ANON_KEY` を設定し再デプロイ |
| ログインできない | メール認証ON時は確認メールのリンクが必要。エラーは日本語表示されます |
| 保存でエラー（列が無い等） | `schema.sql` または `migrations/` を未適用の可能性。SQLを実行してください |
| スマホ連動が同期しない | `schema.sql` の Realtime publication 追加を実行。RLS有効時は `call_sessions` の anon ポリシーを確認 |
| 取込/定型文/監査が動かない | 対応テーブル未作成時は機能を静かにスキップします。`migrations` を適用してください |

---

## 8. スクリプト

| コマンド | 内容 |
|---|---|
| `npm run dev` | 開発サーバ（http://localhost:5173） |
| `npm run build` | 型チェック＋本番ビルド（`dist/`） |
| `npm run preview` | ビルド結果をローカル確認 |

---

## 9. 補足・セキュリティ

- 開発簡略化のため **既定では RLS 無効** です。本番運用では以下のいずれかを適用してください。
  - 緩い版: `migrations/2026-06-26_rls_optional.sql`（ログイン済みなら全操作可）
  - **厳格版（推奨）**: `migrations/2026-06-26_rls_roles.sql`（ロール権限＋組織分離）。
    `viewer` は読取専用、`admin`/`member` は書込可。適用前に **自分を admin に設定**しロックアウトを防止。
- **ロール**: `profiles.role`（`admin`/`member`/`viewer`）は `/users` 画面で設定。UI側でも `viewer` は書込ボタンを無効化します。
- **新規登録の停止**: `VITE_ALLOW_SIGNUP=false` でログイン画面の新規登録導線を非表示にできます。
- **マルチテナント対応**: 各テーブルに `organization_id` を保持済み（既存データ互換のため NULL 許容）。
  将来、複数会社で利用する際は `profiles.organization_id` を基準に分離できます。
- 担当者一覧・ステータス・クイックフィルター等は [`src/lib/constants.ts`](./src/lib/constants.ts) で変更できます。
- タウンページ検索の対象開始日は `TOWNPAGE_CUTOFF`（既定 `2026-06-18`）。

### 今後の改善余地（任意）
- 一覧の取得は「全件をページングで取得→クライアント側フィルタ」です（仮想スクロールで描画は軽量）。
  数万件規模になる場合は、検索条件をサーバー側クエリ（`ilike`/`in`）に寄せた**サーバーフィルタ**化を推奨します。
- 監査ログの保持期間ポリシー（古いログの定期削除）やCSV出力は未実装です。
- LLM収集（地図/新規店/自動）は Edge Function 未デプロイ時は静かにスキップされます。

### パフォーマンス（Phase 3 実績）
- ルート単位コード分割で初期JSは単一 ~1.18MB → 約490KB（gzip ~144KB）に縮小。各画面は遷移時ロード。
- 案件一覧は `react-window` で仮想化済み。数千件でもスクロールが軽量。
- `*.listAll()` は `range` ページングでSupabaseの1000行上限を回避（既定 最大30ページ=30,000件）。
