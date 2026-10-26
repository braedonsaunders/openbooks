import { seedApprovalFlow } from "../testing/fixtures.ts";
import { decideGate } from "../flows/gates.ts";
import { grantScratchPermissions } from "../testing/fixtures.ts";
import { before } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { contractRecurringAmounts } from "./subscription-billing.ts";

import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
  type ScratchOrg,
} from "../testing/fixtures.ts";
import {
  activateQuote,
  declineQuoteSignature,
  deleteQuoteTerm,
  discountPercent,
  QuoteToCashError,
  quoteCashPreview,
  QUOTE_SUBJECT_TABLE,
  requestQuoteSignature,
  resolveRampSchedule,
  runSignatureReminderScan,
  saveQuoteTerm,
  signQuoteSignature,
  viewQuoteSignature,
  voidSignatureRequestsForSubject,
  type RampStepInput,
} from "./quote-to-cash.ts";

const DB = { skip: !process.env.OPENBOOKS_DB_URL };

function step(
  periodIndex: number,
  startsAfterMonths: number,
  unitPrice: string,
  quantity: string,
  escalatorPercent: string | null = null,
): RampStepInput {
  return {
    id: randomUUID(),
    periodIndex,
    startsAfterMonths,
    unitPrice,
    quantity,
    escalatorPercent,
  };
}

test("ramp steps resolve escalators with minor-unit rounding", () => {
  const schedule = resolveRampSchedule(12, [
    step(0, 0, "100.00", "1", "10"),
    step(1, 6, "0.00", "2"),
  ]);
  assert.equal(schedule.periods.length, 2);
  // 100 + 10% escalates to exactly 110.00 for the second period.
  assert.equal(schedule.periods[0]!.unitPrice, "100.00");
  assert.equal(schedule.periods[0]!.months, 6);
  assert.equal(schedule.periods[0]!.periodAmount, "600.0000");
  assert.equal(schedule.periods[0]!.arr, "1200.0000");
  assert.equal(schedule.periods[1]!.unitPrice, "110.0000");
  assert.equal(schedule.periods[1]!.months, 6);
  assert.equal(schedule.periods[1]!.periodAmount, "1320.0000");
  assert.equal(schedule.periods[1]!.arr, "2640.0000");
  assert.equal(schedule.tcv, "1920.0000");
});

test("escalator fractions round half away from zero to minor units", () => {
  const schedule = resolveRampSchedule(12, [
    step(0, 0, "99.99", "1", "7.5"),
    step(1, 6, "0.00", "1"),
  ]);
  // 99.99 + 7.5% = 7.49925, which rounds to 7.50 at minor units.
  assert.equal(schedule.periods[1]!.unitPrice, "107.4900");
});

test("ramp gaps and overlaps refuse by name", () => {
  assert.throws(
    () => resolveRampSchedule(12, [step(0, 0, "100.00", "1"), step(2, 6, "100.00", "1")]),
    /without gaps/,
  );
  assert.throws(() => resolveRampSchedule(12, [step(0, 2, "100.00", "1")]), /month 0/);
});

test("discount percent handles overage and free plans", () => {
  assert.equal(discountPercent("1800.0000", "1920.0000"), "-6.67");
  assert.equal(discountPercent("1800.0000", "1728.0000"), "4.00");
  assert.equal(discountPercent("0", "0"), "0.00");
});

interface QuoteSeed {
  quoteId: string;
  lineId: string;
  termId: string;
  planId: string;
}

