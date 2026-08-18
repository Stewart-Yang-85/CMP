-- Agent-recorded payment amount at mark-paid (not validated against total_amount).
alter table bills
  add column if not exists paid_amount numeric(12, 2);

comment on column bills.paid_amount is 'Amount recorded by reseller at mark-paid; audit-only, not reconciled to total_amount.';
