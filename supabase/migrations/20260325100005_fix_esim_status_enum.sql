-- Fix eSIM profile status enum: rename AVAILABLE to INVENTORY, add TEST_READY
-- Rollback:
--   ALTER TYPE esim_profile_status RENAME VALUE 'INVENTORY' TO 'AVAILABLE';
--   (TEST_READY cannot be removed from an enum without recreating the type)

-- Rename AVAILABLE to INVENTORY
ALTER TYPE esim_profile_status RENAME VALUE 'AVAILABLE' TO 'INVENTORY';

-- Add TEST_READY state
ALTER TYPE esim_profile_status ADD VALUE IF NOT EXISTS 'TEST_READY';

-- Update any existing rows that had AVAILABLE (now INVENTORY) as default
ALTER TABLE esim_profiles ALTER COLUMN status SET DEFAULT 'INVENTORY';
