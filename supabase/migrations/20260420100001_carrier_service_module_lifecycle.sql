-- Carrier Service module: lifecycle columns (DRAFT / PUBLISHED / DEPRECATED), aligned with APN/Roaming profile semantics.
alter table public.carrier_service_modules
  add column if not exists status text not null default 'PUBLISHED',
  add column if not exists published_at timestamptz,
  add column if not exists deprecated_at timestamptz,
  add column if not exists effective_from timestamptz;

update public.carrier_service_modules
set
  published_at = coalesce(published_at, created_at),
  effective_from = coalesce(effective_from, created_at)
where published_at is null or effective_from is null;

alter table public.carrier_service_modules alter column status set default 'DRAFT';
