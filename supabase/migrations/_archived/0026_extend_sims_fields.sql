do $$
begin
  if not exists (select 1 from pg_type where typname = 'sim_form_factor') then
    create type sim_form_factor as enum (
      'consumer_removable',
      'industrial_removable',
      'consumer_embedded',
      'industrial_embedded'
    );
  end if;
end $$;

alter table sims
  add column if not exists imsi_secondary_1 text,
  add column if not exists imsi_secondary_2 text,
  add column if not exists imsi_secondary_3 text,
  add column if not exists form_factor sim_form_factor default 'consumer_removable',
  add column if not exists activation_code text,
  add column if not exists upstream_status text,
  add column if not exists upstream_status_updated_at timestamptz;
