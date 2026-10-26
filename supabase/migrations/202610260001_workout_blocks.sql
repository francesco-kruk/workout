begin;

create function public.workout_block_integer(p jsonb, minimum integer, maximum integer)
returns boolean language plpgsql immutable set search_path = '' as $$
begin
  if jsonb_typeof(p) is distinct from 'number' then return false; end if;
  return (p::text)::numeric between minimum and maximum
    and trunc((p::text)::numeric) = (p::text)::numeric;
end;
$$;

create function public.workout_block_object(p jsonb, allowed text[], required_text text[] default '{}')
returns boolean language plpgsql immutable set search_path = '' as $$
declare field text;
begin
  if p is null or jsonb_typeof(p) <> 'object' or p - allowed <> '{}'::jsonb then return false; end if;
  foreach field in array required_text loop
    if jsonb_typeof(p->field) is distinct from 'string'
      or char_length(trim(p->>field)) not between 1 and 4000 then return false; end if;
  end loop;
  foreach field in array array['instructions','subtitle'] loop
    if p ? field and (jsonb_typeof(p->field) <> 'string'
      or char_length(p->>field) > 4000) then return false; end if;
  end loop;
  return true;
end;
$$;

create function public.workout_plan_valid_v3(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  day jsonb;
  block jsonb;
  slot jsonb;
  exercise jsonb;
  item jsonb;
  groups jsonb;
  fields text[];
  identifier text;
  ids text[] := '{}';
  work_count integer;
  exercise_count integer;
  minute_count integer;
  legacy_count integer;
begin
  if not public.workout_block_object(p, array['version','title','trackingId','warmup','sessions'], array['title'])
    or char_length(p::text) > 220000 or p->'version' is distinct from '3'::jsonb
    or jsonb_typeof(p->'warmup') is distinct from 'array'
    or jsonb_typeof(p->'sessions') is distinct from 'array' then return false; end if;
  if jsonb_array_length(p->'warmup') > 50
    or jsonb_array_length(p->'sessions') not between 1 and 30 then return false; end if;
  if p ? 'trackingId' and (jsonb_typeof(p->'trackingId') <> 'string'
    or p->>'trackingId' !~ '^[a-zA-Z0-9_-]{1,80}$') then return false; end if;
  for item in select value from jsonb_array_elements(p->'warmup') loop
    if not public.workout_block_object(item, array['id','name','target','instructions'], array['name','target'])
      then return false; end if;
  end loop;
  for day in select value from jsonb_array_elements(p->'sessions') loop
    if not public.workout_block_object(day, array['id','label','subtitle','instructions','blocks'], array['label'])
      or jsonb_typeof(day->'blocks') is distinct from 'array' then return false; end if;
    if jsonb_array_length(day->'blocks') not between 1 and 50 then return false; end if;
    work_count := jsonb_array_length(p->'warmup');
    exercise_count := 0;
    minute_count := 0;
    legacy_count := 0;
    for block in select value from jsonb_array_elements(day->'blocks') loop
      fields := array['id','label','instructions','type'];
      case block->>'type'
        when 'standard' then fields := fields || array['exercises'];
        when 'superset' then fields := fields || array['rounds','optionalRounds','restSeconds','exercises'];
        when 'amrap' then fields := fields || array['durationMinutes','exercises','legacyDayId'];
        when 'emom' then fields := fields || array['rounds','minutes'];
        else return false;
      end case;
      if not public.workout_block_object(block, fields, array['label']) then return false; end if;
      if block->>'type' = 'superset' then
        if not public.workout_block_integer(block->'rounds',1,30)
          or not public.workout_block_integer(block->'restSeconds',0,3600)
          or (block ? 'optionalRounds' and not public.workout_block_integer(block->'optionalRounds',0,30))
          then return false; end if;
      elsif block->>'type' = 'amrap' then
        if not public.workout_block_integer(block->'durationMinutes',1,180) then return false; end if;
        if block ? 'legacyDayId' then
          legacy_count := legacy_count + 1;
          if block->'legacyDayId' is distinct from day->'id' or legacy_count > 1 then return false; end if;
        end if;
      end if;
      if block->>'type' = 'emom' then
        if not public.workout_block_integer(block->'rounds',1,180)
          or jsonb_typeof(block->'minutes') is distinct from 'array' then return false; end if;
        if jsonb_array_length(block->'minutes') not between 1 and 50
          or (block->>'rounds')::integer * jsonb_array_length(block->'minutes') > 180 then return false; end if;
        minute_count := minute_count + jsonb_array_length(block->'minutes');
        groups := block->'minutes';
      else
        groups := jsonb_build_array(jsonb_build_object('exercises', block->'exercises'));
      end if;
      for slot in select value from jsonb_array_elements(groups) loop
        if block->>'type' = 'emom' and not public.workout_block_object(slot,array['id','exercises'])
          then return false; end if;
        if jsonb_typeof(slot->'exercises') is distinct from 'array' then return false; end if;
        if jsonb_array_length(slot->'exercises') not between
          (case when block->>'type' = 'superset' then 2 else 1 end) and 50 then return false; end if;
        for exercise in select value from jsonb_array_elements(slot->'exercises') loop
          fields := array['id','name','target','instructions'];
          if block->>'type' <> 'amrap' then fields := fields || array['measurementMode','usesWeight']; end if;
          if block->>'type' = 'standard' then fields := fields || array['sets','optionalSets','rest']; end if;
          if not public.workout_block_object(exercise, fields, array['name','target']) then return false; end if;
          if exercise ? 'measurementMode' and (jsonb_typeof(exercise->'measurementMode') <> 'string'
            or exercise->>'measurementMode' not in ('reps','seconds')) then return false; end if;
          if exercise ? 'usesWeight' and jsonb_typeof(exercise->'usesWeight') <> 'boolean' then return false; end if;
          exercise_count := exercise_count + 1;
          case block->>'type'
            when 'standard' then
              if not public.workout_block_integer(exercise->'sets',1,30)
                or not public.workout_block_integer(exercise->'rest',0,3600)
                or (exercise ? 'optionalSets' and not public.workout_block_integer(exercise->'optionalSets',0,30))
                then return false; end if;
              work_count := work_count + (exercise->>'sets')::integer + coalesce((exercise->>'optionalSets')::integer,0);
            when 'superset' then
              work_count := work_count + (block->>'rounds')::integer + coalesce((block->>'optionalRounds')::integer,0);
            when 'emom' then work_count := work_count + (block->>'rounds')::integer;
            else work_count := work_count + 1;
          end case;
        end loop;
      end loop;
    end loop;
    if exercise_count > 50 or minute_count > 50 or work_count > 1500 then return false; end if;
  end loop;
  for item in
    select value from jsonb_array_elements(p->'warmup')
    union all select value from jsonb_array_elements(p->'sessions')
    union all select b from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d->'blocks') b
    union all select s from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d->'blocks') b, lateral jsonb_array_elements(b->'minutes') s
    union all select e from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d->'blocks') b, lateral jsonb_array_elements(b->'exercises') e
    union all select e from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d->'blocks') b, lateral jsonb_array_elements(b->'minutes') s,
      lateral jsonb_array_elements(s->'exercises') e
  loop
    identifier := item->>'id';
    if jsonb_typeof(item->'id') is distinct from 'string' or identifier !~ '^[a-zA-Z][a-zA-Z0-9_-]{0,79}$'
      or identifier in ('warmup','__proto__','constructor','prototype')
      or identifier = any(ids) then return false; end if;
    ids := array_append(ids,identifier);
  end loop;
  return true;
