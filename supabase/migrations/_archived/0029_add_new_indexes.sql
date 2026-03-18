create index if not exists idx_bills_status_due on bills(status, due_date);
create index if not exists idx_bills_reseller on bills(reseller_id);
create index if not exists idx_subscriptions_enterprise_state on subscriptions(enterprise_id, state);
create index if not exists idx_usage_sim_day on usage_daily_summary(sim_id, usage_day);
create index if not exists idx_audit_actor_time on audit_logs(actor_user_id, created_at);
create index if not exists idx_events_tenant_time on events(tenant_id, occurred_at);
create index if not exists idx_rating_results_calc on rating_results(calculation_id);
create index if not exists idx_rating_results_enterprise_day on rating_results(enterprise_id, usage_day);