async function seedDeal(
  org: ScratchOrg,
  actor: string,
  opts: {
    features?: string;
    lineAmount?: string;
    steps?: Array<{ price: string; qty: string; escalator?: string | null; startMonth?: number }>;
    planAmount?: string;
  } = {},
): Promise<QuoteSeed> {
  await db.execute(sql`
    update orgs
       set settings = settings || ${opts.features ?? '{"features":{"quoteToCash":true,"subscriptionBilling":true,"advancedSubscriptions":true,"orders":true}}'}::jsonb
     where id = ${org.orgId}
  `);
  const planId = randomUUID();
  await db.execute(sql`
    insert into subscription_plans
      (id, org_id, name, amount, currency_code, interval, interval_count,
       income_account_id, is_active, created_by)
    values (${planId}, ${org.orgId}, 'Quoted plan', ${opts.planAmount ?? "100.0000"}, 'CAD', 'monthly', 1,
            ${org.accounts.revenue}, true, ${actor})
  `);
  const quoteId = randomUUID();
  const lineAmount = opts.lineAmount ?? "1920.0000";
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, document_date,
       currency, subtotal, tax_total, total, created_by)
    values (${quoteId}, ${org.orgId}, 'quote', 'draft', 'Q-1', ${org.customerId}, ${org.date},
            'CAD', ${lineAmount}, '0', ${lineAmount}, ${actor})
  `);
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, description, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${lineId}, ${org.orgId}, ${quoteId}, 1, 'Annual subscription', ${org.accounts.revenue},
            '1', ${lineAmount}, ${lineAmount}, '0', ${lineAmount})
  `);
  const termId = randomUUID();
  await db.execute(sql`
    insert into quote_subscription_terms
      (id, org_id, quote_id, quote_line_id, plan_id, term_months, start_rule, billing_timing, created_by)
    values (${termId}, ${org.orgId}, ${quoteId}, ${lineId}, ${planId}, 12, 'quote_date', 'advance', ${actor})
  `);
  const steps = opts.steps ?? [
    { price: "100.00", qty: "1", escalator: "10", startMonth: 0 },
    { price: "0.00", qty: "2", startMonth: 6 },
  ];
  for (let i = 0; i < steps.length; i++) {
    const s = steps[i]!;
    await db.execute(sql`
      insert into quote_ramp_steps
        (id, org_id, term_id, period_index, starts_after_months, unit_price, quantity, escalator_percent, created_by)
      values (${randomUUID()}, ${org.orgId}, ${termId}, ${i}, ${s.startMonth ?? 0},
              ${s.price}, ${s.qty}, ${s.escalator ?? null}, ${actor})
    `);
  }
  return { quoteId, lineId, termId, planId };
}

