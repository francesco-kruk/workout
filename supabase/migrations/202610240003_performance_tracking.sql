begin;

alter function public.workout_plan_valid(jsonb) rename to workout_plan_valid_v2;
create function public.workout_plan_valid(p jsonb)
returns boolean language sql immutable set search_path = '' as $$
  select public.workout_plan_valid_v2(p) and (not (p ? 'trackingId')
    or (jsonb_typeof(p->'trackingId') = 'string'
      and p->>'trackingId' ~ '^[a-zA-Z0-9_-]{1,80}$'));
$$;
alter table public.workout_plan_versions drop constraint workout_plan_versions_definition_check;
alter table public.workout_plan_versions add check (public.workout_plan_valid(definition));

alter table public.completed_workouts
  add column measurements jsonb not null default '{}'::jsonb,
  add column amrap_extra_reps integer check (amrap_extra_reps between 0 and 100000);

create function public.valid_workout_measurements(p_day jsonb, p_steps jsonb, p_values jsonb, p_extra integer)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  entry record;
  field text;
  value numeric;
begin
  if p_values is null or jsonb_typeof(p_values) <> 'object' or char_length(p_values::text) > 200000 then return false; end if;
  if p_day->>'type' = 'amrap' then
    return p_values = '{}'::jsonb and (p_extra is null or p_extra between 0 and 100000);
  end if;
  if p_extra is not null then return false; end if;
  for entry in select * from jsonb_each(p_values) loop
    if p_steps->>entry.key is distinct from 'completed'
      or not exists (
        select 1 from jsonb_array_elements(p_day->'exercises') e,
          generate_series(0, (e->>'sets')::integer + coalesce((e->>'optionalSets')::integer, 0) - 1) n
        where entry.key = (e->>'id') || ':' || n
      ) or jsonb_typeof(entry.value) <> 'object' or entry.value = '{}'::jsonb
      or entry.value - array['weightKg','reps','seconds'] <> '{}'::jsonb
      or (entry.value ? 'reps' and entry.value ? 'seconds') then return false; end if;
    for field in select jsonb_object_keys(entry.value) loop
      if jsonb_typeof(entry.value->field) <> 'number' then return false; end if;
      value := (entry.value->>field)::numeric;
      if value < 0 or value > (case when field = 'weightKg' then 2000 when field = 'seconds' then 86400 else 100000 end)
        or (field = 'weightKg' and trunc(value, 2) <> value)
        or (field <> 'weightKg' and trunc(value) <> value) then return false; end if;
    end loop;
  end loop;
  return true;
end;
$$;

alter function public.submit_workout_result(uuid,uuid,timestamptz,uuid,text,jsonb,integer)
  rename to submit_workout_result_base;
revoke all on function public.submit_workout_result_base(uuid,uuid,timestamptz,uuid,text,jsonb,integer)
  from public, anon, authenticated;

create function public.submit_workout_result(
  p_user_id uuid, p_event_id uuid, p_completed_at timestamptz,
  p_plan_version_id uuid, p_session_id text, p_steps jsonb, p_amrap_rounds integer,
  p_measurements jsonb default '{}'::jsonb, p_amrap_extra_reps integer default null
) returns date language plpgsql security definer set search_path = '' as $$
declare
  day jsonb;
  existing public.completed_workouts;
  completion_date date;
begin
  if p_user_id is distinct from auth.uid() or not public.is_friend_member() then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  if not exists (select 1 from public.workout_plan_versions
    where id = p_plan_version_id and user_id = auth.uid()) then
    raise exception 'Unknown plan version' using errcode = '22023';
  end if;
  select d into day from public.workout_plan_versions p,
    lateral jsonb_array_elements(p.definition->'sessions') d
    where p.id = p_plan_version_id and p.user_id = auth.uid() and d->>'id' = p_session_id;
  if day is null then raise exception 'Invalid session or steps' using errcode = '22023'; end if;
  if not public.valid_workout_measurements(day, p_steps, p_measurements, p_amrap_extra_reps) then
    raise exception 'Invalid actual workout measurements' using errcode = '22023';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_event_id::text, 0));
  select * into existing from public.completed_workouts where id = p_event_id;
  if found and (existing.measurements is distinct from p_measurements
    or existing.amrap_extra_reps is distinct from p_amrap_extra_reps) then
    raise exception 'Event ID already used with different measurements' using errcode = '22023';
  end if;
  completion_date := public.submit_workout_result_base(p_user_id,p_event_id,p_completed_at,
    p_plan_version_id,p_session_id,p_steps,p_amrap_rounds);
  update public.completed_workouts set measurements = p_measurements, amrap_extra_reps = p_amrap_extra_reps
    where id = p_event_id and user_id = auth.uid();
  return completion_date;
