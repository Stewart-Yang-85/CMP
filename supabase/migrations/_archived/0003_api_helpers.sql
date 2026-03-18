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

