// Preserve client_pipeline_entries notes across an Introduction re-tag.
//
// WHY: applying a label is a delete-then-insert pair (Supabase REST has no
// cross-statement transaction — see app/api/threads/[threadId]/labels/route.ts
// and app/api/threads/bulk/route.ts). Between the two statements a thread has
// zero labels, so the 0033 deferred cleanup trigger deletes its pipeline entry,
// which cascade-deletes its notes (client_pipeline_notes is ON DELETE CASCADE,
// plus the entry's own `notes` column). The re-inserted Introduction label then
// rebuilds a fresh, note-less entry via the 0023 trigger. Operators reported
// this as "re-tagging a no-show as Introduction wipes the old notes."
//
// FIX (scoped to the Introduction path): snapshot each thread's notes BEFORE
// the relabel, then, if the entry was rebuilt (its id changed), copy the notes
// onto the new entry AFTER. Nothing else in the label flow changes — the person
// still lands in Introduction exactly as before, only their notes carry over.
//
// SAFETY: read-only snapshot; restore only writes notes (the `notes` column and
// client_pipeline_notes rows) and only when the entry was actually recreated
// and the new entry has none yet, so it never duplicates or clobbers. It never
// touches stage/hired_at/labels, and both helpers swallow their own errors so a
// labeling request can never fail because of note preservation.

import { createAdminSupabase } from "@/lib/supabase/admin";

type Admin = ReturnType<typeof createAdminSupabase>;

type NoteRow = { body: string; created_at: string; updated_at: string };
type ThreadNotes = { entryId: string; notesText: string | null; log: NoteRow[] };

export type PipelineNotesSnapshot = {
  // keyed by thread_id → the entry + notes that existed before the relabel
  byThread: Map<string, ThreadNotes>;
};

const EMPTY: PipelineNotesSnapshot = { byThread: new Map() };

// Capture the current pipeline-entry notes for the given threads, BEFORE the
// label wipe destroys them. Best-effort: any failure yields an empty snapshot
// so the caller's labeling flow proceeds unchanged.
export async function snapshotPipelineNotes(
  admin: Admin,
  threadIds: string[],
): Promise<PipelineNotesSnapshot> {
  try {
    const ids = Array.from(new Set(threadIds.filter(Boolean)));
    if (ids.length === 0) return EMPTY;

    const { data: entries } = await admin
      .from("client_pipeline_entries")
      .select("id, thread_id, notes")
      .in("thread_id", ids);
    if (!entries || entries.length === 0) return EMPTY;

    const byThread = new Map<string, ThreadNotes>();
    const entryToThread = new Map<string, string>();
    for (const e of entries as Array<{ id: string; thread_id: string | null; notes: string | null }>) {
      if (!e.thread_id) continue;
      byThread.set(e.thread_id, { entryId: e.id, notesText: e.notes, log: [] });
      entryToThread.set(e.id, e.thread_id);
    }
    if (byThread.size === 0) return EMPTY;

    const entryIds = Array.from(entryToThread.keys());
    const { data: notes } = await admin
      .from("client_pipeline_notes")
      .select("entry_id, body, created_at, updated_at")
      .in("entry_id", entryIds);
    for (const n of (notes ?? []) as Array<{ entry_id: string } & NoteRow>) {
      const tid = entryToThread.get(n.entry_id);
      if (!tid) continue;
      byThread.get(tid)?.log.push({
        body: n.body,
        created_at: n.created_at,
        updated_at: n.updated_at,
      });
    }
    return { byThread };
  } catch {
    return EMPTY;
  }
}

// After the relabel, copy snapshotted notes onto any entry that was rebuilt
// (id changed). Skips entries that survived untouched and entries that already
// carry notes, so it never duplicates. Best-effort; never throws.
export async function restorePipelineNotes(
  admin: Admin,
  snapshot: PipelineNotesSnapshot,
): Promise<void> {
  try {
    if (snapshot.byThread.size === 0) return;
    const threadIds = Array.from(snapshot.byThread.keys());

    const { data: current } = await admin
      .from("client_pipeline_entries")
      .select("id, thread_id, notes")
      .in("thread_id", threadIds);
    const currentByThread = new Map<string, { id: string; notes: string | null }>();
    for (const e of (current ?? []) as Array<{ id: string; thread_id: string | null; notes: string | null }>) {
      if (e.thread_id) currentByThread.set(e.thread_id, { id: e.id, notes: e.notes });
    }

    for (const [tid, snap] of snapshot.byThread) {
      const cur = currentByThread.get(tid);
      if (!cur) continue; // no entry now (e.g. swapped to a non-pipeline label) — nothing to restore
      if (cur.id === snap.entryId) continue; // entry survived the relabel — notes intact already

      const hasText = !!(snap.notesText && snap.notesText.trim().length > 0);
      const hasLog = snap.log.length > 0;
      if (!hasText && !hasLog) continue;

      // Legacy single-field notes: restore only if the rebuilt entry has none.
      if (hasText && !(cur.notes && cur.notes.trim().length > 0)) {
        await admin
          .from("client_pipeline_entries")
          .update({ notes: snap.notesText })
          .eq("id", cur.id);
      }

      // Timestamped notes log: re-insert only if the rebuilt entry has no rows
      // yet, preserving the original bodies and timestamps.
      if (hasLog) {
        const { count } = await admin
          .from("client_pipeline_notes")
          .select("id", { count: "exact", head: true })
          .eq("entry_id", cur.id);
        if (!count) {
          const rows = snap.log.map((n) => ({
            entry_id: cur.id,
            body: n.body,
            created_at: n.created_at,
            updated_at: n.updated_at,
          }));
          await admin.from("client_pipeline_notes").insert(rows);
        }
      }
    }
  } catch {
    // best-effort: never break the labeling flow because a note copy failed
  }
}