end;
$$;

alter function public.workout_plan_valid(jsonb) rename to workout_plan_valid_legacy_v2;
create function public.workout_plan_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select case when p->'version' = '3'::jsonb then public.workout_plan_valid_v3(p)
    else public.workout_plan_valid_legacy_v2(p) end;
$$;
alter table public.workout_plan_versions drop constraint workout_plan_versions_definition_check;
alter table public.workout_plan_versions add constraint workout_plan_versions_definition_check
  check (public.workout_plan_valid(definition));

alter table public.completed_workouts add column block_results jsonb not null default '{}'::jsonb
  check (jsonb_typeof(block_results) = 'object' and char_length(block_results::text) <= 200000);

alter function public.workout_expected_steps(jsonb,text) rename to workout_expected_steps_v2;
create function public.workout_expected_steps(p_definition jsonb, p_session_id text)
returns table(step_key text, optional boolean)
language plpgsql immutable set search_path = '' as $$
begin
  if p_definition->'version' is distinct from '3'::jsonb then
    return query select * from public.workout_expected_steps_v2(p_definition,p_session_id);
    return;
  end if;
  return query
    with day as (
      select d from jsonb_array_elements(p_definition->'sessions') d where d->>'id' = p_session_id
    ), blocks as (select b from day, lateral jsonb_array_elements(d->'blocks') b)
    select 'warmup:' || (w->>'id'), false from jsonb_array_elements(p_definition->'warmup') w
      where exists (select 1 from day)
    union all
    select (b->>'id') || ':' || (b->>'type'), false from blocks where b->>'type' in ('amrap','emom')
    union all
    select (e->>'id') || ':' || n,
      n >= (case when b->>'type' = 'standard' then (e->>'sets')::integer else (b->>'rounds')::integer end)
    from blocks, lateral jsonb_array_elements(b->'exercises') e,
      lateral generate_series(0, case when b->>'type' = 'standard'
        then (e->>'sets')::integer + coalesce((e->>'optionalSets')::integer,0) - 1
        when b->>'type' = 'superset'
        then (b->>'rounds')::integer + coalesce((b->>'optionalRounds')::integer,0) - 1
        else -1 end) n
    where b->>'type' in ('standard','superset');
