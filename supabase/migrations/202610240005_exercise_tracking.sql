begin;

create or replace function public.workout_plan_valid(p jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  exercise jsonb;
begin
  if not public.workout_plan_valid_v2(p) then return false; end if;
  if p ? 'trackingId' and (jsonb_typeof(p->'trackingId') <> 'string'
    or p->>'trackingId' !~ '^[a-zA-Z0-9_-]{1,80}$') then return false; end if;
  for exercise in
    select e.value from jsonb_array_elements(p->'sessions') d,
      lateral jsonb_array_elements(d.value->'exercises') e
  loop
    if exercise ? 'measurementMode' and (jsonb_typeof(exercise->'measurementMode') <> 'string'
      or exercise->>'measurementMode' not in ('reps', 'seconds')) then return false; end if;
    if exercise ? 'usesWeight' and jsonb_typeof(exercise->'usesWeight') <> 'boolean' then return false; end if;
  end loop;
  return true;
end;
$$;

commit;
