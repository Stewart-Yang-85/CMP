-- Write-off audit fields (OVERDUE → WRITTEN_OFF via POST ...:write-off).
alter table bills
  add column if not exists written_off_at timestamptz,
  add column if not exists write_off_reason text;

comment on column bills.written_off_at is 'Timestamp when bill was written off (bad debt).';
comment on column bills.write_off_reason is 'Reseller-supplied reason at write-off.';
