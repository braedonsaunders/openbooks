import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { computeTaxReturn } from "./return.ts";
import { computeUsNexusStatus } from "./us-nexus-ledger.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";
import { saveMarketplaceFacilitator } from "../tax/marketplace-facilitators.ts";
import { loadTaxProfileConfig, persistLineTaxComponents } from "../tax/persist.ts";
import { computeLineTaxes } from "../tax/tax.ts";

// Marketplace-facilitator tax is the marketplace's liability to remit: the
// merchant records it for reporting and nexus but never posts it as its own
// liability. Gross documents carry it to the facilitator clearing account
// (the marketplace settles it); returns exclude it from tax due while still
// reporting the facilitator share; nexus measures without it where the state
// rule excludes it.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedClearingAccount(org: Org): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${org.orgId}, '1150', 'Marketplace Clearing', 'asset_receivable',
            false, true, false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
}

async function seedSetup(org: Org, actorId: string): Promise<{ codeId: string; clearingId: string }> {
  const clearingId = await seedClearingAccount(org);
  const codeId = randomUUID();
  await db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active, created_by, updated_by)
    values (${codeId}, ${org.orgId}, 'SALES-10', 'Sales 10%', 'sales', 'standard',
            ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${codeId}, '10.0000', '2020-01-01', ${actorId}, ${actorId})`);
  await withBypass(() =>
    saveMarketplaceFacilitator(db, org.orgId, {
      name: "Amazon",
      clearingAccountId: clearingId,
      collectionMode: "gross",
      states: ["WA"],
    }, actorId),
  );
  return { codeId, clearingId };
}

/** Approved invoice with one merchant line and one marketplace line. */
async function seedMarketplaceInvoice(
  org: Org,
  actorId: string,
  number: string,
  codeId: string,
  shipToRegion = "FL",
  marketplace = true,
): Promise<string> {
  const documentId = randomUUID();
  const merchantLineId = randomUUID();
  const marketLineId = randomUUID();
  // Evidence is immutable once the document leaves draft, so the marketplace
  // line persists through the shared writer before approval.
  const configs = await loadTaxProfileConfig(org.orgId, { taxCodeId: codeId, taxGroupId: null }, org.date);
  const calculated = computeLineTaxes("200.0000", configs);
  assert.equal(calculated.taxTotal, "20.0000");
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total,
         ship_to_country, ship_to_region, created_by, updated_by)
      values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${number}, ${org.subsidiaryId},
              ${org.customerId}, ${org.date}, ${org.date}, 'USD', '1',
              '300.0000', '30.0000', '330.0000', 'US', ${shipToRegion}, ${actorId}, ${actorId})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price, created_by, updated_by)
      values (${merchantLineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '100.0000',
              '100.0000', '10.0000', ${codeId}, '1', '100.0000', ${actorId}, ${actorId}),
             (${marketLineId}, ${org.orgId}, ${documentId}, 2, ${org.accounts.revenue}, '200.0000',
              '200.0000', '20.0000', ${codeId}, '1', '200.0000', ${actorId}, ${actorId})`);
    // The marketplace toggle lives on the line; the component rows inherit it.
    if (marketplace) {
      await tx.execute(sql`
        update document_lines set marketplace_facilitator = 'Amazon'
         where id = ${marketLineId} and org_id = ${org.orgId}`);
    }
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale,
         collected_account_id, paid_account_id, withholding_account_id, overridden,
         created_by, updated_by)
      values (${org.orgId}, ${merchantLineId}, ${codeId}, 1, '10.0000', '100.0000',
              '10.0000', '0.0000', '10.0000', 'standard', false, false, 2,
              ${org.accounts.taxOutput}, null, null, false, ${actorId}, ${actorId})`);
    // The line flag stamps collected_by/facilitator_name on the evidence rows.
    await persistLineTaxComponents(org.orgId, marketLineId, calculated.components, actorId, tx);
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  const stamped = (await db.execute<{ collectedBy: string; facilitatorName: string | null }>(sql`
    select collected_by as "collectedBy", facilitator_name as "facilitatorName"
      from document_line_tax_components
     where org_id = ${org.orgId} and document_line_id = ${marketLineId}`)).rows;
  assert.equal(stamped.length, 1);
  assert.equal(stamped[0]!.collectedBy, marketplace ? "marketplace" : "merchant");
  assert.equal(stamped[0]!.facilitatorName, marketplace ? "Amazon" : null);
  return documentId;
}

const CONTROL = (org: Org) => ({ ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank });

async function journalByAccount(org: Org, entryId: string): Promise<{ legs: Map<string, string>; balanced: boolean }> {
  const rows = (await db.execute<{ accountId: string; amount: string }>(sql`
    select account_id as "accountId", amount::text as amount
      from journal_lines where org_id = ${org.orgId} and entry_id = ${entryId}`)).rows;
  // Several legs can share an account: accumulate per account for the
  // assertions and prove the entry balances over every leg.
  const legs = new Map<string, bigint>();
  let total = 0n;
  for (const row of rows) {
    const minor = BigInt(Math.round(Number(row.amount) * 10000));
    total += minor;
    legs.set(row.accountId, (legs.get(row.accountId) ?? 0n) + minor);
  }
  const format = (minor: bigint): string => (Number(minor) / 10000).toFixed(4);
  return {
    legs: new Map([...legs].map(([account, minor]) => [account, format(minor)])),
    balanced: total === 0n,
  };
}

test("marketplace tax posts to clearing, is excluded from due, and reported on the facilitator line", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Marketplace Controller", "admin");
    // The invoice tenders in USD: measure the USD-base org so no conversion
    // is needed to post or to report.
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2)
      on conflict (code) do nothing`);
    await db.execute(sql`update orgs set base_currency = 'USD' where id = ${org.orgId}`);
    await db.execute(sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId}`);
    const { codeId, clearingId } = await seedSetup(org, actorId);
    const documentId = await seedMarketplaceInvoice(org, actorId, "INV-MKT-1", codeId);
    const entryId = await postDocument(documentId, { control: CONTROL(org) });

    // The journal balances with the facilitator share in clearing, not liability.
    const { legs, balanced } = await journalByAccount(org, entryId);
    assert.equal(balanced, true);
    assert.equal(legs.get(org.accounts.taxOutput), "-10.0000");
    assert.equal(legs.get(clearingId), "-20.0000");
    assert.equal(legs.get(org.accounts.ar), "330.0000");

    // The return excludes the facilitator share from tax due and reports it.
    const formCode = "FL_MARKETPLACE";
    await db.execute(sql`
      insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
      values (${randomUUID()}, ${org.orgId}, ${formCode}, 'Florida DR-15', 'portal_manual', true)`);
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'DUE', 'Tax due', ${codeId}, 'tax_collected', -1, 10),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'MKT', 'Marketplace sales', ${codeId}, 'marketplace_sales', 1, 20),
        (${randomUUID()}, ${org.orgId}, ${formCode}, 'MKTTAX', 'Marketplace tax', ${codeId}, 'marketplace_tax', 1, 30)`);
    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = new Map(result.boxes.map((box) => [box.lineCode, box.value]));
    assert.equal(values.get("DUE"), "10.0000");
    assert.equal(values.get("MKT"), "200.0000");
    assert.equal(values.get("MKTTAX"), "20.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("nexus excludes marketplace sales where the state rule excludes them and flags unreviewed states", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Nexus Controller", "admin");
    // A USD-base org measures in USD with no conversion: the exclusion is
    // pure subtraction, exactly what this test proves.
    await db.execute(sql`
      insert into currencies (code, name, minor_units)
      values ('USD', 'US Dollar', 2)
      on conflict (code) do nothing`);
    await db.execute(sql`update orgs set base_currency = 'USD' where id = ${org.orgId}`);
    await db.execute(sql`update subsidiaries set base_currency = 'USD' where id = ${org.subsidiaryId}`);
    const { codeId } = await seedSetup(org, actorId);
    const documentId = await seedMarketplaceInvoice(org, actorId, "INV-MKT-2", codeId);
    await postDocument(documentId, { control: CONTROL(org) });
    // A second invoice — merchant-only, shipping to a state with no
    // verified rule — proves the include-pending-review default on a real row.
    const wyomingId = await seedMarketplaceInvoice(org, actorId, "INV-MKT-3", codeId, "WY", false);
    await postDocument(wyomingId, { control: CONTROL(org) });

    // The invoice ships to Florida, whose seeded rule excludes facilitator
    // sales: the threshold measures the merchant's 100 alone.
    const to = org.date;
    const from = org.date.slice(0, 8) + "01";
    const status = await computeUsNexusStatus(org.orgId, from, to);
    const florida = status.states.find((s) => s.state === "FL");
    assert.ok(florida, "florida is measured");
    assert.equal(florida.marketplace.included, false);
    assert.equal(florida.marketplace.needsReview, false);
    assert.equal(florida.marketplace.marketplaceSalesUsd, "200.0000");
    // 300 of sales, 200 of them facilitator-collected: Florida measures 100.
    assert.equal(florida.salesUsd, "100.0000");

    const wyoming = status.states.find((s) => s.state === "WY");
    assert.ok(wyoming, "wyoming is measured");
    assert.equal(wyoming.marketplace.included, true);
    assert.equal(wyoming.marketplace.needsReview, true);
    assert.equal(wyoming.salesUsd, "300.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});