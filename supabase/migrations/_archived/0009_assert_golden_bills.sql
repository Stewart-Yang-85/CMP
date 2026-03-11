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

