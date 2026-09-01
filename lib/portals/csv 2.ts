// Minimal CSV parser — handles quoted fields (with escaped "" quotes),
// commas and newlines inside quotes. No external dependency. Used for
// the Your Agents + DNC bulk imports in the portal, and for the
// client-side Export CSV buttons on the same pages.

export type CsvRow = Record<string, string>;

export function parseCsv(text: string): CsvRow[] {
  // Strip a UTF-8 BOM if present.
  const src = text.replace(/^﻿/, "");
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          // Escaped double-quote.
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += c;
      }
      continue;
    }
    if (c === '"') {
      inQuotes = true;
      continue;
    }
    if (c === ",") {
      row.push(cell);
      cell = "";
      continue;
    }
    if (c === "\n" || c === "\r") {
      // Push pending row, swallow \r\n pairs.
      if (cell.length > 0 || row.length > 0) {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = "";
      }
      if (c === "\r" && src[i + 1] === "\n") i++;
      continue;
    }
    cell += c;
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  if (rows.length === 0) return [];

  // First non-empty row = headers.
  const headerLine = rows[0];
  const headers = headerLine.map((h) => normaliseHeader(h));
  return rows.slice(1)
    .filter((r) => r.some((c) => c.trim().length > 0))
    .map((r) => {
      const obj: CsvRow = {};
      for (let i = 0; i < headers.length; i++) {
        if (!headers[i]) continue;
        obj[headers[i]] = (r[i] ?? "").trim();
      }
      return obj;
    });
}

function normaliseHeader(h: string): string {
  return h.toLowerCase().trim().replace(/[\s\-]+/g, "_");
}

// Two-tier header matcher. Tries an exact-key list first (so an
// explicit `email` column always wins over `email_address` when both
// exist), then falls back to substring contains so headers like
// "Current Brokerage" (normalised → "current_brokerage") still map to
// the `brokerage` field via the contains token "brokerage".
function pickFuzzy(
  row: CsvRow,
  exact: string[],
  contains: string[],
): string | null {
  for (const k of exact) {
    const v = row[k];
    if (v && v.trim().length > 0) return v.trim();
  }
  for (const key of Object.keys(row)) {
    if (contains.some((tok) => key.includes(tok))) {
      const v = row[key];
      if (v && v.trim().length > 0) return v.trim();
    }
  }
  return null;
}

// Maps a parsed CSV row to a Your Agents insert payload.
export interface AgentRow {
  name: string;
  email: string | null;
  phone: string | null;
  license: string | null;
}

export function csvRowToAgent(row: CsvRow): AgentRow | null {
  const first = pickFuzzy(row, ["first_name", "firstname", "first"], []);
  const last = pickFuzzy(row, ["last_name", "lastname", "last"], []);
  const name =
    pickFuzzy(
      row,
      ["name", "full_name", "fullname", "agent_name", "agent"],
      ["name", "agent"],
    ) ?? (first && last ? `${first} ${last}` : first ?? last);
  if (!name) return null;
  return {
    name,
    email: pickFuzzy(row, ["email", "email_address", "agent_email"], ["email"]),
    phone: pickFuzzy(
      row,
      ["phone", "phone_number", "mobile", "cell"],
      ["phone", "mobile", "cell"],
    ),
    license: pickFuzzy(
      row,
      ["license", "license_number", "license_no", "lic"],
      ["license", "lic"],
    ),
  };
}

export interface DncRow {
  kind: "agent" | "company";
  name: string;
  email: string | null;
  phone: string | null;
  brokerage: string | null;
  // Company rows can carry a domain — the import pushes that domain
  // to the providers' wildcard / domain-level blacklists. Falls
  // back to deriving from email if the CSV only has email.
  domain: string | null;
  notes: string | null;
}

