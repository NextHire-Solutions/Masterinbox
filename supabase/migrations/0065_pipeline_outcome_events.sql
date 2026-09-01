-- Pipeline outcome-event log — the source for the public GET /api/outcomes
-- feed a downstream attribution tool polls.
--
-- WHY: client_pipeline_entries stores only a candidate's CURRENT stage, so a
-- funnel question ("how many reached Phone Screen?") can't be answered from
-- history — the transitions were never recorded. This adds a small append-only
-- log so every stage a candidate reaches is captured from now on, plus a
-- one-time backfill of the current known state (Introduction + Hire are exact;
-- the current middle stage is approximate). A true cumulative funnel then
-- accrues going forward.
--
-- SAFETY (portal + inbox are in live client use): purely additive — a NEW
-- table, view, and triggers; NO change to any existing column. Every trigger
-- body is wrapped in BEGIN…EXCEPTION WHEN OTHERS THEN NULL so a logging failure
-- can never roll back or block a real pipeline edit. Composes with the 0059
-- (hired_at, BEFORE) and 0061 (client_activity_at, BEFORE) triggers — those run
-- first, so NEW.hired_at is already populated when our AFTER triggers read it.

-- ---------------------------------------------------------------------------
-- 1. The log table. Self-contained: it snapshots email + client_id so a row
--    survives a hard-delete of its entry (entry_id → SET NULL) and can still
--    be reported as voided=true.
-- ---------------------------------------------------------------------------
create table if not exists public.pipeline_outcome_events (
  id          uuid primary key default uuid_generate_v4(),
  entry_id    uuid references public.client_pipeline_entries(id) on delete set null,
  client_id   uuid not null,
  email       text,                                   -- snapshot, lowercased
  event_type  text not null,                          -- a pipeline_stage value
  occurred_at timestamptz not null,                   -- when the outcome happened
  created_at  timestamptz not null default timezone('utc', now()),
  updated_at  timestamptz not null default timezone('utc', now()),
  voided      boolean not null default false          -- true once the entry is deleted
);

-- Pagination cursor: the endpoint orders by (updated_at, id) and filters
-- updated_at >= updated_since for incremental polling.
create index if not exists pipeline_outcome_events_cursor_idx
  on public.pipeline_outcome_events (updated_at, id);
create index if not exists pipeline_outcome_events_client_idx
  on public.pipeline_outcome_events (client_id);
create index if not exists pipeline_outcome_events_entry_idx
  on public.pipeline_outcome_events (entry_id);
create index if not exists pipeline_outcome_events_email_idx
  on public.pipeline_outcome_events (email);

-- ---------------------------------------------------------------------------
-- 2. Recording triggers on client_pipeline_entries.
--    Log EVERYTHING (including the demo client); the view below is the single
--    point that excludes demo, so the triggers stay dead-simple.
-- ---------------------------------------------------------------------------

-- INSERT: every new entry is an introduction. If it was inserted straight at a
-- later stage (CSV / bulk import), also record that current stage.
create or replace function public.pipeline_outcome_log_insert()
returns trigger
language plpgsql
as $$
begin
  begin
    insert into public.pipeline_outcome_events
      (entry_id, client_id, email, event_type, occurred_at)
    values
      (new.id, new.client_id, lower(new.lead_email), 'introduction',
       coalesce(new.introduced_at, new.created_at, timezone('utc', now())));

    if new.stage is distinct from 'introduction' then
      insert into public.pipeline_outcome_events
        (entry_id, client_id, email, event_type, occurred_at)
      values
        (new.id, new.client_id, lower(new.lead_email), new.stage::text,
         coalesce(case when new.stage = 'hired' then new.hired_at end,
                  new.client_activity_at, new.updated_at, timezone('utc', now())));
    end if;
  exception when others then
    -- best-effort logging: never break the pipeline write
    null;
  end;
  return new;
end;
$$;

-- UPDATE: one event per genuine stage transition. hired_at is already stamped
-- by the 0059 BEFORE trigger, so it's the accurate occurred_at for hires.
create or replace function public.pipeline_outcome_log_update()
returns trigger
language plpgsql
as $$
begin
  if new.stage is distinct from old.stage then
    begin
      insert into public.pipeline_outcome_events
        (entry_id, client_id, email, event_type, occurred_at)
      values
        (new.id, new.client_id, lower(new.lead_email), new.stage::text,
         coalesce(case when new.stage = 'hired' then new.hired_at end,
                  timezone('utc', now())));
    exception when others then
      null;
    end;
  end if;
  return new;
end;
$$;