end;
$$;

create function public.workout_block_measurement_valid(exercise jsonb, p_values jsonb, required boolean)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  field text;
  value numeric;
  mode text := coalesce(exercise->>'measurementMode','reps');
  weighted boolean := coalesce((exercise->>'usesWeight')::boolean,false);
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object'
    or p_values - array[mode,'weightKg','notes'] <> '{}'::jsonb
    or (not weighted and p_values ? 'weightKg')
    or (required and (not (p_values ? mode) or (weighted and not (p_values ? 'weightKg'))))
    then return false; end if;
  for field in select jsonb_object_keys(p_values) loop
    if field = 'notes' then
      if jsonb_typeof(p_values->field) <> 'string' or char_length(p_values->>field) > 1000 then return false; end if;
    else
      if jsonb_typeof(p_values->field) <> 'number' then return false; end if;
      value := (p_values->>field)::numeric;
      if value < 0 or value > (case field when 'weightKg' then 2000 when 'seconds' then 86400 else 100000 end)
        or (field = 'weightKg' and trunc(value,2) <> value)
        or (field <> 'weightKg' and trunc(value) <> value) then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;

create function public.workout_block_results_valid(day jsonb, steps jsonb, measurements jsonb, results jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  block jsonb;
  exercise jsonb;
  result jsonb;
  minute jsonb;
  slot jsonb;
  entry record;
  n integer;
  count_rounds integer;
  expected_measurements integer := 0;
  expected_blocks integer := 0;
  status text;
begin
  if measurements is null or jsonb_typeof(measurements) <> 'object'
    or char_length(measurements::text) > 200000
    or results is null or jsonb_typeof(results) <> 'object'
    or char_length(results::text) > 200000 then return false; end if;
  for block in select value from jsonb_array_elements(day->'blocks') loop
    if block->>'type' in ('standard','superset') then
      if block->>'type' = 'superset' then
        for n in (block->>'rounds')::integer ..
          (block->>'rounds')::integer + coalesce((block->>'optionalRounds')::integer,0) - 1 loop
          select steps->>((e->>'id') || ':' || n) into status
            from jsonb_array_elements(block->'exercises') e limit 1;
          if exists (select 1 from jsonb_array_elements(block->'exercises') e
            where steps->>((e->>'id') || ':' || n) is distinct from status) then return false; end if;
        end loop;
      end if;
      for exercise in select value from jsonb_array_elements(block->'exercises') loop
        count_rounds := case when block->>'type' = 'standard'
          then (exercise->>'sets')::integer + coalesce((exercise->>'optionalSets')::integer,0)
          else (block->>'rounds')::integer + coalesce((block->>'optionalRounds')::integer,0) end;
        for n in 0 .. count_rounds - 1 loop
          if steps->>((exercise->>'id') || ':' || n) = 'completed' then
            expected_measurements := expected_measurements + 1;
            if not public.workout_block_measurement_valid(exercise,
              measurements->((exercise->>'id') || ':' || n),true) then return false; end if;
          end if;
        end loop;
      end loop;
    else
      expected_blocks := expected_blocks + 1;
      result := results->(block->>'id');
      if block->>'type' = 'amrap' then
        if not public.workout_block_object(result,array['rounds','extraReps'])
          or not public.workout_block_integer(result->'rounds',0,100000)
          or not (result ? 'extraReps')
          or (result->'extraReps' <> 'null'::jsonb
            and not public.workout_block_integer(result->'extraReps',0,100000)) then return false; end if;
      else
        if not public.workout_block_object(result,array['minutes'])
          or jsonb_typeof(result->'minutes') is distinct from 'object' then return false; end if;
        count_rounds := (block->>'rounds')::integer * jsonb_array_length(block->'minutes');
        if (select count(*) from jsonb_object_keys(result->'minutes')) <> count_rounds then return false; end if;
        for n in 0 .. count_rounds - 1 loop
          minute := result->'minutes'->n::text;
          if not public.workout_block_object(minute,array['status','measurements'])
            or minute->>'status' is null or minute->>'status' not in ('completed','missed')
            or jsonb_typeof(minute->'measurements') is distinct from 'object'
            then return false; end if;
          if minute->>'status' = 'missed' then
            if minute->'measurements' <> '{}'::jsonb then return false; end if;
          else
            slot := block->'minutes'->(n % jsonb_array_length(block->'minutes'));
            for entry in select * from jsonb_each(minute->'measurements') loop
              select e into exercise from jsonb_array_elements(slot->'exercises') e where e->>'id' = entry.key;
              if exercise is null or not public.workout_block_measurement_valid(exercise,entry.value,false)
                then return false; end if;
            end loop;
          end if;
        end loop;
      end if;
    end if;
  end loop;
  return (select count(*) from jsonb_object_keys(measurements)) = expected_measurements
    and (select count(*) from jsonb_object_keys(results)) = expected_blocks;
end;
$$;

-- Guard the shared legacy base as well as the public legacy entry point.
alter function public.submit_workout_result_base(uuid,uuid,timestamptz,uuid,text,jsonb,integer)
  rename to submit_workout_result_legacy_base;
create function public.submit_workout_result_base(
  p_user_id uuid, p_event_id uuid, p_completed_at timestamptz,
  p_plan_version_id uuid, p_session_id text, p_steps jsonb, p_amrap_rounds integer
) returns date language plpgsql security definer set search_path = '' as $$
begin
  if exists (select 1 from public.workout_plan_versions
    where id = p_plan_version_id and definition->'version' = '3'::jsonb) then
    raise exception 'Version 3 requires submit_workout_result_v3' using errcode = '22023';
  end if;
  return public.submit_workout_result_legacy_base(p_user_id,p_event_id,p_completed_at,
    p_plan_version_id,p_session_id,p_steps,p_amrap_rounds);
end;
$$;

create function public.submit_workout_result_v3(
  p_user_id uuid, p_event_id uuid, p_completed_at timestamptz,
  p_plan_version_id uuid, p_session_id text, p_steps jsonb,
  p_measurements jsonb default '{}'::jsonb, p_block_results jsonb default '{}'::jsonb
) returns date language plpgsql security definer set search_path = '' as $$
declare
  plan public.workout_plan_versions;
  day jsonb;
  existing public.completed_workouts;
  expected_count integer;
begin
  if p_user_id is distinct from auth.uid() or not public.is_friend_member() then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  if p_event_id is null or p_completed_at is null or not isfinite(p_completed_at) or p_completed_at > now() then
    raise exception 'Invalid completion timestamp or event ID' using errcode = '22023';
  end if;
  select * into plan from public.workout_plan_versions where id = p_plan_version_id and user_id = auth.uid();
  if not found or p_completed_at < plan.created_at then
    raise exception 'Unknown plan version or invalid completion date' using errcode = '22023';
  end if;
  if plan.definition->'version' is distinct from '3'::jsonb then
    raise exception 'Version 3 plan required' using errcode = '22023';
  end if;
  select d into day from jsonb_array_elements(plan.definition->'sessions') d where d->>'id' = p_session_id;
  if day is null or p_steps is null or jsonb_typeof(p_steps) <> 'object' or char_length(p_steps::text) > 200000 then
    raise exception 'Invalid session or steps' using errcode = '22023';
  end if;
  select count(*) into expected_count from public.workout_expected_steps(plan.definition,p_session_id);
  if (select count(*) from jsonb_object_keys(p_steps)) <> expected_count or exists (
    select 1 from public.workout_expected_steps(plan.definition,p_session_id) s
    where p_steps->>s.step_key is null or p_steps->>s.step_key not in ('completed','skipped')
      or (not s.optional and p_steps->>s.step_key <> 'completed')
  ) then raise exception 'Workout is not strictly complete' using errcode = '22023'; end if;
  if not public.workout_block_results_valid(day,p_steps,p_measurements,p_block_results) then
    raise exception 'Invalid workout block results or measurements' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text,0));
  insert into public.completed_workouts
    (id,user_id,plan_version_id,session_id,completed_at,steps,measurements,block_results)
    values (p_event_id,auth.uid(),p_plan_version_id,p_session_id,p_completed_at,p_steps,p_measurements,p_block_results)
    on conflict do nothing;
  select * into existing from public.completed_workouts where id = p_event_id;
  if existing.user_id is distinct from auth.uid() or existing.plan_version_id is distinct from p_plan_version_id
    or existing.session_id is distinct from p_session_id or existing.completed_at is distinct from p_completed_at
    or existing.steps is distinct from p_steps or existing.measurements is distinct from p_measurements
    or existing.block_results is distinct from p_block_results
    or existing.amrap_rounds is not null or existing.amrap_extra_reps is not null then
    raise exception 'Event ID already used with different workout results' using errcode = '22023';
  end if;
  return public.submit_gym_day(p_user_id,p_event_id,p_completed_at);