end;
$$;

create or replace function public.workout_history(
  p_before_completed_at timestamptz default null, p_before_id uuid default null
) returns jsonb language sql stable security invoker set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(page) order by completed_at desc, id desc), '[]'::jsonb)
  from (
    select w.id, w.completed_at, w.plan_version_id, w.session_id, w.steps, w.amrap_rounds,
      w.measurements, w.amrap_extra_reps,
      p.revision, p.definition->>'title' as plan_title, p.definition->'warmup' as warmup,
      (select value from jsonb_array_elements(p.definition->'sessions') where value->>'id' = w.session_id) as session
    from public.completed_workouts w join public.workout_plan_versions p
      on p.id = w.plan_version_id and p.user_id = w.user_id
    where w.user_id = auth.uid() and (p_before_completed_at is null
      or (w.completed_at, w.id) < (p_before_completed_at, p_before_id))
    order by w.completed_at desc, w.id desc limit 20
  ) page;
$$;

create function public.workout_series_key(p_plan jsonb, p_day jsonb, p_exercise jsonb default null)
returns text language sql immutable set search_path = '' as $$
  select md5(jsonb_build_array(coalesce(p_plan->>'trackingId', 'legacy'), p_day->>'type',
    case when p_exercise is not null then
      jsonb_build_array(p_exercise->>'id', p_exercise->>'name', coalesce(p_exercise->>'instructions',''))
    else jsonb_build_array(p_day->>'id', split_part(p_day->>'duration',' ',1),
      coalesce(p_day->>'instructions',''), (select jsonb_agg(jsonb_build_array(
        e->>'id', e->>'name', e->>'target', coalesce(e->>'instructions','')) order by n)
        from jsonb_array_elements(p_day->'exercises') with ordinality t(e,n))) end)::text);
$$;

create function public.workout_performance_entries()
returns table(id uuid, completed_at timestamptz, series_key text, name text, kind text,
  context text, sets jsonb, rounds integer, extra_reps integer,
  max_weight numeric, max_reps numeric, max_seconds numeric)
language sql stable security invoker set search_path = '' as $$
  with workouts as (
    select w.*, p.definition,
      (select d from jsonb_array_elements(p.definition->'sessions') d where d->>'id' = w.session_id) as day
    from public.completed_workouts w join public.workout_plan_versions p on p.id = w.plan_version_id
    where w.user_id = auth.uid()
  )
  select w.id, w.completed_at, public.workout_series_key(w.definition,w.day,e),
    e->>'name', 'standard', w.day->>'label', v.sets, null::integer, null::integer,
    v.max_weight, v.max_reps, v.max_seconds
  from workouts w, lateral jsonb_array_elements(w.day->'exercises') e,
    lateral (
      select jsonb_agg(jsonb_build_object('set', n + 1) || w.measurements->((e->>'id') || ':' || n) order by n) as sets,
        max((w.measurements->((e->>'id') || ':' || n)->>'weightKg')::numeric) as max_weight,
        max((w.measurements->((e->>'id') || ':' || n)->>'reps')::numeric) as max_reps,
        max((w.measurements->((e->>'id') || ':' || n)->>'seconds')::numeric) as max_seconds
      from generate_series(0, (e->>'sets')::integer + coalesce((e->>'optionalSets')::integer,0) - 1) n
      where w.measurements ? ((e->>'id') || ':' || n)
    ) v
  where w.day->>'type' = 'standard' and v.sets is not null
  union all
  select w.id, w.completed_at, public.workout_series_key(w.definition,w.day),
    coalesce(nullif(w.day->>'subtitle',''), w.day->>'label'), 'amrap',
    w.day->>'duration', '[]'::jsonb, w.amrap_rounds, w.amrap_extra_reps, null, null, null
  from workouts w where w.day->>'type' = 'amrap';
