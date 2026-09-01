// Lazy env accessor — does NOT throw on import so `next build` can collect
// page data without requiring real Supabase credentials. Each call site reads
// the value at runtime and throws there if it is missing.

function lazyRequired(name: string) {
  return () => {
    const v = process.env[name];
    if (!v) {
      throw new Error(
        `Missing environment variable: ${name}. Copy .env.example to .env.local and fill in the values.`,
      );
    }
    return v;
  };
}

function lazyOptional(name: string) {
  return () => process.env[name] || undefined;
}

export const env = {
  get SUPABASE_URL() {
    return lazyRequired("NEXT_PUBLIC_SUPABASE_URL")();
  },
  get SUPABASE_ANON_KEY() {
    return lazyRequired("NEXT_PUBLIC_SUPABASE_ANON_KEY")();
  },
  get SUPABASE_SERVICE_ROLE_KEY() {
    return lazyOptional("SUPABASE_SERVICE_ROLE_KEY")();
  },
  get APP_URL() {
    return process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000";
  },
  get EMAILBISON_BASE_URL() {
    return process.env.EMAILBISON_BASE_URL ?? "https://send.brokerstaffer.com";
  },
  get INSTANTLY_BASE_URL() {
    return process.env.INSTANTLY_BASE_URL ?? "https://api.instantly.ai/api/v2";
  },
  get INSTANTLY_API_KEY() {
    return lazyOptional("INSTANTLY_API_KEY")();
  },
  get INSTANTLY_WEBHOOK_SECRET() {
    return lazyOptional("INSTANTLY_WEBHOOK_SECRET")();
  },
  get EMAILBISON_API_KEY() {
    return lazyOptional("EMAILBISON_API_KEY")();
  },
  // Symmetric key used by pgcrypto to encrypt per-workspace API keys
  // (AI provider keys, OAuth tokens). Must be set in production.
  get APP_ENCRYPTION_KEY() {
    return lazyOptional("APP_ENCRYPTION_KEY")();
  },
  // n8n webhook notified when a human marks a lead as Introduction.
  // Optional — the notifier is a silent no-op when unset.
  get N8N_INTRODUCTION_WEBHOOK_URL() {
    return lazyOptional("N8N_INTRODUCTION_WEBHOOK_URL")();
  },
  // Bison / Corofy orchestrator webhook, notified on the SAME
  // human-initiated Introduction event as n8n. Payload is richer
  // (custom_fields, thread_id, campaign, portal_url, recruiter,
  // etc.) but fires from the same call site — see
  // lib/webhooks/n8n-introduction.ts. Optional — silent no-op
  // when unset. Include any auth query string (e.g. ?token=…)
  // as part of the URL so credential rotation is env-var only.
  get BISON_INTRODUCTION_WEBHOOK_URL() {
    return lazyOptional("BISON_INTRODUCTION_WEBHOOK_URL")();
  },
  // Slack bot token + channel ids for the portal-activity notifier.
  // All three are optional — when any is missing the helper silently
  // skips (dev / preview / unconfigured envs don't spam Slack).
  // SLACK_CHANNEL_HIRING is the "stage → Hired" channel; everything
  // else (stage changes, notes, DNC / agent edits) lands in
  // SLACK_CHANNEL_PORTAL.
  get SLACK_BOT_TOKEN() {
    return lazyOptional("SLACK_BOT_TOKEN")();
  },
  get SLACK_CHANNEL_HIRING() {
    return lazyOptional("SLACK_CHANNEL_HIRING")();
  },
  get SLACK_CHANNEL_PORTAL() {
    return lazyOptional("SLACK_CHANNEL_PORTAL")();
  },
  // Dedicated channel for "new introduction" alerts. Falls back to
  // SLACK_CHANNEL_PORTAL when unset so the notifier still works without it.
  get SLACK_CHANNEL_INTRODUCTIONS() {
    return lazyOptional("SLACK_CHANNEL_INTRODUCTIONS")();
  },
  // Hard-pinned singleton workspace UUID. Setting this lets requireSession
  // skip the per-request Supabase query that resolves "which workspace am
  // I in" — saving ~280ms × every page render on the single-tenant
  // BrokerStaffer install. Falls back to a DB lookup when unset, for dev
  // convenience. Legacy alias COROFY_WORKSPACE_ID is honoured for the
  // env-var rename transition (drop after Railway is updated).
  get WORKSPACE_ID() {
    return (
      lazyOptional("WORKSPACE_ID")() ?? lazyOptional("COROFY_WORKSPACE_ID")()
    );
  },
  // Bearer token for the public GET /api/outcomes attribution feed. A
  // DEDICATED secret — deliberately NOT the Supabase service-role key — so the
  // external tool that polls outcomes can never touch the database directly and
  // can be rotated in isolation. Optional: when unset the endpoint refuses all
  // requests (401), so a missing env fails closed rather than open.
  get OUTCOMES_API_TOKEN() {
    return lazyOptional("OUTCOMES_API_TOKEN")();
  },
  // External client-status feed (active/paused/churned) that the sidebar's
  // Client List reads to show 🟢/🟡/🔴. Lives in a separate app — MasterInbox
  // does NOT own this data. Both optional: when either is unset the internal
  // proxy returns no status and the sidebar renders exactly as before (fail
  // open — a missing/broken feed must never affect the live inbox).
  get CLIENT_STATUS_URL() {
    return lazyOptional("CLIENT_STATUS_URL")();
  },
  get CLIENT_STATUS_TOKEN() {
    return lazyOptional("CLIENT_STATUS_TOKEN")();
  },
  // External "agents contact" DB (a separate app; MasterInbox does not own it).
  // Used ONLY when staff add a phone from the inbox Agent card, to push it into
  // that agents DB. Token optional: when unset the save fails closed with a
  // clear "not configured" message and nothing is called.
  get AGENTS_CONTACT_URL() {
    return process.env.AGENTS_CONTACT_URL ?? "https://web-production-34f4a.up.railway.app";
  },
  get AGENTS_CONTACT_TOKEN() {
    return lazyOptional("AGENTS_CONTACT_TOKEN")();
  },
};

export const browserEnv = {
  // These are baked into the client bundle at build time, so undefined here
  // simply means the env was empty at build — the runtime will fail loudly
  // when createBrowserClient tries to use them.
  SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL!,
  SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
  APP_URL: process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000",
};