end;
$$;

create or replace function public.workout_history(
  p_before_completed_at timestamptz default null, p_before_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by completed_at desc,id desc),'[]'::jsonb)
  from (
    select w.id,w.completed_at,w.plan_version_id,w.session_id,w.steps,w.amrap_rounds,
      w.measurements,w.amrap_extra_reps,w.block_results,
      p.revision,p.definition->>'title' as plan_title,p.definition->'warmup' as warmup,
      (select d from jsonb_array_elements(p.definition->'sessions') d where d->>'id' = w.session_id) as session
    from public.completed_workouts w join public.workout_plan_versions p
      on p.id = w.plan_version_id and p.user_id = w.user_id
    where w.user_id = auth.uid() and (p_before_completed_at is null
      or (w.completed_at,w.id) < (p_before_completed_at,p_before_id))
    order by w.completed_at desc,id desc limit 20
  ) page;
$$;

create function public.workout_block_series_key(plan jsonb, day jsonb, block jsonb, exercise jsonb default null)
returns text language sql immutable set search_path = '' as $$
  select case block->>'type'
    when 'standard' then public.workout_series_key(plan,jsonb_build_object('type','standard'),exercise)
    when 'amrap' then public.workout_series_key(plan,jsonb_build_object(
      'id',coalesce(block->>'legacyDayId',block->>'id'),'type','amrap',
      'duration',block->>'durationMinutes','instructions',coalesce(block->>'instructions',''),
      'exercises',block->'exercises'))
    else md5(jsonb_build_array(coalesce(plan->>'trackingId','legacy'),block->>'type',block->>'id',
      coalesce(block->>'instructions',''),block->'rounds',
      case when block->>'type' = 'superset' then jsonb_build_array(
        coalesce(block->'optionalRounds','0'::jsonb),block->'restSeconds',block->'exercises',exercise->>'id')
        else block->'minutes' end)::text)
    end;
