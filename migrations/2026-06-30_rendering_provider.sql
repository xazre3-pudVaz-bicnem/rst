ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS rendering_provider TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_rendering_result TEXT;
ALTER TABLE source_sites ADD COLUMN IF NOT EXISTS last_rendering_error TEXT;
