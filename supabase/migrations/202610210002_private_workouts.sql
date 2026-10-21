begin;

create function public.workout_plan_valid(p jsonb)
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
  if jsonb_array_length(p->'warmup') not between 1 and 50
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

create table public.workout_plan_versions (
  id uuid primary key,
  user_id uuid not null references public.friend_members(user_id) on delete cascade,
  revision integer not null check (revision > 0),
  definition jsonb not null check (public.workout_plan_valid(definition)),
  created_at timestamptz not null default now(),
  unique (user_id, revision),
  unique (user_id, id)
);

create table public.completed_workouts (
  id uuid primary key,
  user_id uuid not null references public.friend_members(user_id) on delete cascade,
  plan_version_id uuid not null,
  session_id text not null,
  completed_at timestamptz not null,
  steps jsonb not null check (jsonb_typeof(steps) = 'object'),
  amrap_rounds integer,
  received_at timestamptz not null default now(),
  foreign key (user_id, plan_version_id)
    references public.workout_plan_versions(user_id, id)
);
create index completed_workouts_history on public.completed_workouts
  (user_id, completed_at desc, id desc);

alter table public.workout_plan_versions enable row level security;
alter table public.completed_workouts enable row level security;
create policy own_plans_read on public.workout_plan_versions for select to authenticated
  using (user_id = auth.uid());
create policy own_history_read on public.completed_workouts for select to authenticated
  using (user_id = auth.uid());
revoke all on public.workout_plan_versions, public.completed_workouts from anon, authenticated;
grant select on public.workout_plan_versions, public.completed_workouts to authenticated;

