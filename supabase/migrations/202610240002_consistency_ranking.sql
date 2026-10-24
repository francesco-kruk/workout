begin;

create table public.consistency_settings (
  id boolean primary key default true check (id),
  starts_on date not null
);
insert into public.consistency_settings(starts_on)
values ((now() at time zone 'Europe/Rome')::date);
alter table public.consistency_settings enable row level security;
revoke all on public.consistency_settings from public, anon, authenticated;

drop function public.friends_leaderboard(date);
drop function public.ranking_scores(date, date);
drop function public.ranking_weeks(date);
drop function public.ranking_objectives();
drop function public.propose_ranking_objectives(uuid, jsonb);
drop function public.vote_ranking_objectives(uuid, boolean);
drop function public.withdraw_ranking_objectives(uuid);
drop trigger ranking_membership_change on public.friend_members;
drop function public.ranking_membership_change();
drop type public.ranking_score;
revoke all on public.ranking_settings, public.ranking_proposals, public.ranking_votes from authenticated;

create function public.consistency_weeks(p_today date)
returns table(user_id uuid, week_start date, active_weeks bigint, multiplier numeric)
language sql stable security definer set search_path = '' as $$
  with weeks as (
    select d::date as week_start from public.consistency_settings s,
      generate_series(date_trunc('week', s.starts_on::timestamp),
        date_trunc('week', p_today::timestamp), interval '7 days') d
  ), attendance as (
    select a.user_id, date_trunc('week', a.gym_date::timestamp)::date as week_start
    from public.gym_attendance a, public.consistency_settings s
    where a.gym_date >= s.starts_on and a.gym_date <= p_today
    group by a.user_id, date_trunc('week', a.gym_date::timestamp)::date
  ), gaps as (
    select m.user_id, w.week_start, a.user_id is not null as active,
      sum(case when a.user_id is null then 1 else 0 end)
        over (partition by m.user_id order by w.week_start) as gap
    from public.friend_members m cross join weeks w
    left join attendance a on a.user_id = m.user_id and a.week_start = w.week_start
  ), streaks as (
    select g.*, count(*) filter (where active)
      over (partition by user_id, gap order by week_start) as active_weeks
    from gaps g
  )
  select user_id, week_start, active_weeks,
    least(3::numeric, 1 + greatest(0, active_weeks - 1) * 0.25) from streaks;
$$;

create function public.consistency_scores(p_today date, p_month date default null)
returns table(user_id uuid, display_name text, points numeric, gym_days bigint,
  "position" bigint, month_start date, weekly_streak bigint, multiplier numeric,
  week_start date, starts_on date)
language sql stable security definer set search_path = '' as $$
  with calendar as (
    select date_trunc('month', coalesce(p_month, p_today)::timestamp)::date as month_start,
      date_trunc('week', p_today::timestamp)::date as week_start, starts_on
    from public.consistency_settings
  ), weeks as (
    select * from public.consistency_weeks(p_today)
  ), totals as (
    select m.user_id, m.display_name, count(a.gym_date) as gym_days,
      coalesce(sum(10 * coalesce(w.multiplier, 1)) filter (where a.gym_date is not null), 0) as points
    from public.friend_members m cross join calendar c
    left join public.gym_attendance a on a.user_id = m.user_id
      and a.gym_date >= c.month_start and a.gym_date < (c.month_start + interval '1 month')::date
      and a.gym_date <= p_today
    left join weeks w on w.user_id = a.user_id and w.week_start = date_trunc('week', a.gym_date::timestamp)::date
      and a.gym_date >= c.starts_on
    group by m.user_id, m.display_name
  ), results as (
    select t.*, c.month_start, c.week_start, c.starts_on,
      coalesce(nullif(w.active_weeks, 0), previous.active_weeks, 0) as weekly_streak
    from totals t cross join calendar c
    left join weeks w on w.user_id = t.user_id and w.week_start = c.week_start
    left join weeks previous on previous.user_id = t.user_id and previous.week_start = c.week_start - 7
  )
  select r.user_id, r.display_name, r.points, r.gym_days, rank() over(order by r.points desc),
    r.month_start, r.weekly_streak, least(3::numeric, 1 + greatest(0, r.weekly_streak - 1) * 0.25),
    r.week_start, r.starts_on
  from results r order by r.points desc, r.display_name, r.user_id;
$$;

create function public.friends_leaderboard(p_month date default null)
returns table(user_id uuid, display_name text, points numeric, gym_days bigint,
  "position" bigint, month_start date, weekly_streak bigint, multiplier numeric,
  week_start date, starts_on date)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if p_month is not null and (not isfinite(p_month)
    or p_month <> date_trunc('month', p_month::timestamp)::date
    or p_month > (now() at time zone 'Europe/Rome')::date) then
    raise exception 'Invalid ranking month' using errcode = '22023';
  end if;
  return query select * from public.consistency_scores((now() at time zone 'Europe/Rome')::date, p_month);
end;
$$;

revoke all on function public.consistency_weeks(date), public.consistency_scores(date,date),
  public.friends_leaderboard(date) from public, anon, authenticated;
grant execute on function public.friends_leaderboard(date) to authenticated;

commit;
