-- 0078_intro_entry_when_client_set_later.sql
--
-- An Introduction made before its conversation has a client never reached the
-- client's portal.
--
-- client_pipeline_on_intro_label (0023, last changed in 0073) creates the
-- portal entry at the moment the Introduction label is applied — and returns
-- without one when the conversation has no client yet. Nothing looked again
-- when the client was set afterwards (a campaign name matched later, a portal
-- chosen for the campaign, a person picking the client), so the introduction
-- was sent but the client never saw it. Found 15 Oct 2026: 54 Realty showed
-- 34 introductions in the OS and 50 in its portal; 3 of its introductions
-- (13 and 18 Aug) were never in the portal, and 132 across all clients.
--
-- From now on, when a conversation that carries the Introduction label GETS
-- its client (client_id goes from empty to set), the portal entry is created
-- then — exactly what the label trigger would have written, with
-- introduced_at = when the label was applied.
--
-- What it deliberately does NOT do:
--   - No backfill (user decision, 15 Oct). Only introductions labelled on or
--     after 2026-10-15 00:00 UTC are picked up; the older ones stay as they
--     are, and this migration writes no rows.
--   - It never moves a lead: a conversation moved from one client to another
--     is not handled, and a conversation that already has a portal entry
--     under ANY client is left alone.
--
-- The insert is the label trigger's own (0073): same columns, same preferred
-- email / phone fallbacks, same ON CONFLICT. Safe to run more than once.

create or replace function client_pipeline_on_thread_client_set()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  intro_label_id uuid;
  labelled_at timestamptz;
  lead_row record;
begin
  select id into intro_label_id
    from labels
    where lower(name) = 'introduction'
    limit 1;
  if intro_label_id is null then
    return new;
  end if;

  select la.assigned_at into labelled_at
    from label_assignments la
    where la.target_type = 'thread'
      and la.target_id = new.id
      and la.label_id = intro_label_id
    order by la.assigned_at desc
    limit 1;
  -- Not an introduction, or one from before this fix (no backfill).
  if labelled_at is null or labelled_at < timestamptz '2026-10-15 00:00:00+00' then
    return new;
  end if;

  -- Already in a portal, under this client or another: never a second entry.
  if exists (select 1 from client_pipeline_entries e where e.thread_id = new.id) then
    return new;
  end if;

  select l.full_name, l.email, l.custom_fields
    into lead_row
    from leads l
    where l.id = new.lead_id;

  insert into client_pipeline_entries (
    client_id, thread_id, lead_id, stage,
    lead_name, lead_email, lead_phone, current_brokerage, agent_profile_url,
    introduced_at
  )
  values (
    new.client_id, new.id, new.lead_id, 'introduction',
    lead_row.full_name,
    coalesce(lead_row.custom_fields->>'preferred_email', lead_row.email),
    coalesce(
      lead_row.custom_fields->>'preferred_phone',
      lead_row.custom_fields->>'phone',
      lead_row.custom_fields->>'Phone'
    ),
    coalesce(lead_row.custom_fields->>'companyName', lead_row.custom_fields->>'company'),
    coalesce(
      lead_row.custom_fields->>'Agent Profile',
      lead_row.custom_fields->>'agentProfile',
      lead_row.custom_fields->>'website'
    ),
    labelled_at
  )
  on conflict (client_id, thread_id) do nothing;

  return new;
end;
$$;

drop trigger if exists client_pipeline_intro_on_client_set_trigger on threads;
create trigger client_pipeline_intro_on_client_set_trigger
after update of client_id on threads
for each row
when (old.client_id is null and new.client_id is not null)
execute function client_pipeline_on_thread_client_set();
