-- US9 follow-up: UNEXPECTED_ROAMING is driven by current-period out-of-profile roaming usage.

BEGIN;

UPDATE alert_type_catalog
SET
  default_severity = 'P1',
  description = 'SIM has out-of-profile roaming usage in the current billing period.',
  updated_at = current_timestamp
WHERE alert_type = 'UNEXPECTED_ROAMING';

UPDATE alert_config_items item
SET
  severity = 'P1',
  updated_at = current_timestamp,
  version = item.version + 1
FROM alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'UNEXPECTED_ROAMING';

COMMIT;
