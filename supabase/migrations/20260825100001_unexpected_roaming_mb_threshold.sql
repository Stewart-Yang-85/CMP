-- UNEXPECTED_ROAMING: default absolute OOP threshold 20 MB (was NULL / event-discovery).

BEGIN;

UPDATE alert_type_catalog
SET
  default_threshold_value = 20,
  default_threshold_unit = 'MB',
  description = 'SIM current-period out-of-profile roaming usage reaches or exceeds the configured MB threshold (default 20 MB).',
  updated_at = current_timestamp
WHERE alert_type = 'UNEXPECTED_ROAMING';

UPDATE alert_config_items item
SET
  threshold_value = 20,
  threshold_unit = 'MB',
  updated_at = current_timestamp,
  version = item.version + 1
FROM alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'UNEXPECTED_ROAMING'
  AND (item.threshold_value IS NULL OR item.threshold_unit IS NULL);

COMMIT;
