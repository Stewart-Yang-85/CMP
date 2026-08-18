-- Optional customer→reseller payment evidence (bank transfer slip note) on mark-paid.
alter table bills
  add column if not exists payment_proof text;

comment on column bills.payment_proof is 'Optional free-text payment evidence (e.g. bank transfer slip reference) supplied at mark-paid.';
