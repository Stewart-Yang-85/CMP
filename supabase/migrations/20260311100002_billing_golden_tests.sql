-- V002_billing_golden_tests.sql
-- Golden test infrastructure: seed data, views, functions, assertions, RLS for golden data
-- Sources: 0002, 0003, 0004, 0005, 0006, 0007, 0008_bills_rls, 0009, 0010, 0011, 0012, 0013
--
-- Rollback:
--   DROP FUNCTION IF EXISTS create_adjustment_note(uuid, text, numeric, text) CASCADE;
--   DROP FUNCTION IF EXISTS mark_bill_paid(uuid, text, timestamptz) CASCADE;
--   DROP FUNCTION IF EXISTS get_bill_files(uuid) CASCADE;
--   DROP FUNCTION IF EXISTS get_bill(uuid) CASCADE;
--   DROP FUNCTION IF EXISTS list_bills(text, text, text, text, int, int) CASCADE;
--   DROP VIEW IF EXISTS v_api_bills CASCADE;
--   DROP FUNCTION IF EXISTS get_golden_bill_summary() CASCADE;
--   DROP VIEW IF EXISTS v_golden_bill_summary CASCADE;
--   DROP FUNCTION IF EXISTS get_rating_results_by_calculation_id(text) CASCADE;
--   DROP VIEW IF EXISTS v_rating_results_golden CASCADE;

-- ============================================================
-- 0002: Golden seed data
-- ============================================================
insert into rating_results (calculation_id, iccid, visited_mccmnc, input_ref, classification, charged_kb, rate_per_kb, amount, currency)
values
  ('golden_case_U-01','89860000000000000000','234-15','golden:U-01','IN_PACKAGE',102400,null,0.00,'USD'),
  ('golden_case_U-02','89860000000000000001','208-01','golden:U-02','IN_PACKAGE',102400,null,0.00,'USD'),
  ('golden_case_U-03','89860000000000000002','262-02','golden:U-03','IN_PACKAGE',102400,null,0.00,'USD'),
  ('golden_case_U-04','89860000000000000003','208-01','golden:U-04','IN_PACKAGE',102400,null,0.00,'USD'),
  ('golden_case_U-07','89860000000000000006','234-15','golden:U-07','OVERAGE',10240,0.01,102.40,'USD'),
  ('golden_case_U-08','89860000000000000007','424-02','golden:U-08','PAYG',10240,0.02,204.80,'USD'),
  ('golden_case_U-05','89860000000000000004','424-02','golden:U-05','PAYG',10240,0.02,204.80,'USD'),
  ('golden_case_U-06','89860000000000000005','999-99','golden:U-06','PAYG_RULE_MISSING',10240,null,0.00,'USD')
on conflict do nothing;

-- ============================================================
-- 0003: API helpers (views + functions)
-- ============================================================
create or replace view v_rating_results_golden as
select
  rating_result_id,
  calculation_id,
  iccid,
  visited_mccmnc,
  input_ref,
  classification,
  charged_kb,
  rate_per_kb,
  amount,
  currency,
  created_at
from rating_results
where calculation_id like 'golden_case_%';

create or replace function get_rating_results_by_calculation_id(p_calculation_id text)
returns setof rating_results
language sql
stable
as $$
  select *
  from rating_results
  where calculation_id = p_calculation_id
  order by created_at asc;
$$;

-- ============================================================
-- 0004: RLS policies for rating_results (golden-test-scoped)
-- ============================================================
alter table if exists rating_results enable row level security;

drop policy if exists rating_results_select_golden_anon on rating_results;
create policy rating_results_select_golden_anon
on rating_results
for select
to anon
using (calculation_id like 'golden_case_%');

drop policy if exists rating_results_select_golden_authenticated on rating_results;
create policy rating_results_select_golden_authenticated
on rating_results
for select
to authenticated
using (calculation_id like 'golden_case_%');

-- ============================================================
-- 0005: Golden summary view + function
-- ============================================================
create or replace view v_golden_bill_summary as
select
  'golden'::text as bill_key,
  min(created_at) as first_created_at,
  max(created_at) as last_created_at,
  count(*)::bigint as line_count,
  sum(amount)::numeric(12, 2) as total_amount,
  min(currency)::text as currency
from v_rating_results_golden;

create or replace function get_golden_bill_summary()
returns table (
  bill_key text,
  first_created_at timestamptz,
  last_created_at timestamptz,
  line_count bigint,
  total_amount numeric(12, 2),
  currency text
)
language sql
stable
as $$
  select
    bill_key,
    first_created_at,
    last_created_at,
    line_count,
    total_amount,
    currency
  from v_golden_bill_summary;
