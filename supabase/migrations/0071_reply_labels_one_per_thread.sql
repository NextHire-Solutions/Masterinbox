-- 0071: make v_reply_labels robust to threads carrying MORE THAN ONE label.
--
-- WHY: migration 0070 adds a "No Show / No Response" label ALONGSIDE a thread's
-- existing label (Introduction), so those threads now have two label
-- assignments. The 0067 view joined label_assignments directly, which emits one
-- row PER label — i.e. two rows for those threads — breaking the reply-labels
-- feed's "one row per thread" contract (thread_id is the consumer's upsert key).
--
-- FIX: pick exactly ONE label per thread via a lateral. The reply-labels feed
-- is about the thread's REPLY classification, so the pipeline status label
-- "No Show / No Response" must NOT displace it: we sort that label last and
-- take the most recent otherwise. Result — a thread with Introduction + No Show
-- emits a single row showing Introduction (identical to before 0070, so the
-- consumer's numbers don't shift); "No Show / No Response" stays an inbox-only
-- label. Unlabelled threads still emit one row with null label fields.
--
-- SAFETY: view-only CREATE OR REPLACE. Same columns, same order, same types —
-- only the source of the label fields changes (direct join -> lateral limit 1).
-- No table, row, or trigger touched.

create or replace view public.v_reply_labels as
select
  t.id                                          as thread_id,
  t.source_provider::text                       as source_provider,
  coalesce(msgs.reply_ids, '[]'::jsonb)         as emailbison_reply_ids,
  msgs.first_reply_id                           as first_emailbison_reply_id,
  lbl.name                                      as label_name,
  lbl.sentiment                                 as label_sentiment,
  lbl.assigned_by                               as assigned_by,
  lbl.labelled_at                               as labelled_at,
  t.campaign_id                                 as campaign_id,
  l.email::text                                 as lead_email,
  l.emailbison_lead_id                          as emailbison_lead_id,
  greatest(t.updated_at, coalesce(tlt.touched_at, t.created_at)) as updated_at,
  (t.status = 'trash')                          as deleted
from public.threads t
left join lateral (
  select lb.name              as name,
         lb.sentiment::text   as sentiment,
         la.assigned_by::text as assigned_by,
         la.assigned_at       as labelled_at
  from public.label_assignments la
  join public.labels lb on lb.id = la.label_id
  where la.target_type = 'thread' and la.target_id = t.id
  -- Reply label wins over the "No Show / No Response" status label; newest wins otherwise.
  order by (case when lb.name = 'No Show / No Response' then 1 else 0 end) asc,
           la.assigned_at desc
  limit 1
) lbl on true
left join public.leads l on l.id = t.lead_id
left join public.thread_reply_label_touch tlt on tlt.thread_id = t.id
left join lateral (
  select jsonb_agg(m.emailbison_reply_id order by m.sent_at)              as reply_ids,
         (array_agg(m.emailbison_reply_id order by m.sent_at))[1]         as first_reply_id
  from public.messages m
  where m.thread_id = t.id
    and m.direction = 'inbound'
    and m.emailbison_reply_id is not null
) msgs on true
union all
select
  d.thread_id,
  d.source_provider,
  coalesce(d.emailbison_reply_ids, '[]'::jsonb),
  d.first_emailbison_reply_id,
  d.label_name,
  d.label_sentiment,
  d.assigned_by,
  d.labelled_at,
  d.campaign_id,
  d.lead_email,
  d.emailbison_lead_id,
  d.deleted_at,
  true
from public.deleted_reply_label_tombstone d;

grant select on public.v_reply_labels to service_role;
