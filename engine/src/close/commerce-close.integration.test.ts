import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { commerceCloseChecks, snapshotCommerceCloseEvidence, type CommerceCloseCheck } from "./commerce-close.ts";
import { startCloseRun } from "./run-start.ts";
import { registerChannelAdapter } from "../commerce/adapters.ts";
import { createChannel, markChannelActive, retryChannel } from "../commerce/channels.ts";
import { upsertAccountMap } from "../commerce/account-maps.ts";
import { postEntry } from "../journal/post-entry.ts";
import { db, withBypass } from "../platform/db.ts";
import { createProgram, issueStoredValue } from "../stored-value/accounts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

registerChannelAdapter({
  kind: "shopify",
  describeSettings: () => z.object({}).strict(),
  verifyWebhook: () => ({ eventId: "test", topic: "test" }),
  testConnection: async () => ({ ok: true, detail: "test" }),
  handleEvent: async () => ({ action: "ignored", resultRef: {} }),
  workspaceTabs: () => [],
});

interface Fixture {
  org: ScratchOrg;
  actor: string;
  channelId: string;
  clearing: string;
  giftLiability: string;
  programId: string;
}

const DAY = "2026-07-15";
const SCOPE = (org: ScratchOrg) => ({ startsOn: DAY, endsOn: DAY, bookId: org.bookId });

/**
 * A commerce org with one active Shopify channel, one ingested order for
 * 68.86, a 50.00 gift card issued through the real journal path, and the
 * 50.00 of clearing the payout run swept to the bank — the clean period
 * every check below measures its red case against.
 */
