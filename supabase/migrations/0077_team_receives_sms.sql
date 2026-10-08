-- 0077: per-member "SMS" switch on the portal Team page.
--
-- client_team_members.receives_sms: is this person texted when one of
-- their client's leads is marked Introduction. Default true, so every
-- existing and future member keeps today's behaviour (active + a phone =
-- texted) until someone switches them off.
--
-- Only read for clients whose feature_flags.team_sms_notifications is true
-- (Demo Portal only until rolled out), and only through separate,
-- error-checked queries (lib/portals/team-sms.ts). It is NOT SMS consent:
-- the SMS notifier still asks each person to reply YES first.
--
-- ORDER: apply BEFORE deploying the code that reads it; flip the flag for
-- Demo Portal AFTER the deploy (statement at the bottom). Additive and
-- re-runnable; adding a column with a constant default is catalog-only.

begin;

set local lock_timeout = '5s';

alter table public.client_team_members
  add column if not exists receives_sms boolean not null default true;

comment on column public.client_team_members.receives_sms is
  'Text this person Introduction alerts (also requires active = true and a phone). Read only when the client has feature_flags.team_sms_notifications. Not SMS consent; the notifier asks for YES first.';

commit;

notify pgrst, 'reload schema';

-- After the code deploys, Demo Portal only (by id: a rename changes the slug):
--
--   update public.clients
--      set feature_flags = jsonb_set(feature_flags, '{team_sms_notifications}', 'true'::jsonb, true)
--    where id = '00ef116c-646d-43b4-a323-680548ea7126';