$$;

-- ============================================================
-- 0006: Assert golden data
-- ============================================================
do $$
declare
  v_count bigint;
  v_sum numeric(12, 2);
  v_summary record;
begin
  select count(*)::bigint, coalesce(sum(amount), 0)::numeric(12, 2)
  into v_count, v_sum
  from v_rating_results_golden;

  if v_count < 8 then
    raise exception 'golden assertion failed: v_rating_results_golden count % < 8', v_count;
  end if;

  if v_sum <> 512.0 then
    raise exception 'golden assertion failed: v_rating_results_golden sum(amount) % <> 512.0', v_sum;
  end if;

  select * into v_summary from get_golden_bill_summary();
  if v_summary is null then
    raise exception 'golden assertion failed: get_golden_bill_summary() returned no rows';
  end if;

  if (v_summary.total_amount::numeric(12, 2)) <> 512.0 then
    raise exception 'golden assertion failed: summary.total_amount % <> 512.0', v_summary.total_amount;
  end if;

  if (v_summary.line_count::bigint) < 8 then
    raise exception 'golden assertion failed: summary.line_count % < 8', v_summary.line_count;
  end if;
end $$;

-- ============================================================
-- 0007: Golden bill seed
-- ============================================================
do $$
declare
  v_enterprise_id uuid;
  v_bill_id uuid;
  v_total numeric(12, 2);
begin
  select tenant_id into v_enterprise_id
  from tenants
  where code = 'ENT_GOLDEN'
  limit 1;

  if v_enterprise_id is null then
    insert into tenants (tenant_type, code, name, enterprise_status, auto_suspend_enabled)
    values ('ENTERPRISE', 'ENT_GOLDEN', 'Golden Enterprise', 'ACTIVE', true)
    returning tenant_id into v_enterprise_id;
  end if;

  update rating_results
  set enterprise_id = v_enterprise_id
  where calculation_id like 'golden_case_%'
    and enterprise_id is null;

  select coalesce(sum(amount), 0)::numeric(12, 2)
  into v_total
  from v_rating_results_golden;

  select bill_id into v_bill_id
  from bills
  where enterprise_id = v_enterprise_id
    and period_start = date '2026-02-01'
    and period_end = date '2026-02-28'
  limit 1;

  if v_bill_id is null then
    insert into bills (
      enterprise_id,
      period_start,
      period_end,
      status,
      currency,
      total_amount,
      due_date,
      generated_at,
      published_at
    )
    values (
      v_enterprise_id,
      date '2026-02-01',
      date '2026-02-28',
      'PUBLISHED',
      'USD',
      v_total,
      date '2026-03-10',
      current_timestamp,
      current_timestamp
    )
    returning bill_id into v_bill_id;
  end if;

  insert into bill_line_items (bill_id, item_type, amount, metadata)
  select
    v_bill_id,
    r.classification,
    r.amount,
    jsonb_build_object(
      'calculationId', r.calculation_id,
      'iccid', r.iccid,
      'visitedMccMnc', r.visited_mccmnc,
      'chargedKb', r.charged_kb,
      'ratePerKb', r.rate_per_kb,
      'inputRef', r.input_ref
    )
  from v_rating_results_golden r
  on conflict do nothing;
end $$;

-- ============================================================
-- 0008_bills_rls: RLS for bills (golden-test-scoped)
-- ============================================================
alter table if exists bills enable row level security;
alter table if exists bill_line_items enable row level security;

drop policy if exists bills_select_golden_anon on bills;
create policy bills_select_golden_anon
on bills
for select
to anon
using (
  enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
);

drop policy if exists bills_select_golden_authenticated on bills;
create policy bills_select_golden_authenticated
on bills
for select
to authenticated
using (
  enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
);

drop policy if exists bill_line_items_select_golden_anon on bill_line_items;
create policy bill_line_items_select_golden_anon
on bill_line_items
for select
to anon
using (
  exists (
    select 1
    from bills b
    where b.bill_id = bill_line_items.bill_id
      and b.enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
  )
);

drop policy if exists bill_line_items_select_golden_authenticated on bill_line_items;
create policy bill_line_items_select_golden_authenticated
on bill_line_items
for select
to authenticated
using (
  exists (
    select 1
    from bills b
    where b.bill_id = bill_line_items.bill_id
      and b.enterprise_id in (select tenant_id from tenants where code = 'ENT_GOLDEN')
  )
);

