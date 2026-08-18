-- Phase 47 / T402: fix full-profile alert config replace ordering.
--
-- The first RPC version used data-modifying CTEs for delete + insert. PostgreSQL
-- does not guarantee CTE execution order unless dependencies force it, so the
-- insert could observe existing items and hit the (config_profile_id, alert_type)
-- unique constraint. This version makes the item replacement explicitly
-- sequential inside the function.

BEGIN;

CREATE OR REPLACE FUNCTION public.replace_alert_config_profile_with_items(
  p_profile_id uuid,
  p_scope_type text,
  p_reseller_id uuid,
  p_enterprise_id uuid,
  p_status text,
  p_name text,
  p_description text,
  p_items jsonb,
  p_actor_user_id uuid DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_profile_id uuid;
  v_now timestamptz := current_timestamp;
  v_item_count int;
BEGIN
  IF jsonb_typeof(coalesce(p_items, '[]'::jsonb)) <> 'array' THEN
    RAISE EXCEPTION 'p_items must be a JSON array' USING ERRCODE = '22023';
  END IF;

  IF p_profile_id IS NULL THEN
    INSERT INTO public.alert_config_profiles (
      scope_type,
      reseller_id,
      enterprise_id,
      status,
      name,
      description,
      version,
      created_by,
      updated_by,
      created_at,
      updated_at
    )
    VALUES (
      p_scope_type,
      p_reseller_id,
      p_enterprise_id,
      p_status,
      p_name,
      p_description,
      1,
      p_actor_user_id,
      p_actor_user_id,
      v_now,
      v_now
    )
    RETURNING config_profile_id INTO v_profile_id;
  ELSE
    UPDATE public.alert_config_profiles
    SET
      status = p_status,
      name = p_name,
      description = p_description,
      version = version + 1,
      updated_by = p_actor_user_id,
      updated_at = v_now
    WHERE config_profile_id = p_profile_id
    RETURNING config_profile_id INTO v_profile_id;

    IF v_profile_id IS NULL THEN
      RAISE EXCEPTION 'alert config profile not found: %', p_profile_id USING ERRCODE = 'P0002';
    END IF;
  END IF;

  CREATE TEMP TABLE IF NOT EXISTS pg_temp.alert_config_old_item_versions (
    alert_type alert_type PRIMARY KEY,
    version int NOT NULL
  ) ON COMMIT DROP;

  TRUNCATE TABLE pg_temp.alert_config_old_item_versions;

  INSERT INTO pg_temp.alert_config_old_item_versions (alert_type, version)
  SELECT alert_type, version
  FROM public.alert_config_items
  WHERE config_profile_id = v_profile_id;

  DELETE FROM public.alert_config_items
  WHERE config_profile_id = v_profile_id;

  INSERT INTO public.alert_config_items (
    config_profile_id,
    alert_type,
    enabled,
    severity,
    threshold_value,
    threshold_unit,
    window_minutes,
    suppress_minutes,
    delivery_channels,
    delivery_targets,
    threshold_config,
    version,
    created_at,
    updated_at
  )
  SELECT
    v_profile_id,
    i."alertType"::alert_type,
    coalesce(i.enabled, true),
    i.severity::alert_severity,
    i."thresholdValue",
    nullif(i."thresholdUnit", ''),
    i."windowMinutes",
    coalesce(i."suppressMinutes", 30),
    coalesce(
      ARRAY(SELECT jsonb_array_elements_text(coalesce(i."deliveryChannels", '[]'::jsonb))),
      ARRAY['PORTAL']::text[]
    ),
    coalesce(i."deliveryTargets", '{}'::jsonb),
    coalesce(i."thresholdConfig", '{}'::jsonb),
    coalesce(o.version + 1, 1),
    v_now,
    v_now
  FROM jsonb_to_recordset(coalesce(p_items, '[]'::jsonb)) AS i(
    "alertType" text,
    enabled boolean,
    severity text,
    "thresholdValue" numeric,
    "thresholdUnit" text,
    "windowMinutes" int,
    "suppressMinutes" int,
    "deliveryChannels" jsonb,
    "deliveryTargets" jsonb,
    "thresholdConfig" jsonb
  )
  LEFT JOIN pg_temp.alert_config_old_item_versions o
    ON o.alert_type = i."alertType"::alert_type;

  GET DIAGNOSTICS v_item_count = ROW_COUNT;

  IF v_item_count <> jsonb_array_length(coalesce(p_items, '[]'::jsonb)) THEN
    RAISE EXCEPTION 'alert config item count mismatch' USING ERRCODE = '22023';
  END IF;

  RETURN jsonb_build_object('profileId', v_profile_id);
END;
$$;

GRANT EXECUTE ON FUNCTION public.replace_alert_config_profile_with_items(
  uuid,
  text,
  uuid,
  uuid,
  text,
  text,
  text,
  jsonb,
  uuid
) TO authenticated, service_role;

COMMIT;