create function public.save_workout_plan(
  p_user_id uuid, p_version_id uuid, p_base_version_id uuid, p_definition jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  latest public.workout_plan_versions;
  saved public.workout_plan_versions;
begin
  if p_user_id is distinct from auth.uid() or not public.is_friend_member() then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  perform 1 from public.friend_members where user_id = auth.uid() for update;
  if p_version_id is null or not public.workout_plan_valid(p_definition) then
    raise exception 'Invalid workout plan' using errcode = '22023';
  end if;
  select * into latest from public.workout_plan_versions
    where user_id = auth.uid() order by revision desc limit 1;
  select * into saved from public.workout_plan_versions where id = p_version_id;
  if found then
    if saved.user_id = auth.uid() and saved.definition = p_definition and latest.id = saved.id then
      return to_jsonb(saved);
    end if;
    raise exception 'Version ID already used or superseded' using errcode = '40001';
  end if;
  if latest.id is distinct from p_base_version_id then
    raise exception 'Plan changed on another device. Reload before saving.' using errcode = '40001';
  end if;
  insert into public.workout_plan_versions(id, user_id, revision, definition)
    values (p_version_id, auth.uid(), coalesce(latest.revision, 0) + 1, p_definition)
    returning * into saved;
  return to_jsonb(saved);
end;
$$;

create function public.workout_expected_steps(p_definition jsonb, p_session_id text)
returns table (step_key text, optional boolean)
language sql immutable set search_path = '' as $$
  with day as (
    select value as definition from jsonb_array_elements(p_definition->'sessions')
      where value->>'id' = p_session_id
  )
  select 'warmup:' || (value->>'id'), false
    from jsonb_array_elements(p_definition->'warmup') where exists (select 1 from day)
  union all
  select p_session_id || ':amrap', false from day where definition->>'type' = 'amrap'
  union all
  select (e.value->>'id') || ':' || n,
    case when d.definition->>'type' = 'standard' then n >= (e.value->>'sets')::integer else false end
    from day d, lateral jsonb_array_elements(d.definition->'exercises') e,
    lateral generate_series(0, case when d.definition->>'type' = 'standard'
      then (e.value->>'sets')::integer + coalesce((e.value->>'optionalSets')::integer, 0) - 1 else -1 end) n
    where d.definition->>'type' = 'standard';
$$;

create function public.submit_workout_result(
  p_user_id uuid, p_event_id uuid, p_completed_at timestamptz,
  p_plan_version_id uuid, p_session_id text, p_steps jsonb, p_amrap_rounds integer
) returns date language plpgsql security definer set search_path = '' as $$
declare
  plan public.workout_plan_versions;
  day jsonb;
  existing public.completed_workouts;
  expected_count integer;
  completion_date date;
begin
  if p_user_id is distinct from auth.uid() or not public.is_friend_member() then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  if p_event_id is null or p_completed_at is null or not isfinite(p_completed_at) or p_completed_at > now() then
    raise exception 'Invalid completion timestamp or event ID' using errcode = '22023';
  end if;
  select * into plan from public.workout_plan_versions
    where id = p_plan_version_id and user_id = auth.uid();
  if not found or p_completed_at < plan.created_at then
    raise exception 'Unknown plan version or invalid completion date' using errcode = '22023';
  end if;
  select value into day from jsonb_array_elements(plan.definition->'sessions')
    where value->>'id' = p_session_id;
  if day is null or p_steps is null or jsonb_typeof(p_steps) <> 'object' then
    raise exception 'Invalid session or steps' using errcode = '22023';
  end if;
  select count(*) into expected_count from public.workout_expected_steps(plan.definition, p_session_id);
  if (select count(*) from jsonb_object_keys(p_steps)) <> expected_count or exists (
    select 1 from public.workout_expected_steps(plan.definition, p_session_id) s
    where (p_steps->>s.step_key) is null
      or (p_steps->>s.step_key) not in ('completed', 'skipped')
      or (not s.optional and p_steps->>s.step_key <> 'completed')
  ) then
    raise exception 'Workout is not strictly complete' using errcode = '22023';
  end if;
  if (day->>'type' = 'standard' and p_amrap_rounds is not null)
    or (day->>'type' = 'amrap' and (p_amrap_rounds is null or p_amrap_rounds not between 0 and 100000)) then
    raise exception 'Invalid AMRAP result' using errcode = '22023';
  end if;
  insert into public.completed_workouts
    (id, user_id, plan_version_id, session_id, completed_at, steps, amrap_rounds)
  values (p_event_id, auth.uid(), p_plan_version_id, p_session_id, p_completed_at, p_steps, p_amrap_rounds)
  on conflict do nothing;
  select * into existing from public.completed_workouts where id = p_event_id;
  if existing.user_id is distinct from auth.uid()
    or existing.plan_version_id is distinct from p_plan_version_id
    or existing.session_id is distinct from p_session_id
    or existing.completed_at is distinct from p_completed_at
    or existing.steps is distinct from p_steps
    or existing.amrap_rounds is distinct from p_amrap_rounds then
    raise exception 'Event ID already used' using errcode = '22023';
  end if;
  completion_date := public.submit_gym_day(p_user_id, p_event_id, p_completed_at);
  return completion_date;
end;
$$;

create function public.workout_history(
  p_before_completed_at timestamptz default null, p_before_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by completed_at desc, id desc), '[]'::jsonb)
  from (
    select w.id, w.completed_at, w.plan_version_id, w.session_id, w.steps, w.amrap_rounds,
      p.revision, p.definition->>'title' as plan_title, p.definition->'warmup' as warmup,
      (select value from jsonb_array_elements(p.definition->'sessions')
        where value->>'id' = w.session_id) as session
    from public.completed_workouts w join public.workout_plan_versions p
      on p.id = w.plan_version_id and p.user_id = w.user_id
    where w.user_id = auth.uid() and (p_before_completed_at is null
      or (w.completed_at, w.id) < (p_before_completed_at, p_before_id))
    order by w.completed_at desc, w.id desc limit 20
  ) page;
$$;

revoke all on function public.workout_plan_valid(jsonb),
  public.workout_expected_steps(jsonb, text),
  public.save_workout_plan(uuid, uuid, uuid, jsonb),
  public.submit_workout_result(uuid, uuid, timestamptz, uuid, text, jsonb, integer),
  public.workout_history(timestamptz, uuid) from public, anon;
grant execute on function public.save_workout_plan(uuid, uuid, uuid, jsonb),
  public.submit_workout_result(uuid, uuid, timestamptz, uuid, text, jsonb, integer),
  public.workout_history(timestamptz, uuid) to authenticated;

commit;
