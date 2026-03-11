create or replace view v_api_bills as
select
  b.bill_id::text as "billId",
  b.enterprise_id::text as "enterpriseId",
  to_char(b.period_start, 'YYYY-MM') as "period",
  b.status::text as "status",
  b.currency as "currency",
  b.total_amount::float8 as "totalAmount",
  b.due_date as "dueDate"
from bills b;

create or replace function list_bills(
  p_period text default null,
  p_status text default null,
  p_sort_by text default null,
  p_sort_order text default null,
  p_limit int default 20,
  p_offset int default 0
)
returns jsonb
language plpgsql
stable
as $$
declare
  v_items jsonb;
  v_total bigint;
begin
  select count(*) into v_total
  from v_api_bills
  where (p_period is null or "period" = p_period)
    and (p_status is null or "status" = p_status);

  select coalesce(jsonb_agg(to_jsonb(t)), '[]'::jsonb)
  into v_items
  from (
    select *
    from v_api_bills
    where (p_period is null or "period" = p_period)
      and (p_status is null or "status" = p_status)
    order by
      case when coalesce(p_sort_by, 'period') = 'period' and coalesce(p_sort_order, 'desc') = 'asc' then "period" end asc,
      case when coalesce(p_sort_by, 'period') = 'period' and coalesce(p_sort_order, 'desc') = 'desc' then "period" end desc,
      case when coalesce(p_sort_by, 'period') = 'dueDate' and coalesce(p_sort_order, 'desc') = 'asc' then "dueDate" end asc,
      case when coalesce(p_sort_by, 'period') = 'dueDate' and coalesce(p_sort_order, 'desc') = 'desc' then "dueDate" end desc,
      case when coalesce(p_sort_by, 'period') = 'totalAmount' and coalesce(p_sort_order, 'desc') = 'asc' then "totalAmount" end asc,
      case when coalesce(p_sort_by, 'period') = 'totalAmount' and coalesce(p_sort_order, 'desc') = 'desc' then "totalAmount" end desc,
      case when coalesce(p_sort_by, 'period') = 'status' and coalesce(p_sort_order, 'desc') = 'asc' then "status" end asc,
      case when coalesce(p_sort_by, 'period') = 'status' and coalesce(p_sort_order, 'desc') = 'desc' then "status" end desc,
      "billId" asc
    limit greatest(p_limit, 0)
    offset greatest(p_offset, 0)
  ) t;

  return jsonb_build_object(
    'items', v_items,
    'total', v_total
  );
end;
$$;

create or replace function get_bill(p_bill_id uuid)
returns jsonb
language sql
stable
as $$
  select to_jsonb(b)
  from v_api_bills b
  where b."billId" = p_bill_id::text;
$$;

create or replace function get_bill_files(p_bill_id uuid)
returns jsonb
language sql
stable
as $$
  select jsonb_build_object(
    'pdfUrl', null,
    'csvUrl', null
  );
$$;