// Maps a parsed CSV row to a DNC insert payload. Kind defaults to "agent"
// unless the row explicitly says company / brokerage / firm.
export function csvRowToDnc(row: CsvRow): DncRow | null {
  const first = pickFuzzy(row, ["first_name", "firstname", "first"], []);
  const last = pickFuzzy(row, ["last_name", "lastname", "last"], []);
  const name =
    pickFuzzy(
      row,
      [
        "name",
        "full_name",
        "fullname",
        "agent_name",
        "agent",
        "company_name",
        "company",
        "brokerage_name",
        "firm",
      ],
      ["name", "agent", "company", "firm"],
    ) ?? (first && last ? `${first} ${last}` : first ?? last);
  if (!name) return null;

  const kindRaw = pickFuzzy(
    row,
    ["kind", "type", "category"],
    ["kind", "type", "category"],
  )?.toLowerCase() ?? "";
  let kind: "agent" | "company" = "agent";
  if (
    kindRaw === "company" ||
    kindRaw === "brokerage" ||
    kindRaw === "firm" ||
    kindRaw === "org" ||
    kindRaw === "organization"
  ) {
    kind = "company";
  }

  return {
    kind,
    name,
    email: pickFuzzy(row, ["email", "email_address"], ["email"]),
    phone: pickFuzzy(
      row,
      ["phone", "phone_number", "mobile", "cell"],
      ["phone", "mobile", "cell"],
    ),
    brokerage:
      kind === "agent"
        ? pickFuzzy(
            row,
            ["brokerage", "company", "firm", "agency"],
            ["brokerage", "company", "firm", "agency"],
          )
        : null,
    domain:
      kind === "company"
        ? pickFuzzy(
            row,
            ["domain", "website", "url"],
            ["domain", "website", "url"],
          ) ?? deriveDomainFromEmail(pickFuzzy(row, ["email", "email_address"], ["email"]))
        : null,
    notes: pickFuzzy(
      row,
      ["notes", "reason", "comment"],
      ["notes", "reason", "comment"],
    ),
  };
}

// Maps a parsed CSV row to a Team-member insert payload. Email is
// required (server schema enforces .email()); the other columns are
// best-effort. Same fuzzy header matching as the Agents importer so
// "Full Name" / "Email Address" / "Job Title" all flow without a
// manual mapping step.
export interface TeamRow {
  name: string;
  email: string;
  title: string | null;
  phone: string | null;
}

export function csvRowToTeam(row: CsvRow): TeamRow | null {
  const first = pickFuzzy(row, ["first_name", "firstname", "first"], []);
  const last = pickFuzzy(row, ["last_name", "lastname", "last"], []);
  const name =
    pickFuzzy(
      row,
      ["name", "full_name", "fullname", "team_member", "member_name"],
      ["name", "member"],
    ) ?? (first && last ? `${first} ${last}` : first ?? last);
  const email = pickFuzzy(
    row,
    ["email", "email_address", "work_email"],
    ["email"],
  );
  // Team requires email — the server schema does too. Drop rows
  // without one before they hit the network.
  if (!name || !email) return null;
  return {
    name,
    email,
    title: pickFuzzy(
      row,
      ["title", "job_title", "role", "position"],
      ["title", "role", "position"],
    ),
    phone: pickFuzzy(
      row,
      ["phone", "phone_number", "mobile", "cell"],
      ["phone", "mobile", "cell"],
    ),
  };
}

// Pull the host out of an email — last-resort domain extraction when
// a company-kind CSV row only includes an email column.
function deriveDomainFromEmail(email: string | null): string | null {
  if (!email) return null;
  const at = email.lastIndexOf("@");
  if (at < 0 || at === email.length - 1) return null;
  return email.slice(at + 1).toLowerCase();
}

// CSV export helpers used by the portal Agents + DNC pages. The rows
// they export are already in memory (component state), so the whole
// generate-and-download flow stays client-side — no API roundtrip.

export function toCsv(
  rows: Record<string, unknown>[],
  columns: string[],
): string {
  const escape = (v: unknown) => {
    const s = v == null ? "" : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.join(",")];
  for (const r of rows) lines.push(columns.map((c) => escape(r[c])).join(","));
  return lines.join("\r\n");
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
