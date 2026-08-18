-- US9 follow-up: SILENT_SIM tracks long-running DEACTIVATED SIMs, not ACTIVATED SIMs without usage.

BEGIN;

UPDATE alert_type_catalog
SET
  default_threshold_value = 4320,
  default_threshold_unit = 'HOURS',
  description = 'SIM has remained DEACTIVATED beyond the configured threshold.',
  updated_at = current_timestamp
WHERE alert_type = 'SILENT_SIM';

UPDATE alert_config_items item
SET
  threshold_value = 4320,
  threshold_unit = 'HOURS',
  updated_at = current_timestamp,
  version = item.version + 1
FROM alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'SILENT_SIM';

COMMIT;
