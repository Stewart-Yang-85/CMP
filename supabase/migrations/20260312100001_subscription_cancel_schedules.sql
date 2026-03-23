-- subscription_cancel_schedules: 已生效订阅的取消队列
-- 当用户请求取消 ACTIVE 订阅时，操作插入此表，由定时任务在 scheduled_execute_at 执行

create table if not exists subscription_cancel_schedules (
  schedule_id uuid primary key default gen_random_uuid(),
  subscription_id uuid not null references subscriptions(subscription_id) on delete cascade,
  scheduled_execute_at timestamptz not null,
  status text not null default 'PENDING' check (status in ('PENDING', 'EXECUTED', 'CANCELLED')),
  created_at timestamptz not null default current_timestamp,
  executed_at timestamptz,
  unique (subscription_id)
);

create index if not exists idx_subscription_cancel_schedules_execute
  on subscription_cancel_schedules(scheduled_execute_at)
  where status = 'PENDING';
