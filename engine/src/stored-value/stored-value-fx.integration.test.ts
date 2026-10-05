import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass, withBypassContext, withOrg } from "../platform/db.ts";
import { toUnits } from "../money/money.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { completeRequestedDocumentVoid, requestDocumentVoid } from "../ledger/document-void.ts";
import { reverseStoredValueForVoidedDocument } from "./void-reversal.ts";
import { runRevaluation } from "../close/fx-revaluation.ts";
import { attachDocumentIssue } from "./accounts.ts";
import { createProgram } from "./accounts.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  seedPostingAccount,
  type ScratchOrg,
} from "../testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface FxFixture {
  org: ScratchOrg;
  actorId: string;
  liability: string;
  gainLoss: string;
  unrealized: string;
  giftProgram: string;
  giftItem: string;
}

async function seedFxOrg(): Promise<FxFixture> {
  const org = await withBypassContext(() => createScratchOrg());
  const actorId = await withBypassContext(() => createScratchUser(org.orgId, "FX Tester", "admin"));
  const liability = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "2600", "Gift card liability", "liability_current_other"),
  );
  const breakageIncome = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "4900", "Breakage income", "income_other"),
  );
  const unrealized = await withBypassContext(() =>
    seedPostingAccount(org.orgId, "7020", "Unrealized FX gain or loss", "income_other"),
  );
  await withBypassContext(async () => {
    await db.execute(sql`
      update orgs set settings = settings
        || jsonb_build_object('features', coalesce(settings->'features', '{}'::jsonb)
          || '{"storedValue": true, "multiCurrency": true}'::jsonb)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,storedValueLiability}', to_jsonb(${liability}::text), true)
       where id = ${org.orgId}`);
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{controlAccounts,fxUnrealizedGainLoss}', to_jsonb(${unrealized}::text), true)
       where id = ${org.orgId}`);
    // The revaluation's mandatory reversal needs a following period to land in.
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      select ${randomUUID()}, ${org.orgId}, 2026, 8, '2026-08', '2026-08-01', '2026-08-31', false, fiscal_calendar_id
        from accounting_periods where id = ${org.periodId}`);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-31', 'spot', '1.3700000000')`);
  });
  const giftProgram = await withBypass(() =>
    createProgram({
      orgId: org.orgId,
      name: "USD gift cards",
      kind: "gift_card",
      liabilityAccountId: liability,
      breakageIncomeAccountId: breakageIncome,
      actorId,
    }),
  );
  const giftItem = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into items (id, org_id, kind, code, name, income_account_id, created_by, updated_by)
      values (${giftItem}, ${org.orgId}, 'gift_card', 'USGIFTCARD', 'US gift card', ${org.accounts.revenue}, ${actorId}, ${actorId})`);
  });
  return { org, actorId, liability, gainLoss: org.accounts.fxGainLoss, unrealized, giftProgram: giftProgram.id, giftItem };
}

async function postUsdGiftInvoice(
  fx: FxFixture,
  options: { amount: string; rate: string; subsidiaryId?: string; number: string; currency?: string },
): Promise<{ documentId: string; entryId: string; accountId: string }> {
  const { org, actorId } = fx;
  const currency = options.currency ?? "USD";
  const documentId = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, document_number, party_id, subsidiary_id,
         document_date, posting_date, currency, fx_rate, status, subtotal, tax_total, total,
         created_by, updated_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', ${options.number}, ${org.customerId},
        ${options.subsidiaryId ?? org.subsidiaryId}, ${org.date}, ${org.date}, ${currency}, ${options.rate},
        'draft', ${options.amount}, '0', ${options.amount}, ${actorId}, ${actorId})`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, item_id, account_id, quantity, unit_price, amount,
         tax_input_amount, tax_amount, custom, created_by, updated_by)
      values (${org.orgId}, ${documentId}, 1, ${fx.giftItem}, ${org.accounts.revenue}, '1',
        ${options.amount}, ${options.amount}, ${options.amount}, '0',
        ${JSON.stringify({ storedValueProgramId: fx.giftProgram })}::jsonb, ${actorId}, ${actorId})`);
    await db.execute(sql`
      update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  const entryId = await withBypass(() =>
    postDocument(documentId, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
  );
  const accounts = (await withBypass(() => db.execute<{ id: string }>(sql`
    select id from stored_value_accounts where org_id = ${org.orgId} and source_document_id = ${documentId}`))).rows;
  assert.equal(accounts.length, 1);
  return { documentId, entryId, accountId: accounts[0]!.id };
}

