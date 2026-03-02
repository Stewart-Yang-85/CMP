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

