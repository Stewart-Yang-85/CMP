-- Phase 21b T173: eSIM profile tables + SM-DP+ system + state history
-- Zero-downtime: new tables only, no ALTER on existing tables
-- Rollback:
--   DROP TABLE IF EXISTS esim_state_history, esim_profiles, smdp_systems CASCADE;
--   DROP TYPE IF EXISTS esim_profile_status CASCADE;

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'esim_profile_status') THEN
    CREATE TYPE esim_profile_status AS ENUM ('AVAILABLE', 'ACTIVATED', 'DEACTIVATED', 'RETIRED');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS smdp_systems (
  smdp_system_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  base_url text NOT NULL,
  auth_type text NOT NULL DEFAULT 'NONE',
  credentials jsonb,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE TABLE IF NOT EXISTS esim_profiles (
  profile_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  iccid text NOT NULL,
  eid text NOT NULL,
  smdp_system_id uuid REFERENCES smdp_systems(smdp_system_id),
  activation_code text,
  status esim_profile_status NOT NULL DEFAULT 'AVAILABLE',
  remark text,
  created_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_esim_profiles_iccid ON esim_profiles(iccid);
CREATE INDEX IF NOT EXISTS idx_esim_profiles_eid ON esim_profiles(eid);
CREATE INDEX IF NOT EXISTS idx_esim_profiles_status ON esim_profiles(status);

CREATE TABLE IF NOT EXISTS esim_state_history (
  history_id bigserial PRIMARY KEY,
  profile_id uuid NOT NULL REFERENCES esim_profiles(profile_id),
  before_status esim_profile_status,
  after_status esim_profile_status NOT NULL,
  source text NOT NULL,
  request_id text,
  occurred_at timestamptz NOT NULL DEFAULT current_timestamp
);

CREATE INDEX IF NOT EXISTS idx_esim_state_history_profile ON esim_state_history(profile_id, occurred_at);

COMMIT;