async function postUsdCashSaleRedeeming(
  fx: FxFixture,
  options: { accountId: string; amount: string; rate: string; number: string; subsidiaryId?: string },
): Promise<string> {
  const { org } = fx;
  const id = randomUUID();
  await withBypassContext(async () => {
    await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom)
      values (${id}, ${org.orgId}, 'cash_sale', 'draft', ${options.number},
        ${options.subsidiaryId ?? org.subsidiaryId}, ${org.customerId},
        ${org.date}, ${org.date}, 'USD', ${options.rate},
        ${options.amount}, '0', ${options.amount}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_lines
        (org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, quantity, unit_price, custom)
      values (${org.orgId}, ${id}, 1, ${org.accounts.revenue},
        ${options.amount}, ${options.amount}, '0', '1', ${options.amount}, '{}'::jsonb)`);
    await db.execute(sql`
      insert into document_tenders
        (org_id, document_id, position, kind, method_label, account_id,
         stored_value_account_id, amount_minor, currency, reference)
      values (${org.orgId}, ${id}, 1, 'stored_value', 'Gift card', null,
        ${options.accountId}, ${toUnits(options.amount).toString()}, 'USD', null)`);
    await db.execute(sql`
      update documents set status = 'approved' where id = ${id} and org_id = ${org.orgId}`);
  });
  await withBypass(() =>
    postDocument(id, { control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank } }),
  );
  return id;
}

type JournalLeg = {
  account: string;
  amount: string;
  currency: string;
  txn: string;
  rate: string;
};

async function entryLegs(orgId: string, entryId: string): Promise<JournalLeg[]> {
  return (await withBypass(() => db.execute<JournalLeg>(sql`
    select account_id as account, amount::text as amount, currency,
           txn_amount::text as txn, fx_rate::text as rate
      from journal_lines
     where org_id = ${orgId} and entry_id = ${entryId}
     order by line_number`))).rows;
}

// Functional carrying value inside one close scope: the revaluation's
// mandatory next-period reversal must not net the adjustment away.
async function liabilityFunctional(
  orgId: string,
  liability: string,
  subsidiaryId: string,
  scopeEndsOn = "2026-07-31",
): Promise<string> {
  const rows = (await withBypass(() => db.execute<{ total: string }>(sql`
    select coalesce(sum(l.amount), 0)::text as total
      from journal_lines l
      join journal_entries je on je.id = l.entry_id and je.org_id = l.org_id
      join accounting_periods ep on ep.id = je.period_id and ep.org_id = je.org_id
     where l.org_id = ${orgId} and l.account_id = ${liability}
       and l.subsidiary_id = ${subsidiaryId}
       and je.status in ('posted', 'reversed')
       and ep.ends_on <= ${scopeEndsOn}::date`))).rows;
  return rows[0]!.total;
}

async function subledgerFunctional(orgId: string, subsidiaryId: string): Promise<string> {
  const rows = (await withBypass(() => db.execute<{ total: string }>(sql`
    select coalesce(sum(e.functional_amount_minor), 0)::text as total
      from stored_value_entries e
      join stored_value_accounts a on a.id = e.account_id and a.org_id = e.org_id
     where e.org_id = ${orgId} and a.subsidiary_id = ${subsidiaryId}`))).rows;
  return rows[0]!.total;
}

test("a USD card issued in a CAD subsidiary posts USD 50 with the CAD equivalent at the document rate", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const { entryId, accountId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-1" });
    const legs = await entryLegs(org.orgId, entryId);
    const liabilityLeg = legs.find((leg) => leg.account === fx.liability);
    assert.ok(liabilityLeg, "the sale carries the stored-value liability leg");
    assert.equal(liabilityLeg.amount, "-68.0000");
    assert.equal(liabilityLeg.currency, "USD");
    assert.equal(liabilityLeg.txn, "-50.0000");
    assert.equal(liabilityLeg.rate, "1.3600000000");
    const account = (await withBypass(() => db.execute<{
      subsidiary: string; currency: string; balance: string; functional: string; rate: string;
    }>(sql`
      select a.subsidiary_id as subsidiary, a.currency,
             a.balance_minor::text as balance,
             e.functional_amount_minor::text as functional, e.fx_rate::text as rate
        from stored_value_accounts a
        join stored_value_entries e on e.org_id = a.org_id and e.account_id = a.id
       where a.org_id = ${org.orgId} and a.id = ${accountId} and e.kind = 'issue'`))).rows[0]!;
    assert.equal(account.subsidiary, org.subsidiaryId);
    assert.equal(account.currency, "USD");
    assert.equal(account.balance, "500000");
    assert.equal(account.functional, "680000");
    assert.equal(account.rate, "1.3600000000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("redemption at a weaker rate books realized FX and the subledger still ties in functional currency", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const { accountId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-2" });
    await postUsdCashSaleRedeeming(fx, { accountId, amount: "30.0000", rate: "1.40", number: "CS-FX-1" });
    const redeem = (await withBypass(() => db.execute<{
      amount: string; functional: string; rate: string; journal: string | null;
    }>(sql`
      select amount_minor::text as amount, functional_amount_minor::text as functional,
             fx_rate::text as rate, journal_entry_id as journal
        from stored_value_entries
       where org_id = ${org.orgId} and account_id = ${accountId} and kind = 'redeem'`))).rows[0]!;
    // The subledger relieves the redeemed slice at its carrying rate (1.36):
    // 30 USD relieves 40.80 CAD of liability, not the 42.00 the till converted at.
    assert.equal(redeem.amount, "-300000");
    assert.equal(redeem.functional, "-408000");
    assert.equal(redeem.rate, "1.3600000000");
    // The 1.20 CAD repricing between carrying and redemption is a realized loss.
    const realized = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from journal_entries
       where org_id = ${org.orgId} and origin = 'stored_value'
         and memo like 'Realized FX%'`))).rows;
    assert.equal(realized.length, 1);
    const legs = await entryLegs(org.orgId, realized[0]!.id);
    // The restatement pair nets on the liability: +40.80 at the 1.36 carrying
    // rate against −42.00 at the 1.40 redemption rate, with the card currency
    // and both rates evidenced on the legs.
    const liabilityLegs = legs.filter((leg) => leg.account === fx.liability);
    assert.equal(liabilityLegs.length, 2);
    assert.deepEqual(
      liabilityLegs.map((leg) => [leg.currency, leg.txn, leg.amount, leg.rate]),
      [
        ["USD", "30.0000", "40.8000", "1.3600000000"],
        ["USD", "-30.0000", "-42.0000", "1.4000000000"],
      ],
    );
    const totals = (await withBypass(() => db.execute<{ account: string; total: string }>(sql`
      select account_id as account, sum(amount)::text as total
        from journal_lines
       where org_id = ${org.orgId} and entry_id = ${realized[0]!.id}
       group by account_id`))).rows;
    const byAccount = new Map(totals.map((row) => [row.account, row.total]));
    assert.equal(byAccount.get(fx.liability), "-1.2000");
    assert.equal(byAccount.get(fx.gainLoss), "1.2000");
    // The roll-forward ties: the subledger functional remainder equals the
    // general-ledger liability for the entity (20 USD carried at 1.36).
    assert.equal(await subledgerFunctional(org.orgId, org.subsidiaryId), "272000");
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, org.subsidiaryId), "-27.2000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("voiding a redeeming sale restores the card and reverses its realized FX", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const { accountId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-VOID" });
    const saleId = await postUsdCashSaleRedeeming(fx, { accountId, amount: "30.0000", rate: "1.40", number: "CS-FX-VOID" });
    const spent = (await withBypass(() => db.execute<{ balance: string }>(sql`
      select balance_minor::text as balance from stored_value_accounts
       where org_id = ${org.orgId} and id = ${accountId}`))).rows[0]!;
    assert.equal(spent.balance, "200000");
    const requested = await withOrg(org.orgId, () =>
      requestDocumentVoid({ documentId: saleId, orgId: org.orgId, actorId: fx.actorId, reason: "till error", reversalDate: org.date, source: "api" }));
    assert.equal(requested.status, "voided");
    await withOrg(org.orgId, () => completeRequestedDocumentVoid(saleId, org.orgId, null));
    // The card is whole again: the void appends a reversal, never edits the redeem entry.
    const restored = (await withBypass(() => db.execute<{ balance: string }>(sql`
      select balance_minor::text as balance from stored_value_accounts
       where org_id = ${org.orgId} and id = ${accountId}`))).rows[0]!;
    assert.equal(restored.balance, "500000");
    const reversal = (await withBypass(() => db.execute<{
      amount: string; functional: string; rate: string; redeem: string;
    }>(sql`
      select amount_minor::text as amount, functional_amount_minor::text as functional,
             fx_rate::text as rate, document_id as redeem
        from stored_value_entries
       where org_id = ${org.orgId} and account_id = ${accountId} and kind = 'reversal'`))).rows;
    assert.equal(reversal.length, 1);
    assert.equal(reversal[0]!.amount, "300000");
    assert.equal(reversal[0]!.functional, "408000");
    assert.equal(reversal[0]!.rate, "1.3600000000");
    // The repricing never happened either: the realized entry is reversed by a mirror.
    const realized = (await withBypass(() => db.execute<{ id: string; status: string }>(sql`
      select id, status from journal_entries
       where org_id = ${org.orgId} and origin = 'stored_value' and memo like 'Realized FX%'`))).rows;
    assert.equal(realized.length, 1);
    assert.equal(realized[0]!.status, "reversed");
    const mirror = (await withBypass(() => db.execute<{ id: string }>(sql`
      select id from journal_entries
       where org_id = ${org.orgId} and reverses_entry_id = ${realized[0]!.id}`))).rows;
    assert.equal(mirror.length, 1);
    // A retried unwind finds the first reversal instead of restoring twice.
    const again = await withBypass(() =>
      reverseStoredValueForVoidedDocument({
        orgId: org.orgId,
        documentId: saleId,
        documentNumber: "CS-FX-VOID",
        reversalEntryId: null,
        actorId: fx.actorId,
        reason: "till error",
      }));
    assert.deepEqual(again, { reversed: 0 });
    // The roll-forward ties again: the full 50 USD carried at 1.36.
    assert.equal(await subledgerFunctional(org.orgId, org.subsidiaryId), "680000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("period-end revaluation restates the remaining foreign liability without touching realized FX", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org, actorId } = fx;
  try {
    const { accountId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-3" });
    await postUsdCashSaleRedeeming(fx, { accountId, amount: "30.0000", rate: "1.40", number: "CS-FX-2" });
    const run = await withBypass(() => runRevaluation(org.orgId, org.periodId, actorId));
    assert.deepEqual(run.problems, []);
    const posted = run.posted.find((p) => p.subsidiaryId === org.subsidiaryId);
    assert.ok(posted, "the subsidiary revalues");
    // 20 USD carried at 27.20 CAD restated to 27.40 CAD at the 1.37
    // period-end spot. The run's own net also restates the sale's USD
    // receivable (+0.50), so the assertion pins the liability leg itself.
    const legs = await entryLegs(org.orgId, posted.entryId);
    const liabilityLeg = legs.find((leg) => leg.account === fx.liability);
    assert.ok(liabilityLeg);
    assert.equal(liabilityLeg.amount, "-0.2000");
    assert.equal(liabilityLeg.currency, "CAD");
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, org.subsidiaryId), "-27.4000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("the liability tie is per subsidiary: a scoped tie sees only its own entity", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const branchId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'East Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into party_subsidiaries (org_id, party_id, subsidiary_id, created_by, updated_by)
        values (${org.orgId}, ${org.customerId}, ${branchId}, ${fx.actorId}, ${fx.actorId})`);
    });
    // The root holds a CAD card at par; the branch holds the USD card at
    // the document rate. Each entity ties on its own, and neither tie sees
    // the other.
    await postUsdGiftInvoice(fx, { amount: "100.0000", rate: "1", number: "INV-FX-4", currency: "CAD" });
    await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-5", subsidiaryId: branchId });
    assert.equal(await subledgerFunctional(org.orgId, org.subsidiaryId), "1000000");
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, org.subsidiaryId), "-100.0000");
    assert.equal(await subledgerFunctional(org.orgId, branchId), "680000");
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, branchId), "-68.0000");
    // A subsidiary-scoped run revalues only the scoped entity: the branch
    // restates its 50 USD at the 1.37 spot while the root stands still.
    const run = await withBypass(() => runRevaluation(org.orgId, org.periodId, fx.actorId, [branchId]));
    assert.deepEqual(run.problems, []);
    assert.deepEqual(run.posted.map((p) => p.subsidiaryId), [branchId]);
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, branchId), "-68.5000");
    assert.equal(await liabilityFunctional(org.orgId, fx.liability, org.subsidiaryId), "-100.0000");
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a card is redeemed on its own entity's documents, never another's", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const branchId = randomUUID();
    await withBypassContext(async () => {
      await db.execute(sql`
        insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
        values (${branchId}, ${org.orgId}, ${org.subsidiaryId}, 'East Branch', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
      await db.execute(sql`
        insert into party_subsidiaries (org_id, party_id, subsidiary_id, created_by, updated_by)
        values (${org.orgId}, ${org.customerId}, ${branchId}, ${fx.actorId}, ${fx.actorId})`);
    });
    const { accountId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-6" });
    await assert.rejects(
      postUsdCashSaleRedeeming(fx, { accountId, amount: "10.0000", rate: "1.36", number: "CS-FX-3", subsidiaryId: branchId }),
      /one entity cannot relieve another's debt/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});

test("a document-driven issue refuses a card currency the document does not carry", { skip: !DB }, async () => {
  const fx = await seedFxOrg();
  const { org } = fx;
  try {
    const { documentId, entryId } = await postUsdGiftInvoice(fx, { amount: "50.0000", rate: "1.36", number: "INV-FX-7" });
    await assert.rejects(
      withBypass(() =>
        attachDocumentIssue({
          orgId: org.orgId,
          programId: fx.giftProgram,
          amountMinor: toUnits("5"),
          currency: "EUR",
          sourceDocumentId: documentId,
          journalEntryId: entryId,
          idempotencyKey: `fx-mismatch-${randomUUID()}`,
          actorId: fx.actorId,
        }),
      ),
      /USD, not EUR/,
    );
  } finally {
    await withBypassContext(() => dropScratchOrg(org.orgId));
  }
});
