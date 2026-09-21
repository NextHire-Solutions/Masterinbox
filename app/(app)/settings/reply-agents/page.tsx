import { SettingsPageShell } from "@/components/settings/page-shell";
import { ReplyAgentsManager } from "@/components/settings/reply-agents-manager";
import { requireSession } from "@/lib/auth/workspace";
import { loadAgents } from "@/lib/ai/agent";
import { liveSendingEnabled } from "@/lib/ai/live-gate";
import { createAdminSupabase } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

export default async function Page() {
  const session = await requireSession();
  const admin = createAdminSupabase();
  // The client roster for the config dialog's picker — the same catalog the
  // Clients settings page reads, minus the "unknown" fallback bucket, which is
  // not a client anyone assigns an agent to.
  const [agents, { data: clientRows }] = await Promise.all([
    loadAgents(session.activeWorkspace.id),
    admin.from("clients").select("id, name, slug").order("name", { ascending: true }),
  ]);
  const clients = (clientRows ?? [])
    .filter((c) => (c.slug as string) !== "unknown")
    .map((c) => ({ id: c.id as string, name: c.name as string }));

  return (
    <SettingsPageShell
      title="Reply Agents"
      description="Configure AI agents that qualify leads and draft replies for you. Shadow agents draft into the composer; live sending is gated off on this server."
    >
      <ReplyAgentsManager
        agents={agents}
        clients={clients}
        liveSendingEnabled={liveSendingEnabled()}
      />
    </SettingsPageShell>
  );
}