async function seedCommerceOrg(): Promise<Fixture> {
  const org = await withBypass(() => createScratchOrg());
  const actor = await withBypass(() => createScratchUser(org.orgId, "Clerk", "admin"));
  await withBypass(async () => {
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || ${JSON.stringify({ salesChannels: true, storedValue: true })}::jsonb, true)
      where id = ${org.orgId}`);
  });
  const created = await withBypass(() =>
    createChannel(org.orgId, actor, {
      kind: "shopify",
      name: "Test Shop",
      currency: "CAD",
      externalAccount: "test.myshopify.com",
      settings: {},
    }),
  );
  const channelId = created.channel.id;
  await withBypass(() => retryChannel(org.orgId, actor, channelId, "test"));
  await withBypass(() => markChannelActive(org.orgId, actor, channelId));
  const clearing = await withBypass(() => seedPostingAccount(org.orgId, "1015", "Shopify Clearing", "asset_current_other", org.subsidiaryId));
  const giftLiability = await withBypass(() => seedPostingAccount(org.orgId, "2310", "Gift Card Liability", "liability_current_other", org.subsidiaryId));
  await withBypass(() =>
    upsertAccountMap(org.orgId, actor, { channelId, role: "gateway_clearing", key: "shopify_payments", accountId: clearing, effectiveFrom: DAY }),
  );
  await withBypass(() =>
    upsertAccountMap(org.orgId, actor, { channelId, role: "gift_card_liability", key: "", accountId: giftLiability, effectiveFrom: DAY }),
  );
  const program = await withBypass(() =>
    createProgram({ orgId: org.orgId, name: "Gift cards", kind: "gift_card", liabilityAccountId: giftLiability, actorId: actor }),
  );
  await withBypass(() =>
    issueStoredValue({
      orgId: org.orgId,
      programId: program.id,
      // Stored-value minor units are ten-thousandths (units4("50")), not cents.
      amountMinor: 500000n,
      currency: "CAD",
      idempotencyKey: `close-proof-${org.orgId}`,
      debitAccountId: clearing,
      postingDate: DAY,
      actorId: actor,
    }),
  );
  // The payout run sweeps clearing to the bank: captured money that reached
  // its deposit leaves no residual.
  await withBypass(() =>
    postEntry(db, {
      orgId: org.orgId,
      bookId: org.bookId,
      subsidiaryId: org.subsidiaryId,
      entryNumber: "PSP-SWEEP-1",
      postingDate: DAY,
      periodId: org.periodId,
      origin: "commerce_close_fixture",
      idempotencyKey: `close-proof-sweep-${org.orgId}`,
      currency: "CAD",
      actorId: actor,
      lines: [
        { accountId: org.accounts.bank, amount: "50.0000", currency: "CAD", txnAmount: "50.0000" },
        { accountId: clearing, amount: "-50.0000", currency: "CAD", txnAmount: "-50.0000" },
      ],
    }),
  );
  await withBypass(async () => {
    await db.execute(sql`
      insert into channel_orders
        (org_id, channel_id, external_id, external_number, shop_currency, presentment_currency,
         subtotal_minor, tax_minor, shipping_minor, total_minor,
         financial_status, fulfilment_status, ordered_at, posting_status)
      values (${org.orgId}, ${channelId}, '1001', '#1001', 'CAD', 'CAD',
              6300, 586, 0, 6886, 'paid', 'unfulfilled', ${`${DAY}T12:00:00Z`}::timestamptz, 'posted')`);
  });
  return { org, actor, channelId, clearing, giftLiability, programId: program.id };
}

function matchingProvider(count = 1, grossMinor = 6886n) {
  return async () => ({ orderCount: count, grossMinor, currency: "CAD" });
}

function byCode(checks: CommerceCloseCheck[], code: string): CommerceCloseCheck {
  const found = checks.find((check) => check.code === code);
  assert.ok(found, `expected a ${code} check`);
  return found;
}

test("a clean commerce period passes every completeness check", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    assert.equal(checks.length, 8);
    for (const check of checks) {
      assert.equal(check.count, 0, `${check.code} should be clean: ${JSON.stringify(check.details)}`);
    }
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a missing storefront order fails naming the channel, day and gap", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    const checks = await withBypass(() =>
      commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider(2, 13772n) }),
    );
    const orders = byCode(checks, "commerce-orders-incomplete");
    assert.ok(orders.count > 0);
    const gaps = (orders.details as { gaps: { channelName: string; day: string; missingCount: number; grossGapMinor: string }[] }).gaps;
    assert.equal(gaps.length, 1);
    assert.equal(gaps[0]!.channelName, "Test Shop");
    assert.equal(gaps[0]!.day, DAY);
    assert.equal(gaps[0]!.missingCount, 1);
    assert.equal(gaps[0]!.grossGapMinor, "6886");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a storefront that cannot be reached fails closed instead of passing", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    const checks = await withBypass(() =>
      commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), {
        storefrontTotals: async () => {
          throw new Error("Shopify refused the credentials (HTTP 401)");
        },
      }),
    );
    const unreachable = byCode(checks, "commerce-storefront-unreachable");
    assert.equal(unreachable.count, 1);
    const orders = byCode(checks, "commerce-orders-incomplete");
    assert.equal(orders.count, 0);
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a clearing residual fails naming the account", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    // Fresh capture with no payout yet: 10.00 sits in clearing at close.
    await withBypass(() =>
      postEntry(db, {
        orgId: fx.org.orgId,
        bookId: fx.org.bookId,
        subsidiaryId: fx.org.subsidiaryId,
        entryNumber: "CAPTURE-2",
        postingDate: DAY,
        periodId: fx.org.periodId,
        origin: "commerce_close_fixture",
        idempotencyKey: `close-proof-capture-${fx.org.orgId}`,
        currency: "CAD",
        actorId: fx.actor,
        lines: [
          { accountId: fx.clearing, amount: "10.0000", currency: "CAD", txnAmount: "10.0000" },
          { accountId: fx.org.accounts.revenue, amount: "-10.0000", currency: "CAD", txnAmount: "-10.0000" },
        ],
      }),
    );
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    const clearing = byCode(checks, "commerce-clearing-residual");
    assert.equal(clearing.count, 1);
    const accounts = (clearing.details as { accounts: { name: string; residual: string }[] }).accounts;
    assert.equal(accounts[0]!.name, "Shopify Clearing");
    assert.equal(accounts[0]!.residual, "10.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a draft payout fails naming the provider reference", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    await withBypass(async () => {
      await db.execute(sql`
        insert into psp_settlement_batches (org_id, provider, external_ref, currency, settlement_date, status)
        values (${fx.org.orgId}, 'stripe', 'po_draft_1', 'CAD', ${DAY}::date, 'draft')`);
    });
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    const payouts = byCode(checks, "commerce-payouts-unposted");
    assert.equal(payouts.count, 1);
    const batches = (payouts.details as { batches: { provider: string; externalRef: string }[] }).batches;
    assert.equal(batches[0]!.provider, "stripe");
    assert.equal(batches[0]!.externalRef, "po_draft_1");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a parked order fails naming its exception code", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    await withBypass(async () => {
      await db.execute(sql`
        insert into channel_orders
          (org_id, channel_id, external_id, external_number, shop_currency, presentment_currency,
           subtotal_minor, tax_minor, shipping_minor, total_minor,
           financial_status, fulfilment_status, ordered_at, posting_status,
           exception_code, exception_reason, exception_remedy)
        values (${fx.org.orgId}, ${fx.channelId}, '1002', '#1002', 'CAD', 'CAD',
                2500, 0, 0, 2500, 'paid', 'unfulfilled', ${`${DAY}T13:00:00Z`}::timestamptz, 'exception',
                'unmapped_sku', 'SKU TEE-BLUE-XL matches no item', 'Map the SKU under Channels → Products, then replay')`);
    });
    const checks = await withBypass(() =>
      commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider(2, 9386n) }),
    );
    const exceptions = byCode(checks, "commerce-exceptions-open");
    assert.equal(exceptions.count, 1);
    const parked = (exceptions.details as { parked: { code: string; reference: string }[] }).parked;
    assert.equal(parked[0]!.code, "unmapped_sku");
    assert.equal(parked[0]!.reference, "#1002");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a stray journal to the gift liability fails naming the account", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    await withBypass(() =>
      postEntry(db, {
        orgId: fx.org.orgId,
        bookId: fx.org.bookId,
        subsidiaryId: fx.org.subsidiaryId,
        entryNumber: "STRAY-1",
        postingDate: DAY,
        periodId: fx.org.periodId,
        origin: "commerce_close_fixture",
        idempotencyKey: `close-proof-stray-${fx.org.orgId}`,
        currency: "CAD",
        actorId: fx.actor,
        lines: [
          { accountId: fx.giftLiability, amount: "5.0000", currency: "CAD", txnAmount: "5.0000" },
          { accountId: fx.org.accounts.revenue, amount: "-5.0000", currency: "CAD", txnAmount: "-5.0000" },
        ],
      }),
    );
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    const storedValue = byCode(checks, "commerce-stored-value-gap");
    assert.equal(storedValue.count, 1);
    const ties = (storedValue.details as { ties: { name: string; gap: string }[] }).ties;
    assert.equal(ties[0]!.name, "Gift Card Liability");
    assert.equal(ties[0]!.gap, "5.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("an unrecognized plan without its deferral fails naming the account", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    await withBypass(async () => {
      const contractId = (await db.execute<{ id: string }>(sql`
        insert into revenue_contracts (org_id, customer_id, contract_number, currency, scope)
        values (${fx.org.orgId}, ${fx.org.customerId}, 'C-1', 'USD', 'invoice') returning id`)).rows[0]!.id;
      const obligationId = (await db.execute<{ id: string }>(sql`
        insert into performance_obligations (org_id, contract_id, description, recognition_rule_id, allocated_price, deferred_account_id, status)
        values (${fx.org.orgId}, ${contractId}, 'Annual plan', ${fx.org.recognitionRuleId}, 1200, ${fx.org.accounts.deferred}, 'open')
        returning id`)).rows[0]!.id;
      const scheduleId = (await db.execute<{ id: string }>(sql`
        insert into recognition_schedules (org_id, obligation_id, book_id, status, total_amount)
        values (${fx.org.orgId}, ${obligationId}, ${fx.org.bookId}, 'planned', 1200) returning id`)).rows[0]!.id;
      await db.execute(sql`
        insert into recognition_schedule_lines (org_id, schedule_id, period_id, sequence, planned_amount)
        values (${fx.org.orgId}, ${scheduleId}, ${fx.org.periodId}, 1, 100)`);
    });
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    const deferred = byCode(checks, "commerce-deferred-gap");
    assert.equal(deferred.count, 1);
    const ties = (deferred.details as { ties: { gap: string }[] }).ties;
    assert.equal(ties[0]!.gap, "100.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a proven commerce task freezes one evidence snapshot, exactly once per fingerprint", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    const runId = await withBypass(() =>
      startCloseRun({ orgId: fx.org.orgId, periodId: fx.org.periodId, bookId: fx.org.bookId, actorId: fx.actor }),
    );
    const taskId = (
      await withBypass(() => db.execute<{ id: string }>(sql`
        select id from close_run_tasks
         where org_id = ${fx.org.orgId} and run_id = ${runId} and key = 'commerce-complete'`))
    ).rows[0]?.id;
    assert.ok(taskId, "the run carries the commerce task while Sales Channels is on");
    // Nothing to freeze before the proof completes.
    assert.equal(await withBypass(() => snapshotCommerceCloseEvidence(fx.org.orgId, runId, fx.actor)), null);
    await withBypass(async () => {
      await db.execute(sql`update close_runs set data_fingerprint = 'fp-proof-1' where id = ${runId} and org_id = ${fx.org.orgId}`);
      await db.execute(sql`update close_run_tasks set status = 'complete' where id = ${taskId} and org_id = ${fx.org.orgId}`);
    });
    const evidenceId = await withBypass(() => snapshotCommerceCloseEvidence(fx.org.orgId, runId, fx.actor));
    assert.ok(evidenceId);
    const rows = (
      await withBypass(() => db.execute<{ label: string; snapshot: unknown }>(sql`
        select label, snapshot from close_task_evidence
         where org_id = ${fx.org.orgId} and run_id = ${runId} and task_id = ${taskId}`))
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.label, "Commerce completeness evidence");
    const snapshot = rows[0]!.snapshot as { fingerprint: string; checks: { code: string; count: number }[] };
    assert.equal(snapshot.fingerprint, "fp-proof-1");
    assert.equal(snapshot.checks.length, 8);
    // The tokenless test channel cannot be verified live, so the snapshot
    // records the refusal (one per period day) instead of a clean proof —
    // and still attaches once.
    const unreachable = snapshot.checks.find((check) => check.code === "commerce-storefront-unreachable");
    assert.ok((unreachable?.count ?? 0) > 0);
    assert.equal(await withBypass(() => snapshotCommerceCloseEvidence(fx.org.orgId, runId, fx.actor)), evidenceId);
    assert.equal(
      (
        await withBypass(() => db.execute<{ count: string }>(sql`
          select count(*)::text as count from close_task_evidence
           where org_id = ${fx.org.orgId} and run_id = ${runId} and task_id = ${taskId}`))
      ).rows[0]!.count,
      "1",
    );
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});

test("a capitalized cost without its asset legs fails naming the shortfall", { skip: !DB }, async () => {
  const fx = await seedCommerceOrg();
  try {
    await withBypass(async () => {
      const assetAccount = await seedPostingAccount(fx.org.orgId, "1800", "Contract cost asset", "asset_other", fx.org.subsidiaryId);
      const amortAccount = await seedPostingAccount(fx.org.orgId, "6100", "Commission amortization", "expense", fx.org.subsidiaryId);
      await db.execute(sql`
        insert into contract_cost_policies (org_id, effective_from, asset_account_id, amortization_expense_account_id)
        values (${fx.org.orgId}, '2026-01-01', ${assetAccount}, ${amortAccount})`);
      await db.execute(sql`
        insert into contract_cost_assets (org_id, cost_type, amount_minor, currency, capitalized_on, amort_start_on, amort_end_on, method, status)
        values (${fx.org.orgId}, 'commission', 12000, 'USD', ${DAY}::date, '2026-07-01', '2027-06-30', 'straight_line', 'active')`);
    });
    const checks = await withBypass(() => commerceCloseChecks(fx.org.orgId, SCOPE(fx.org), { storefrontTotals: matchingProvider() }));
    const costs = byCode(checks, "commerce-contract-cost-gap");
    assert.equal(costs.count, 1);
    const ties = (costs.details as { ties: { gap: string }[] }).ties;
    assert.equal(ties[0]!.gap, "-120.0000");
  } finally {
    await dropScratchOrg(fx.org.orgId);
  }
});
