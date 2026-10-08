import assert from "node:assert/strict";
import { test } from "node:test";

import {
  alreadyBlacklisted,
  escapeLike,
  isBlockableAddress,
  isStopContactLabel,
  planStop,
  sameName,
  type PersonConversation,
} from "./stop-person-plan";

const conv = (c: Partial<PersonConversation> & { threadId: string }): PersonConversation => ({
  provider: "emailbison",
  leadEmail: null,
  leadName: null,
  latestReplyId: null,
  senders: [],
  ...c,
});

test("their own conversations: one reply id per EmailBison conversation; Instantly ones have none", () => {
  const plan = planStop({ emails: ["kp@personal.com"], name: "Kristin Park" }, [
    conv({ threadId: "t1", leadEmail: "kp@personal.com", latestReplyId: "101" }),
    conv({ threadId: "t2", leadEmail: "KP@personal.com", latestReplyId: "101" }),
    conv({ threadId: "t3", provider: "instantly", leadEmail: "kp@personal.com" }),
    conv({ threadId: "t4", leadEmail: "kp@personal.com", latestReplyId: "not-a-number" }),
  ]);
  assert.deepEqual(plan, { unsubscribeReplyIds: ["101"], otherEmails: [], review: [] });
});

test("the same person under another address: that conversation is stopped and the address blocked", () => {
  // The 8 Oct case: DNC lists her personal address; we emailed her work address;
  // she replied from the personal one.
  const plan = planStop({ emails: ["KP@Personal.com"], name: "Kristin Park" }, [
    conv({ threadId: "t1", leadEmail: "Kristin@Work.com ", leadName: "kristin park", latestReplyId: "149968", senders: ["kp@personal.com"] }),
  ]);
  assert.deepEqual(plan, { unsubscribeReplyIds: ["149968"], otherEmails: ["kristin@work.com"], review: [] });
});

test("someone else's conversation they replied on is left alone and listed for review", () => {
  // e.g. the client's own manager replying on an introduced lead's thread.
  const plan = planStop({ emails: ["boss@client.com"], name: "Dana Boss" }, [
    conv({ threadId: "t1", leadEmail: "recruit@x.com", leadName: "Sam Recruit", latestReplyId: "5", senders: ["boss@client.com"] }),
    conv({ threadId: "t2", leadEmail: "anon@x.com", leadName: null, latestReplyId: "6", senders: ["boss@client.com"] }),
  ]);
  assert.deepEqual(plan.unsubscribeReplyIds, []);
  assert.deepEqual(plan.otherEmails, []);
  assert.deepEqual(plan.review.map((r) => r.threadId), ["t1", "t2"]);
});

test("conversations not tied to the person are ignored", () => {
  const plan = planStop({ emails: ["a@b.com"], name: "A B" }, [conv({ threadId: "t", leadEmail: "z@y.com", latestReplyId: "1" })]);
  assert.deepEqual(plan, { unsubscribeReplyIds: [], otherEmails: [], review: [] });
});

test("several known addresses: none of them counts as 'other'", () => {
  const plan = planStop({ emails: ["kp@personal.com", "Kristin@work.com"], name: "Kristin Park" }, [
    conv({ threadId: "t1", leadEmail: "kristin@work.com", latestReplyId: "7" }),
    conv({ threadId: "t2", provider: "instantly", leadEmail: "kp@personal.com" }),
    conv({ threadId: "t3", provider: "instantly", leadEmail: "k.p@third.com", leadName: "Kristin A. Park", senders: ["kp@personal.com"] }),
  ]);
  assert.deepEqual(plan, { unsubscribeReplyIds: ["7"], otherEmails: ["k.p@third.com"], review: [] });
});

test("names: first and last must agree; one-word names never match", () => {
  assert.equal(sameName("Kristin Park", "KRISTIN  PARK"), true);
  assert.equal(sameName("Kristin A. Park", "Kristin Park, Realtor"), true);
  assert.equal(sameName("José Núñez", "Jose Nunez"), true);
  assert.equal(sameName("Kristin Park", "Kris Park"), false);
  assert.equal(sameName("Kristin", "Kristin"), false);
  assert.equal(sameName(null, "Kristin Park"), false);
});

test("mail-system and junk addresses are never blocked", () => {
  for (const a of ["MAILER-DAEMON@x.com", "postmaster@x.com", "noreply@x.com", "no-reply@x.com", "do-not-reply@x.com", "bounce@x.com", "not an email"]) {
    assert.equal(isBlockableAddress(a), false, a);
  }
  for (const a of ["jane@x.com", "noreen@x.com", "postmasters.guild@x.com"]) assert.equal(isBlockableAddress(a), true, a);
  const plan = planStop({ emails: ["a@b.com"], name: "Al Bee" }, [
    conv({ threadId: "t", leadEmail: "mailer-daemon@b.com", leadName: "Al Bee", latestReplyId: "1", senders: ["a@b.com"] }),
  ]);
  assert.deepEqual(plan.otherEmails, []);
});

test("LIKE wildcards are escaped so an address matches exactly", () => {
  assert.equal(escapeLike("first_last%x@a.com"), "first\\_last\\%x@a.com");
});

test("the labels that mean stop: Hostile, Unsubscribe, Do Not Contact, Add to Blocklist", () => {
  for (const n of ["Hostile", "unsubscribe", " Do Not Contact ", "ADD TO BLOCKLIST"]) assert.equal(isStopContactLabel(n), true, n);
  for (const n of ["Not Interested", "Interested", "Introduction", "", null]) assert.equal(isStopContactLabel(n), false, String(n));
});

test("EmailBison's 422 'already on the list' counts as blacklisted; other 422s do not", () => {
  assert.equal(alreadyBlacklisted(422, { message: "The email has already been taken." }), true);
  assert.equal(alreadyBlacklisted(422, { message: "The email field must be a valid email address." }), false);
  assert.equal(alreadyBlacklisted(500, "already"), false);
});
