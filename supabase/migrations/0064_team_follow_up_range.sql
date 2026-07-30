-- Range-aware follow-up metric.
--
-- WHY: the per-day RPC returns one median per day, but a median CANNOT be
-- reconstructed from daily medians (averaging them is wrong — a single
-- slow day skews it badly). To answer "median over the last 30 days" you
-- must run percentile_cont over the raw replies IN that range. This adds a
-- 3-arg overload that takes an optional [p_from, p_to] ET-date window and
-- returns BOTH an "overall" row (day = NULL — the exact median across
-- every reply in the range) AND the per-day breakdown within the range.
--
-- ADDITIVE + zero-downtime: this is a NEW overload with NO defaults, so
-- the existing 1-arg team_follow_up_by_day(uuid) keeps resolving
-- unambiguously for the currently-deployed endpoint. NULL from/to = no
-- filter (whole history). Reuses business_seconds() from 0063.

create or replace function public.team_follow_up_by_day(
  p_ws   uuid,
  p_from date,   -- inclusive ET calendar date; NULL = open start
  p_to   date    -- inclusive ET calendar date; NULL = open end
)
returns table (day date, median_seconds numeric, sample_size bigint)
language sql
stable
security definer
set search_path = public
as $$
  with pairs as (
    select
      (m.sent_at at time zone 'America/New_York')::date as day,
      public.business_seconds(m.sent_at, r.reply_at)     as biz_seconds
    from messages m
    cross join lateral (
      select min(o.sent_at) as reply_at
        from messages o
       where o.thread_id = m.thread_id
         and o.direction = 'outbound'
         and o.sent_at > m.sent_at
    ) r
    where m.workspace_id = p_ws
      and m.direction = 'inbound'
      and m.sent_at is not null
      and r.reply_at is not null
      and (p_from is null or (m.sent_at at time zone 'America/New_York')::date >= p_from)
      and (p_to   is null or (m.sent_at at time zone 'America/New_York')::date <= p_to)
  )
  -- overall (day = NULL): the EXACT median across every reply in the range.
  select null::date,
         percentile_cont(0.5) within group (order by biz_seconds),
         count(*)::bigint
  from pairs
  union all
  -- per-day breakdown
  select day,
         percentile_cont(0.5) within group (order by biz_seconds),
         count(*)::bigint
  from pairs
  group by day;
$$;

revoke all on function public.team_follow_up_by_day(uuid, date, date) from public;
grant execute on function public.team_follow_up_by_day(uuid, date, date) to service_role;