/** Attach one flat list-price term to an already-seeded quote header. */
async function attachFlatTerm(
  org: ScratchOrg,
  actor: string,
  quoteId: string,
  planId: string,
  lineAmount: string,
): Promise<void> {
  const lineId = randomUUID();
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, description, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
    values (${lineId}, ${org.orgId}, ${quoteId}, 1, 'Annual subscription', ${org.accounts.revenue},
            '1', ${lineAmount}, ${lineAmount}, '0', ${lineAmount})
  `);
  const termId = randomUUID();
  await db.execute(sql`
    insert into quote_subscription_terms
      (id, org_id, quote_id, quote_line_id, plan_id, term_months, start_rule, billing_timing, created_by)
    values (${termId}, ${org.orgId}, ${quoteId}, ${lineId}, ${planId}, 12, 'quote_date', 'advance', ${actor})
  `);
  await db.execute(sql`
    insert into quote_ramp_steps
      (id, org_id, term_id, period_index, starts_after_months, unit_price, quantity, created_by)
    values (${randomUUID()}, ${org.orgId}, ${termId}, 0, 0, '100.00', '1', ${actor})
  `);
}

async function withDeal(
  run: (org: ScratchOrg, actor: string, seed: QuoteSeed) => Promise<void>,
  seedOpts: Parameters<typeof seedDeal>[2] = {},
): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actor = await createScratchUser(org.orgId, "Quote-to-cash controller", "admin");
    await grantScratchPermissions(org.orgId, actor, [
      "estimates.read",
      "estimates.create",
      "estimates.issue",
    ]);
    await run(org, actor, await seedDeal(org, actor, seedOpts));
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
}

test(
  "quote term, signature, and activation operations enforce the quote subsidiary scope",
  DB,
  async () => {
    await withDeal(async (org, actor, seed) => {
      await db.execute(sql`
      update documents set subsidiary_id = ${org.subsidiaryId}
       where org_id = ${org.orgId} and id = ${seed.quoteId}
    `);
      const restricted = new Set<string>();
      const refused = (error: unknown) => error instanceof QuoteToCashError && error.status === 404;
      const term = {
        termId: seed.termId,
        quoteLineId: seed.lineId,
        planId: seed.planId,
        termMonths: 12,
        startRule: "quote_date" as const,
        billingTiming: "advance" as const,
        steps: [{ startsAfterMonths: 0, unitPrice: "100.00", quantity: "1.00" }],
      };

      await assert.rejects(quoteCashPreview(org.orgId, seed.quoteId, restricted), refused);
      await assert.rejects(quoteCashPreview(org.orgId, seed.quoteId, undefined as never), refused);
      await assert.rejects(
        saveQuoteTerm(org.orgId, actor, seed.quoteId, term, restricted),
        refused,
      );
      await assert.rejects(
        deleteQuoteTerm(org.orgId, actor, seed.quoteId, seed.termId, restricted),
        refused,
      );
      await assert.rejects(
        requestQuoteSignature({
          orgId: org.orgId,
          actorId: actor,
          quoteId: seed.quoteId,
          allowedSubsidiaryIds: restricted,
          signerName: "Ada Customer",
          signerEmail: "ada@example.com",
        }),
        refused,
      );
      await assert.rejects(
        activateQuote(org.orgId, actor, seed.quoteId, { allowedSubsidiaryIds: restricted }),
        refused,
      );
      await assert.rejects(
        withOrgTransaction(org.orgId, () =>
          voidSignatureRequestsForSubject(
            db,
            org.orgId,
            QUOTE_SUBJECT_TABLE,
            seed.quoteId,
            restricted,
          ),
        ),
        refused,
      );

      const unchanged = (
        await db.execute<{ terms: number; signatures: number; subscriptions: number }>(
          sql`
      select (select count(*)::int from quote_subscription_terms where org_id = ${org.orgId} and quote_id = ${seed.quoteId}) as terms,
             (select count(*)::int from signature_requests where org_id = ${org.orgId} and subject_id = ${seed.quoteId}) as signatures,
             (select count(*)::int from subscriptions where org_id = ${org.orgId} and source_quote_id = ${seed.quoteId}) as subscriptions
    `,
          "objects",
        )
      )[0]!;
      assert.deepEqual(unchanged, { terms: 1, signatures: 0, subscriptions: 0 });
    });
  },
);

test("list-price quote sends, signs, and activates exactly once", DB, async () => {
  await withDeal(async (org, actor, seed) => {
    const sent = await requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: seed.quoteId,
      allowedSubsidiaryIds: null,
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
    });
    assert.equal(sent.status, "sent", "The zero-gate submission must complete its native outcome");
    if (sent.status !== "sent")
      throw new Error("The zero-gate submission unexpectedly awaits approval.");
    assert.ok(sent.token.length > 32);
    assert.equal(sent.expiresAt.getTime() > Date.now(), true);

    const stored = (
      await db.execute<{ status: string; document_hash: string; consent_text: string | null }>(
        sql`
        select status, document_hash, consent_text from signature_requests where id = ${sent.requestId}`,
        "objects",
      )
    )[0]!;
    assert.equal(stored.status, "sent");
    assert.equal(stored.document_hash, sent.documentHash);
    assert.ok((stored.consent_text ?? "").length > 32);

    const viewed = await viewQuoteSignature(sent.token);
    assert.equal(viewed.status, "viewed");
    assert.equal(viewed.quoteId, seed.quoteId);

    const signed = await signQuoteSignature({
      token: sent.token,
      name: "Ada Customer",
      ip: "10.0.0.1",
    });
    assert.equal(signed.quoteId, seed.quoteId);
    assert.deepEqual(signed.subscriptionIds, []);

    const signedRow = (
      await db.execute<{ status: string; signer_ip: string | null }>(
        sql`
        select status, signer_ip from signature_requests where id = ${sent.requestId}`,
        "objects",
      )
    )[0]!;
    assert.equal(signedRow.status, "signed");
    assert.equal(signedRow.signer_ip, "10.0.0.1");

    // A replayed link refuses instead of signing twice.
    await assert.rejects(
      signQuoteSignature({ token: sent.token, name: "Ada Customer" }),
      /once and never replayed/,
    );

    const first = await activateQuote(org.orgId, actor, seed.quoteId, {
      allowedSubsidiaryIds: null,
    });
    assert.equal(first.created, true);
    assert.equal(first.subscriptionIds.length, 1);
    assert.equal(first.contractId, null);

    const sub = (
      await db.execute<{
        quantity: string;
        price_override: string;
        source_term_id: string;
        status: string;
      }>(
        sql`
        select quantity::text as quantity, price_override::text as price_override,
               source_term_id, status
          from subscriptions where id = ${first.subscriptionIds[0]}`,
        "objects",
      )
    )[0]!;
    assert.equal(sub.status, "active");
    assert.equal(sub.source_term_id, seed.termId);
    // Period-zero price and quantity open the subscription.
    assert.equal(toUnits(sub.quantity), toUnits("1"));
    assert.equal(toUnits(sub.price_override), toUnits("100.00"));

    // The ramp's later periods schedule as idempotent amendments.
    const amendments = (
      await db.execute<{ idempotency_key: string }>(
        sql`
        select idempotency_key from subscription_amendments
         where org_id = ${org.orgId} and subscription_id = ${first.subscriptionIds[0]}
         order by idempotency_key`,
        "objects",
      )
    ).map((r) => r.idempotency_key);
    assert.deepEqual(amendments, [`quote-activation:${seed.quoteId}:${seed.termId}:p1`]);

    const second = await activateQuote(org.orgId, actor, seed.quoteId, {
      allowedSubsidiaryIds: null,
    });
    assert.equal(second.created, false);
    assert.deepEqual(second.subscriptionIds, first.subscriptionIds);
    const subCount = (
      await db.execute<{ n: string }>(
        sql`
        select count(*)::text as n from subscriptions
         where org_id = ${org.orgId} and source_quote_id = ${seed.quoteId}`,
        "objects",
      )
    )[0]!;
    assert.equal(subCount.n, "1");
  });
});

test("same-plan quote terms activate only their own billed component", DB, async () => {
  await withDeal(
    async (org, actor, seed) => {
      const secondLineId = randomUUID();
      await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, description, account_id, quantity, unit_price, amount, tax_amount, tax_input_amount)
      values (${secondLineId}, ${org.orgId}, ${seed.quoteId}, 2, 'Additional seats', ${org.accounts.revenue},
              '1', '3000.0000', '3000.0000', '0', '3000.0000')`);
      await db.execute(sql`
      update documents set subtotal = '9000.0000', total = '9000.0000'
       where org_id = ${org.orgId} and id = ${seed.quoteId}`);
      const secondTermId = randomUUID();
      await db.execute(sql`
      insert into quote_subscription_terms
        (id, org_id, quote_id, quote_line_id, plan_id, term_months, start_rule, billing_timing, created_by)
      values (${secondTermId}, ${org.orgId}, ${seed.quoteId}, ${secondLineId}, ${seed.planId}, 12, 'quote_date', 'advance', ${actor})`);
      await db.execute(sql`
      insert into quote_ramp_steps
        (id, org_id, term_id, period_index, starts_after_months, unit_price, quantity, created_by)
      values (${randomUUID()}, ${org.orgId}, ${secondTermId}, 0, 0, '50.00', '5', ${actor})`);

      const sent = await requestQuoteSignature({
        orgId: org.orgId,
        actorId: actor,
        quoteId: seed.quoteId,
        allowedSubsidiaryIds: null,
        signerName: "Ada Customer",
        signerEmail: "ada@example.com",
      });
      assert.equal(
        sent.status,
        "sent",
        "The zero-gate submission must complete its native outcome",
      );
      if (sent.status !== "sent")
        throw new Error("The zero-gate submission unexpectedly awaits approval.");
      await signQuoteSignature({ token: sent.token, name: "Ada Customer" });
      const activation = await activateQuote(org.orgId, actor, seed.quoteId, {
        allowedSubsidiaryIds: null,
      });
      assert.equal(activation.subscriptionIds.length, 2);

      const components = await db.execute<{
        source_term_id: string;
        component_key: string;
        quantity: string;
        unit_price: string;
      }>(
        sql`
      select s.source_term_id, c.component_key, c.quantity::text as quantity, c.unit_price::text as unit_price
        from subscriptions s
        join subscription_components c on c.org_id = s.org_id and c.subscription_id = s.id
       where s.org_id = ${org.orgId} and s.source_quote_id = ${seed.quoteId}
       order by s.source_term_id, c.component_key`,
        "objects",
      );
      assert.equal(components.length, 2);
      assert.deepEqual(
        components.map((component) => component.source_term_id).sort(),
        [seed.termId, secondTermId].sort(),
      );
      assert.deepEqual(
        components
          .map((component) => toUnits(component.quantity))
          .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
        [toUnits("5"), toUnits("10")].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
      );
      assert.ok(
        components.every((component) => toUnits(component.unit_price) === toUnits("50.0000")),
      );

      const recurring = await contractRecurringAmounts(org.orgId, org.date);
      const amount = activation.subscriptionIds.reduce(
        (sum, id) => sum + toUnits(recurring.get(id)!.amount),
        0n,
      );
      assert.equal(amount, toUnits("750.0000"));
    },
    {
      steps: [{ price: "50.00", qty: "10", startMonth: 0 }],
      lineAmount: "6000.0000",
      planAmount: "50.0000",
    },
  );
});