$$;

alter function public.workout_performance_entries() rename to workout_performance_entries_v2;
create function public.workout_performance_entries()
returns table(id uuid, completed_at timestamptz, series_key text, name text, kind text,
  context text, sets jsonb, rounds integer, extra_reps integer,
  max_weight numeric, max_reps numeric, max_seconds numeric)
language sql stable security invoker set search_path = '' as $$
  with workouts as (
    select w.*,p.definition,d as day,b as block
    from public.completed_workouts w join public.workout_plan_versions p on p.id = w.plan_version_id,
      lateral jsonb_array_elements(p.definition->'sessions') d,
      lateral jsonb_array_elements(d->'blocks') b
    where w.user_id = auth.uid() and p.definition->'version' = '3'::jsonb and d->>'id' = w.session_id
  )
  select * from public.workout_performance_entries_v2()
  union all
  select w.id,w.completed_at,public.workout_block_series_key(w.definition,w.day,w.block,e),
    e->>'name',w.block->>'type',
    case when w.block->>'type' = 'superset' then format('%s · %s giri (+%s) · recupero %s s',
      w.block->>'label',w.block->>'rounds',coalesce(w.block->>'optionalRounds','0'),w.block->>'restSeconds')
      else w.block->>'label' end,
    v.sets,null::integer,null::integer,v.max_weight,v.max_reps,v.max_seconds
  from workouts w,lateral jsonb_array_elements(w.block->'exercises') e,
    lateral (
      select jsonb_agg(jsonb_build_object('set',n+1) || (w.measurements->((e->>'id') || ':' || n)) order by n) as sets,
        max((w.measurements->((e->>'id') || ':' || n)->>'weightKg')::numeric) as max_weight,
        max((w.measurements->((e->>'id') || ':' || n)->>'reps')::numeric) as max_reps,
        max((w.measurements->((e->>'id') || ':' || n)->>'seconds')::numeric) as max_seconds
      from generate_series(0,case when w.block->>'type' = 'standard'
        then (e->>'sets')::integer + coalesce((e->>'optionalSets')::integer,0) - 1
        when w.block->>'type' = 'superset'
        then (w.block->>'rounds')::integer + coalesce((w.block->>'optionalRounds')::integer,0) - 1
        else -1 end) n
      where w.measurements ? ((e->>'id') || ':' || n)
    ) v
  where w.block->>'type' in ('standard','superset') and v.sets is not null
  union all
  select w.id,w.completed_at,public.workout_block_series_key(w.definition,w.day,w.block),
    w.block->>'label','amrap',(w.block->>'durationMinutes') || ' minuti','[]'::jsonb,
    (w.block_results->(w.block->>'id')->>'rounds')::integer,
    (w.block_results->(w.block->>'id')->>'extraReps')::integer,null,null,null
  from workouts w where w.block->>'type' = 'amrap'
  union all
  select w.id,w.completed_at,public.workout_block_series_key(w.definition,w.day,w.block),
    w.block->>'label','emom',format('%s giri × %s minuti · %s',w.block->>'rounds',
      jsonb_array_length(w.block->'minutes'),
      (select string_agg(schedule.description,' / ' order by schedule.n) from (
        select s.n,string_agg((e->>'name') || ' (' || (e->>'target') || ')',' + ' order by e.n) as description
        from jsonb_array_elements(w.block->'minutes') with ordinality s(slot,n),
          lateral jsonb_array_elements(s.slot->'exercises') with ordinality e(e,n)
        group by s.n
      ) schedule)),
    v.sets,v.completed,v.missed,null,null,null
  from workouts w,lateral (
    select jsonb_agg(jsonb_build_object('minute',m.key::integer,'names',(
        select jsonb_object_agg(e->>'id',e->>'name')
        from jsonb_array_elements(w.block->'minutes'->(m.key::integer % jsonb_array_length(w.block->'minutes'))->'exercises') e
      )) || m.value order by m.key::integer) as sets,
      count(*) filter (where m.value->>'status' = 'completed')::integer as completed,
      count(*) filter (where m.value->>'status' = 'missed')::integer as missed
    from jsonb_each(w.block_results->(w.block->>'id')->'minutes') m
  ) v where w.block->>'type' = 'emom';
