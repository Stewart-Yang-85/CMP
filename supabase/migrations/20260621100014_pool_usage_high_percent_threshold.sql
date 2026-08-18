-- Phase 44 follow-up: POOL_USAGE_HIGH threshold is a quota percentage, not an absolute volume.

BEGIN;

UPDATE alert_type_catalog
SET
  default_threshold_value = 80,
  default_threshold_unit = 'PERCENT',
  description = 'Package in-profile usage consumed the configured percentage of the applicable quota.',
  updated_at = current_timestamp
WHERE alert_type = 'POOL_USAGE_HIGH';

UPDATE alert_config_items item
SET
  threshold_value = 80,
  threshold_unit = 'PERCENT',
  threshold_config = COALESCE(item.threshold_config, '{}'::jsonb) || jsonb_build_object(
    'metric', 'in_profile_usage_ratio',
    'quotaScope', 'price_plan',
    'unit', 'PERCENT'
  ),
  version = item.version + 1,
  updated_at = current_timestamp
FROM alert_config_profiles profile
WHERE profile.config_profile_id = item.config_profile_id
  AND profile.scope_type = 'PLATFORM'
  AND profile.status = 'ACTIVE'
  AND item.alert_type = 'POOL_USAGE_HIGH';

COMMIT;