test("quote discounts use only the tenant's configured Flow gates", DB, async () => {
  const options = { steps: [{ price: "40.00", qty: "1", startMonth: 0 }], lineAmount: "480.0000" };
  const send = (org: ScratchOrg, actor: string, seed: QuoteSeed) =>
    requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: seed.quoteId,
      allowedSubsidiaryIds: null,
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
    });
  await withDeal(async (org, actor, seed) => {
    const sent = await send(org, actor, seed);
    assert.equal(
      sent.status,
      "sent",
      "zero gates release the quote without a separate discount policy",
    );
    assert.equal(
      (
        await db.execute<{ status: string }>(
          sql`select status from documents where org_id=${org.orgId} and id=${seed.quoteId}`,
          "objects",
        )
      )[0]?.status,
      "approved",
    );
  }, options);
  await withDeal(async (org, actor, seed) => {
    await db.execute(
      sql`update orgs set settings=jsonb_set(settings,'{features,flows}','true'::jsonb) where id=${org.orgId}`,
    );
    const reviewer = await createScratchUser(org.orgId, "Quote reviewer", "quote_reviewer");
    await grantScratchPermissions(org.orgId, reviewer, ["estimates.read", "ar.approve"]);
    for (let index = 0; index < 10; index++)
      await seedApprovalFlow(org.orgId, {
        subjectKind: "quote",
        assignees: [{ type: "user", userId: reviewer }],
        mode: "all",
        condition: { field: "subscriptionDiscountPercent", op: "gt", value: 10 },
      });
    assert.deepEqual(await send(org, actor, seed), { status: "pending_approval" });
    assert.equal(
      (
        await db.execute(
          sql`select id from signature_requests where org_id=${org.orgId} and subject_id=${seed.quoteId}`,
          "objects",
        )
      ).length,
      0,
    );
    const gates = await db.execute<{ id: string }>(
      sql`select id from flow_gates where org_id=${org.orgId} and subject_id=${seed.quoteId} and status='pending' order by id`,
      "objects",
    );
    assert.equal(gates.length, 10);
    for (const gate of gates.slice(0, -1))
      await decideGate({ gateId: gate.id, userId: reviewer, decision: "approved" });
    assert.deepEqual(await send(org, actor, seed), { status: "pending_approval" });
    await decideGate({ gateId: gates.at(-1)!.id, userId: reviewer, decision: "approved" });
    assert.equal((await send(org, actor, seed)).status, "sent");
  }, options);
});

