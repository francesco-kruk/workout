begin;

create table public.manual_workouts (
  id uuid primary key,
  user_id uuid not null references public.friend_members(user_id) on delete cascade,
  plan_version_id uuid not null references public.workout_plan_versions(id) on delete cascade,
  session_id text not null,
  description text not null check (char_length(trim(description)) between 1 and 2000 and description !~ '^[[:space:]]*$'),
  replaces_planned boolean not null,
  electorate uuid[] not null check (cardinality(electorate) > 0),
  required_approvals integer not null check (required_approvals = cardinality(electorate) / 2 + 1),
  completed_at timestamptz not null default clock_timestamp(),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected')),
  decided_at timestamptz,
  reason text,
  check ((status = 'pending') = (decided_at is null))
);
create index manual_workouts_history on public.manual_workouts(user_id, completed_at desc, id desc);
create index manual_workouts_pending on public.manual_workouts(completed_at desc, id desc) where status = 'pending';

create table public.manual_workout_votes (
  workout_id uuid not null references public.manual_workouts(id) on delete cascade,
  voter_id uuid not null,
  approve boolean not null,
  created_at timestamptz not null default now(),
  primary key (workout_id, voter_id)
);

alter table public.manual_workouts enable row level security;
alter table public.manual_workout_votes enable row level security;
-- Read RPCs expose shared descriptions, never the referenced private plan/session.
revoke all on public.manual_workouts, public.manual_workout_votes from public, anon, authenticated;

create function public.manual_workout_summary(p_id uuid)
returns jsonb language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id', w.id, 'user_id', w.user_id, 'display_name', m.display_name,
    'description', w.description, 'replaces_planned', w.replaces_planned,
    'completed_at', w.completed_at, 'status', w.status, 'decided_at', w.decided_at,
    'reason', w.reason, 'voters', cardinality(w.electorate),
    'required_approvals', w.required_approvals,
    'approvals', (select count(*) from public.manual_workout_votes v where v.workout_id = w.id and v.approve),
    'rejections', (select count(*) from public.manual_workout_votes v where v.workout_id = w.id and not v.approve),
    'own_vote', (select approve from public.manual_workout_votes v where v.workout_id = w.id and v.voter_id = auth.uid()),
    'eligible', auth.uid() = any(w.electorate)
  )
  from public.manual_workouts w join public.friend_members m on m.user_id = w.user_id
  where w.id = p_id;
$$;

create function public.submit_manual_workout(
  p_id uuid, p_plan_version_id uuid, p_session_id text, p_description text, p_replaces_planned boolean
)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  existing public.manual_workouts;
  voters uuid[];
begin
  perform pg_advisory_xact_lock(7342330);
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if p_id is null or p_description is null or char_length(trim(p_description)) not between 1 and 2000
    or p_description ~ '^[[:space:]]*$' or p_replaces_planned is null then
    raise exception 'A description of 1 to 2000 characters and a progression choice are required' using errcode = '22023';
  end if;
  select * into existing from public.manual_workouts where id = p_id;
  if found then
    if existing.user_id = auth.uid() and existing.plan_version_id = p_plan_version_id
      and existing.session_id = p_session_id and existing.description = trim(p_description)
      and existing.replaces_planned = p_replaces_planned then
      return public.manual_workout_summary(p_id);
    end if;
    raise exception 'Submission ID already used' using errcode = '22023';
  end if;
  if not exists (
    select 1 from public.workout_plan_versions p,
      jsonb_array_elements(p.definition -> 'sessions') s
    where p.id = p_plan_version_id and p.user_id = auth.uid() and s ->> 'id' = p_session_id
  ) then raise exception 'Unknown personal plan or session' using errcode = '22023'; end if;
  if exists (select 1 from public.gym_attendance where event_id = p_id)
    or exists (select 1 from public.completed_workouts where id = p_id) then
    raise exception 'Submission ID already used' using errcode = '22023';
  end if;
  select array_agg(user_id order by user_id) into voters
    from public.friend_members where user_id <> auth.uid();
  if coalesce(cardinality(voters), 0) = 0 then
    raise exception 'At least one other member is required' using errcode = '22023';
  end if;
  insert into public.manual_workouts
    (id, user_id, plan_version_id, session_id, description, replaces_planned, electorate, required_approvals)
  values (p_id, auth.uid(), p_plan_version_id, p_session_id, trim(p_description),
    p_replaces_planned, voters, cardinality(voters) / 2 + 1);
  return public.manual_workout_summary(p_id);
