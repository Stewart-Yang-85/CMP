create or replace function mark_bill_paid(p_bill_id uuid, p_payment_ref text default null, p_paid_at timestamptz default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_bill bills;
  v_paid_at timestamptz;
begin
  v_paid_at := coalesce(p_paid_at, current_timestamp);

  update bills
  set status = 'PAID',
      paid_at = v_paid_at
  where bill_id = p_bill_id
  returning * into v_bill;

  if v_bill.bill_id is null then
    return null;
  end if;

  insert into events (event_type, occurred_at, tenant_id, payload)
  values (
    'BILL_MARK_PAID',
    current_timestamp,
    v_bill.enterprise_id,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'paymentRef', p_payment_ref,
      'paidAt', v_paid_at
    )
  );

  return get_bill(p_bill_id);
end;
$$;

revoke all on function mark_bill_paid(uuid, text, timestamptz) from public;
grant execute on function mark_bill_paid(uuid, text, timestamptz) to service_role;

