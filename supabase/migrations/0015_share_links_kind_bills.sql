begin;

alter table if exists public.share_links
  drop constraint if exists share_links_kind;

alter table if exists public.share_links
  add constraint share_links_kind check (kind in ('packages','packageVersions','bills'));

commit;
