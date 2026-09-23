-- Client lifecycle status for Master Inbox.
--
-- This table has carried no lifecycle state at all. `portal_enabled` looks
-- like one and is not: it says whether the client can open their portal, which
-- is a DIFFERENT question from whether they are a client. An active client can
-- have their portal off while it is being set up, and a churned one can keep
-- it on while they download their data.
--
-- So status is added beside it rather than derived from it, and nothing here
-- changes portal access.
--
-- DELIBERATELY NOT ENFORCED YET. The rule the client gave us — paused or
-- churned means pause the campaigns and turn the portal off — is real, and it
-- is not in this migration. A trigger that disabled portals would act on
-- fifty-nine live rows the moment it was created, and portals are the one
-- surface a client sees. Recording the status is safe; acting on it is a
-- separate, deliberate step with someone watching.
--
-- SAME DATABASE AS os_clients, so the backfill is a join rather than a sync.

BEGIN;

ALTER TABLE public.clients
  ADD COLUMN IF NOT EXISTS status TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'clients_status_check'
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
 * manufacture thirty-odd clients that nobody has agreed to, and guessing
 * 'churned' would be worse. The spec asks (§17) that we be able to tell an
 * intentional exception from a system failure; a NULL we can see is how that
 * distinction stays visible until someone resolves it.
 */
UPDATE public.clients c
   SET status = o.status
  FROM public.os_clients o
 WHERE o.mi_client_id = c.id
   AND c.status IS DISTINCT FROM o.status;

COMMENT ON COLUMN public.clients.status IS
  'onboarding | active | paused | churned, mirrored from os_clients. '
  'NULL means no master record claims this row. Separate from portal_enabled, '
  'which is portal ACCESS and is not set from here.';

CREATE INDEX IF NOT EXISTS clients_status_idx ON public.clients (status);

COMMIT;
