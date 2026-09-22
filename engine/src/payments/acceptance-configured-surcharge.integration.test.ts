import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after, before } from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { PaymentAcceptanceError, resolveSurcharge } from "./acceptance.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;
// engine/src/platform/secrets.ts reads the data key live from process.env (never the
// engine db.ts module-evaluation snapshot), so seed it there too.
const priorDataKey = process.env.OPENBOOKS_DATA_KEY;

before(() => {
  process.env.OPENBOOKS_DATA_KEY = "00".repeat(32);
});

after(() => {
  if (priorDataKey === undefined) delete process.env.OPENBOOKS_DATA_KEY;
  else process.env.OPENBOOKS_DATA_KEY = priorDataKey;
});

/** An explicitly configured surcharge rule is a reference, not a preference:
 *  when the rule cannot price the quote — wrong payment method, wrong
 *  provider, retired, foreign, or outside its effective window — the quote
 *  refuses by name instead of silently substituting another rule. A valid
 *  explicit rule still wins its tier, and automatic (unconfigured) selection
 *  is unchanged. */
test("explicit surcharge rule mismatch refuses by name instead of substituting", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const foreign = await createScratchOrg();
  try {
    const userId = await createScratchUser(org.orgId, "Surcharge Refusal Tester", "admin");
    const foreignUserId = await createScratchUser(foreign.orgId, "Foreign Rule Tester", "admin");
    // Fixed quote date keeps every window assertion deterministic.
    const onDate = "2024-05-15";
    const cardRuleId = randomUUID();
    const debitRuleId = randomUUID();
    const stripeOnlyRuleId = randomUUID();
    const expiredRuleId = randomUUID();
    const futureRuleId = randomUUID();
    const adyenRuleId = randomUUID();
    const retiredRuleId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fixed_amount, effective_to, fee_income_account_id, provider, payment_method, effective_from, is_active, created_by, updated_by)
      values
        (${cardRuleId}, ${org.orgId}, 'Configured card fee', 'percent', '3', null, null, ${org.accounts.revenue}, null, 'card', '2020-01-01', true, ${userId}, ${userId}),
        (${debitRuleId}, ${org.orgId}, 'Debit fee', 'fixed', null, '2.0000', null, ${org.accounts.revenue}, null, 'bank_debit', '2020-01-01', true, ${userId}, ${userId}),
        (${stripeOnlyRuleId}, ${org.orgId}, 'Stripe card fee', 'percent', '4', null, null, ${org.accounts.revenue}, 'stripe', 'card', '2020-06-01', true, ${userId}, ${userId}),
        (${expiredRuleId}, ${org.orgId}, 'Expired fee', 'percent', '5', null, '2020-12-31', ${org.accounts.revenue}, null, 'all', '2020-01-01', true, ${userId}, ${userId}),
        (${futureRuleId}, ${org.orgId}, 'Future fee', 'percent', '6', null, null, ${org.accounts.revenue}, null, 'all', '2030-01-01', true, ${userId}, ${userId}),
        (${adyenRuleId}, ${org.orgId}, 'Adyen card fee', 'percent', '7', null, null, ${org.accounts.revenue}, 'adyen', 'card', '2020-01-01', true, ${userId}, ${userId}),
        (${retiredRuleId}, ${org.orgId}, 'Retired fee', 'percent', '8', null, null, ${org.accounts.revenue}, null, 'all', '2020-01-01', false, ${userId}, ${userId})
    `);
    const foreignRuleId = randomUUID();
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values (${foreignRuleId}, ${foreign.orgId}, 'Foreign fee', 'percent', '9', ${foreign.accounts.revenue}, null, 'all', '2020-01-01', ${foreignUserId}, ${foreignUserId})
    `);

    const quote = (provider: "stripe" | "gocardless", configuredRuleId: string) =>
      resolveSurcharge(org.orgId, { provider, amount: "100.0000", currency: "CAD", onDate, configuredRuleId });

    // Wrong payment method: the card rule must not price a bank-debit quote,
    // even though the debit rule matches and would price it.
    await assert.rejects(
      quote("gocardless", cardRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Configured card fee/.test(error.message) &&
        /bank_debit/.test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "a method-mismatched explicit rule refuses instead of falling back",
    );

    // Expired and future windows: the quote date is canonical.
    await assert.rejects(
      quote("stripe", expiredRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Expired fee/.test(error.message) &&
        /not in effect on 2024-05-15/.test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "an expired explicit rule refuses instead of falling back",
    );
    await assert.rejects(
      quote("stripe", futureRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Future fee/.test(error.message) &&
        /not in effect on 2024-05-15/.test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "a future explicit rule refuses instead of falling back",
    );

    // Wrong provider and foreign/inactive references refuse by name too.
    await assert.rejects(
      quote("stripe", adyenRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Adyen card fee/.test(error.message) &&
        /adyen, not stripe/.test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "a provider-mismatched explicit rule refuses",
    );
    await assert.rejects(
      quote("stripe", foreignRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        new RegExp(foreignRuleId).test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "a foreign-org rule reference refuses",
    );
    await assert.rejects(
      quote("stripe", retiredRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /Retired fee/.test(error.message) &&
        /not active/.test(error.message) &&
        /Company Settings → Payment Providers/.test(error.message),
      "a retired explicit rule refuses",
    );

    // A valid explicit rule still wins its tier over the provider-specific
    // candidate.
    assert.deepEqual(await quote("stripe", cardRuleId), {
      amount: "3.0000",
      ruleId: cardRuleId,
      feeIncomeAccountId: org.accounts.revenue,
    });

    // Automatic (unconfigured) selection is unchanged: provider-specific
    // beats global within the matching method, and an empty landscape
    // still quotes zero.
    assert.equal(
      (await resolveSurcharge(org.orgId, { provider: "stripe", amount: "100.0000", currency: "CAD", onDate })).ruleId,
      stripeOnlyRuleId,
    );
    assert.deepEqual(
      await resolveSurcharge(org.orgId, { provider: "gocardless", amount: "100.0000", currency: "CAD", onDate }),
      { amount: "2.0000", ruleId: debitRuleId, feeIncomeAccountId: org.accounts.revenue },
    );

    // A rule whose fee-income account stops being an active income account
    // refuses at quote time. (Storage refuses such a row at insert, so the
    // test retires a dedicated income account after a valid insert.)
    const perishableAccountId = randomUUID();
    const badAccountRuleId = randomUUID();
    await db.execute(sql`
      insert into accounts (id, org_id, name, type, created_by, updated_by)
      values (${perishableAccountId}, ${org.orgId}, 'Perishable fee income', 'income', ${userId}, ${userId})
    `);
    await db.execute(sql`
      insert into payment_surcharge_rules
        (id, org_id, name, calculation, percent, fee_income_account_id, provider, payment_method, effective_from, created_by, updated_by)
      values (${badAccountRuleId}, ${org.orgId}, 'Bad account fee', 'percent', '3', ${perishableAccountId}, 'gocardless', 'bank_debit', '2020-01-01', ${userId}, ${userId})
    `);
    await db.execute(sql`update accounts set is_active = false where org_id = ${org.orgId} and id = ${perishableAccountId}`);
    await assert.rejects(
      quote("gocardless", badAccountRuleId),
      (error: unknown) =>
        error instanceof PaymentAcceptanceError &&
        /surcharge income account must be an active income account/.test(error.message),
      "an explicit rule with a retired fee account refuses",
    );
  } finally {
    await dropScratchOrg(org.orgId);
    await dropScratchOrg(foreign.orgId);
  }
});
