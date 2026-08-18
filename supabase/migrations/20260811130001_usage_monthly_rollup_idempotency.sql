-- Unique idempotencyKey for USAGE_MONTHLY_ROLLUP (duplicate → conflict).

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_usage_monthly_rollup_idempotency_key
  ON jobs (idempotency_key)
  WHERE job_type = 'USAGE_MONTHLY_ROLLUP'
    AND idempotency_key IS NOT NULL;
