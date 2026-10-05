import assert from "node:assert/strict";
import test from "node:test";
import {
  AutopayError,
  classifyDecline,
  parseExpiryNoticeDays,
  retryLadderForClass,
  terminalDeclineDetail,
  type AutopayPolicy,
} from "./autopay.ts";

function policy(): AutopayPolicy {
  return {
    policyId: "policy",
    policyName: "Collections",
    retryOffsetsDays: [1, 3, 7],
    insufficientFundsOffsetsDays: [3, 7, 14],
    finalAction: "none",
    gracePeriodDays: 0,
    expiryNoticeDays: 30,
  };
}

test("decline taxonomy maps each provider code to its recovery class", () => {
  assert.equal(classifyDecline(null), null);
  assert.equal(classifyDecline(""), null);
  // Insufficient funds is its own class on every provider.
  assert.equal(classifyDecline("insufficient_funds"), "insufficient_funds");
  assert.equal(classifyDecline("Not enough balance"), "insufficient_funds");
  // Authentication-required never auto-retries.
  assert.equal(classifyDecline("authentication_required"), "needs_authentication");
  assert.equal(classifyDecline("Authentication Required"), "needs_authentication");
  // Dead instruments wait for new payment details.
  assert.equal(classifyDecline("stolen_card"), "hard");
  assert.equal(classifyDecline("Lost Card"), "hard");
  assert.equal(classifyDecline("expired_card"), "hard");
  assert.equal(classifyDecline("mandate_cancelled"), "hard");
  assert.equal(classifyDecline("missing_shopper_reference"), "hard");
  // Anything unrecognized retries on the generic cadence, bounded by the schedule.
  assert.equal(classifyDecline("some_future_code"), "soft");
  assert.equal(classifyDecline("do_not_honor"), "soft");
});

test("each decline class reads its own retry ladder", () => {
  const p = policy();
  assert.deepEqual(retryLadderForClass(p, "soft"), [1, 3, 7]);
  assert.deepEqual(retryLadderForClass(p, "insufficient_funds"), [3, 7, 14]);
  assert.deepEqual(retryLadderForClass(p, "hard"), []);
  assert.deepEqual(retryLadderForClass(p, "needs_authentication"), []);
});

test("terminal declines name the remedy that clears them", () => {
  assert.match(terminalDeclineDetail("hard", "stolen_card"), /update the payment method/);
  assert.match(terminalDeclineDetail("needs_authentication", "authentication_required"), /authentication link/);
  assert.match(terminalDeclineDetail("soft", "do_not_honor"), /final retry/);
});

test("pre-expiry notice window is a whole day between 1 and 90", () => {
  assert.equal(parseExpiryNoticeDays(30), 30);
  assert.equal(parseExpiryNoticeDays(1), 1);
  assert.throws(() => parseExpiryNoticeDays(0), AutopayError);
  assert.throws(() => parseExpiryNoticeDays(91), AutopayError);
  assert.throws(() => parseExpiryNoticeDays(1.5), AutopayError);
  assert.throws(() => parseExpiryNoticeDays("soon"), AutopayError);
});
