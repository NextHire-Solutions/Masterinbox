-- Reply-labels feed — backs the public GET /api/reply-labels endpoint a
-- downstream attribution tool polls. One row per THREAD: its single current
-- label (name + sentiment), who applied it, the inbound reply ids, provider,
-- and a change-aware cursor.
--
-- WHY change-capture is needed: the consumer must see label REMOVALS and thread
-- DELETIONS, not just additions. But label_assignments has only assigned_at
-- (no updated_at) and a removal hard-deletes the row leaving no timestamp; and
-- a hard-deleted thread leaves no trace. So a cursor built on the existing
-- schema can only ever grow (Positive counts could never drop). This migration
-- captures those two events.
--
-- SAFETY (inbox + portals are in live client use): 100% ADDITIVE. It creates
-- two NEW tables, two triggers, and one view. It does NOT alter or write any
-- existing table, column, row, or trigger — threads / labels / label_assignments
-- are only READ. Both trigger bodies are wrapped in EXCEPTION WHEN OTHERS THEN
-- NULL, so they can NEVER block a label change or a thread deletion. No backfill
-- (the consumer's initial full sync reads every thread once; capture fills from
-- deploy-day forward). Functions are SECURITY DEFINER so the capturing write
-- always succeeds regardless of which role performed the mutation.

-- ---------------------------------------------------------------------------
-- 1. Label-change cursor. A trigger stamps touched_at whenever a thread's
--    label is added, changed, or REMOVED. The feed's updated_at is
--    greatest(threads.updated_at, touched_at), so re-labels and un-labels both
--    move the cursor. (Soft-delete to Trash is a threads UPDATE, already
--    covered by threads.updated_at.)
-- ---------------------------------------------------------------------------
create table if not exists public.thread_reply_label_touch (
  thread_id  uuid primary key,
  touched_at timestamptz not null default timezone('utc', now())
);

create or replace function public.reply_label_touch()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  tid uuid;
  tt  assignment_target;
begin
  begin
    if tg_op = 'DELETE' then
      tid := old.target_id; tt := old.target_type;
    else
      tid := new.target_id; tt := new.target_type;
    end if;
    if tt = 'thread' then
      insert into public.thread_reply_label_touch (thread_id, touched_at)
      values (tid, timezone('utc', now()))
      on conflict (thread_id) do update set touched_at = excluded.touched_at;
    end if;
  exception when others then
    null;  -- best-effort: never block a label mutation
  end;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end;
$$;

drop trigger if exists reply_label_touch on public.label_assignments;
create trigger reply_label_touch
  after insert or update or delete on public.label_assignments
  for each row execute function public.reply_label_touch();

-- ---------------------------------------------------------------------------
-- 2. Hard-delete tombstone. A BEFORE DELETE trigger on threads snapshots the
--    row's feed fields so a permanently-deleted thread still surfaces as
--    deleted:true (like `voided` on the outcomes feed). Soft-delete (Trash)
--    does NOT hit this — the row stays and the view reads status='trash'.
-- ---------------------------------------------------------------------------
create table if not exists public.deleted_reply_label_tombstone (
  thread_id                 uuid primary key,
  source_provider           text,
  campaign_id               text,
  lead_email                text,
  emailbison_lead_id        text,
  first_emailbison_reply_id text,
  emailbison_reply_ids      jsonb,
  label_name                text,
  label_sentiment           text,
  assigned_by               text,
  labelled_at               timestamptz,
  deleted_at                timestamptz not null default timezone('utc', now())
);

create or replace function public.reply_label_tombstone()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text; v_eblead text;
  v_name text; v_sent text; v_by text; v_at timestamptz;
  v_ids jsonb; v_first text;
begin
  begin
    select l.email::text, l.emailbison_lead_id
      into v_email, v_eblead
      from public.leads l where l.id = old.lead_id;

    select lb.name, lb.sentiment::text, la.assigned_by::text, la.assigned_at
      into v_name, v_sent, v_by, v_at
      from public.label_assignments la
      join public.labels lb on lb.id = la.label_id
     where la.target_type = 'thread' and la.target_id = old.id
     order by la.assigned_at desc
     limit 1;

    -- messages still exist inside a BEFORE DELETE (FK cascade fires after).
    select jsonb_agg(m.emailbison_reply_id order by m.sent_at),
           (array_agg(m.emailbison_reply_id order by m.sent_at))[1]
      into v_ids, v_first
      from public.messages m
     where m.thread_id = old.id
       and m.direction = 'inbound'
       and m.emailbison_reply_id is not null;

    insert into public.deleted_reply_label_tombstone
      (thread_id, source_provider, campaign_id, lead_email, emailbison_lead_id,
       first_emailbison_reply_id, emailbison_reply_ids, label_name,
       label_sentiment, assigned_by, labelled_at, deleted_at)
    values
      (old.id, old.source_provider::text, old.campaign_id, v_email, v_eblead,
       v_first, coalesce(v_ids, '[]'::jsonb), v_name, v_sent, v_by, v_at,
       timezone('utc', now()))
    on conflict (thread_id) do update set
      source_provider = excluded.source_provider,
      campaign_id = excluded.campaign_id,
      lead_email = excluded.lead_email,
      emailbison_lead_id = excluded.emailbison_lead_id,
      first_emailbison_reply_id = excluded.first_emailbison_reply_id,
      emailbison_reply_ids = excluded.emailbison_reply_ids,
      label_name = excluded.label_name,
      label_sentiment = excluded.label_sentiment,
      assigned_by = excluded.assigned_by,
      labelled_at = excluded.labelled_at,
      deleted_at = excluded.deleted_at;
  exception when others then
    null;  -- best-effort: never block a thread deletion
  end;
  return old;
end;
$$;

drop trigger if exists reply_label_tombstone on public.threads;
create trigger reply_label_tombstone
  before delete on public.threads
  for each row execute function public.reply_label_tombstone();

-- ---------------------------------------------------------------------------
-- 3. The feed view. One row per thread (unlabelled included, null label fields
--    — so "not labelled yet" is distinguishable from "labelled neutral"),
--    UNION the hard-delete tombstones. Includes BOTH providers; the endpoint
--    passes source_provider through so the consumer excludes Instantly from
--    campaign math while still seeing coverage.
-- ---------------------------------------------------------------------------
create or replace view public.v_reply_labels as
select
  t.id                                          as thread_id,
  t.source_provider::text                       as source_provider,
  coalesce(msgs.reply_ids, '[]'::jsonb)         as emailbison_reply_ids,
  msgs.first_reply_id                           as first_emailbison_reply_id,
  lb.name                                       as label_name,
  lb.sentiment::text                            as label_sentiment,
  la.assigned_by::text                          as assigned_by,
  la.assigned_at                                as labelled_at,
  t.campaign_id                                 as campaign_id,
  l.email::text                                 as lead_email,
  l.emailbison_lead_id                          as emailbison_lead_id,
  greatest(t.updated_at, coalesce(tlt.touched_at, t.created_at)) as updated_at,
  (t.status = 'trash')                          as deleted
from public.threads t
left join public.label_assignments la
       on la.target_type = 'thread' and la.target_id = t.id
left join public.labels lb on lb.id = la.label_id
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

-- Reached only via the service-role admin client (never anon).
revoke all on public.thread_reply_label_touch from public;
revoke all on public.deleted_reply_label_tombstone from public;
revoke all on public.v_reply_labels from public;
grant select, insert, update on public.thread_reply_label_touch to service_role;
grant select, insert, update on public.deleted_reply_label_tombstone to service_role;
grant select on public.v_reply_labels to service_role;