$$;

create function public.workout_previous_v3(
  p_plan_version_id uuid, p_session_id text, p_block_id text default null, p_exercise_id text default null
) returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  plan jsonb;
  day jsonb;
  block jsonb;
  exercise jsonb;
  result jsonb;
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  select definition into plan from public.workout_plan_versions where id = p_plan_version_id and user_id = auth.uid();
  select d into day from jsonb_array_elements(plan->'sessions') d where d->>'id' = p_session_id;
  if plan is null or day is null then
    raise exception 'Unknown performance exercise or plan' using errcode = '22023';
  end if;
  if plan->'version' is distinct from '3'::jsonb then
    if p_block_id is not null and p_block_id <> p_session_id then
      raise exception 'Unknown performance block' using errcode = '22023';
    end if;
    return public.workout_previous(p_plan_version_id,p_session_id,p_exercise_id);
  end if;
  select b into block from jsonb_array_elements(day->'blocks') b
    where b->>'id' = p_block_id or (p_block_id is null and jsonb_array_length(day->'blocks') = 1);
  if p_exercise_id is not null then
    select e into exercise from jsonb_array_elements(block->'exercises') e where e->>'id' = p_exercise_id;
  end if;
  if block is null or (block->>'type' in ('standard','superset') and exercise is null)
    or (block->>'type' in ('amrap','emom') and p_exercise_id is not null) then
    raise exception 'Unknown performance block or exercise' using errcode = '22023';
  end if;
  select to_jsonb(e) into result from public.workout_performance_entries() e
    where e.series_key = public.workout_block_series_key(plan,day,block,exercise)
    order by e.completed_at desc,e.id desc limit 1;
  return result;
end;
$$;

revoke all on function public.workout_block_integer(jsonb,integer,integer),
  public.workout_block_object(jsonb,text[],text[]),public.workout_plan_valid_v3(jsonb),
  public.workout_plan_valid(jsonb),public.workout_expected_steps(jsonb,text),
  public.workout_block_measurement_valid(jsonb,jsonb,boolean),
  public.workout_block_results_valid(jsonb,jsonb,jsonb,jsonb),
  public.submit_workout_result_base(uuid,uuid,timestamptz,uuid,text,jsonb,integer),
  public.submit_workout_result_v3(uuid,uuid,timestamptz,uuid,text,jsonb,jsonb,jsonb),
  public.workout_block_series_key(jsonb,jsonb,jsonb,jsonb),public.workout_performance_entries(),
  public.workout_previous_v3(uuid,text,text,text) from public,anon,authenticated;
grant execute on function public.submit_workout_result_v3(uuid,uuid,timestamptz,uuid,text,jsonb,jsonb,jsonb),
  public.workout_block_series_key(jsonb,jsonb,jsonb,jsonb),public.workout_performance_entries(),
  public.workout_previous_v3(uuid,text,text,text) to authenticated;

commit;
