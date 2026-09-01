-- Backfill the 'hired' outcome events that the 0065 backfill missed.
--
-- WHY: 0065 only inserted a 'hired' event where hired_at IS NOT NULL. But
-- hired_at is stamped only by the trigger added in 0059, so every agent hired
-- BEFORE 0059 has hired_at = NULL and received no 'hired' event — appearing in
-- the outcomes feed only as 'introduction'. Result: ~50 of 53 hires are absent
-- from the feed's hire count. This inserts the missing 'hired' events, dating
-- each by coalesce(hired_at, updated_at) — the same "fall back to updated_at for
-- older records" rule /api/clients/intros?label=Hired already uses (per 0059's
-- header note).
--
-- SAFETY: additive + idempotent. Inserts only — no schema change, no existing
-- row touched. The NOT EXISTS guard means it never duplicates a 'hired' event
-- already present (the few from 0065 + any produced live by the 0065 trigger),
-- so it is safe to run more than once. Demo client excluded, matching the feed.
-- New rows get updated_at = now() (table default), so the consumer picks them up
-- on its next incremental poll.

insert into public.pipeline_outcome_events
  (entry_id, client_id, email, event_type, occurred_at)
select e.id, e.client_id, lower(e.lead_email), 'hired',
       coalesce(e.hired_at, e.updated_at, e.introduced_at, e.created_at,
                timezone('utc', now()))
from public.client_pipeline_entries e
where e.client_id <> '00ef116c-646d-43b4-a323-680548ea7126'
  and e.stage = 'hired'
  and not exists (
    select 1 from public.pipeline_outcome_events x
     where x.entry_id = e.id and x.event_type = 'hired'
  );
