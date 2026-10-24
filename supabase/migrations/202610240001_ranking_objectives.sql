begin;

create table public.ranking_settings (
  id boolean primary key default true check (id),
  cutover date not null check (extract(isodow from cutover) = 1)
);
insert into public.ranking_settings (cutover)
values (date_trunc('week', now() at time zone 'Europe/Rome')::date + 7);

create function public.valid_ranking_objectives(p_rules jsonb)
returns boolean language plpgsql immutable set search_path = '' as $$
declare
  kind text;
  goal jsonb;
  value numeric;
  field text;
begin
  if p_rules is null or jsonb_typeof(p_rules) <> 'object'
    or p_rules = '{}'::jsonb then return false; end if;
  for kind, goal in select * from jsonb_each(p_rules) loop
    if kind not in ('streak', 'count', 'schedule') or jsonb_typeof(goal) <> 'object' then
      return false;
    end if;
    if kind = 'streak' then
      if not (goal ?& array['step', 'cap']) or goal - array['step', 'cap'] <> '{}'::jsonb then return false; end if;
    else
      if not (goal ?& array['days', 'bonus']) or goal - array['days', 'bonus'] <> '{}'::jsonb then return false; end if;
    end if;
    for field in select unnest(case when kind = 'streak' then array['step', 'cap'] else array['bonus'] end) loop
      if jsonb_typeof(goal -> field) <> 'number' then return false; end if;
      value := (goal ->> field)::numeric;
      if value < 0.01 or value > 999.99 or trunc(value, 2) <> value then return false; end if;
    end loop;
    if kind = 'streak' and (goal ->> 'cap')::numeric < (goal ->> 'step')::numeric then return false; end if;
    if kind = 'count' then
      if jsonb_typeof(goal -> 'days') <> 'number' then return false; end if;
      value := (goal ->> 'days')::numeric;
      if value < 1 or value > 7 or trunc(value) <> value then return false; end if;
    elsif kind = 'schedule' then
      if jsonb_typeof(goal -> 'days') <> 'array' then return false; end if;
      if jsonb_array_length(goal -> 'days') not between 1 and 7 then return false; end if;
      for goal in select v from jsonb_array_elements(goal -> 'days') as e(v) loop
        if jsonb_typeof(goal) <> 'number' then return false; end if;
        value := goal::numeric;
        if value < 1 or value > 7 or trunc(value) <> value then return false; end if;
      end loop;
      if (select count(distinct (v::numeric)) from jsonb_array_elements(p_rules #> '{schedule,days}') as e(v))
        <> jsonb_array_length(p_rules #> '{schedule,days}') then return false; end if;
    end if;
  end loop;
  return true;
end;
$$;

create table public.ranking_proposals (
  id uuid primary key,
  user_id uuid not null references public.friend_members(user_id) on delete cascade,
  rules jsonb not null check (public.valid_ranking_objectives(rules)),
  electorate uuid[] not null check (cardinality(electorate) > 0),
  voter_names jsonb not null,
  required_approvals integer not null check (required_approvals > 0),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'withdrawn', 'invalidated')),
  reason text,
  created_at timestamptz not null default now(),
  decided_at timestamptz,
  effective_from date,
  check ((status = 'approved') = (effective_from is not null)),
  check (effective_from is null or extract(isodow from effective_from) = 1)
);
create unique index ranking_one_pending on public.ranking_proposals(user_id) where status = 'pending';
create unique index ranking_one_version_per_week on public.ranking_proposals(user_id, effective_from) where status = 'approved';
create table public.ranking_votes (
  proposal_id uuid not null references public.ranking_proposals(id) on delete cascade,
  voter_id uuid not null,
  approve boolean not null,
  created_at timestamptz not null default now(),
  primary key (proposal_id, voter_id)
);

alter table public.ranking_settings enable row level security;
alter table public.ranking_proposals enable row level security;
alter table public.ranking_votes enable row level security;
create policy ranking_settings_read on public.ranking_settings for select to authenticated using (public.is_friend_member());
create policy ranking_proposals_read on public.ranking_proposals for select to authenticated using (public.is_friend_member());
create policy ranking_votes_read on public.ranking_votes for select to authenticated using (public.is_friend_member());
revoke all on public.ranking_settings, public.ranking_proposals, public.ranking_votes from anon, authenticated;
grant select on public.ranking_settings, public.ranking_proposals, public.ranking_votes to authenticated;

create function public.propose_ranking_objectives(p_id uuid, p_rules jsonb)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  voters uuid[];
  names jsonb;
  existing public.ranking_proposals;
begin
  perform pg_advisory_xact_lock(7342329);
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if p_id is null or not public.valid_ranking_objectives(p_rules) then
    raise exception 'Invalid objective package' using errcode = '22023';
  end if;
  select * into existing from public.ranking_proposals where id = p_id;
  if found then
    if existing.user_id = auth.uid() and existing.rules = p_rules then return p_id; end if;
    raise exception 'Proposal ID already used' using errcode = '22023';
  end if;
  if exists (select 1 from public.ranking_proposals where user_id = auth.uid() and status = 'pending') then
    raise exception 'Withdraw the pending proposal before replacing it' using errcode = '22023';
  end if;
  if exists (select 1 from public.ranking_proposals where user_id = auth.uid() and status = 'approved'
    and effective_from > (now() at time zone 'Europe/Rome')::date) then
    raise exception 'An approved package is already scheduled; wait until it becomes active' using errcode = '22023';
  end if;
  select array_agg(user_id order by user_id), jsonb_object_agg(user_id::text, display_name)
    into voters, names from public.friend_members where user_id <> auth.uid();
  if coalesce(cardinality(voters), 0) = 0 then
    raise exception 'At least one other member is required' using errcode = '22023';
  end if;
  insert into public.ranking_proposals(id, user_id, rules, electorate, voter_names, required_approvals)
  values (p_id, auth.uid(), p_rules, voters, names, cardinality(voters) / 2 + 1);
  return p_id;
end;
$$;

create function public.vote_ranking_objectives(p_id uuid, p_approve boolean)
returns text language plpgsql security definer set search_path = '' as $$
declare
  proposal public.ranking_proposals;
  previous_vote boolean;
  approvals integer;
  rejections integer;
  activation date;
begin
  perform pg_advisory_xact_lock(7342329);
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  select * into proposal from public.ranking_proposals where id = p_id;
  if not found then raise exception 'Unknown proposal' using errcode = '22023'; end if;
  if not (auth.uid() = any(proposal.electorate)) or auth.uid() = proposal.user_id then
    raise exception 'Not eligible to vote' using errcode = '42501';
  end if;
  if p_approve is null then raise exception 'A vote is required' using errcode = '22023'; end if;
  select approve into previous_vote from public.ranking_votes where proposal_id = p_id and voter_id = auth.uid();
  if found then
    if previous_vote = p_approve then return proposal.status; end if;
    raise exception 'Votes cannot be changed' using errcode = '22023';
  end if;
  if proposal.status <> 'pending' then raise exception 'Proposal is no longer pending' using errcode = '22023'; end if;
  insert into public.ranking_votes(proposal_id, voter_id, approve) values (p_id, auth.uid(), p_approve);
  select count(*) filter (where approve), count(*) filter (where not approve)
    into approvals, rejections from public.ranking_votes where proposal_id = p_id;
  if approvals >= proposal.required_approvals then
    activation := greatest(
      date_trunc('week', now() at time zone 'Europe/Rome')::date + 7,
      (select cutover from public.ranking_settings)
    );
    if exists (select 1 from public.ranking_proposals where user_id = proposal.user_id
      and status = 'approved' and effective_from = activation) then
      raise exception 'An approved package is already scheduled for that week' using errcode = '22023';
    end if;
    update public.ranking_proposals set status = 'approved', decided_at = now(), effective_from = activation where id = p_id;
  elsif cardinality(proposal.electorate) - rejections < proposal.required_approvals then
    update public.ranking_proposals set status = 'rejected', decided_at = now(), reason = 'Approval majority is no longer possible' where id = p_id;
  end if;
  return (select status from public.ranking_proposals where id = p_id);
end;
$$;

create function public.withdraw_ranking_objectives(p_id uuid)
returns text language plpgsql security definer set search_path = '' as $$
declare proposal public.ranking_proposals;
begin
  perform pg_advisory_xact_lock(7342329);
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  select * into proposal from public.ranking_proposals where id = p_id;
  if not found then raise exception 'Unknown proposal' using errcode = '22023'; end if;
  if proposal.user_id <> auth.uid() then raise exception 'Only the proposer can withdraw' using errcode = '42501'; end if;
  if proposal.status = 'withdrawn' then return 'withdrawn'; end if;
  if proposal.status <> 'pending' then raise exception 'Proposal is no longer pending' using errcode = '22023'; end if;
  update public.ranking_proposals set status = 'withdrawn', decided_at = now() where id = p_id;
  return 'withdrawn';
end;
$$;

create function public.ranking_membership_change()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  perform pg_advisory_xact_lock(7342329);
  if tg_op = 'DELETE' or (tg_op = 'UPDATE' and old.user_id is distinct from new.user_id) then
    update public.ranking_proposals set status = 'invalidated', decided_at = now(),
      reason = 'An eligible voter left the group; submit a new proposal'
      where status = 'pending' and old.user_id = any(electorate);
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;
create trigger ranking_membership_change before insert or update or delete on public.friend_members
  for each row execute function public.ranking_membership_change();

-- The date-parameterized calculators are internal, for deterministic tests and
-- server-time wrappers only. Authenticated clients cannot pick a scoring date.
create function public.ranking_weeks(p_today date)
returns table (
  user_id uuid, week_start date, days integer[], active_weeks bigint,
  package_id uuid, rules jsonb, bonuses jsonb, earned_multiplier numeric
)
language sql stable security definer set search_path = '' as $$
  with weeks as (
    select d::date as week_start
    from public.ranking_settings s,
      generate_series(s.cutover::timestamp, date_trunc('week', p_today::timestamp), interval '7 days') d
  ), attendance as (
    select a.user_id, date_trunc('week', a.gym_date::timestamp)::date as week_start,
      array_agg(extract(isodow from a.gym_date)::integer order by a.gym_date) as days
    from public.gym_attendance a, public.ranking_settings s
    where a.gym_date >= s.cutover and a.gym_date <= p_today
    group by a.user_id, date_trunc('week', a.gym_date::timestamp)::date
  ), weekly as (
    select m.user_id, w.week_start, coalesce(a.days, '{}'::integer[]) as days,
      sum(case when a.days is null then 1 else 0 end) over (partition by m.user_id order by w.week_start) as gap
    from public.friend_members m cross join weeks w
    left join attendance a on a.user_id = m.user_id and a.week_start = w.week_start
  ), streaks as (
    select w.*, sum(case when cardinality(w.days) > 0 then 1 else 0 end)
      over (partition by w.user_id, w.gap order by w.week_start) as active_weeks
    from weekly w
  ), packages as (
    select w.*, p.id as package_id, coalesce(p.rules, '{}'::jsonb) as rules
    from streaks w left join lateral (
      select p.id, p.rules from public.ranking_proposals p
      where p.user_id = w.user_id and p.status = 'approved' and p.effective_from <= w.week_start
      order by p.effective_from desc limit 1
    ) p on true
  ), bonuses as (
    select p.*, case when cardinality(p.days) > 0 then
      least(p.active_weeks * coalesce((p.rules #>> '{streak,step}')::numeric, 0),
        coalesce((p.rules #>> '{streak,cap}')::numeric, 0)) else 0 end as streak_bonus,
      case when cardinality(p.days) >= (p.rules #>> '{count,days}')::numeric::integer
        then (p.rules #>> '{count,bonus}')::numeric else 0 end as count_bonus,
      case when p.rules ? 'schedule' and
        p.days @> array(select value::numeric::integer from jsonb_array_elements_text(p.rules #> '{schedule,days}'))
        then (p.rules #>> '{schedule,bonus}')::numeric else 0 end as schedule_bonus
    from packages p
  )
  select b.user_id, b.week_start, b.days, b.active_weeks, b.package_id, b.rules,
    jsonb_build_object('streak', b.streak_bonus, 'count', b.count_bonus, 'schedule', b.schedule_bonus),
    1 + b.streak_bonus + b.count_bonus + b.schedule_bonus
  from bonuses b;
$$;

create type public.ranking_score as (
  user_id uuid, display_name text, points numeric, gym_days bigint,
  current_streak bigint, multiplier numeric, "position" bigint, month_start date,
  weekly_streak bigint, settled_multiplier numeric, week_days integer[],
  pending_bonus numeric, week_start date, settles_on date, cutover date,
  current_objectives jsonb, current_bonuses jsonb, last_settled_week date
);
create function public.ranking_scores(p_today date, p_month date default null)
returns setof public.ranking_score
language sql stable security definer set search_path = '' as $$
  with calendar as (
    select p_today as today, date_trunc('month', coalesce(p_month, p_today)::timestamp)::date as first_day,
      date_trunc('week', p_today::timestamp)::date as current_week, s.cutover
    from public.ranking_settings s
  ), previous_days as (
    select a.user_id, a.gym_date, lag(a.gym_date) over (partition by a.user_id order by a.gym_date) as previous_date
    from public.gym_attendance a, calendar c where a.gym_date < c.cutover and a.gym_date <= c.today
  ), islands as (
    select p.*, sum(case when p.previous_date is null or p.gym_date - p.previous_date > 2 then 1 else 0 end)
      over (partition by p.user_id order by p.gym_date) as streak_id from previous_days p
  ), legacy as (
    select i.*, row_number() over (partition by i.user_id, i.streak_id order by i.gym_date) as streak_length from islands i
  ), weeks as (
    select * from public.ranking_weeks(p_today)
  ), scored_days as (
    select a.user_id, a.gym_date, 10 * case when a.gym_date < c.cutover then
      least(3::numeric, 1 + (l.streak_length - 1) * 0.25)
      when w.week_start < c.current_week then w.earned_multiplier else 1 end as points
    from public.gym_attendance a cross join calendar c
    left join legacy l on l.user_id = a.user_id and l.gym_date = a.gym_date
    left join weeks w on w.user_id = a.user_id and w.week_start = date_trunc('week', a.gym_date::timestamp)::date
    where a.gym_date <= c.today
  ), totals as (
    select m.user_id, m.display_name, coalesce(sum(s.points), 0) as points, count(s.gym_date) as gym_days
    from public.friend_members m cross join calendar c
    left join scored_days s on s.user_id = m.user_id and s.gym_date >= c.first_day
      and s.gym_date < (c.first_day + interval '1 month')::date
    group by m.user_id, m.display_name
  ), results as (
    select t.*, c.*,
      case when c.today < c.cutover and c.today - old.gym_date <= 2 then old.streak_length else 0 end as legacy_streak,
      coalesce(nullif(w.active_weeks, 0), last_week.active_weeks, 0) as weekly_streak,
      coalesce(last_week.earned_multiplier, 1) as settled_multiplier,
      coalesce(w.days, '{}'::integer[]) as week_days,
      cardinality(coalesce(w.days, '{}'::integer[])) * 10 * (coalesce(w.earned_multiplier, 1) - 1) as pending_bonus,
      coalesce(w.rules, '{}'::jsonb) as current_objectives,
      coalesce(w.bonuses, '{"streak":0,"count":0,"schedule":0}'::jsonb) as current_bonuses,
      last_week.week_start as last_settled_week
    from totals t cross join calendar c
    left join weeks w on w.user_id = t.user_id and w.week_start = c.current_week
    left join weeks last_week on last_week.user_id = t.user_id and last_week.week_start = c.current_week - 7
    left join lateral (select l.gym_date, l.streak_length from legacy l where l.user_id = t.user_id order by l.gym_date desc limit 1) old on true
  )
  select r.user_id, r.display_name, r.points, r.gym_days, r.legacy_streak,
    case when r.today < r.cutover then least(3::numeric, 1 + greatest(0, r.legacy_streak - 1) * 0.25) else 1 end,
    rank() over (order by r.points desc), r.first_day, r.weekly_streak, r.settled_multiplier,
    r.week_days, r.pending_bonus, r.current_week, r.current_week + 7, r.cutover,
    r.current_objectives, r.current_bonuses, r.last_settled_week
  from results r order by r.points desc, r.display_name, r.user_id;
$$;

drop function public.friends_leaderboard();
create function public.friends_leaderboard(p_month date default null)
returns setof public.ranking_score
language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  if p_month is not null and (not isfinite(p_month) or p_month <> date_trunc('month', p_month::timestamp)::date
    or p_month > (now() at time zone 'Europe/Rome')::date) then
    raise exception 'Invalid ranking month' using errcode = '22023';
  end if;
  return query select * from public.ranking_scores((now() at time zone 'Europe/Rome')::date, p_month);
end;
$$;

create function public.ranking_objectives()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
begin
  if not public.is_friend_member() then raise exception 'Membership required' using errcode = '42501'; end if;
  return jsonb_build_object(
    'cutover', (select cutover from public.ranking_settings),
    'week_start', date_trunc('week', now() at time zone 'Europe/Rome')::date,
    'settles_on', date_trunc('week', now() at time zone 'Europe/Rome')::date + 7,
    'proposals', coalesce((select jsonb_agg(to_jsonb(p) || jsonb_build_object(
      'display_name', m.display_name,
      'votes', coalesce((select jsonb_agg(to_jsonb(v) order by v.created_at, v.voter_id)
        from public.ranking_votes v where v.proposal_id = p.id), '[]'::jsonb)
    ) order by p.created_at desc, p.id)
      from public.ranking_proposals p join public.friend_members m on m.user_id = p.user_id), '[]'::jsonb)
  );
end;
$$;

revoke all on function public.valid_ranking_objectives(jsonb),
  public.propose_ranking_objectives(uuid, jsonb), public.vote_ranking_objectives(uuid, boolean),
  public.withdraw_ranking_objectives(uuid), public.ranking_membership_change(),
  public.ranking_weeks(date), public.ranking_scores(date, date),
  public.friends_leaderboard(date), public.ranking_objectives() from public, anon, authenticated;
grant execute on function public.propose_ranking_objectives(uuid, jsonb),
  public.vote_ranking_objectives(uuid, boolean), public.withdraw_ranking_objectives(uuid),
  public.friends_leaderboard(date), public.ranking_objectives() to authenticated;

commit;
