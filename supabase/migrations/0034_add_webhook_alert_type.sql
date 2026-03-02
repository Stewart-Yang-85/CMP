do $$
begin
  if not exists (
    select 1
    from pg_type t
    join pg_enum e on t.oid = e.enumtypid
    where t.typname = 'alert_type'
      and e.enumlabel = 'WEBHOOK_DELIVERY_FAILED'
  ) then
    alter type alert_type add value 'WEBHOOK_DELIVERY_FAILED';
  end if;
end $$;
