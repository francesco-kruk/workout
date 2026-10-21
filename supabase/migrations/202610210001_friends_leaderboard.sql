begin;

create table public.friend_group (
  id boolean primary key default true check (id),
  name text not null check (char_length(name) between 1 and 80)
);
insert into public.friend_group (name) values ('Amici in palestra');

create table public.friend_members (
  user_id uuid primary key references auth.users (id) on delete cascade,
  group_id boolean not null default true references public.friend_group (id),
  display_name text not null default 'Atleta'
    check (char_length(trim(display_name)) between 1 and 40),
  joined_at timestamptz not null default now()
);

create table public.gym_attendance (
  user_id uuid not null references public.friend_members (user_id) on delete cascade,
  gym_date date not null,
  event_id uuid not null unique,
  completed_at timestamptz not null,
  received_at timestamptz not null default now(),
  primary key (user_id, gym_date),
  check (gym_date = (completed_at at time zone 'Europe/Rome')::date)
);

alter table public.friend_group enable row level security;
alter table public.friend_members enable row level security;
alter table public.gym_attendance enable row level security;

create function public.is_friend_member()
returns boolean
language sql stable security definer
set search_path = ''
as $$
  select exists (
    select 1 from public.friend_members where user_id = auth.uid()
  );
$$;

create policy group_read on public.friend_group for select to authenticated
  using (public.is_friend_member());
create policy members_read on public.friend_members for select to authenticated
  using (public.is_friend_member());
create policy own_name_update on public.friend_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());
create policy attendance_read on public.gym_attendance for select to authenticated
  using (public.is_friend_member());

revoke all on public.friend_group, public.friend_members, public.gym_attendance
  from anon, authenticated;
grant select on public.friend_group, public.friend_members, public.gym_attendance
  to authenticated;
grant update (display_name) on public.friend_members to authenticated;

create function public.submit_gym_day(p_user_id uuid, p_event_id uuid, p_completed_at timestamptz)
returns date
language plpgsql security definer
set search_path = ''
as $$
declare
  member_id uuid := auth.uid();
  member_since timestamptz;
  completion_date date := (p_completed_at at time zone 'Europe/Rome')::date;
  existing public.gym_attendance;
begin
  select joined_at into member_since
  from public.friend_members where user_id = member_id;
  if member_id is null or member_since is null or p_user_id is distinct from member_id then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  if p_event_id is null or p_completed_at is null
    or not isfinite(p_completed_at)
    or p_completed_at > now()
    or p_completed_at < member_since then
    raise exception 'Invalid completion timestamp or event ID' using errcode = '22023';
  end if;

  insert into public.gym_attendance (user_id, gym_date, event_id, completed_at)
  values (member_id, completion_date, p_event_id, p_completed_at)
  on conflict do nothing;

  select * into existing from public.gym_attendance where event_id = p_event_id;
  if found and (existing.user_id <> member_id or existing.completed_at <> p_completed_at) then
    raise exception 'Event ID already used' using errcode = '22023';
  end if;
  return completion_date;
end;
$$;

create function public.friends_leaderboard()
returns table (
  user_id uuid,
  display_name text,
  points numeric,
  gym_days bigint,
  current_streak bigint,
  multiplier numeric,
  "position" bigint,
  month_start date
)
language plpgsql stable security definer
set search_path = ''
as $$
begin
  if not public.is_friend_member() then
    raise exception 'Membership required' using errcode = '42501';
  end if;
  return query
  with calendar as (
    select (now() at time zone 'Europe/Rome')::date as today,
      date_trunc('month', now() at time zone 'Europe/Rome')::date as first_day
  ), previous_days as (
    select a.user_id, a.gym_date,
      lag(a.gym_date) over (partition by a.user_id order by a.gym_date) as previous_date
    from public.gym_attendance a
  ), islands as (
    select p.*,
      sum(case when p.previous_date is null or p.gym_date - p.previous_date > 2
        then 1 else 0 end) over (partition by p.user_id order by p.gym_date) as streak_id
    from previous_days p
  ), streaks as (
    select i.user_id, i.gym_date,
      row_number() over (partition by i.user_id, i.streak_id order by i.gym_date) as streak_length
    from islands i
  ), totals as (
    select m.user_id, m.display_name, c.first_day,
      coalesce(sum(10 * least(3::numeric, 1 + (s.streak_length - 1) * 0.25))
        filter (where s.gym_date >= c.first_day and s.gym_date <= c.today), 0) as points,
      count(s.gym_date) filter (where s.gym_date >= c.first_day and s.gym_date <= c.today) as gym_days,
      case when c.today - max(s.gym_date) <= 2
        then coalesce((array_agg(s.streak_length order by s.gym_date desc)
          filter (where s.gym_date is not null))[1], 0)
        else 0 end as current_streak
    from public.friend_members m cross join calendar c
    left join streaks s on s.user_id = m.user_id
    group by m.user_id, m.display_name, c.first_day, c.today
  )
  select t.user_id, t.display_name, t.points, t.gym_days, t.current_streak,
    least(3::numeric, 1 + greatest(0, t.current_streak - 1) * 0.25) as multiplier,
    rank() over (order by t.points desc) as position, t.first_day as month_start
  from totals t
  order by t.points desc, t.display_name, t.user_id;
end;
$$;

revoke all on function public.is_friend_member(),
  public.submit_gym_day(uuid, uuid, timestamptz), public.friends_leaderboard()
  from public, anon;
grant execute on function public.is_friend_member(),
  public.submit_gym_day(uuid, uuid, timestamptz), public.friends_leaderboard()
  to authenticated;

commit;
