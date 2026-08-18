-- Phase 40 T333/T334: idempotencyKey for adjustment notes and BILLING_GENERATE jobs.

ALTER TABLE adjustment_notes
  ADD COLUMN IF NOT EXISTS source_bill_id uuid REFERENCES bills (bill_id),
  ADD COLUMN IF NOT EXISTS idempotency_key text;

CREATE UNIQUE INDEX IF NOT EXISTS idx_adjustment_notes_source_bill_idempotency_key
  ON adjustment_notes (source_bill_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL
    AND source_bill_id IS NOT NULL;

-- Backfill source_bill_id from adjustment_note_items.metadata.billId (manual notes).
UPDATE adjustment_notes AS an
SET source_bill_id = sub.bill_id
FROM (
  SELECT DISTINCT ON (ani.note_id)
    ani.note_id,
    (ani.metadata ->> 'billId')::uuid AS bill_id
  FROM adjustment_note_items AS ani
  WHERE ani.metadata ->> 'billId' IS NOT NULL
    AND (ani.metadata ->> 'billId') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
  ORDER BY ani.note_id, ani.note_item_id
) AS sub
WHERE an.note_id = sub.note_id
  AND an.source_bill_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jobs_billing_generate_idempotency_key
  ON jobs (idempotency_key)
  WHERE job_type = 'BILLING_GENERATE'
    AND idempotency_key IS NOT NULL;
