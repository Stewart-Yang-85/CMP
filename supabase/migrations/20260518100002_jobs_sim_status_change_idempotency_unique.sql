-- Enforce unique idempotencyKey per SIM_STATUS_CHANGE job (race-safe duplicate rejection).

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_sim_status_change_idempotency_key
  ON jobs (idempotency_key)
  WHERE job_type = 'SIM_STATUS_CHANGE'
    AND idempotency_key IS NOT NULL;
