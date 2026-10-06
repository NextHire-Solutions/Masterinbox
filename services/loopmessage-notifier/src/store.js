// Durable state for the delivery engine: one JSON document.
//
// Who has consented, which alerts are held, and the pacing clock all have
// to survive a redeploy — Railway redeploys on every variable change, and
// forgetting consent would re-send welcomes (wasting LoopMessage's daily
// initiation cap) while forgetting the pacing clock would break the
// 15-minute spacing LoopMessage requires.
//
// The data is small (one record per team member's phone), so a whole-file
// rewrite per change is fine. Writes go to a temp file and are renamed into
// place, so a crash mid-write leaves the previous version intact.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export class FileStore {
  constructor(path, { logger = console } = {}) {
    this.path = path;
    this.logger = logger;
  }

  load() {
    let raw;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch (err) {
      // Keep the unreadable file for inspection and start fresh, rather than
      // crash-looping on every boot.
      const aside = `${this.path}.corrupt-${Date.now()}`;
      try {
        renameSync(this.path, aside);
      } catch {
        // Best effort; the fresh state will overwrite it on the next save.
      }
      this.logger.error(
        JSON.stringify({
          level: "error",
          msg: "state_unreadable",
          moved_to: aside,
          error: String(err?.message ?? err),
        }),
      );
      return null;
    }
  }

  save(state) {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    writeFileSync(tmp, JSON.stringify(state));
    renameSync(tmp, this.path);
  }
}

// Same interface, kept in memory. Used by the tests; a structured clone on
// both sides so tests can't accidentally share references with the engine.
export class MemoryStore {
  constructor(initial = null) {
    this.data = initial ? structuredClone(initial) : null;
    this.saves = 0;
  }

  load() {
    return this.data ? structuredClone(this.data) : null;
  }

  save(state) {
    this.data = structuredClone(state);
    this.saves += 1;
  }
}
