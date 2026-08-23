import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  advanceSubscription,
  monthlyRecurringRevenue,
  prorate,
  subscriptionClaimRollback,
} from "./subscription-billing.ts";

test("advanceSubscription steps by interval × count with month-end clamp", () => {
  assert.equal(advanceSubscription("2026-01-15", "monthly", 1), "2026-02-15");
  assert.equal(advanceSubscription("2026-01-31", "monthly", 1), "2026-02-28");
  assert.equal(advanceSubscription("2026-01-10", "monthly", 3), "2026-04-10");
  assert.equal(advanceSubscription("2026-11-30", "quarterly", 1), "2027-02-28");
  assert.equal(advanceSubscription("2026-07-21", "annually", 1), "2027-07-21");
  assert.equal(advanceSubscription("2026-07-21", "weekly", 2), "2026-08-04");
});

test("monthlyRecurringRevenue normalizes each interval to a monthly figure", () => {
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("100", "monthly", 1, "3"), "300.0000");
  assert.equal(monthlyRecurringRevenue("1200", "annually", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("300", "quarterly", 1, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("300", "monthly", 3, "1"), "100.0000");
  assert.equal(monthlyRecurringRevenue("100", "weekly", 1, "1"), "433.3333");
});

test("prorate bills the remaining slice of a period exactly", () => {
  // 30-day period; 10 days elapsed → 20/30 of $300 = $200.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-06-11"), "200.0000");
  // Full period remaining.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-06-01"), "300.0000");
  // Period already over → nothing remains.
  assert.equal(prorate("300", "2026-06-01", "2026-07-01", "2026-07-05"), "0.0000");
  // Degenerate period → zero, never a divide-by-zero.
  assert.equal(prorate("300", "2026-06-01", "2026-06-01", "2026-06-01"), "0.0000");
});

test("subscriptionClaimRollback puts the pre-claim schedule back so the next tick retries", () => {
  const prior = {
    nextBillOn: "2026-06-01",
    currentPeriodStart: "2026-05-01",
    lastBilledAt: new Date("2026-05-15T09:30:00Z"),
  };
  const rollback = subscriptionClaimRollback(prior, "2026-07-01");
  // The restore targets the ORIGINAL values, never the claimed (advanced) ones.
  assert.deepEqual(rollback, {
    expectedNextBillOn: "2026-07-01", // guard: only while the row still holds the claim
    nextBillOn: "2026-06-01",
    currentPeriodStart: "2026-05-01",
    lastBilledAt: prior.lastBilledAt,
  });
});

test("subscriptionClaimRollback yields nothing when a concurrent writer moved the schedule", () => {
  const prior = { nextBillOn: "2026-06-01", currentPeriodStart: null, lastBilledAt: null };
  // The row moved past our claim (e.g. a manual bill won) — the rollback must
  // not clobber it.
  assert.equal(subscriptionClaimRollback(prior, "2026-07-01", "2026-07-15"), null);
  assert.equal(subscriptionClaimRollback(prior, "2026-07-01", "2026-06-01"), null);
  // Live value unknown → still build the payload; the SQL WHERE decides atomically.
  assert.ok(subscriptionClaimRollback(prior, "2026-07-01"));
});

test("a failed billing tick rolls its claim back instead of losing the occurrence", () => {
  // The runner claims by advancing next_bill_on before billOne runs; if billOne
  // throws, the catch must restore the pre-claim schedule — pinned structurally,
  // like fx-revaluation does.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueSubscriptions");
  const claim = source.indexOf("set next_bill_on = ${advanced}", run);
  const catchBlock = source.indexOf("} catch (e) {", claim);
  const rollbackCall = source.indexOf("subscriptionClaimRollback(row, advanced)", catchBlock);
  const restore = source.indexOf("next_bill_on = ${rollback.nextBillOn}", rollbackCall);
  const restoreGuard = source.indexOf(
    "next_bill_on = ${rollback.expectedNextBillOn}",
    rollbackCall,
  );
  const lastError = source.indexOf("last_error = ${message}", rollbackCall);
  assert.ok(claim > run, "the occurrence is claimed by advancing next_bill_on");
  assert.ok(catchBlock > claim, "billing failures are caught after the claim");
  assert.ok(rollbackCall > catchBlock, "the catch builds a claim rollback");
  assert.ok(restore > rollbackCall, "the failed attempt restores the pre-claim next_bill_on");
  assert.ok(restoreGuard > restore, "the restore is guarded on the claimed value");
  assert.ok(lastError > restoreGuard, "last_error is still written for observability");
  // The claim itself stays compare-and-swap: only one tick can win an
  // occurrence, and the claim is org-scoped (and status-guarded) like every
  // other subscription write.
  const claimSql = source.slice(claim, source.indexOf("returning id", claim));
  assert.match(
    claimSql,
    /where id = \$\{row\.id\} and org_id = \$\{row\.orgId\} and next_bill_on = \$\{row\.nextBillOn\} and status = 'active'/,
  );
});

test("changeSubscription and prorateFirstInvoice serialize on the subscription row lock", () => {
  // Both mutations price a proration from subscription state; without one
  // transaction holding billOne's row lock across read → invoice, two
  // concurrent calls (double-click) would each cut an adjustment invoice.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  for (const name of ["export async function changeSubscription", "export async function prorateFirstInvoice"]) {
    const fn = source.indexOf(name);
    const orgTx = source.indexOf("return withOrg(orgId", fn);
  const lock = source.indexOf("for update", orgTx);
  const read = source.indexOf("await loadSubRow(subscriptionId, orgId)", orgTx);
    const invoice = source.indexOf("createSubscriptionInvoice({", orgTx);
    assert.ok(orgTx > fn, `${name}: the mutation runs inside one org transaction`);
    assert.ok(lock > orgTx, `${name}: the subscription row lock is taken inside that transaction`);
    assert.ok(read > lock, `${name}: state is read under the lock`);
    assert.ok(invoice > read, `${name}: the proration invoice is cut under the same lock`);
  }
  // Single-fire first proration: create inserts next_bill_on = firstBillOn and
  // current_period_start = startOn — the same columns a successful proration
  // writes. The guard must key off last_invoice_id / run_count, not that
  // insert state, or addSubscription + prorateFirstPeriod is dead on arrival.
  const prorateFn = source.indexOf("export async function prorateFirstInvoice");
  const guard = source.indexOf('throw new SubscriptionError("the first invoice has already been prorated")', prorateFn);
  const invoice = source.indexOf("createSubscriptionInvoice({", prorateFn);
  const guardBlock = source.slice(prorateFn, invoice);
  assert.ok(guard > prorateFn && invoice > guard, "the already-prorated guard precedes the second invoice attempt");
  assert.match(guardBlock, /lastInvoiceId/, "single-fire keys off the invoice, not the create-state schedule columns");
  assert.match(guardBlock, /runCount/, "single-fire also keys off run_count");
  assert.ok(
    !/nextBillOn === firstBillOn && row\.currentPeriodStart === row\.startOn/.test(guardBlock),
    "must not treat the create-state schedule as already-prorated",
  );
});

