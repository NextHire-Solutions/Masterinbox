-- 0074_client_pipeline_stages.sql
--
-- Client-customizable pipeline stages (create / rename / reorder / hide / delete),
-- built as a DISPLAY OVERLAY on top of the frozen `pipeline_stage` enum.
--
-- SAFETY / INVARIANTS (this is why it cannot break the live system):
--  - The `pipeline_stage` enum and EVERY trigger/view/webhook that keys off it stay
--    untouched. Reporting (v_pipeline_outcomes / /api/outcomes), the introduction /
--    hired / no_show side-effects, and the n8n / Bison / FUB / Slack notifiers all
--    keep running purely on the canonical enum `client_pipeline_entries.stage`.
--  - This migration is PURELY ADDITIVE and INERT: nothing reads these objects unless
--    the `manage_stages` feature flag is on (Demo portal only). Existing clients, the
--    live portals, and the whole inbox are byte-for-byte unaffected.
--  - Custom stages are workflow/display buckets only. They never become enum values,
--    never fire webhooks, and never appear in the funnel.

-- Per-client stage list: the canonical 9 (seeded per client on first use) plus any
-- custom stages the client adds. Drives order, labels, colors, and visibility on the
-- portal board — only when the feature flag is on.
create table if not exists public.client_pipeline_stages (
  id              uuid primary key default uuid_generate_v4(),
  client_id       uuid not null references public.clients (id) on delete cascade,
  key             text not null,          -- canonical rows: the enum value; custom rows: 'custom_<slug>'
  label           text not null,
  color           text,                   -- optional style token / hex; null falls back to the code default
  sort_order      integer not null default 0,
  kind            text not null default 'custom' check (kind in ('canonical', 'custom')),
  canonical_stage pipeline_stage,         -- set for kind='canonical' (= the enum value); null for custom
  hidden          boolean not null default false,
  created_at      timestamptz not null default timezone('utc', now()),
  updated_at      timestamptz not null default timezone('utc', now()),
  unique (client_id, key),
  -- canonical rows must name their enum stage; custom rows must not
  check ((kind = 'canonical') = (canonical_stage is not null))
);

create index if not exists client_pipeline_stages_client_idx
  on public.client_pipeline_stages (client_id, sort_order);

-- Service-role only, matching the sibling client_* child tables (the portal and staff
-- read via the admin client). No anon / authenticated access.
alter table public.client_pipeline_stages enable row level security;

-- Display-only pointer: when set, an entry RENDERS in this custom stage. Its canonical
-- `stage` (enum) is deliberately left unchanged, so metrics / outcomes / webhooks keep
-- treating the entry by its real funnel position. Plain nullable text, validated in app
-- code; a custom stage is only deleted after its entries have been reassigned (which
-- clears this back to null).
alter table public.client_pipeline_entries
  add column if not exists custom_stage_key text;
