-- Add lifecycle_sub_status column to sims table
DO $$ BEGIN
  CREATE TYPE lifecycle_sub_status AS ENUM ('normal', 'activating', 'activation_failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE sims ADD COLUMN IF NOT EXISTS lifecycle_sub_status lifecycle_sub_status DEFAULT 'normal';