-- ============================================================
-- 0009: Assert golden bills
-- ============================================================
do $$
declare
  v_enterprise_id uuid;
  v_bill record;
  v_expected_total numeric(12, 2);
  v_line_total numeric(12, 2);
  v_line_count bigint;
  v_rating_count bigint;
begin
  select tenant_id into v_enterprise_id
  from tenants
  where code = 'ENT_GOLDEN'
  limit 1;

  if v_enterprise_id is null then
    raise exception 'golden bills assertion failed: ENT_GOLDEN tenant missing';
  end if;

  select * into v_bill
  from bills
  where enterprise_id = v_enterprise_id
    and period_start = date '2026-02-01'
    and period_end = date '2026-02-28'
  limit 1;

  if v_bill is null then
    raise exception 'golden bills assertion failed: bill row missing';
  end if;

  if v_bill.status::text <> 'PUBLISHED' then
    raise exception 'golden bills assertion failed: bill status % <> PUBLISHED', v_bill.status;
  end if;

  select coalesce(sum(amount), 0)::numeric(12, 2), count(*)::bigint
  into v_line_total, v_line_count
  from bill_line_items
  where bill_id = v_bill.bill_id;

  select coalesce(sum(amount), 0)::numeric(12, 2), count(*)::bigint
  into v_expected_total, v_rating_count
  from v_rating_results_golden;

  if v_line_count <> v_rating_count then
    raise exception 'golden bills assertion failed: line_count % <> rating_count %', v_line_count, v_rating_count;
  end if;

  if v_line_total <> v_expected_total then
    raise exception 'golden bills assertion failed: line_total % <> expected_total %', v_line_total, v_expected_total;
  end if;

  if v_bill.total_amount::numeric(12, 2) <> v_expected_total then
    raise exception 'golden bills assertion failed: bills.total_amount % <> expected_total %', v_bill.total_amount, v_expected_total;
  end if;
end $$;

-- ============================================================
-- 0010: Bills API views + functions
-- ============================================================
create or replace view v_api_bills as
select
  b.bill_id::text as "billId",
  b.enterprise_id::text as "enterpriseId",
  to_char(b.period_start, 'YYYY-MM') as "period",
  b.status::text as "status",
  b.currency as "currency",
  b.total_amount::float8 as "totalAmount",
  b.due_date as "dueDate"
from bills b;

create or replace function list_bills(
  p_period text default null,
  p_status text default null,
  p_sort_by text default null,
  p_sort_order text default null,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  select count(*) into v_total
  from v_api_bills
  where (p_period is null or "period" = p_period)
    and (p_status is null or "status" = p_status);

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  into v_items
  from (
    select *
    from v_api_bills
    where (p_period is null or "period" = p_period)
      and (p_status is null or "status" = p_status)
    order by
      case when coalesce(p_sort_by, 'period') = 'period' and coalesce(p_sort_order, 'desc') = 'asc' then "period" end asc,
      case when coalesce(p_sort_by, 'period') = 'period' and coalesce(p_sort_order, 'desc') = 'desc' then "period" end desc,
      case when coalesce(p_sort_by, 'period') = 'dueDate' and coalesce(p_sort_order, 'desc') = 'asc' then "dueDate" end asc,
      case when coalesce(p_sort_by, 'period') = 'dueDate' and coalesce(p_sort_order, 'desc') = 'desc' then "dueDate" end desc,
      case when coalesce(p_sort_by, 'period') = 'totalAmount' and coalesce(p_sort_order, 'desc') = 'asc' then "totalAmount" end asc,
      case when coalesce(p_sort_by, 'period') = 'totalAmount' and coalesce(p_sort_order, 'desc') = 'desc' then "totalAmount" end desc,
      case when coalesce(p_sort_by, 'period') = 'status' and coalesce(p_sort_order, 'desc') = 'asc' then "status" end asc,
      case when coalesce(p_sort_by, 'period') = 'status' and coalesce(p_sort_order, 'desc') = 'desc' then "status" end desc,
      "billId" asc
    limit greatest(p_limit, 0)
    offset greatest(p_offset, 0)
  ) t;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total
  );
end;
$$;

create or replace function get_bill(p_bill_id uuid)
returns jsonb
language sql
stable
as $$
  select to_jsonb(b)
  from v_api_bills b
  where b."billId" = p_bill_id::text;
$$;

create or replace function get_bill_files(p_bill_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'pdfUrl', null,
    'csvUrl', null
  );
