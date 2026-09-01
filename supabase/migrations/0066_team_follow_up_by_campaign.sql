-- Follow-up (reply-speed) median grouped by EmailBison campaign.
--
-- WHY: the dashboard shows ONE blended median for the whole workspace. A
-- downstream tool wants "how fast does the team reply, per campaign?" so it can
-- add a Median Follow-up column to its Campaigns table and see which campaign is
-- being neglected. Same pairs + same business_seconds() as the day/overall RPCs
-- (0063/0064) — just grouped by the reply thread's campaign instead of by date.
--
-- KEY DECISION — EmailBison campaigns only. threads.campaign_id holds a MIX:
-- numeric ids for EmailBison threads (which also carry emailbison_thread_id) and
-- UUID ids for Instantly threads. The consumer joins on the EmailBison INTEGER
-- campaign id ("not a UUID"), so we filter to EmailBison threads
-- (emailbison_thread_id is not null) — that guarantees a numeric campaign_id.
-- Instantly replies (UUID campaigns) can't join to EmailBison and are excluded
-- here; they still count in `overall` and `days`.
--
-- SAFETY: purely additive — one NEW function, reached only via the service-role
-- admin client (not granted to anon). STABLE + SECURITY DEFINER like its
-- siblings. NULL p_from/p_to = whole history. Reuses business_seconds() (0063)
-- and the messages(thread_id, sent_at) index.

create or replace function public.team_follow_up_by_campaign(
  p_ws   uuid,
  p_from date,   -- inclusive ET calendar date of the inbound msg; NULL = open start
  p_to   date    -- inclusive ET calendar date; NULL = open end
)
returns table (campaign_id text, median_seconds numeric, sample_size bigint)
language sql
stable
security definer
set search_path = public
as $$
  with pairs as (
    select
      t.campaign_id                                  as campaign_id,
      public.business_seconds(m.sent_at, r.reply_at) as biz_seconds
    from messages m
    join threads t on t.id = m.thread_id
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
      -- EmailBison threads only → campaign_id is the EmailBison INTEGER id.
      and t.emailbison_thread_id is not null
      and t.campaign_id is not null
      and (p_from is null or (m.sent_at at time zone 'America/New_York')::date >= p_from)
      and (p_to   is null or (m.sent_at at time zone 'America/New_York')::date <= p_to)
  )
  select campaign_id,
         percentile_cont(0.5) within group (order by biz_seconds),
         count(*)::bigint
  from pairs
  group by campaign_id;
$$;

revoke all on function public.team_follow_up_by_campaign(uuid, date, date) from public;
grant execute on function public.team_follow_up_by_campaign(uuid, date, date) to service_role;
