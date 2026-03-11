ALTER TABLE usage_daily_summary
ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT current_timestamp;
