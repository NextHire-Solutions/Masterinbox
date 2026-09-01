-- Expose the owning client on the outcomes feed.
--
-- WHY: the downstream tool was inferring each outcome's client from the reply's
-- campaign, and falling back to email→first-touch-campaign when campaign was
-- null — wrong ~95% of the time. The same agents are prospected by many
-- brokerages, so first-touch credits whoever emailed earliest (a big early
-- campaign like MattC Group wins constantly), not the client who actually hired
-- them — which is why C21's hires showed under other clients. MasterInbox
-- already knows the true owner: every outcome event snapshots client_id, and the
-- live pipeline entry carries it too. Exposing it takes attribution from ~40% to
-- ~100% and lets the consumer drop the email-guessing path. (Verified: 100% of
-- events carry a client_id.)
--
-- SAFETY: additive. CREATE OR REPLACE VIEW appends two columns (client_id,
-- client_name) at the end; every existing column and its position is unchanged,
-- so current consumers keep working. No table or row is modified. Demo is still
-- excluded via ev.client_id. client_id prefers the LIVE entry's owner
-- (coalesce(e.client_id, ev.client_id)) so a "Move agent" re-tag is reflected,
-- and the event's snapshot still resolves it after an entry is hard-deleted.

create or replace view public.v_pipeline_outcomes as
select
  ev.id,
  ev.email,
  ev.event_type,
  ev.occurred_at,
  ev.updated_at,
  ev.voided,
  l.emailbison_lead_id,
  t.campaign_id,
  coalesce(e.client_id, ev.client_id) as client_id,
  c.name                              as client_name
from public.pipeline_outcome_events ev
left join public.client_pipeline_entries e on e.id = ev.entry_id
left join public.leads   l on l.id = e.lead_id
left join public.threads t on t.id = e.thread_id
left join public.clients c on c.id = coalesce(e.client_id, ev.client_id)
where ev.client_id <> '00ef116c-646d-43b4-a323-680548ea7126';

grant select on public.v_pipeline_outcomes to service_role;
