-- 0073_intro_prefer_preferred_email.sql
--
-- Make the introduction snapshot prefer a staff-chosen "preferred" EMAIL, the
-- same way 0072 did for the phone.
--
-- Staff can mark one of an agent's emails as preferred (stored on
-- leads.custom_fields->>'preferred_email'). At introduction the portal snapshot
-- (client_pipeline_entries.lead_email) should use that email when present.
--
-- This `create or replace` keeps everything from 0072 (including the
-- preferred_phone coalesce) and changes ONLY the lead_email expression: it
-- prepends 'preferred_email' to the previous `lead_row.email`. Provably ADDITIVE
-- — when 'preferred_email' is unset (every current lead) the result is exactly
-- the prior `lead_row.email`. No data is migrated; no schema changes; the trigger
-- binding is untouched.

create or replace function client_pipeline_on_intro_label()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  intro_label_id uuid;
  th_row record;
  lead_row record;
begin
  if new.target_type <> 'thread' then
    return new;
  end if;

  select id into intro_label_id
    from labels
    where lower(name) = 'introduction'
    limit 1;
  if intro_label_id is null or new.label_id <> intro_label_id then
    return new;
  end if;

  select t.id as thread_id, t.lead_id, t.client_id
    into th_row
    from threads t
    where t.id = new.target_id;
  if th_row.client_id is null then
    return new;
  end if;

  select l.full_name, l.email, l.custom_fields
    into lead_row
    from leads l
    where l.id = th_row.lead_id;

  insert into client_pipeline_entries (
    client_id, thread_id, lead_id, stage,
    lead_name, lead_email, lead_phone, current_brokerage, agent_profile_url,
    introduced_at
  )
  values (
    th_row.client_id, th_row.thread_id, th_row.lead_id, 'introduction',
    lead_row.full_name,
    -- CHANGED (0073): prefer the staff-chosen email; falls back to the prior
    -- behaviour (leads.email) when 'preferred_email' is unset.
    coalesce(lead_row.custom_fields->>'preferred_email', lead_row.email),
    -- From 0072: prefer the staff-chosen number; falls back when unset.
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
    new.assigned_at
  )
  on conflict (client_id, thread_id) do nothing;

  return new;
end;
$$;

-- Trigger binding is unchanged (still AFTER INSERT ON label_assignments from
-- 0023). Re-asserted here idempotently so a fresh apply is self-contained.
drop trigger if exists client_pipeline_intro_label_trigger on label_assignments;
create trigger client_pipeline_intro_label_trigger
after insert on label_assignments
for each row execute function client_pipeline_on_intro_label();
