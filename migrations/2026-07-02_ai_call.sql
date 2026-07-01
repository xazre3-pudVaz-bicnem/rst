-- ============================================================
-- AIテレアポ MVP: トークスクリプト管理・架電ジョブ(=架電ログ+結果)・再架電防止
-- 既存機能は変更しない（cases に列追加のみ）。実通話はモック、Twilioは後から差し替え可能。
-- ============================================================

-- トークスクリプト（管理画面で編集）
CREATE TABLE IF NOT EXISTS ai_call_scripts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  is_default BOOLEAN NOT NULL DEFAULT false,
  is_active BOOLEAN NOT NULL DEFAULT true,
  created_by_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 架電ジョブ（1行=1架電。ステータス・結果・文字起こし・AI要約・温度感・次回アクションを保持）
CREATE TABLE IF NOT EXISTS ai_call_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  case_id UUID,
  case_name TEXT,
  phone TEXT,
  script_id UUID,
  -- 未架電/発信中/通話完了/不在/担当者不在/興味あり/興味なし/再架電/NG
  status TEXT NOT NULL DEFAULT '未架電',
  provider TEXT NOT NULL DEFAULT 'mock',    -- mock / twilio（後から差し替え）
  provider_call_sid TEXT,                    -- Twilio Call SID 等
  called_at TIMESTAMPTZ,                      -- 通話日時
  duration_sec INTEGER,                       -- 通話時間(秒)
  transcript TEXT,                            -- 文字起こし
  ai_summary TEXT,                            -- AI要約
  temperature TEXT,                           -- 温度感（高/中/低）
  next_action TEXT,                           -- 次回アクション
  appointment_id UUID,                        -- 興味あり→作成した訪問予定
  error TEXT,
  created_by_id UUID,
  created_date TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_date TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_ai_call_jobs_case ON ai_call_jobs(case_id, created_date DESC);
CREATE INDEX IF NOT EXISTS idx_ai_call_jobs_status ON ai_call_jobs(status, created_date DESC);

-- 再架電防止フラグ（NG判定で true）・最終架電・最新架電ステータス（既存casesに追加のみ）
ALTER TABLE cases ADD COLUMN IF NOT EXISTS do_not_call BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS last_ai_call_at TIMESTAMPTZ;
ALTER TABLE cases ADD COLUMN IF NOT EXISTS ai_call_status TEXT;

-- RLS（既存方針に合わせ authenticated 全許可。管理者制限はアプリ側で担保）
ALTER TABLE ai_call_scripts ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_call_jobs ENABLE ROW LEVEL SECURITY;
DO $$ BEGIN CREATE POLICY rst_authenticated_all ON ai_call_scripts FOR ALL TO authenticated USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE POLICY rst_authenticated_all ON ai_call_jobs FOR ALL TO authenticated USING (true) WITH CHECK (true); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- デフォルトのトークスクリプト（未登録時のみ）
INSERT INTO ai_call_scripts (name, body, is_default)
SELECT 'デフォルト（MEO/Web提案）',
$body$【AIテレアポ トークスクリプト】

■ 導入
お世話になっております。私、{会社名}のAIアシスタントの{担当者}と申します。{店名}様のご担当者さまはいらっしゃいますでしょうか。

■ 用件
本日は、Googleマップ（MEO）やホームページ集客について、{地域}エリアの店舗様へ無料のご案内でお電話いたしました。1分ほどお時間よろしいでしょうか。

■ ヒアリング
・現在、Googleのクチコミや上位表示の対策はされていますか？
・新規のお客様の集客で、いま課題に感じていることはありますか？

■ クロージング（興味ありの場合）
ありがとうございます。より詳しいご提案を、担当者が改めてご訪問またはオンラインでご説明できればと思います。今週〜来週で、ご都合の良い日時はございますか？

■ 断り時
承知しました。お忙しいところ失礼いたしました。もし今後ご興味が出ましたらいつでもご連絡ください。失礼いたします。
$body$, true
WHERE NOT EXISTS (SELECT 1 FROM ai_call_scripts WHERE is_default);