test(
  "below-catalog ramps retain their pricing facts while zero tenant gates permit sending",
  DB,
  async () => {
    await withDeal(
      async (org, actor, seed) => {
        const preview = await quoteCashPreview(org.orgId, seed.quoteId, null);
        assert.equal(preview.floorBreached, true);
        assert.ok(toUnits(preview.discountPct) < 0n);
        const sent = await requestQuoteSignature({
          orgId: org.orgId,
          actorId: actor,
          quoteId: seed.quoteId,
          allowedSubsidiaryIds: null,
          signerName: "Ada Customer",
          signerEmail: "ada@example.com",
        });
        assert.equal(sent.status, "sent");
      },
      {
        steps: [
          { price: "90.00", qty: "1", escalator: "50", startMonth: 0 },
          { price: "0.00", qty: "2", startMonth: 6 },
        ],
        lineAmount: "2160.0000",
      },
    );
  },
);

test("editing a sent quote voids the request and stale signatures refuse", DB, async () => {
  await withDeal(async (org, actor, seed) => {
    const sent = await requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: seed.quoteId,
      allowedSubsidiaryIds: null,
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
    });
    assert.equal(sent.status, "sent", "The zero-gate submission must complete its native outcome");
    if (sent.status !== "sent")
      throw new Error("The zero-gate submission unexpectedly awaits approval.");
    const voided = await voidSignatureRequestsForSubject(
      db,
      org.orgId,
      QUOTE_SUBJECT_TABLE,
      seed.quoteId,
      null,
    );
    assert.equal(voided.voided, 1);
    const row = (
      await db.execute<{ status: string }>(
        sql`
        select status from signature_requests where id = ${sent.requestId}`,
        "objects",
      )
    )[0]!;
    assert.equal(row.status, "voided");
    await assert.rejects(signQuoteSignature({ token: sent.token, name: "Ada Customer" }), /voided/);
    // Voiding twice is a no-op, never a failure.
    const again = await voidSignatureRequestsForSubject(
      db,
      org.orgId,
      QUOTE_SUBJECT_TABLE,
      seed.quoteId,
      null,
    );
    assert.equal(again.voided, 0);
  });
});

