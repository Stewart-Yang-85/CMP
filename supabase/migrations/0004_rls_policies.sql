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

