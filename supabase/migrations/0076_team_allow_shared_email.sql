-- 0076: allow the same email on multiple team members (group inboxes).
--
-- WHY: some clients run their Team roster off a single shared inbox address
-- (e.g. team@brokerage.com) and want several people listed under it. Migration
-- 0042 added a per-client UNIQUE index on (client_id, email) — originally only
-- to let the CSV path upsert — which blocks that. Team email drives no
-- blocklist / DNC push and nothing keys off it being unique (recruiter
-- ownership is by row id, the UI keys by id, the n8n webhook lists by
-- client_id), so the uniqueness is safe to drop.
--
-- Dedup now lives in the app on (name + email) combined: the single-add route
-- rejects only an exact (name, email) repeat, and the CSV import skips rows
-- whose (name, email) already exists — so a shared email with different names
-- is allowed while a re-uploaded file stays a no-op. This migration removes the
-- storage-level uniqueness those code paths were updated to stop relying on.
--
-- ORDER: the code change (team + team/csv routes) ships FIRST and works whether
-- or not this index still exists (it inserts plainly and, during the pre-drop
-- window, falls back to per-row inserts that skip the legacy conflict). Running
-- this migration after that deploy is what actually enables shared emails.
--
-- SAFETY (portal + inbox are in live client use): DROP INDEX removes a
-- constraint only — it touches no rows and cannot affect any other client,
-- portal section, or MasterInbox. The replacement index is a NON-unique lookup
-- index so the app's "does this (client_id, email) already exist" check stays
-- fast.

-- (1) The redundant UNIQUE INDEX added by migration 0042.
drop index if exists public.client_team_members_unique_email;

-- (2) The original UNIQUE CONSTRAINT from the 0023 table definition
--     (Postgres-named client_team_members_client_id_email_key). A DROP INDEX
--     does NOT remove a table constraint, so it must be dropped explicitly —
--     this is the one that actually blocks a shared email.
alter table public.client_team_members
  drop constraint if exists client_team_members_client_id_email_key;

-- Replace both with a plain (non-unique) lookup index so the app's
-- "does this (client_id, email) already exist" check stays fast.
create index if not exists client_team_members_client_email_idx
  on public.client_team_members (client_id, email);