test("unsigned quotes refuse activation by name", DB, async () => {
  await withDeal(async (org, actor, seed) => {
    await assert.rejects(
      activateQuote(org.orgId, actor, seed.quoteId, { allowedSubsidiaryIds: null }),
      /no signed signature/,
    );
  });
});

test("the reminder scan expires lapsed links and sends one reminder each", DB, async () => {
  await withDeal(async (org, actor, seed) => {
    const soon = await requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: seed.quoteId,
      allowedSubsidiaryIds: null,
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
    });
    assert.equal(soon.status, "sent", "The zero-gate submission must complete its native outcome");
    if (soon.status !== "sent")
      throw new Error("The zero-gate submission unexpectedly awaits approval.");
    await db.execute(sql`
      update signature_requests set expires_at = now() + interval '1 hour'
       where id = ${soon.requestId}`);
    const before = (
      await db.execute<{ token_hash: string }>(
        sql`
        select token_hash from signature_requests where id = ${soon.requestId}`,
        "objects",
      )
    )[0]!.token_hash;

    // A second quote carries the lapsed request the scan must expire.
    const lapsedQuoteId = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, party_id, document_date,
         currency, subtotal, tax_total, total, created_by)
      values (${lapsedQuoteId}, ${org.orgId}, 'quote', 'draft', 'Q-2', ${org.customerId}, ${org.date},
              'CAD', '1200.0000', '0', '1200.0000', ${actor})`);
    await attachFlatTerm(org, actor, lapsedQuoteId, seed.planId, "1200.0000");
    const lapsed = await requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: lapsedQuoteId,
      allowedSubsidiaryIds: null,
      signerName: "Bo Customer",
      signerEmail: "bo@example.com",
    });
    assert.equal(
      lapsed.status,
      "sent",
      "The zero-gate submission must complete its native outcome",
    );
    if (lapsed.status !== "sent")
      throw new Error("The zero-gate submission unexpectedly awaits approval.");
    await db.execute(sql`
      update signature_requests set expires_at = now() - interval '1 hour'
       where id = ${lapsed.requestId}`);

    async function addServiceQuoteSignature(documentNumber: string, expiresAt: Date) {
      const serviceQuoteDocumentId = randomUUID();
      const serviceRequestId = randomUUID();
      const tokenHash = randomUUID();
      await db.execute(sql`
        insert into documents
          (id, org_id, kind, status, document_number, party_id, document_date,
           currency, subtotal, tax_total, total, created_by)
        values (${serviceQuoteDocumentId}, ${org.orgId}, 'quote', 'approved', ${documentNumber}, ${org.customerId}, ${org.date},
                'CAD', '100.0000', '0', '100.0000', ${actor})`);
      await db.execute(sql`
        insert into signature_requests
          (id, org_id, subject_table, subject_id, signer_name, signer_email, token_hash, status,
           expires_at, sent_at, document_hash, created_by, updated_by)
        values (${serviceRequestId}, ${org.orgId}, 'documents', ${serviceQuoteDocumentId}, 'Cy Customer', 'cy@example.com',
                ${tokenHash}, 'sent', ${expiresAt}, now() - interval '2 hours', 'service-presentation', ${actor}, ${actor})`);
      await db.execute(sql`
        insert into service_quotes
          (org_id, quote_document_id, deposit_basis, deposit_value, status, signature_request_id,
           sent_at, created_by, updated_by)
        values (${org.orgId}, ${serviceQuoteDocumentId}, 'none', 0, 'sent', ${serviceRequestId},
                now() - interval '2 hours', ${actor}, ${actor})`);
      return { requestId: serviceRequestId, tokenHash };
    }
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}',
        coalesce(settings->'features', '{}'::jsonb) || '{"hrm": true, "hrmShiftPlanning": true, "serviceDispatch": true}'::jsonb)
       where id = ${org.orgId}`);
    const serviceDue = await addServiceQuoteSignature(
      "SQ-DUE",
      new Date(Date.now() + 60 * 60 * 1000),
    );
    const serviceExpired = await addServiceQuoteSignature(
      "SQ-EXPIRED",
      new Date(Date.now() - 60 * 60 * 1000),
    );

    const first = await runSignatureReminderScan();
    assert.equal(first.expired, 1);
    assert.equal(first.reminded, 1);
    assert.deepEqual(first.orgErrors, []);

    const lapsedRow = (
      await db.execute<{ status: string }>(
        sql`
        select status from signature_requests where id = ${lapsed.requestId}`,
        "objects",
      )
    )[0]!;
    assert.equal(lapsedRow.status, "expired");

    const serviceRows = await db.execute<{ id: string; status: string; token_hash: string }>(
      sql`
      select id, status, token_hash from signature_requests
       where id in (${serviceDue.requestId}, ${serviceExpired.requestId})`,
      "objects",
    );
    assert.equal(serviceRows.length, 2);
    assert.ok(serviceRows.every((row) => row.status === "sent"));
    assert.equal(
      serviceRows.find((row) => row.id === serviceDue.requestId)!.token_hash,
      serviceDue.tokenHash,
    );
    assert.equal(
      serviceRows.find((row) => row.id === serviceExpired.requestId)!.token_hash,
      serviceExpired.tokenHash,
    );
    const serviceReminders = await db.execute(
      sql`
      select 1 from scheduler_outbox where kind = 'flow_email'
       and occurrence_key in (${`signature-reminder:${serviceDue.requestId}`}, ${`signature-reminder:${serviceExpired.requestId}`})`,
      "objects",
    );
    assert.equal(serviceReminders.length, 0);

    // The reminder rotated the live link and queued exactly one email.
    const rotated = (
      await db.execute<{ token_hash: string }>(
        sql`
        select token_hash from signature_requests where id = ${soon.requestId}`,
        "objects",
      )
    )[0]!.token_hash;
    assert.notEqual(rotated, before);
    const queued = await db.execute<{ payload: { html: string } }>(
      sql`
        select payload from scheduler_outbox
         where kind = 'flow_email' and occurrence_key = ${`signature-reminder:${soon.requestId}`}`,
      "objects",
    );
    assert.equal(queued.length, 1);
    assert.ok((queued[0]!.payload as { html: string }).html.includes("/sign/quotes/"));

    // A second tick converges: nothing more expires, nothing re-sends.
    const second = await runSignatureReminderScan();
    assert.equal(second.expired, 0);
    assert.equal(second.reminded, 0);
  });
});

