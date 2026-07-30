-- Team follow-up (reply-speed) metric.
--
-- WHY: leadership wants "how fast does my team reply?" Every inbound lead
-- message is paired with the team's NEXT outbound message in the same
-- thread; the gap is one follow-up time. We count only BUSINESS hours
-- (Mon–Fri 09:00–17:00 America/New_York, DST-aware) so an 11pm→9am reply
-- reads as fast, not a 10-hour wait. The public GET
-- /api/metrics/follow-up-time returns the per-ET-day median + sample size.
--
-- SAFETY: purely additive — two new functions, no table/column/trigger
-- change. Reached only via the service-role admin client (not granted to
-- anon), STABLE + SECURITY DEFINER like the sibling RPCs (0025/0058).

-- Business-seconds (Mon–Fri 09:00–17:00 America/New_York, DST-aware)
-- elapsed between two instants. Weekends and off-hours contribute 0.
create or replace function public.business_seconds(
  p_start timestamptz,
  p_end   timestamptz
)
returns numeric
language plpgsql
stable                                    -- tz-dependent → STABLE, not IMMUTABLE
as $$
declare
  tz    text := 'America/New_York';
  total numeric := 0;
  d date; ws timestamptz; we timestamptz; ov_start timestamptz; ov_end timestamptz;
begin
  if p_start is null or p_end is null or p_end <= p_start then
    return 0;
  end if;
  for d in
    -- ::date::timestamp forces the timestamp overload of generate_series
    -- so the day loop never depends on the session TimeZone GUC.
    select generate_series(
             (p_start at time zone tz)::date::timestamp,
             (p_end   at time zone tz)::date::timestamp,
             interval '1 day')::date
  loop
    if extract(isodow from d) >= 6 then continue; end if;  -- skip Sat(6)/Sun(7)
    ws := (d + interval '9 hours')  at time zone tz;        -- 09:00 ET that date → UTC instant
    we := (d + interval '17 hours') at time zone tz;        -- 17:00 ET
    ov_start := greatest(p_start, ws);
    ov_end   := least(p_end, we);
    if ov_end > ov_start then
      total := total + extract(epoch from (ov_end - ov_start));
    end if;
  end loop;
  return total;
end;
$$;

-- Median business-seconds follow-up time per ET calendar day of the
-- inbound message. Every inbound → its next outbound reply (same thread);
-- never-replied inbounds and null sent_at are excluded.
create or replace function public.team_follow_up_by_day(p_ws uuid)
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
  )
  select day,
         percentile_cont(0.5) within group (order by biz_seconds),
         count(*)::bigint
  from pairs
  group by day
  order by day;
$$;

revoke all on function public.business_seconds(timestamptz, timestamptz) from public;
revoke all on function public.team_follow_up_by_day(uuid) from public;
grant execute on function public.business_seconds(timestamptz, timestamptz) to service_role;
grant execute on function public.team_follow_up_by_day(uuid) to service_role;
