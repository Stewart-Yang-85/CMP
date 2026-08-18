-- Explicit lifecycle status for price_plans (aligned with apn_profiles / carrier_service_modules).
-- Rollback: ALTER TABLE price_plans DROP CONSTRAINT IF EXISTS price_plans_status_check; ALTER TABLE price_plans DROP COLUMN IF EXISTS status;

alter table price_plans add column if not exists status text;

update price_plans
set status = case
  when deprecated_at is not null then 'DEPRECATED'
  when effective_from is null then 'DRAFT'
  when effective_from <= current_timestamp then 'PUBLISHED'
  else 'DRAFT'
end
where status is null;

alter table price_plans alter column status set default 'DRAFT';
alter table price_plans alter column status set not null;

alter table price_plans drop constraint if exists price_plans_status_check;
alter table price_plans
  add constraint price_plans_status_check
  check (status in ('DRAFT', 'PUBLISHED', 'DEPRECATED'));

comment on column price_plans.status is 'Lifecycle: DRAFT | PUBLISHED | DEPRECATED (see also effective_from, deprecated_at).';

create index if not exists idx_price_plans_enterprise_status on price_plans (enterprise_id, status);