test("changeSubscription persists quantity and priceOverride through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("function persistSubscriptionMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "persistSubscriptionMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /must be an exact decimal/);

  const fn = source.indexOf("export async function changeSubscription");
  const next = source.indexOf("export async function prorateFirstInvoice");
  const body = source.slice(fn, next);
  assert.match(body, /persistSubscriptionMoney\(changes\.quantity \?\? oldQty, "quantity"\)/);
  assert.match(body, /persistSubscriptionMoney\(changes\.priceOverride, "price override"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(changes\.quantity/);
  assert.doesNotMatch(body, /normalizeMoney\(changes\.priceOverride\)/);
});

test("createSubscriptionInvoice persists line quantity and unitPrice through persistSubscriptionMoney", () => {
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function createSubscriptionInvoice");
  const next = source.indexOf("async function billOne");
  const body = source.slice(fn, next);
  assert.ok(fn >= 0 && next > fn, "createSubscriptionInvoice precedes billOne");
  assert.match(body, /persistSubscriptionMoney\(input\.quantity, "quantity"\)/);
  assert.match(body, /persistSubscriptionMoney\(input\.unitPrice, "unit price"\)/);
  assert.doesNotMatch(body, /normalizeDecimal\(input\.quantity/);
  assert.doesNotMatch(body, /normalizeDecimal\(input\.unitPrice/);
});

test("billOne guards EVERY billing path through subscription_period_invoices", () => {
  // Plain plan-based subscriptions previously fell through with no dedupe: a
  // tick whose success bookkeeping failed after posting rolled its claim back
  // and the retry cut a second invoice for the same period. The guard must be
  // one mechanism for both paths (no parallel sources of truth), derived BEFORE
  // any invoice is created.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const billOne = source.indexOf("async function billOne");
  const guard = source.indexOf("const guard = advanced", billOne);
  const plainBranch = source.indexOf(
    "advanceSubscription(billingDate, sub.interval, sub.intervalCount)",
    guard,
  );
  const priorCheck = source.indexOf("from subscription_period_invoices pi join documents d", guard);
  const replay = source.indexOf("if (prior.rows[0]) return", priorCheck);
  const invoice = source.indexOf("createSubscriptionInvoice({", guard);
  const insert = source.indexOf("insert into subscription_period_invoices", invoice);
  const end = source.indexOf("return generated;", invoice);
  assert.ok(guard > billOne && source.indexOf("startsOn: advanced.periodStartsOn", guard) > guard,
    "advanced lifecycles keep their frozen period + revision key");
  assert.ok(plainBranch > guard && plainBranch < priorCheck,
    "plain plan-based subs derive the same guard shape deterministically from the billed date");
  assert.ok(priorCheck < invoice, "the committed period invoice is looked up before any creation");
  assert.ok(replay > priorCheck && replay < invoice, "an existing period invoice is replayed, not re-cut");
  assert.ok(insert > invoice && insert < end, "the guard row commits in the same transaction as its invoice");
});

test("success bookkeeping can never roll the claim back after an invoice exists", () => {
  // The rollback catch restores next_bill_on ONLY when billing itself threw;
  // it must hand control back (continue) before the success-bookkeeping block,
  // whose failure path touches last_error alone — never next_bill_on.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueSubscriptions");
  const claim = source.indexOf("set next_bill_on = ${advanced}", run);
  const rollbackCatch = source.indexOf("} catch (e) {", claim);
  const skipBookkeeping = source.indexOf("continue;", rollbackCatch);
  const bookkeeping = source.indexOf("set run_count = run_count + 1", skipBookkeeping);
  const bookkeepingCatch = source.indexOf("} catch (e) {", bookkeeping);
  const loopEnd = source.indexOf("return result;", run);
  assert.ok(skipBookkeeping > rollbackCatch, "the rollback catch skips success bookkeeping");
  assert.ok(bookkeeping > skipBookkeeping && bookkeeping < loopEnd,
    "bookkeeping runs in its own scope after the rollback catch");
  const bookkeepingFailurePath = source.slice(bookkeepingCatch, loopEnd);
  assert.match(bookkeepingFailurePath, /last_error/,
    "a bookkeeping failure still surfaces through last_error");
  assert.doesNotMatch(bookkeepingFailurePath, /next_bill_on/,
    "a bookkeeping failure never restores next_bill_on once an invoice was produced");
});
