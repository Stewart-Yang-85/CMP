begin;

create table if not exists public.share_links (
  code text primary key,
  kind text not null,
  params jsonb not null,
  tenant_id uuid not null,
  enterprise_id uuid generated always as (tenant_id) stored,
  visibility text not null default 'tenant',
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  created_by_role text not null default 'ENTERPRISE',
  request_id text null,
  constraint share_links_code_format check (code ~ '^[A-Za-z0-9]{8}$'),
  constraint share_links_kind check (kind in ('packages','packageVersions')),
  constraint share_links_visibility check (visibility in ('tenant','public')),
  constraint share_links_params_object check (jsonb_typeof(params) = 'object')
);

create index if not exists idx_share_links_tenant_id on public.share_links (tenant_id);
create index if not exists idx_share_links_enterprise_id on public.share_links (enterprise_id);
create index if not exists idx_share_links_expires_at on public.share_links (expires_at);
create index if not exists idx_share_links_created_at on public.share_links (created_at);
create index if not exists idx_share_links_kind on public.share_links (kind);
create index if not exists idx_share_links_request_id on public.share_links (request_id);

commit;