$$;

-- ============================================================
-- 0011: Assert bills API
-- ============================================================
do $$
declare
  v_list jsonb;
  v_total int;
  v_items jsonb;
  v_first jsonb;
  v_bill_id uuid;
  v_bill jsonb;
begin
  v_list := list_bills('2026-02', null, null, null, 20, 0);
  if v_list is null then
    raise exception 'bills api assertion failed: list_bills returned null';
  end if;

  v_total := coalesce((v_list->>'total')::int, 0);
  if v_total < 1 then
    raise exception 'bills api assertion failed: total % < 1', v_total;
  end if;

  v_items := coalesce(v_list->'items', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'bills api assertion failed: items not array';
  end if;

  v_first := v_items->0;
  if v_first is null then
    raise exception 'bills api assertion failed: first item missing';
  end if;

  if (v_first->>'period') <> '2026-02' then
    raise exception 'bills api assertion failed: period % <> 2026-02', v_first->>'period';
  end if;

  if (v_first->>'totalAmount')::numeric(12, 2) <> 512.0 then
    raise exception 'bills api assertion failed: totalAmount % <> 512.0', v_first->>'totalAmount';
  end if;

  v_bill_id := (v_first->>'billId')::uuid;
  v_bill := get_bill(v_bill_id);
  if v_bill is null then
    raise exception 'bills api assertion failed: get_bill returned null';
  end if;
  if (v_bill->>'billId')::uuid <> v_bill_id then
    raise exception 'bills api assertion failed: get_bill billId mismatch';
  end if;
end $$;

-- ============================================================
-- 0012: Bills mutations
-- ============================================================
create or replace function mark_bill_paid(p_bill_id uuid, p_payment_ref text default null, p_paid_at timestamptz default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_bill bills;
  v_paid_at timestamptz;
begin
  v_paid_at := coalesce(p_paid_at, current_timestamp);

  update bills
  set status = 'PAID',
      paid_at = v_paid_at
  where bill_id = p_bill_id
  returning * into v_bill;

  if v_bill.bill_id is null then
    return null;
  end if;

  insert into events (event_type, occurred_at, tenant_id, payload)
  values (
    'BILL_MARK_PAID',
    current_timestamp,
    v_bill.enterprise_id,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'paymentRef', p_payment_ref,
      'paidAt', v_paid_at
    )
  );

  return get_bill(p_bill_id);
end;
$$;

revoke all on function mark_bill_paid(uuid, text, timestamptz) from public;
grant execute on function mark_bill_paid(uuid, text, timestamptz) to service_role;

-- ============================================================
-- 0013: Adjustment notes API
-- ============================================================
create or replace function create_adjustment_note(p_bill_id uuid, p_type text, p_amount numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_bill bills;
  v_note_id uuid;
  v_note_type note_type;
begin
  select * into v_bill
  from bills
  where bill_id = p_bill_id;

  if v_bill.bill_id is null then
    raise exception 'Bill not found';
  end if;

  if upper(p_type) = 'CREDIT' then
    v_note_type := 'CREDIT';
  elsif upper(p_type) = 'DEBIT' then
    v_note_type := 'DEBIT';
  else
    raise exception 'Invalid adjustment type';
  end if;

  insert into adjustment_notes (
    enterprise_id,
    note_type,
    status,
    currency,
    total_amount,
    reason,
    input_ref,
    calculation_id
  )
  values (
    v_bill.enterprise_id,
    v_note_type,
    'DRAFT',
    v_bill.currency,
    p_amount,
    p_reason,
    'manual',
    'manual'
  )
  returning note_id into v_note_id;

  insert into adjustment_note_items (note_id, item_type, amount, metadata)
  values (
    v_note_id,
    'MANUAL',
    p_amount,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'periodStart', v_bill.period_start,
      'periodEnd', v_bill.period_end,
      'reason', p_reason
    )
  );

  insert into events (event_type, occurred_at, tenant_id, payload)
  values (
    'BILL_ADJUSTMENT_NOTE_CREATED',
    current_timestamp,
    v_bill.enterprise_id,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'noteId', v_note_id::text,
      'type', v_note_type::text,
      'amount', p_amount,
      'reason', p_reason
    )
  );

  return jsonb_build_object('noteId', v_note_id::text);
end;
$$;

revoke all on function create_adjustment_note(uuid, text, numeric, text) from public;
grant execute on function create_adjustment_note(uuid, text, numeric, text) to service_role;
