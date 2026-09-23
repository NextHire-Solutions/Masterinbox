-- Client lifecycle status for Master Inbox.
--
-- This table has carried no lifecycle state at all. `portal_enabled` looks
-- like one and is not: it says whether the client can open their portal, which
-- is a DIFFERENT question from whether they are a client. An active client can
-- have their portal off while it is being set up, and a churned one can keep
-- it on while they download their data.
--
-- So status is added beside it rather than derived from it, and NOTHING HERE
-- CHANGES PORTAL ACCESS. No row's portal_enabled is read or written. Every
-- live portal keeps working exactly as it does now.
--
-- DELIBERATELY NOT ENFORCED YET. The rule the client gave us — paused or
-- churned means pause the campaigns and turn the portal off — is real, and it
-- is not in this migration. A trigger that disabled portals would act on
-- fifty-nine live rows the moment it was created, and portals are the one
-- surface a client sees. Recording the status is safe; acting on it is a
-- separate, deliberate step with someone watching. (That step now exists as
-- lib/portals/status-sync.ts, which is driven by a feed and has its own
-- fail-safes.)
--
-- ADDS ONE NULLABLE COLUMN AND ONE INDEX. No existing column is read, written,
-- renamed or dropped, so no running query can change behaviour.
--
-- SAME DATABASE AS os_clients, so the backfill is a join rather than a sync.
--
-- SAFE TO RE-RUN.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS status TEXT;

/*
 * Scoped to THIS table. `conname` is unique per table, not per database, so a
 * constraint of the same name on some other table would otherwise make this
 * block skip silently and leave the column unconstrained.
 */
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.clients'::regclass
      AND conname  = 'clients_status_check'
  ) THEN
    ALTER TABLE public.clients
      ADD CONSTRAINT clients_status_check
      CHECK (status IS NULL OR status IN ('onboarding', 'active', 'paused', 'churned'));
  END IF;
END $$;

/*
 * Backfill ONLY from os_clients, which is the master. Every row it knows about
 * gets the authoritative answer.
 *
 * Everything else stays NULL, and that is the point rather than an oversight.
 * NULL here means "no master record claims this row" — a test row, a fallback,
 * or a client that predates the roster. Guessing 'active' for those would
 * manufacture twenty-odd clients that nobody has agreed to, and guessing
 * 'churned' would be worse. The spec asks (§17) that we be able to tell an
 * intentional exception from a system failure; a NULL we can see is how that
 * distinction stays visible until someone resolves it.
 *
 * 'prospect' is mapped rather than copied. os_clients still accepts that word
 * until OS migration 0013 retires it, and copying it verbatim would violate
 * the CHECK above and abort this migration. Mapping costs nothing and means
 * the two migrations can be run in either order.
 */
UPDATE public.clients c
   SET status = CASE WHEN o.status = 'prospect' THEN 'onboarding' ELSE o.status END
  FROM public.os_clients o
 WHERE o.mi_client_id = c.id
   AND c.status IS DISTINCT FROM
       (CASE WHEN o.status = 'prospect' THEN 'onboarding' ELSE o.status END);

COMMENT ON COLUMN public.clients.status IS
  'onboarding | active | paused | churned, mirrored from os_clients. '
  'NULL means no master record claims this row. Separate from portal_enabled, '
  'which is portal ACCESS and is not set from here.';

CREATE INDEX IF NOT EXISTS clients_status_idx ON public.clients (status);

COMMIT;
