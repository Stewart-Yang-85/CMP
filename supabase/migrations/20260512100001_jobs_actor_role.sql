-- SIM_IMPORT and other job rows record actor_role (see src/services/simImport.ts); align with audit_logs.
alter table jobs
  add column if not exists actor_role text;
