/*
 * Plain text → HTML, preserving paragraph and line breaks.
 *
 * ---------------------------------------------------------------------------
 * WHY THE SERVER NEEDS THIS TOO
 *
 * The composer already does this conversion in the browser and always sends
 * `content_type: "html"`, which is why replies typed in the UI arrive looking
 * the way they were written.
 *
 * A reply sent with `content_type: "text"` had no such step. It reached
 * Instantly as a text body, and what landed in the mailbox was every line run
 * together: a 40-paragraph message arrived as one unbroken wall of text, and a
 * short one lost the blank line before its second paragraph.
 *
 * The part worth remembering is how it was missed. The stored row looked
 * perfect — `body_text` held all 80 newlines and all 40 paragraph breaks — so
 * checking the database said the send was fine. Only the rendered email showed
 * the truth. Storage is not rendering.
 *
 * Kept as its own module rather than exported from the composer because the
 * composer is a client component, and pulling it into a route handler would
 * drag the editor in with it.
 */

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    // `&#039;`, not `&#39;`: the composer writes the four-digit form, and the
    // agent's send is byte-compared against the composer's output.
    .replace(/'/g, "&#039;");
}

/**
 * Single newlines become `<br>`; blank lines become paragraph breaks.
 *
 * Deliberately the same rule as the composer's own `plainTextToHtml`, so a
 * reply sent through the API and one typed in the UI arrive looking identical.
 */
export function plainTextToHtml(s: string): string {
  if (!s) return "";
  return s
    .split(/\n{2,}/)
    .map((para) => `<p>${escapeHtml(para).replace(/\n/g, "<br>") || "<br>"}</p>`)
    .join("");
}
