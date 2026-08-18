-- Commercial Terms & Control Policy modules: lifecycle (DRAFT / PUBLISHED / DEPRECATED), aligned with carrier_service_modules / APN profiles.
alter table public.commercial_terms_modules
  add column if not exists status text not null default 'PUBLISHED',
  add column if not exists published_at timestamptz,
  add column if not exists deprecated_at timestamptz,
  add column if not exists effective_from timestamptz;

update public.commercial_terms_modules
set
  published_at = coalesce(published_at, created_at),
  effective_from = coalesce(effective_from, created_at)
where published_at is null or effective_from is null;

alter table public.commercial_terms_modules alter column status set default 'DRAFT';

alter table public.control_policy_modules
  add column if not exists status text not null default 'PUBLISHED',
  add column if not exists published_at timestamptz,
  add column if not exists deprecated_at timestamptz,
  add column if not exists effective_from timestamptz;

update public.control_policy_modules
set
  published_at = coalesce(published_at, created_at),
  effective_from = coalesce(effective_from, created_at)
where published_at is null or effective_from is null;

alter table public.control_policy_modules alter column status set default 'DRAFT';