end;
$$;

create function public.vote_manual_workout(p_id uuid, p_approve boolean)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  workout public.manual_workouts;
  previous_vote boolean;
  approvals integer;
  rejections integer;
begin
  perform pg_advisory_xact_lock(7342330);
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  select * into workout from public.manual_workouts where id = p_id for update;
  if not found then raise exception 'Unknown manual workout' using errcode = '22023'; end if;
  if auth.uid() = workout.user_id or not (auth.uid() = any(workout.electorate)) then
    raise exception 'Not eligible to vote' using errcode = '42501';
  end if;
  if p_approve is null then raise exception 'A vote is required' using errcode = '22023'; end if;
  select approve into previous_vote from public.manual_workout_votes
    where workout_id = p_id and voter_id = auth.uid();
  if found then
    if previous_vote = p_approve then return public.manual_workout_summary(p_id); end if;
    raise exception 'Votes cannot be changed' using errcode = '22023';
  end if;
  if workout.status <> 'pending' then raise exception 'Review is no longer pending' using errcode = '22023'; end if;
  insert into public.manual_workout_votes(workout_id, voter_id, approve) values (p_id, auth.uid(), p_approve);
  select count(*) filter (where approve), count(*) filter (where not approve)
    into approvals, rejections from public.manual_workout_votes where workout_id = p_id;
  if approvals >= workout.required_approvals then
    insert into public.gym_attendance(user_id, gym_date, event_id, completed_at)
    values (workout.user_id, (workout.completed_at at time zone 'Europe/Rome')::date, workout.id, workout.completed_at)
    on conflict (user_id, gym_date) do nothing;
    update public.manual_workouts set status = 'approved', decided_at = clock_timestamp() where id = p_id;
  elsif cardinality(workout.electorate) - rejections < workout.required_approvals then
    update public.manual_workouts set status = 'rejected', decided_at = clock_timestamp(),
      reason = 'majority_impossible' where id = p_id;
  end if;
  return public.manual_workout_summary(p_id);
end;
$$;

create function public.manual_workout_activity(
  p_own boolean default false, p_before_completed_at timestamptz default null, p_before_id uuid default null
)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if p_own is null or (p_before_completed_at is null) <> (p_before_id is null)
    or (p_before_completed_at is not null and not isfinite(p_before_completed_at)) then
    raise exception 'Invalid activity cursor' using errcode = '22023';
  end if;
  return coalesce((
    select jsonb_agg(public.manual_workout_summary(page.id) order by page.completed_at desc, page.id desc)
    from (
      select w.id, w.completed_at from public.manual_workouts w
      where (case when p_own then w.user_id = auth.uid()
        else w.status = 'pending' and auth.uid() = any(w.electorate)
          and not exists (select 1 from public.manual_workout_votes v where v.workout_id = w.id and v.voter_id = auth.uid())
        end)
        and (p_before_completed_at is null or (w.completed_at, w.id) < (p_before_completed_at, p_before_id))
      order by w.completed_at desc, w.id desc limit 20
    ) page
  ), '[]'::jsonb);
end;
$$;

create function public.manual_workout_membership_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(7342330);
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.user_id is distinct from new.user_id) then
    update public.manual_workouts set status = 'rejected', decided_at = clock_timestamp(), reason = 'voter_left'
      where status = 'pending' and old.user_id = any(electorate);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger manual_workout_membership_change before insert or update or delete on public.friend_members
  for each row execute function public.manual_workout_membership_change();

revoke all on function public.manual_workout_summary(uuid),
  public.submit_manual_workout(uuid,uuid,text,text,boolean), public.vote_manual_workout(uuid,boolean),
  public.manual_workout_activity(boolean,timestamptz,uuid), public.manual_workout_membership_change()
  from public, anon, authenticated;
grant execute on function public.submit_manual_workout(uuid,uuid,text,text,boolean),
  public.vote_manual_workout(uuid,boolean), public.manual_workout_activity(boolean,timestamptz,uuid)
  to authenticated;

commit;
