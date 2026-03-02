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

