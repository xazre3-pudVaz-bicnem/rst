-- ============================================================
-- AIトークスクリプトの構造化（管理画面から編集できる項目を列で持つ）。
-- 既存の body 列は互換のため残す（mockプロバイダが参照）。列追加のみ・冪等。
-- realtime音声AIは tool-context 経由でこれらの項目を受け取り、
-- 固定ガードレール（コード側）と合成して session instructions を組み立てる。
-- ============================================================
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS target_product TEXT;            -- 対象商材
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS opening_talk TEXT;              -- 冒頭トーク（AIの最初の発話に使う）
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS contact_talk TEXT;              -- 担当者につながった時のトーク
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS reception_talk TEXT;            -- 受付対応トーク
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS interest_talk TEXT;             -- 興味あり時のトーク
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS pricing_answer TEXT;            -- 料金を聞かれた時の回答
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS rejection_handling TEXT;        -- 断られた時の対応
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS absent_handling TEXT;           -- 担当者不在時の対応
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS appointment_confirm_talk TEXT;  -- アポ取得時の確認トーク
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS ng_words TEXT;                  -- 禁止ワード
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS forbidden_actions TEXT;         -- AIに絶対させない行動
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS conversation_goal TEXT;         -- 会話のゴール
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS temperature_rule TEXT;          -- 温度感判定ルール
ALTER TABLE ai_call_scripts ADD COLUMN IF NOT EXISTS appointment_rule TEXT;          -- アポ登録ルール

-- 既定スクリプト（デフォルト（MEO/Web提案））に構造化内容を投入（未設定の項目のみ埋める・冪等）。
UPDATE ai_call_scripts SET
  target_product = COALESCE(NULLIF(target_product, ''), 'Googleマップ(MEO)・ホームページ・SEO・AI活用による集客改善の「無料診断」'),
  opening_talk = COALESCE(NULLIF(opening_talk, ''), 'お忙しいところ失礼いたします。株式会社サイプレスのAI営業担当です。Googleマップやホームページからの集客改善の無料診断についてお電話しました。ご担当の方はいらっしゃいますでしょうか。'),
  contact_talk = COALESCE(NULLIF(contact_talk, ''), 'ありがとうございます。今のホームページやGoogleマップの表示状況を確認したうえで、改善できそうな点を無料でお伝えしているのですが、10分ほどオンラインかお電話でご説明できるお時間をいただけますか。'),
  reception_talk = COALESCE(NULLIF(reception_talk, ''), '恐れ入ります。集客改善の無料診断のご案内で、ご担当の方にお取次ぎいただけますでしょうか。お手数をおかけします。'),
  interest_talk = COALESCE(NULLIF(interest_talk, ''), 'ありがとうございます。それでしたら、今の集客状況を無料で診断したうえで、改善ポイントを10分ほどでご説明します。ご都合の良い日時をお伺いできますか。'),
  pricing_answer = COALESCE(NULLIF(pricing_answer, ''), '今回の診断とご説明は無料です。費用は改善のご提案内容によりますが、まずは無料診断で現状と改善余地をお伝えするところからです。'),
  rejection_handling = COALESCE(NULLIF(rejection_handling, ''), '承知しました。お忙しいところ失礼いたしました。もし今後ご興味が出ましたら、いつでもご連絡ください。ありがとうございました。'),
  absent_handling = COALESCE(NULLIF(absent_handling, ''), '承知しました。改めてお電話いたします。ご担当の方がお戻りになりやすいお時間帯を教えていただけますか。'),
  appointment_confirm_talk = COALESCE(NULLIF(appointment_confirm_talk, ''), 'ありがとうございます。では、〇月〇日〇曜日の〇時から10分ほど、無料診断のご説明ということでよろしいでしょうか。'),
  ng_words = COALESCE(NULLIF(ng_words, ''), '絶対・必ず儲かる・確実・保証・No.1・公式・Google公認'),
  forbidden_actions = COALESCE(NULLIF(forbidden_actions, ''), '- 契約を無理に迫らない\n- 相手の話を遮らない\n- 長々と一方的に話さない'),
  conversation_goal = COALESCE(NULLIF(conversation_goal, ''), '無料診断（10分程度のオンライン/電話説明）のアポイントを取得する。'),
  temperature_rule = COALESCE(NULLIF(temperature_rule, ''), '高: 日程まで前向き／中: 話は聞くが即決しない・再架電希望／低: 興味なし・多忙で断り'),
  appointment_rule = COALESCE(NULLIF(appointment_rule, ''), '相手が明確に日時を言い、復唱確認でOKをもらえたときのみ create_appointment を呼ぶ。日時が曖昧・聞き取れない場合は必ず聞き直す。')
WHERE is_default = true;
