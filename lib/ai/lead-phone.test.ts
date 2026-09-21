import assert from "node:assert/strict";
import { test } from "node:test";

import { findLeadPhone, stripQuoted, normalisePhone } from "./lead-phone";
import type { ConversationTurn } from "./reply";

/*
 * Every signature here is a real one, copied from inbound messages in this
 * workspace. 342 of 600 recent inbound messages carry a phone-shaped string,
 * so this is the common case rather than an edge one — and the failure it
 * guards against is putting a stranger's phone number into an email to a
 * client's prospect.
 */

const inbound = (body: string): ConversationTurn => ({ direction: "inbound", sentAt: null, body });
const outbound = (body: string): ConversationTurn => ({ direction: "outbound", sentAt: null, body });

test("a labelled cell beats the office line in the same signature", () => {
  // Real: "Julie Graybill REALTOR®, Peggy Slappey Properties, Inc. Cell 770 654-0956 Office 770 271-5555"
  const found = findLeadPhone([
    inbound("Thanks!\n\nJulie Graybill\nREALTOR®, Peggy Slappey Properties, Inc.\nCell 770 654-0956\nOffice 770 271-5555"),
  ]);
  assert.equal(found?.digits, "7706540956");
  assert.equal(found?.label, "mobile");
});

test("the abbreviated m./o. form is understood too", () => {
  // Real: "Jay Vadakkeveedu Real Estate Advisor ... m. 919-449-8020 o. 954-799-5182"
  const found = findLeadPhone([
    inbound("Thanks, Jay.\n--\nJay Vadakkeveedu\nReal Estate Advisor\nm. 919-449-8020 o. 954-799-5182"),
  ]);
  assert.equal(found?.digits, "9194498020");
});

test("Main vs Direct — the direct line wins", () => {
  // Real: "6641 West Broad St, Suite 101 Richmond, VA 23230 Main: 804-270-9440 Direct: 804-967-2778"
  const found = findLeadPhone([
    inbound("Best,\nSam\n6641 West Broad St, Suite 101\nRichmond, VA 23230\nMain: 804-270-9440\nDirect: 804-967-2778"),
  ]);
  assert.equal(found?.digits, "8049672778");
});

test("a trailing label is read as well as a leading one", () => {
  // Real: "Donna Oehler Realty Executives Platinum *CalBRE # *01316711 661-618-9444- mobile"
  const found = findLeadPhone([
    inbound("Not switching companies at this time.\nDonna Oehler\nRealty Executives Platinum\n661-618-9444- mobile"),
  ]);
  assert.equal(found?.digits, "6616189444");
});

/*
 * THE ONE THAT MATTERS MOST.
 *
 * Inbound bodies quote the message being replied to, signature and all. A real
 * inbound message in this workspace contained "Can you confirm that (602)
 * 625-4675 is the best number to reach you" — OUR agent's own sentence, about
 * a number we had sent. Picking that up would put it in a reply to someone
 * else entirely.
 */
test("our own number, quoted back inside their reply, is never taken", () => {
  const found = findLeadPhone([
    outbound("Hi — is (602) 625-4675 still best for you?\n\nNicole Collins\nBrokerStaffer\n(602) 625-4675"),
    inbound(
      "Sounds good.\n\nOn Mon, 21 Sept 2026, Nicole Collins wrote:\n> Hi — is (602) 625-4675 still best for you?\n> Nicole Collins\n> (602) 625-4675",
    ),
  ]);
  assert.equal(found, null, "the only number present was ours");
});

test("the lead's own number is taken even when ours is quoted below it", () => {
  const found = findLeadPhone([
    outbound("Hi — worth a chat?\n\nNicole Collins\n(602) 625-4675"),
    inbound(
      "Sure, call me on 470-345-1668.\n\nOn Mon, 21 Sept 2026, Nicole Collins wrote:\n> Hi — worth a chat?\n> (602) 625-4675",
    ),
  ]);
  assert.equal(found?.digits, "4703451668");
});

test("the newest reply's number supersedes an older one", () => {
  const found = findLeadPhone([
    inbound("Reach me on 770 654-0956"),
    outbound("Thanks."),
    inbound("Actually use my cell 919-449-8020"),
  ]);
  assert.equal(found?.digits, "9194498020");
});

test("the record is the fallback, and is labelled as such", () => {
  const found = findLeadPhone([inbound("Sounds good, speak soon.")], "+1 214 796 8485");
  assert.equal(found?.digits, "2147968485");
  assert.equal(found?.source, "record");
});

test("nothing anywhere returns null rather than a guess", () => {
  assert.equal(findLeadPhone([inbound("No thanks.")]), null);
  assert.equal(findLeadPhone([]), null);
});

test("a US country code is normalised away so the same number compares equal", () => {
  assert.equal(normalisePhone("+1 (214) 796-8485"), "2147968485");
  assert.equal(normalisePhone("214.796.8485"), "2147968485");
  assert.equal(normalisePhone("12147968485"), "2147968485");
});

test("stripQuoted keeps what the lead wrote and drops what they quoted", () => {
  const body = "My cell is 470-345-1668.\n\nOn Mon, 21 Sept 2026, Nicole wrote:\n> call me on 602-625-4675";
  const kept = stripQuoted(body);
  assert.match(kept, /470-345-1668/);
  assert.doesNotMatch(kept, /602-625-4675/);
});

/*
 * Numbers that are not phone numbers. A licence number or a zip+suite run of
 * digits must not become something we read back to a lead as their number.
 */
test("licence numbers and addresses are not mistaken for phones", () => {
  const found = findLeadPhone([
    inbound("Donna Oehler\nRealty Executives Platinum\n*CalBRE # *01316711\n6641 West Broad St, Suite 101, Richmond, VA 23230"),
  ]);
  assert.equal(found, null);
});
