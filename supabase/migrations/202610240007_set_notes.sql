begin;

create or replace function public.valid_workout_measurements(p_day jsonb, p_steps jsonb, p_values jsonb, p_extra integer)
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
      or entry.value - array['weightKg','reps','seconds','notes'] <> '{}'::jsonb
      or (entry.value ? 'reps' and entry.value ? 'seconds') then return false; end if;
    for field in select jsonb_object_keys(entry.value) loop
      if field = 'notes' then
        if jsonb_typeof(entry.value->field) <> 'string'
          or char_length(entry.value->>field) > 1000 then return false; end if;
      else
        if jsonb_typeof(entry.value->field) <> 'number' then return false; end if;
        value := (entry.value->>field)::numeric;
        if value < 0 or value > (case when field = 'weightKg' then 2000 when field = 'seconds' then 86400 else 100000 end)
          or (field = 'weightKg' and trunc(value, 2) <> value)
          or (field <> 'weightKg' and trunc(value) <> value) then return false; end if;
      end if;
    end loop;
  end loop;
  return true;
end;
$$;

commit;
