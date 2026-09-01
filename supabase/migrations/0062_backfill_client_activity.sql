-- One-time backfill of client_activity_at from the clearest historical
-- client-engagement signals, so the Client Success dashboard has a real
-- baseline instead of a wall of nulls until the 0061 trigger accumulates
-- data going forward.
--
-- Per entry, client_activity_at is set to the best available CLIENT
-- timestamp, in this preference order (matches the product spec):
--   1. hired_at            — for hired leads this IS the "current label
--                            assigned_at" (the exact client hire action,
--                            set by the 0059 trigger; dodges FUB pollution).
--   2. latest note time    — the client added/edited a note.
--   3. updated_at          — last-resort fallback for a lead the client
--                            moved past 'introduction' but for which we
--                            have no cleaner signal (approximate; may
--                            reflect a FUB push, accepted per spec).
-- greatest() takes the most-recent of the clean signals (hire vs notes);
-- coalesce() drops to the updated_at fallback only when no clean signal
-- exists.
--
-- SCOPE: only rows the client demonstrably engaged with — stage moved
-- past 'introduction', OR has at least one note. An introduction-stage
-- lead with no notes stays NULL (correctly "never engaged").
--
-- SAFETY: sets ONLY client_activity_at, and ONLY where it is currently
-- NULL — so it never overwrites a real value the 0061 trigger has already
-- stamped, and re-running is a no-op (idempotent). It does not touch
-- updated_at (so last_lead_activity_at is unaffected) or any other column.
-- The 0061 BEFORE UPDATE trigger is a no-op on these updates (no enumerated
-- field changes), and the 0059 hired_at trigger is a no-op (stage
-- unchanged), so the explicit values are preserved.

update public.client_pipeline_entries e
set client_activity_at = coalesce(
  greatest(
    case when e.stage = 'hired' then e.hired_at end,
    (select max(coalesce(n.updated_at, n.created_at))
       from public.client_pipeline_notes n
      where n.entry_id = e.id)
  ),
  case when e.stage <> 'introduction' then e.updated_at end
)
where e.client_activity_at is null
  and (
    e.stage <> 'introduction'
    or exists (
      select 1 from public.client_pipeline_notes n where n.entry_id = e.id
    )
  );
