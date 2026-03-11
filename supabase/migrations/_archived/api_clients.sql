create table if not exists public.api_clients (
  api_client_id uuid primary key default gen_random_uuid(),
  client_id text not null unique,
  secret_hash text not null,
  enterprise_id uuid not null references public.tenants(tenant_id),
  status text not null default 'ACTIVE',
  created_at timestamptz not null default now(),
  rotated_at timestamptz null
);

alter table public.api_clients enable row level security;

create policy "no_anon_access" on public.api_clients
  for all
  to anon
  using (false)
  with check (false);

