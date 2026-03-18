begin;

alter table if exists roaming_profiles
  alter column mccmnc_list type jsonb
  using coalesce(to_jsonb(mccmnc_list), '[]'::jsonb);

update roaming_profiles
set mccmnc_list = (
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'mcc', split_part(item, '-', 1),
        'mnc', split_part(item, '-', 2),
        'tariff', null
      )
    ),
    '[]'::jsonb
  )
  from jsonb_array_elements_text(mccmnc_list) as item
)
where jsonb_typeof(mccmnc_list) = 'array'
  and (
    jsonb_array_length(mccmnc_list) = 0
    or jsonb_typeof(mccmnc_list->0) = 'string'
  );

update profile_versions
set config = jsonb_set(
  coalesce(config, '{}'::jsonb),
  '{mccmncList}',
  (
    select coalesce(
      jsonb_agg(
        jsonb_build_object(
          'mcc', split_part(item, '-', 1),
          'mnc', split_part(item, '-', 2),
          'tariff', null
        )
      ),
      '[]'::jsonb
    )
    from jsonb_array_elements_text(config->'mccmncList') as item
  ),
  true
)
where profile_type = 'ROAMING'
  and config ? 'mccmncList'
  and jsonb_typeof(config->'mccmncList') = 'array'
  and (
    jsonb_array_length(config->'mccmncList') = 0
    or jsonb_typeof((config->'mccmncList')->0) = 'string'
  );

commit;
