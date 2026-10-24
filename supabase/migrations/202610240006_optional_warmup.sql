begin;

create or replace function public.workout_plan_valid_v2(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  item jsonb;
  day jsonb;
  exercise jsonb;
  field text;
  ids text[] := '{}';
  identifier text;
  total_steps integer;
  rest_parts text[];
begin
  if p is null or jsonb_typeof(p) <> 'object' or char_length(p::text) > 220000
    or p->'version' is distinct from '2'::jsonb
    or jsonb_typeof(p->'title') is distinct from 'string'
    or char_length(trim(p->>'title')) not between 1 and 4000
    or jsonb_typeof(p->'warmup') is distinct from 'array'
    or jsonb_typeof(p->'sessions') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'warmup') not between 0 and 50
    or jsonb_array_length(p->'sessions') not between 1 and 30 then return false; end if;
  for item in select value from jsonb_array_elements(p->'warmup') loop
    if jsonb_typeof(item) <> 'object' then return false; end if;
    for field in select unnest(array['name', 'target']) loop
      if jsonb_typeof(item->field) is distinct from 'string'
        or char_length(trim(item->>field)) not between 1 and 4000 then return false; end if;
    end loop;
    if item ? 'instructions' and (jsonb_typeof(item->'instructions') <> 'string'
      or char_length(item->>'instructions') > 4000) then return false; end if;
  end loop;
  for day in select value from jsonb_array_elements(p->'sessions') loop
    if jsonb_typeof(day) <> 'object' or day->>'type' not in ('standard', 'amrap')
      or day->>'type' is null or jsonb_typeof(day->'label') is distinct from 'string'
      or char_length(trim(day->>'label')) not between 1 and 4000
      or jsonb_typeof(day->'exercises') is distinct from 'array' then return false; end if;
    if jsonb_array_length(day->'exercises') not between 1 and 50 then return false; end if;
    for field in select unnest(array['subtitle', 'instructions']) loop
      if day ? field and (jsonb_typeof(day->field) <> 'string'
        or char_length(day->>field) > 4000) then return false; end if;
    end loop;
    if day->>'type' = 'amrap' then
      if jsonb_typeof(day->'duration') is distinct from 'string'
        or day->>'duration' !~ '^[1-9][0-9]{0,2}( (min|minuti))?$' then return false; end if;
      if split_part(day->>'duration', ' ', 1)::integer > 180 then return false; end if;
    end if;
    total_steps := jsonb_array_length(p->'warmup');
    for exercise in select value from jsonb_array_elements(day->'exercises') loop
      if jsonb_typeof(exercise) <> 'object' then return false; end if;
      for field in select unnest(array['name', 'target']) loop
        if jsonb_typeof(exercise->field) is distinct from 'string'
          or char_length(trim(exercise->>field)) not between 1 and 4000 then return false; end if;
      end loop;
      for field in select unnest(array['instructions', 'rest']) loop
        if exercise ? field and (jsonb_typeof(exercise->field) <> 'string'
          or char_length(exercise->>field) > 4000) then return false; end if;
      end loop;
      if day->>'type' = 'standard' then
        if exercise ? 'rest' and trim(exercise->>'rest') <> '' then
          rest_parts := regexp_match(trim(exercise->>'rest'), '^([0-9]{1,4})(-([0-9]{1,4}))?( (s|sec|secondi))?$');
          if rest_parts is null then return false; end if;
          if rest_parts[1]::integer > 3600 or coalesce(rest_parts[3], rest_parts[1])::integer > 3600
            or coalesce(rest_parts[3], rest_parts[1])::integer < rest_parts[1]::integer then return false; end if;
        end if;
        if jsonb_typeof(exercise->'sets') is distinct from 'number'
          or exercise->>'sets' !~ '^[0-9]{1,2}$' then return false; end if;
        if (exercise->>'sets')::integer not between 1 and 30 then return false; end if;
        if exercise ? 'optionalSets' then
          if jsonb_typeof(exercise->'optionalSets') <> 'number'
            or exercise->>'optionalSets' !~ '^[0-9]{1,2}$' then return false; end if;
          if (exercise->>'optionalSets')::integer not between 0 and 30 then return false; end if;
        end if;
        total_steps := total_steps + (exercise->>'sets')::integer
          + coalesce((exercise->>'optionalSets')::integer, 0);
      end if;
    end loop;
    if total_steps > 1500 then return false; end if;
  end loop;
  for item in
    select value from jsonb_array_elements(p->'warmup')
    union all select value from jsonb_array_elements(p->'sessions')
    union all select e.value from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d.value->'exercises') e
  loop
    identifier := item->>'id';
    if jsonb_typeof(item->'id') is distinct from 'string' or identifier !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$'
      or identifier in ('warmup', '__proto__', 'constructor', 'prototype')
      or identifier = any(ids) then return false; end if;
    ids := array_append(ids, identifier);
  end loop;
  return true;
end;
$$;

commit;
