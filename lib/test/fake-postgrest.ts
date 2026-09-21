/*
 * A fake PostgREST and two fake providers behind `globalThis.fetch`, for the
 * send-path tests.
 *
 * ---------------------------------------------------------------------------
 * WHY A FAKE DATABASE RATHER THAN THROWAWAY ROWS IN THE REAL ONE
 *
 * The same pattern as the OS's sync/handlers.test.ts, and for the same reason:
 * the code under test reaches the database only through a real supabase-js client
 * whose only side effect is `fetch`, so an in-memory PostgREST exercises the
 * query building, `.maybeSingle()`, the upsert-on-conflict and the workspace
 * scoping exactly as shipped, with no network and no database.
 *
 * Here there is a second reason, specific to what these tests do. A live
 * handover applies the Introduction label, and in the real database that
 * label fires a trigger which opens a pipeline entry in a client's LIVE
 * portal and announces the introduction to that client. `workspaceId()`
 * throws if a second workspace exists, so a throwaway workspace is not an
 * option either. No row written by these tests may exist in the shared
 * database, even for a second.
 *
 * ---------------------------------------------------------------------------
 * THE PROVIDERS
 *
 * The EmailBison and Instantly clients are constructed for real, pointed at
 * `emailbison.test` and `instantly.test` by the same environment variables
 * the app reads, and their requests are recorded here and answered with the
 * shape the real services return. A test asserts on the exact request. Any
 * request to a host other than those three is refused before it leaves the
 * process and recorded in `blocked`; the tests assert that list is empty.
 */

import { randomUUID } from "node:crypto";

export type Row = Record<string, unknown>;

export interface RecordedCall {
  method: string;
  table: string;
  query: URLSearchParams;
  body: unknown;
  headers: Headers;
}

export interface ProviderCall {
  provider: "emailbison" | "instantly";
  method: string;
  path: string;
  url: string;
  headers: Headers;
  body: unknown;
}

export class FakePostgrest {
  readonly tables = new Map<string, Row[]>();
  readonly calls: RecordedCall[] = [];
  readonly providerCalls: ProviderCall[] = [];
  readonly blocked: string[] = [];
  /** Queued provider responses, consumed in order; a canned success otherwise. */
  readonly nextProviderResponses: Array<{ status: number; body: unknown }> = [];

  /** Seeds a table (replacing it) and returns the rows, each with an id. */
  seed(table: string, rows: Row[]): Array<Row & { id: string }> {
    const seeded = rows.map((r) => ({ id: randomUUID(), ...r }) as Row & { id: string });
    this.tables.set(table, seeded);
    return seeded;
  }
  rows(table: string): Row[] {
    return this.tables.get(table) ?? [];
  }
  reset() {
    this.tables.clear();
    this.calls.length = 0;
    this.providerCalls.length = 0;
    this.blocked.length = 0;
    this.nextProviderResponses.length = 0;
  }
  writes(table: string, method: "POST" | "PATCH" | "DELETE") {
    return this.calls.filter((c) => c.table === table && c.method === method);
  }