test("signing and declining refuse while quote-to-cash is off", DB, async () => {
  await withDeal(async (org, actor, seed) => {
    const sent = await requestQuoteSignature({
      orgId: org.orgId,
      actorId: actor,
      quoteId: seed.quoteId,
      allowedSubsidiaryIds: null,
      signerName: "Ada Customer",
      signerEmail: "ada@example.com",
    });
    assert.equal(sent.status, "sent", "The zero-gate submission must complete its native outcome");
    if (sent.status !== "sent")
      throw new Error("The zero-gate submission unexpectedly awaits approval.");
    // The operator switches the surface off after the link goes out: the
    // hosted page carries no session, so the engine fences both writes.
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,quoteToCash}', 'false'::jsonb)
       where id = ${org.orgId}`);
    await assert.rejects(
      signQuoteSignature({ token: sent.token, name: "Ada Customer" }),
      /no longer available/,
      "a signature that could auto-activate live subscriptions must refuse while the gate is off",
    );
    await assert.rejects(
      declineQuoteSignature({ token: sent.token, name: "Ada Customer" }),
      /no longer available/,
      "a decline is a quote-to-cash write and refuses with the same fence",
    );
    const stored = (
      await db.execute<{ status: string }>(
        sql`
        select status from signature_requests where id = ${sent.requestId}`,
        "objects",
      )
    )[0]!;
    assert.equal(stored.status, "sent", "refused writes leave the request open for a re-sent link");
  });
});

// Exercise the same native Flow composition installed by application entry points.
before(async () => {
  const { installEngineSeams } = await import("../composition/install.ts");
  installEngineSeams();
});