-- DELETE (hard delete of an entry) is a retraction: flip its events to voided
-- and bump updated_at so the consumer sees it on the next incremental poll.
-- Runs BEFORE the delete, while entry_id still points at the row.
create or replace function public.pipeline_outcome_void_on_delete()
returns trigger
language plpgsql
as $$
begin
  begin
    update public.pipeline_outcome_events
       set voided = true,
           updated_at = timezone('utc', now())
     where entry_id = old.id
       and voided = false;
  exception when others then
    null;
  end;
  return old;
end;
$$;

drop trigger if exists pipeline_outcome_log_insert on public.client_pipeline_entries;
create trigger pipeline_outcome_log_insert
  after insert on public.client_pipeline_entries
  for each row execute function public.pipeline_outcome_log_insert();

drop trigger if exists pipeline_outcome_log_update on public.client_pipeline_entries;
create trigger pipeline_outcome_log_update
  after update on public.client_pipeline_entries
  for each row execute function public.pipeline_outcome_log_update();

drop trigger if exists pipeline_outcome_void_on_delete on public.client_pipeline_entries;
create trigger pipeline_outcome_void_on_delete
  before delete on public.client_pipeline_entries
  for each row execute function public.pipeline_outcome_void_on_delete();

-- ---------------------------------------------------------------------------
-- 3. One-time backfill of current known state (NON-DEMO only).
--    Introduction (all) + Hire (where hired_at) + current middle stage.
--    Backfilled middle-stage events reflect CURRENT position only — true
--    intermediate history accrues from deploy-day forward via the triggers.
-- ---------------------------------------------------------------------------
-- The `not exists` guards make each insert idempotent: a re-run (or a run
-- after triggers have already logged some entries) never double-inserts a
-- backfilled event for the same (entry, event_type).
insert into public.pipeline_outcome_events
  (entry_id, client_id, email, event_type, occurred_at)
select e.id, e.client_id, lower(e.lead_email), 'introduction',
       coalesce(e.introduced_at, e.created_at, timezone('utc', now()))
from public.client_pipeline_entries e
where e.client_id <> '00ef116c-646d-43b4-a323-680548ea7126'
  and not exists (
    select 1 from public.pipeline_outcome_events x
     where x.entry_id = e.id and x.event_type = 'introduction'
  );

insert into public.pipeline_outcome_events
  (entry_id, client_id, email, event_type, occurred_at)
select e.id, e.client_id, lower(e.lead_email), 'hired',
       coalesce(e.hired_at, e.updated_at, timezone('utc', now()))
from public.client_pipeline_entries e
where e.client_id <> '00ef116c-646d-43b4-a323-680548ea7126'
  and e.hired_at is not null
  and not exists (
    select 1 from public.pipeline_outcome_events x
     where x.entry_id = e.id and x.event_type = 'hired'
  );

insert into public.pipeline_outcome_events
  (entry_id, client_id, email, event_type, occurred_at)
select e.id, e.client_id, lower(e.lead_email), e.stage::text,
       coalesce(e.client_activity_at, e.updated_at, e.introduced_at,
                e.created_at, timezone('utc', now()))
from public.client_pipeline_entries e
where e.client_id <> '00ef116c-646d-43b4-a323-680548ea7126'
  and e.stage not in ('introduction', 'hired')
  and not exists (
    select 1 from public.pipeline_outcome_events x
     where x.entry_id = e.id and x.event_type = e.stage::text
  );

-- ---------------------------------------------------------------------------
-- 4. Read view for the endpoint. LEFT JOINs so a voided event whose entry was
--    deleted still appears (enrichment columns null). Demo excluded here — the
--    single choke point. emailbison_lead_id / campaign_id are best-effort.
-- ---------------------------------------------------------------------------
create or replace view public.v_pipeline_outcomes as
select
  ev.id,
  ev.email,
  ev.event_type,
  ev.occurred_at,
  ev.updated_at,
  ev.voided,
  l.emailbison_lead_id,
  t.campaign_id
from public.pipeline_outcome_events ev
left join public.client_pipeline_entries e on e.id = ev.entry_id
left join public.leads   l on l.id = e.lead_id
left join public.threads t on t.id = e.thread_id
where ev.client_id <> '00ef116c-646d-43b4-a323-680548ea7126';

-- Reached only via the service-role admin client (never anon). Lock it down.
revoke all on public.pipeline_outcome_events from public;
revoke all on public.v_pipeline_outcomes from public;
grant select, insert, update on public.pipeline_outcome_events to service_role;
grant select on public.v_pipeline_outcomes to service_role;