$$;

create function public.workout_performance(p_series text default null,
  p_before_completed_at timestamptz default null, p_before_id uuid default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if (p_before_completed_at is null) <> (p_before_id is null)
    or (p_series is not null and p_series !~ '^[a-f0-9]{32}$') then
    raise exception 'Invalid performance cursor or series' using errcode = '22023';
  end if;
  return (
    with entries as materialized (select * from public.workout_performance_entries()),
    series as (
      select series_key, max(name) as name, kind, max(context) as context, count(*) as workouts,
        max(max_weight) as best_weight, max(max_reps) as best_reps, max(max_seconds) as best_seconds,
        max(rounds) as best_rounds,
        (array_agg(jsonb_build_object('rounds',rounds,'extra_reps',extra_reps)
          order by rounds desc nulls last, coalesce(extra_reps,0) desc, completed_at desc))[1] as best_amrap
      from entries group by series_key, kind
    ), selected as (
      select e.* from entries e where e.series_key = coalesce(p_series,
        (select s.series_key from series s order by s.name,s.series_key limit 1))
        and (p_before_completed_at is null or (e.completed_at,e.id) < (p_before_completed_at,p_before_id))
      order by completed_at desc,id desc limit 21
    ), page as (select * from selected order by completed_at desc,id desc limit 20)
    select jsonb_build_object(
      'series', coalesce((select jsonb_agg(to_jsonb(s) order by name,series_key) from series s),'[]'::jsonb),
      'results', coalesce((select jsonb_agg(to_jsonb(p) order by completed_at desc,id desc) from page p),'[]'::jsonb),
      'more', (select count(*) > 20 from selected))
  );
end;
$$;

create function public.workout_previous(p_plan_version_id uuid, p_session_id text, p_exercise_id text default null)
returns jsonb language plpgsql stable security invoker set search_path = '' as $$
declare
  plan jsonb;
  day jsonb;
  exercise jsonb;
  result jsonb;
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  select definition into plan from public.workout_plan_versions where id = p_plan_version_id and user_id = auth.uid();
  select d into day from jsonb_array_elements(plan->'sessions') d where d->>'id' = p_session_id;
  if p_exercise_id is not null then
    select e into exercise from jsonb_array_elements(day->'exercises') e where e->>'id' = p_exercise_id;
  end if;
  if day is null or (day->>'type' = 'standard' and exercise is null)
    or (day->>'type' = 'amrap' and p_exercise_id is not null) then
    raise exception 'Unknown performance exercise or plan' using errcode = '22023';
  end if;
  select to_jsonb(e) into result from public.workout_performance_entries() e
    where e.series_key = public.workout_series_key(plan,day,exercise)
    order by completed_at desc,id desc limit 1;
  return result;
end;
$$;

revoke all on function public.workout_plan_valid_v2(jsonb), public.workout_plan_valid(jsonb),
  public.valid_workout_measurements(jsonb,jsonb,jsonb,integer),
  public.submit_workout_result(uuid,uuid,timestamptz,uuid,text,jsonb,integer,jsonb,integer),
  public.workout_series_key(jsonb,jsonb,jsonb), public.workout_performance_entries(),
  public.workout_performance(text,timestamptz,uuid), public.workout_previous(uuid,text,text)
  from public, anon, authenticated;
grant execute on function public.submit_workout_result(uuid,uuid,timestamptz,uuid,text,jsonb,integer,jsonb,integer),
  public.workout_series_key(jsonb,jsonb,jsonb), public.workout_performance_entries(),
  public.workout_performance(text,timestamptz,uuid), public.workout_previous(uuid,text,text) to authenticated;

commit;
