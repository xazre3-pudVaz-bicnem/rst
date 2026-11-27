-- ============================================================
-- 月額ぶん（保守管理・SEO・MEO）の支払方法が途中で変わる契約に対応する。
--
--   例: 月額49,500円（製作費＋保守）を 12ヶ月分カード決済 → 13ヶ月目以降は口座振替
--   カードは決済できる回数に上限があるため、はじめの数ヶ月だけカードで、
--   そのあとは口座振替に切り替える契約がある。HP制作の分割にはすでに同じ仕組みが
--   あるが（hp_first_method ほか）、月額サービス側には無かったため追加する。
--
--   monthly_first_method : 1ヶ月目から切替までの支払方法（例: クレジットカード）
--   monthly_first_months : その方法で払う月数（例: 12 → 1〜12ヶ月目）
--   monthly_later_method : 13ヶ月目以降の支払方法（例: 口座振替）
--   monthly_first_lump   : 前半が「ショット入金」か
--     true  … カード会社から契約月に前半の合計額（月額×月数）がまとめて入金される
--     false … 毎月その月ぶんが入金される（カードで毎月課金している契約）
--     null  … 支払方法から自動判定（クレジットカード＝ショット、それ以外＝毎月）
--   ※ 13ヶ月目以降は解約まで続く区間なので、常に毎月入金として扱う（lump列は持たない）。
--   ※ 金額は既存の maintenance_price / seo_price / meo_price のまま。変わるのは
--     「いつ当社に入金されるか」＝歩合の計上月だけ。
-- 冪等: IF NOT EXISTS。
-- ============================================================
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS monthly_first_method TEXT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS monthly_first_months INT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS monthly_later_method TEXT;
ALTER TABLE visit_reports ADD COLUMN IF NOT EXISTS monthly_first_lump BOOLEAN;
