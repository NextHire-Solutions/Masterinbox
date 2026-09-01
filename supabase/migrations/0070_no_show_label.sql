-- 0070: surface the portal "No Show / No Response" status as a MasterInbox label.
--
-- WHY: when a client marks an introduction as "No Show / No Response" in their
-- portal (pipeline stage -> no_show), staff want to see that in the inbox. This
-- adds a dedicated label that is applied to the thread whenever an entry enters
-- the no_show stage.
--
-- REQUIREMENTS honored:
--  - NOT AI-labelled: the AI classifier only picks from ai_labeling_config
--    .category_set (13 labels). This label is deliberately NOT added there, so
--    the AI can never assign it. It's applied only here, with assigned_by =
--    'system'.
--  - Comes only from the portal action: applied when the pipeline entry enters
--    the no_show stage (which is the portal "No Show / No Response" action).
--  - ADD alongside (product decision): the thread KEEPS its "Introduction"
--    label (which drives the introduction count in /api/clients/intros) and
--    gains this one. We never delete a label here.
--
-- SAFETY: additive + INSERT-ONLY. Because nothing is deleted, the 0033
-- unlabel-cascade constraint trigger can never fire, so pipeline entries are
-- never at risk. Inserting a non-"introduction" label does not fire the 0023
-- intro trigger. The trigger body is wrapped in EXCEPTION WHEN OTHERS THEN NULL
-- so it can never block a stage change. Demo client excluded. No backfill
-- removes anything.

-- ---------------------------------------------------------------------------
-- 1. The label. One per workspace (there is one). Neutral sentiment ("no
--    response" carries no reply sentiment), system-managed. Deliberately kept
--    out of ai_labeling_config.category_set so the AI never assigns it.
-- ---------------------------------------------------------------------------
insert into public.labels (workspace_id, name, color, sentiment, platform, is_system)
select w.id, 'No Show / No Response', 'stone', 'neutral', 'both', true
from public.workspaces w
on conflict (workspace_id, name) do nothing;

-- ---------------------------------------------------------------------------
-- 2. Apply the label when a pipeline entry ENTERS the no_show stage. Reverse of
--    the 0023 "Introduction label -> pipeline entry" trigger: here a stage ->
--    a thread label. INSERT-ONLY (add alongside), assigned_by = 'system'.
-- ---------------------------------------------------------------------------
create or replace function public.pipeline_apply_no_show_label()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_label_id uuid;
  v_ws       uuid;
begin
  begin
    -- Guard rails: needs a thread, only the no_show stage, exclude demo.
    if new.thread_id is null or new.stage <> 'no_show' then
      return new;
    end if;
    if new.client_id = '00ef116c-646d-43b4-a323-680548ea7126' then
      return new;  -- demo client
    end if;
    -- Only when ENTERING no_show (skip no-op updates that were already no_show).
    if tg_op = 'UPDATE' then
      if old.stage = 'no_show' then
        return new;
      end if;
    end if;

    select t.workspace_id into v_ws from public.threads t where t.id = new.thread_id;
    if v_ws is null then
      return new;
    end if;
    select l.id into v_label_id
      from public.labels l
     where l.workspace_id = v_ws
       and l.name = 'No Show / No Response'
     limit 1;
    if v_label_id is null then
      return new;
    end if;

    insert into public.label_assignments
      (workspace_id, label_id, target_type, target_id, assigned_by)
    values
      (v_ws, v_label_id, 'thread', new.thread_id, 'system')
    on conflict (label_id, target_type, target_id) do nothing;
  exception when others then
    null;  -- best-effort: never block a stage change
  end;
  return new;
end;
$$;

drop trigger if exists pipeline_apply_no_show_label on public.client_pipeline_entries;
create trigger pipeline_apply_no_show_label
  after insert or update on public.client_pipeline_entries
  for each row execute function public.pipeline_apply_no_show_label();

-- ---------------------------------------------------------------------------
-- 3. Backfill: label every existing no_show intro's thread (non-demo). INSERT
--    ONLY — the Introduction label stays, so the thread ends with both labels
--    and no 0033 cascade can trigger.
-- ---------------------------------------------------------------------------
insert into public.label_assignments
  (workspace_id, label_id, target_type, target_id, assigned_by)
select t.workspace_id, l.id, 'thread', e.thread_id, 'system'
from public.client_pipeline_entries e
join public.threads t on t.id = e.thread_id
join public.labels  l on l.workspace_id = t.workspace_id
                     and l.name = 'No Show / No Response'
where e.stage = 'no_show'
  and e.thread_id is not null
  and e.client_id <> '00ef116c-646d-43b4-a323-680548ea7126'
on conflict (label_id, target_type, target_id) do nothing;
