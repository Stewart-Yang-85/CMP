do $$
declare
  v_list jsonb;
  v_total int;
  v_items jsonb;
  v_first jsonb;
  v_bill_id uuid;
  v_bill jsonb;
begin
  v_list := list_bills('2026-02', null, 20, 0);
  if v_list is null then
    raise exception 'bills api assertion failed: list_bills returned null';
  end if;

  v_total := coalesce((v_list->>'total')::int, 0);
  if v_total < 1 then
    raise exception 'bills api assertion failed: total % < 1', v_total;
  end if;

  v_items := coalesce(v_list->'items', '[]'::jsonb);
  if jsonb_typeof(v_items) <> 'array' then
    raise exception 'bills api assertion failed: items not array';
  end if;

  v_first := v_items->0;
  if v_first is null then
    raise exception 'bills api assertion failed: first item missing';
  end if;

  if (v_first->>'period') <> '2026-02' then
    raise exception 'bills api assertion failed: period % <> 2026-02', v_first->>'period';
  end if;

  if (v_first->>'totalAmount')::numeric(12, 2) <> 512.0 then
    raise exception 'bills api assertion failed: totalAmount % <> 512.0', v_first->>'totalAmount';
  end if;

  v_bill_id := (v_first->>'billId')::uuid;
  v_bill := get_bill(v_bill_id);
  if v_bill is null then
    raise exception 'bills api assertion failed: get_bill returned null';
  end if;
  if (v_bill->>'billId')::uuid <> v_bill_id then
    raise exception 'bills api assertion failed: get_bill billId mismatch';
  end if;
end $$;

