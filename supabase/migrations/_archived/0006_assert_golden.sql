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

