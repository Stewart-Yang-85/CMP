-- US9 follow-up: OUT_OF_PROFILE_SURGE threshold is a percentage of the subscribed package quota.

BEGIN;

UPDATE alert_type_catalog
SET
  default_threshold_value = 20,
  default_threshold_unit = 'PERCENT',
  description = 'Package out-of-profile usage consumed the configured percentage of the applicable quota.',
  updated_at = current_timestamp
WHERE alert_type = 'OUT_OF_PROFILE_SURGE';

UPDATE alert_config_items item
SET
  threshold_value = 20,
  threshold_unit = 'PERCENT',
  updated_at = current_timestamp,
  version = item.version + 1
FROM alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'OUT_OF_PROFILE_SURGE';

COMMIT;
