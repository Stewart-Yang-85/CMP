begin;

update roaming_profiles
set mccmnc_list = (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'mcc', entry->>'mcc',
        'mnc', entry->>'mnc',
        'ratePerKb', coalesce(entry->'ratePerKb', entry->'tariff', 'null'::jsonb)
      )
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements(mccmnc_list) as entry
)
where jsonb_typeof(mccmnc_list) = 'array'
  and (
    jsonb_array_length(mccmnc_list) = 0
    or jsonb_typeof(mccmnc_list->0) = 'object'
  );

update profile_versions
set config = jsonb_set(
  coalesce(config, '{}'::jsonb),
  '{mccmncList}',
  (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'mcc', entry->>'mcc',
          'mnc', entry->>'mnc',
          'ratePerKb', coalesce(entry->'ratePerKb', entry->'tariff', 'null'::jsonb)
        )
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements(config->'mccmncList') as entry
  ),
  true
)
where profile_type = 'ROAMING'
  and config ? 'mccmncList'
  and jsonb_typeof(config->'mccmncList') = 'array'
  and (
    jsonb_array_length(config->'mccmncList') = 0
    or jsonb_typeof((config->'mccmncList')->0) = 'object'
  );

commit;
