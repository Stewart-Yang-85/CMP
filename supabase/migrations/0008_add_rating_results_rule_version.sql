alter table if exists rating_results
add column if not exists rule_version_id uuid;