  private matches(row: Row, query: URLSearchParams): boolean {
    for (const [k, v] of query) {
      if (["select", "order", "limit", "offset", "on_conflict", "columns"].includes(k)) continue;
      const cell = row[k];
      const str = cell === null || cell === undefined ? null : String(cell);
      if (v.startsWith("eq.")) {
        if (str !== v.slice(3)) return false;
      } else if (v.startsWith("neq.")) {
        if (str === v.slice(4)) return false;
      } else if (v === "is.null") {
        if (str !== null) return false;
      } else if (v === "not.is.null") {
        if (str === null) return false;
      } else if (v.startsWith("ilike.")) {
        const pattern = v.slice(6).replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/%/g, ".*").replace(/\*/g, ".*");
        if (str === null || !new RegExp(`^${pattern}$`, "i").test(str)) return false;
      } else if (v.startsWith("in.(")) {
        const wanted = v
          .slice(4, -1)
          .split(",")
          .map((s) => s.replace(/^"|"$/g, ""));
        if (str === null || !wanted.includes(str)) return false;
      } else if (v.startsWith("gte.")) {
        if (str === null || str < v.slice(4)) return false;
      } else if (v.startsWith("gt.")) {
        if (str === null || !(Number(str) > Number(v.slice(3)) || str > v.slice(3))) return false;
      } else if (v.startsWith("lte.")) {
        if (str === null || str > v.slice(4)) return false;
      } else if (v.startsWith("lt.")) {
        if (str === null || str >= v.slice(3)) return false;
      } else {
        throw new Error(`fake-postgrest: unsupported filter ${k}=${v}`);
      }
    }
    return true;
  }

  private order(rows: Row[], query: URLSearchParams): Row[] {
    const order = query.get("order");
    if (!order) return rows;
    const [col, ...mods] = order.split(".");
    const desc = mods.includes("desc");
    return [...rows].sort((a, b) => {
      const av = a[col] as string | number | null | undefined;
      const bv = b[col] as string | number | null | undefined;
      if (av === bv) return 0;
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      return (av < bv ? -1 : 1) * (desc ? -1 : 1);
    });
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host === "emailbison.test" || url.host === "instantly.test") {
      return this.provider(url, init);
    }
    if (url.host !== "supabase.test") {
      this.blocked.push(url.href);
      throw new Error(`network blocked: ${url.href}`);
    }
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const parts = url.pathname.replace(/^\/rest\/v1\//, "").split("/");
    const table = parts[0] === "rpc" ? `rpc:${parts[1]}` : parts[0];
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    this.calls.push({ method, table, query: url.searchParams, body, headers });

    const respond = (rows: Row[], status = 200) => {
      const wantsObject = (headers.get("accept") ?? "").includes("vnd.pgrst.object+json");
      if (wantsObject && rows.length !== 1) {
        return new Response(JSON.stringify({ code: "PGRST116", message: `${rows.length} rows` }), {
          status: 406,
          headers: { "content-type": "application/json" },
        });
      }
      if ((headers.get("prefer") ?? "").includes("return=minimal")) {
        return new Response("", { status: 204 });
      }
      return new Response(JSON.stringify(wantsObject ? rows[0] : rows), {
        status,
        headers: { "content-type": "application/json" },
      });
    };

    if (table.startsWith("rpc:")) return respond([]);
    const store = this.tables.get(table) ?? [];
    this.tables.set(table, store);

    if (method === "GET") {
      let rows = this.order(
        store.filter((r) => this.matches(r, url.searchParams)),
        url.searchParams,
      );
      const limit = url.searchParams.get("limit");
      if (limit) rows = rows.slice(0, Number(limit));
      return respond(rows);
    }
    if (method === "POST") {
      const incoming: Row[] = Array.isArray(body) ? body : [body];
      const prefer = headers.get("prefer") ?? "";
      const conflictCols = (url.searchParams.get("on_conflict") ?? "").split(",").filter(Boolean);
      const out: Row[] = [];
      for (const r of incoming) {
        const existing =
          conflictCols.length > 0
            ? store.find((s) => conflictCols.every((c) => String(s[c]) === String(r[c])))
            : undefined;
        if (existing && prefer.includes("resolution=ignore-duplicates")) {
          continue;
        }
        if (existing && prefer.includes("resolution=merge-duplicates")) {
          Object.assign(existing, r);
          out.push(existing);
          continue;
        }
        const inserted = { id: randomUUID(), created_at: new Date().toISOString(), ...r };
        store.push(inserted);
        out.push(inserted);
      }
      return respond(out, 201);
    }
    if (method === "PATCH") {
      const rows = store.filter((r) => this.matches(r, url.searchParams));
      for (const r of rows) Object.assign(r, body);
      return respond(rows);
    }
    if (method === "DELETE") {
      const rows = store.filter((r) => this.matches(r, url.searchParams));
      for (const r of rows) store.splice(store.indexOf(r), 1);
      return respond(rows);
    }
    return respond([]);
  };

  private async provider(url: URL, init?: RequestInit): Promise<Response> {
    const provider = url.host === "emailbison.test" ? "emailbison" : "instantly";
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    let body: unknown = undefined;
    if (init?.body instanceof FormData) {
      body = Object.fromEntries(
        [...init.body.entries()].map(([k, v]) => [k, v instanceof File ? `<file:${v.name}>` : v]),
      );
    } else if (init?.body) {
      body = JSON.parse(String(init.body));
    }
    this.providerCalls.push({ provider, method, path: url.pathname, url: url.href, headers, body });

    const queued = this.nextProviderResponses.shift();
    if (queued) {
      return new Response(JSON.stringify(queued.body), {
        status: queued.status,
        headers: { "content-type": "application/json" },
      });
    }
    // The shapes the real services return for a successful send.
    const canned =
      provider === "emailbison"
        ? url.pathname.endsWith("/switch-workspace") || url.pathname.includes("/workspaces")
          ? { data: { success: true } }
          : { data: { success: true, reply: { id: 987654 } } }
        : { id: "instantly-email-uuid-1", status: "sent" };
    return new Response(JSON.stringify(canned), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }
}

/**
 * Point every client at the fakes and make sure nothing else is configured.
 *
 * `prefix` is "MASTER_INBOX_" in the OS and "" in this app; the Supabase URL
 * variable differs by name between them as well, so both are set.
 */
export function configureFakeEnvironment(prefix: string): void {
  process.env[`${prefix}SUPABASE_URL`] = "http://supabase.test";
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_URL`] = "http://supabase.test";
  process.env[`${prefix}NEXT_PUBLIC_SUPABASE_ANON_KEY`] = "test-anon";
  process.env[`${prefix}SUPABASE_SERVICE_ROLE_KEY`] = "test-service-role";
  process.env[`${prefix}EMAILBISON_BASE_URL`] = "http://emailbison.test";
  process.env[`${prefix}EMAILBISON_API_KEY`] = "test-emailbison-key";
  process.env[`${prefix}INSTANTLY_BASE_URL`] = "http://instantly.test";
  process.env[`${prefix}INSTANTLY_API_KEY`] = "test-instantly-key";
  for (const v of [
    "MASTER_INBOX_REPLY_AGENT_LIVE_SEND",
    `${prefix}SLACK_BOT_TOKEN`,
    `${prefix}N8N_INTRODUCTION_WEBHOOK_URL`,
    `${prefix}BISON_INTRODUCTION_WEBHOOK_URL`,
    `${prefix}APP_ENCRYPTION_KEY`,
    `${prefix}CRON_ENABLED`,
    `${prefix}ADMIN_TOKEN`,
    "MASTER_INBOX_ADMIN_TOKEN",
  ]) {
    delete process.env[v];
  }
}
