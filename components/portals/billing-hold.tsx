import type { BillingHold } from "@/lib/portals/billing-hold";

/*
 * What a portal shows while it is held for an unpaid invoice (BrokerStaffer
 * OS, 6 Oct). The URL is unchanged, nothing is deleted, and the portal comes
 * back by itself once the invoice is paid.
 */
export function PortalBillingHold({ clientName, hold }: { clientName: string; hold: BillingHold }) {
  const amount = hold.amount !== null ? hold.amount.toLocaleString("en-US", { style: "currency", currency: "USD" }) : null;
  return (
    <main style={{ minHeight: "100vh", display: "grid", placeItems: "center", padding: "24px 16px", background: "#F7F8FA", fontFamily: "Inter, system-ui, sans-serif" }}>
      <section style={{ maxWidth: 480, width: "100%", background: "#fff", border: "1px solid #E5E7EB", borderRadius: 16, padding: "28px 26px", boxShadow: "0 10px 30px rgba(15,23,42,.06)" }}>
        <p style={{ margin: 0, fontSize: 12, letterSpacing: ".12em", textTransform: "uppercase", color: "#6B7280", fontWeight: 600 }}>BrokerStaffer Client Portal</p>
        <h1 style={{ margin: "10px 0 8px", fontSize: 22, color: "#0F172A", letterSpacing: "-.01em" }}>Your portal is paused</h1>
        <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "#374151" }}>
          We weren&rsquo;t able to collect {amount ? <b>{amount}</b> : "your latest payment"} for {clientName}. Your agents, pipeline and settings are all kept — the portal reopens automatically once the invoice is paid.
        </p>
        {hold.payUrl ? (
          <a href={hold.payUrl} target="_blank" rel="noopener noreferrer"
            style={{ display: "inline-block", marginTop: 20, padding: "11px 18px", borderRadius: 10, background: "#0165FE", color: "#fff", fontWeight: 600, fontSize: 15, textDecoration: "none" }}>
            Pay the invoice
          </a>
        ) : null}
        <p style={{ margin: "18px 0 0", fontSize: 13, color: "#6B7280" }}>Questions? Reply to any email from your BrokerStaffer account manager.</p>
      </section>
    </main>
  );
}
