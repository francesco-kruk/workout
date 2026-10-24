begin;

lock table public.workout_plan_versions in share row exclusive mode;

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
      if exercise ? 'instructions' and (jsonb_typeof(exercise->'instructions') <> 'string'
        or char_length(exercise->>'instructions') > 4000) then return false; end if;
      if day->>'type' = 'standard' or exercise ? 'rest' then
        if jsonb_typeof(exercise->'rest') is distinct from 'number' then return false; end if;
        if (exercise->>'rest')::numeric not between 0 and 3600
          or trunc((exercise->>'rest')::numeric) <> (exercise->>'rest')::numeric then return false; end if;
      end if;
      if day->>'type' = 'standard' then
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

do $$
declare
  plan record;
  day record;
  exercise record;
  converted_definition jsonb;
  parts text[];
  seconds integer;
begin
  for plan in select id, p.definition from public.workout_plan_versions p loop
    converted_definition := plan.definition;
    for day in select value, ordinality from jsonb_array_elements(converted_definition->'sessions') with ordinality loop
      for exercise in select value, ordinality from jsonb_array_elements(day.value->'exercises') with ordinality loop
        if jsonb_typeof(exercise.value->'rest') = 'string' then
          -- These bundled exercises explicitly used blank rest for no recovery.
          if day.value->>'type' = 'standard'
            and exercise.value->>'rest' = ''
            and exercise.value->>'id' in ('core-barchetta', 'core-pallina-bastone',
              'core-raises-barchetta', 'core-crunch-farfalla', 'core-cardio') then
            converted_definition := jsonb_set(converted_definition,
              array['sessions', (day.ordinality - 1)::text, 'exercises', (exercise.ordinality - 1)::text, 'rest'],
              '0'::jsonb);
            continue;
          end if;
          if day.value->>'type' = 'amrap' and trim(exercise.value->>'rest') = '' then
            converted_definition := converted_definition #-
              array['sessions', (day.ordinality - 1)::text, 'exercises', (exercise.ordinality - 1)::text, 'rest'];
            continue;
          end if;
          parts := regexp_match(trim(exercise.value->>'rest'), '^([0-9]{1,4})(-([0-9]{1,4}))?( (s|sec|secondi))?$');
          if parts is null then
            raise exception 'Cannot convert rest in plan %, exercise %', plan.id, exercise.value->>'id';
          end if;
          seconds := coalesce(parts[3], parts[1])::integer;
          if seconds > 3600 or parts[1]::integer > seconds then
            raise exception 'Invalid rest interval in plan %, exercise %', plan.id, exercise.value->>'id';
          end if;
          converted_definition := jsonb_set(converted_definition,
            array['sessions', (day.ordinality - 1)::text, 'exercises', (exercise.ordinality - 1)::text, 'rest'],
            to_jsonb(seconds));
        end if;
      end loop;
    end loop;
    if not public.workout_plan_valid(converted_definition) then
      raise exception 'Invalid workout plan %: explicit integer rest from 0 to 3600 seconds required', plan.id;
    end if;
    if converted_definition is distinct from plan.definition then
      update public.workout_plan_versions set definition = converted_definition where id = plan.id;
    end if;
  end loop;
end;
$$;

commit;
