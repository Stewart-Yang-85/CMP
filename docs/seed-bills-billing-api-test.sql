-- Seed bills for Billing API testing (GET /bills, GET /bills:csv, etc.)
-- Reseller: 938ca03b-01c7-4f6a-bff6-9dbee00452a6
-- Enterprises: 2f130185-1bc9-4a33-8f1a-7f49312daa0c, 89ec0276-7444-48bd-bb9d-1a14353b2f07
-- Periods: 2026-01 .. 2026-05 (header-only rows; no bill_line_items / usage)
--
-- Run in Supabase SQL Editor (service role / postgres). Safe to re-run (upsert).

begin;

insert into bills (
  bill_id,
  enterprise_id,
  reseller_id,
  period_start,
  period_end,
  status,
  currency,
  total_amount,
  due_date,
  generated_at,
  published_at,
  paid_at
)
values
  -- Enterprise 2f130185-1bc9-4a33-8f1a-7f49312daa0c
  (
    'a1010101-0101-4011-8011-010101010101'::uuid,
    '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-01-01', date '2026-01-31',
    'PUBLISHED', 'CNY', 12500.00, date '2026-02-15',
    timestamptz '2026-02-01 02:00:00+00', timestamptz '2026-02-01 03:00:00+00', null
  ),
  (
    'a1010101-0101-4011-8011-010101010102'::uuid,
    '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-02-01', date '2026-02-28',
    'PAID', 'CNY', 13200.50, date '2026-03-15',
    timestamptz '2026-03-01 02:00:00+00', timestamptz '2026-03-01 03:00:00+00', timestamptz '2026-03-10 09:30:00+00'
  ),
  (
    'a1010101-0101-4011-8011-010101010103'::uuid,
    '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-03-01', date '2026-03-31',
    'PUBLISHED', 'CNY', 14100.00, date '2026-04-15',
    timestamptz '2026-04-01 02:00:00+00', timestamptz '2026-04-01 03:00:00+00', null
  ),
  (
    'a1010101-0101-4011-8011-010101010104'::uuid,
    '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-04-01', date '2026-04-30',
    'OVERDUE', 'CNY', 15800.75, date '2026-05-15',
    timestamptz '2026-05-01 02:00:00+00', timestamptz '2026-05-01 03:00:00+00', null
  ),
  (
    'a1010101-0101-4011-8011-010101010105'::uuid,
    '2f130185-1bc9-4a33-8f1a-7f49312daa0c'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-05-01', date '2026-05-31',
    'GENERATED', 'CNY', 16350.00, date '2026-06-15',
    timestamptz '2026-06-01 02:00:00+00', null, null
  ),
  -- Enterprise 89ec0276-7444-48bd-bb9d-1a14353b2f07
  (
    'a2020202-0202-4022-8022-020202020201'::uuid,
    '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-01-01', date '2026-01-31',
    'PUBLISHED', 'CNY', 8900.00, date '2026-02-15',
    timestamptz '2026-02-01 02:00:00+00', timestamptz '2026-02-01 03:00:00+00', null
  ),
  (
    'a2020202-0202-4022-8022-020202020202'::uuid,
    '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-02-01', date '2026-02-28',
    'PUBLISHED', 'CNY', 9200.00, date '2026-03-15',
    timestamptz '2026-03-01 02:00:00+00', timestamptz '2026-03-01 03:00:00+00', null
  ),
  (
    'a2020202-0202-4022-8022-020202020203'::uuid,
    '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-03-01', date '2026-03-31',
    'PAID', 'CNY', 9750.25, date '2026-04-15',
    timestamptz '2026-04-01 02:00:00+00', timestamptz '2026-04-01 03:00:00+00', timestamptz '2026-04-12 14:00:00+00'
  ),
  (
    'a2020202-0202-4022-8022-020202020204'::uuid,
    '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-04-01', date '2026-04-30',
    'PUBLISHED', 'CNY', 10100.00, date '2026-05-15',
    timestamptz '2026-05-01 02:00:00+00', timestamptz '2026-05-01 03:00:00+00', null
  ),
  (
    'a2020202-0202-4022-8022-020202020205'::uuid,
    '89ec0276-7444-48bd-bb9d-1a14353b2f07'::uuid,
    '938ca03b-01c7-4f6a-bff6-9dbee00452a6'::uuid,
    date '2026-05-01', date '2026-05-31',
    'PUBLISHED', 'CNY', 10850.50, date '2026-06-15',
    timestamptz '2026-06-01 02:00:00+00', timestamptz '2026-06-01 03:00:00+00', null
  )
on conflict (enterprise_id, period_start, period_end) do update set
  reseller_id = excluded.reseller_id,
  status = excluded.status,
  currency = excluded.currency,
  total_amount = excluded.total_amount,
  due_date = excluded.due_date,
  generated_at = excluded.generated_at,
  published_at = excluded.published_at,
  paid_at = excluded.paid_at;

commit;

-- Quick verify:
-- select bill_id, enterprise_id, period_start, status, total_amount
-- from bills
-- where reseller_id = '938ca03b-01c7-4f6a-bff6-9dbee00452a6'
--   and period_start >= date '2026-01-01'
-- order by enterprise_id, period_start;
