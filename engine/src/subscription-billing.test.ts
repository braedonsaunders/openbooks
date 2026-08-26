import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  SubscriptionError,
  advanceSubscription,
  monthlyRecurringRevenue,
  normalizeSubscriptionCadence,
  normalizeSubscriptionMoney,
  prorate,
  prorationDocument,
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

test("base subscription configuration preserves valid exact decimals and rejects impossible values", () => {
  assert.equal(
    normalizeSubscriptionMoney("999999999999999.9999", "amount", "nonnegative"),
    "999999999999999.9999",
  );
  assert.equal(normalizeSubscriptionMoney("0.0001", "quantity", "positive"), "0.0001");
  assert.deepEqual(normalizeSubscriptionCadence("quarterly", "3"), {
    interval: "quarterly",
    intervalCount: 3,
  });
  assert.equal(monthlyRecurringRevenue("0.1001", "monthly", 1, "3"), "0.3003");

  for (const invalid of ["-0.0001", "1.00001", "1000000000000000"]) {
    assert.throws(
      () => normalizeSubscriptionMoney(invalid, "amount", "nonnegative"),
      SubscriptionError,
    );
  }
  assert.throws(
    () => normalizeSubscriptionMoney("0", "quantity", "positive"),
    /quantity must be greater than zero/,
  );
  assert.throws(() => normalizeSubscriptionCadence("monthly", 0), /positive integer/);
  assert.throws(() => normalizeSubscriptionCadence("monthly", 1.5), /positive integer/);
  assert.throws(() => normalizeSubscriptionCadence("sometimes", 1), /interval must be/);
});

