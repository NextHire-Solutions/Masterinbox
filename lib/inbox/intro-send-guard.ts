/**
 * Did the introduction the button drafted actually go out?
 *
 * The Introduce button only DRAFTS. Between the click and the send the
 * operator may delete what it inserted and write something else entirely —
 * and labelling that thread "Introduction" is not a quiet bookkeeping act. It
 * messages the client, posts to Slack, opens a portal pipeline entry and
 * pushes it to Follow Up Boss. An introduction announced but never sent is
 * worse than one labelled by hand a minute later.
 *
 * So the label is applied after a successful send, and only when the sent body
 * still carries a line the button put there.
 *
 * Whole lines of 25 characters or more are the unit of comparison, compared
 * with whitespace collapsed and case ignored. That survives everything the
 * operator legitimately does around the macro — reformatting, appending a
 * signature, rewriting the greeting, editing one paragraph — while a macro
 * that has been deleted matches nothing. The macro offers four such lines, so
 * a single reworded sentence does not lose the label.
 *
 * When in doubt it returns false, which costs an operator one manual label
 * rather than sending a client a false announcement.
 *
 * Kept identical to the workspace's copy in
 * `src/lib/tools/master-inbox/inbox/intro-macro.ts` — the two apps must agree
 * on when a thread becomes an introduction.
 */
export function introWasSent(inserted: string, sent: string): boolean {
  const haystack = collapseForMatch(sent);
  if (!haystack) return false;
  return inserted
    .split("\n")
    .map(collapseForMatch)
    .filter((line) => line.length >= 25)
    .some((line) => haystack.includes(line));
}

function collapseForMatch(value: string): string {
  return value.replace(/\s+/g, " ").trim().toLowerCase();
}
