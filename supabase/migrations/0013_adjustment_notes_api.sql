create or replace function create_adjustment_note(p_bill_id uuid, p_type text, p_amount numeric, p_reason text default null)
returns jsonb
language plpgsql
security definer
as $$
declare
  v_bill bills;
  v_note_id uuid;
  v_note_type note_type;
begin
  select * into v_bill
  from bills
  where bill_id = p_bill_id;

  if v_bill.bill_id is null then
    raise exception 'Bill not found';
  end if;

  if upper(p_type) = 'CREDIT' then
    v_note_type := 'CREDIT';
  elsif upper(p_type) = 'DEBIT' then
    v_note_type := 'DEBIT';
  else
    raise exception 'Invalid adjustment type';
  end if;

  insert into adjustment_notes (
    enterprise_id,
    note_type,
    status,
    currency,
    total_amount,
    reason,
    input_ref,
    calculation_id
  )
  values (
    v_bill.enterprise_id,
    v_note_type,
    'DRAFT',
    v_bill.currency,
    p_amount,
    p_reason,
    'manual',
    'manual'
  )
  returning note_id into v_note_id;

  insert into adjustment_note_items (note_id, item_type, amount, metadata)
  values (
    v_note_id,
    'MANUAL',
    p_amount,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'periodStart', v_bill.period_start,
      'periodEnd', v_bill.period_end,
      'reason', p_reason
    )
  );

  insert into events (event_type, occurred_at, tenant_id, payload)
  values (
    'BILL_ADJUSTMENT_NOTE_CREATED',
    current_timestamp,
    v_bill.enterprise_id,
    jsonb_build_object(
      'billId', v_bill.bill_id::text,
      'noteId', v_note_id::text,
      'type', v_note_type::text,
      'amount', p_amount,
      'reason', p_reason
    )
  );

  return jsonb_build_object('noteId', v_note_id::text);
end;
$$;

revoke all on function create_adjustment_note(uuid, text, numeric, text) from public;
grant execute on function create_adjustment_note(uuid, text, numeric, text) to service_role;