test("billing analytics and period advancement fail closed on residual invalid rows", () => {
  assert.throws(() => advanceSubscription("2026-01-31", "monthly", 0), /positive integer/);
  assert.throws(
    () => monthlyRecurringRevenue("-10", "monthly", 1, "1"),
    /amount must be nonnegative/,
  );
  assert.throws(
    () => monthlyRecurringRevenue("10", "monthly", 1, "0"),
    /quantity must be greater than zero/,
  );
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

test("prorationDocument maps a signed adjustment to the native document it must become", () => {
  // Downgrade → credit memo carrying the ABSOLUTE amount: credit memos store
  // positive totals (posting.ts credits AR off the positive total; AR reports
  // flip the sign by kind), so a negative amount on an invoice is never right.
  assert.deepEqual(prorationDocument("-75"), { kind: "customer_credit", amount: "75.0000" });
  assert.deepEqual(prorationDocument("-0.0001"), { kind: "customer_credit", amount: "0.0001" });
  // Upgrade → ordinary invoice, unchanged.
  assert.deepEqual(prorationDocument("50"), { kind: "customer_invoice", amount: "50.0000" });
  assert.deepEqual(prorationDocument("0"), { kind: "customer_invoice", amount: "0.0000" });
});

test("the claim and the billing share one transaction, closing the crash-skip window", () => {
  // The defect: the tick claimed by committing next_bill_on advancement in its
  // own transaction BEFORE billOne ran; a process killed between the two
  // commits stranded an advanced next_bill_on with no invoice — permanently
  // losing the billable period, because no in-process catch ever runs again.
  // The fix: claim INSIDE the billing transaction so either both commit or
  // neither does.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueSubscriptions");
  const loopStart = source.indexOf("for (const row of due.rows)", run);
  const orgTxn = source.indexOf("await withOrg(row.orgId, async () => {", loopStart);
  const claim = source.indexOf("set next_bill_on = ${advanced}", orgTxn);
  const billCall = source.indexOf("return billOne(s, row.nextBillOn", claim);
  assert.ok(loopStart > run, "the due scan feeds a per-candidate loop");
  assert.ok(orgTxn > loopStart, "billing runs in one pinned org transaction");
  assert.ok(claim > orgTxn, "the occurrence is claimed inside that same transaction");
  assert.ok(billCall > claim, "billOne follows the claim within it");
  // Nothing between the claim and billOne may open another transaction, and
  // nothing before the org transaction may advance the schedule: any commit
  // boundary around the claim alone is exactly the crash window this closes.
  const inside = source.slice(claim, billCall);
  assert.doesNotMatch(inside, /withBypass|withOrg\(/,
    "the claimed unit is not broken by another transaction boundary");
  const before = source.slice(loopStart, orgTxn);
  assert.doesNotMatch(before, /next_bill_on\s*=/,
    "nothing may claim (write next_bill_on) outside the billing transaction");
  const claimSql = source.slice(claim, source.indexOf("returning id", claim));
  assert.match(
    claimSql,
    /where id = \$\{row\.id\} and org_id = \$\{row\.orgId\} and next_bill_on = \$\{row\.nextBillOn\} and status = 'active'/,
    "the claim stays compare-and-swap and org-scoped (and status-guarded): one tick wins an occurrence",
  );
  assert.equal(source.indexOf("subscriptionClaimRollback"), -1,
    "the in-process rollback machinery is gone — atomicity replaced it");
});

test("a failed billing tick leaves the occurrence due and records why — restoring nothing", () => {
  // Atomicity makes "rolled back" and "never claimed" indistinguishable from
  // outside, so the failure path must contain NO next_bill_on writer at all:
  // only last_error observability. (The success-bookkeeping path below it is
  // pinned separately to never touch next_bill_on either.)
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueSubscriptions");
  const claim = source.indexOf("set next_bill_on = ${advanced}", run);
  const catchBlock = source.indexOf("} catch (e) {", claim);
  const skipBookkeeping = source.indexOf("if (!sub) continue;", catchBlock);
  const bookkeeping = source.indexOf("set run_count = run_count + 1", catchBlock);
  assert.ok(catchBlock > claim && skipBookkeeping > catchBlock && bookkeeping > skipBookkeeping,
    "the failure path sits between the claim and the success bookkeeping");
  const failurePath = source.slice(catchBlock, skipBookkeeping);
  assert.match(failurePath, /last_error/, "failures surface through last_error");
  assert.doesNotMatch(failurePath, /next_bill_on/, "the failure path never writes next_bill_on");
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

test("a downgrade proration becomes a customer credit memo, never a negative invoice", () => {
  // The defect: changeSubscription passed the signed adjustment straight into
  // createSubscriptionInvoice with no documentKind, so a downgrade cut a
  // customer_invoice with a negative total. Credit memos are their own native
  // document (posting credits AR off a POSITIVE total; every AR surface flips
  // the sign by kind), so a negative adjustment must become a customer_credit
  // carrying the absolute amount — exactly how CAM reconciliations already do it.
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function changeSubscription");
  const next = source.indexOf("export async function prorateFirstInvoice");
  const body = source.slice(fn, next);
  const decision = body.indexOf("prorationDocument(adjustment)");
  assert.ok(decision >= 0, "the signed adjustment is mapped through prorationDocument");
  const create = body.indexOf("createSubscriptionInvoice({", decision);
  assert.ok(create > decision, "the document decision precedes invoice creation");
  const callBlock = body.slice(create, body.indexOf("invoiceId = gen.invoiceId", create));
  assert.match(callBlock, /documentKind: doc\.kind/, "the cut document's kind comes from the credit decision");
  assert.match(callBlock, /unitPrice: doc\.amount/, "the stored amount comes from the credit decision");
  assert.doesNotMatch(callBlock, /unitPrice: adjustment/,
    "the raw signed adjustment must never be persisted as an invoice line amount");

  const helper = source.indexOf("export function prorationDocument");
  const helperEnd = source.indexOf("\n}", helper);
  const helperBody = source.slice(helper, helperEnd + 2);
  assert.match(helperBody, /customer_credit/, "downgrades map to the native credit-memo kind");
});

test("changeSubscription persists quantity and priceOverride through canonicalDecimal then normalizeMoney", () => {
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const helperStart = source.indexOf("export function normalizeSubscriptionMoney");
  const helperEnd = source.indexOf("\n}", helperStart);
  assert.ok(helperStart >= 0 && helperEnd > helperStart, "normalizeSubscriptionMoney helper is defined");
  const helper = source.slice(helperStart, helperEnd + 2);
  assert.match(helper, /canonicalDecimal\(value, 4\)/);
  assert.match(helper, /normalizeMoney\(exact\)/);
  assert.match(helper, /must be an exact decimal/);
  assert.match(helper, /POSTGRES_MONEY_MAX_UNITS/);
  assert.match(helper, /must be greater than zero/);
  assert.match(helper, /must be nonnegative/);

  const fn = source.indexOf("export async function changeSubscription");
  const next = source.indexOf("export async function prorateFirstInvoice");
  const body = source.slice(fn, next);
  assert.match(body, /persistSubscriptionMoney\(changes\.quantity \?\? persistedOldQty, "quantity", "positive"\)/);
  assert.match(body, /persistSubscriptionMoney\(changes\.priceOverride, "price override", "nonnegative"\)/);
  assert.match(body, /persistSubscriptionMoney\(oldPrice, "stored price", "nonnegative"\)/);
  assert.doesNotMatch(body, /normalizeMoney\(changes\.quantity/);
  assert.doesNotMatch(body, /normalizeMoney\(changes\.priceOverride\)/);
});

test("createSubscriptionInvoice persists line quantity and unitPrice through persistSubscriptionMoney", () => {
  const source = readFileSync(new URL("./subscription-billing.ts", import.meta.url), "utf8");
  const fn = source.indexOf("export async function createSubscriptionInvoice");
  const next = source.indexOf("async function billOne");
  const body = source.slice(fn, next);
  assert.ok(fn >= 0 && next > fn, "createSubscriptionInvoice precedes billOne");
  assert.match(body, /persistSubscriptionMoney\(input\.quantity, "quantity", "positive"\)/);
  assert.match(body, /persistSubscriptionMoney\(input\.unitPrice, "unit price", "nonnegative"\)/);
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
