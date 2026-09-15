import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { postDocument } from "./posting.ts";
import { computeTaxReturn, TaxReturnError } from "./tax-return.ts";
import { createScratchOrg, dropScratchOrg, type ScratchOrg } from "./test-fixtures.ts";

// Filing-entity returns (item 6E): a return is prepared per filing entity in
// THAT entity's functional currency. journal_lines.amount is stored in the
// line's subsidiary functional currency, so an org-wide sum across a CAD root
// and a USD subsidiary adds unlike units. The return must scope to the entity,
// store the functional currency, translate per entity at a declared policy
// rate for consolidated views, and fail closed on undeclared mixing.

const DB = !!process.env.OPENBOOKS_DB_URL;

type DocKind = "customer_invoice" | "customer_credit" | "vendor_bill" | "vendor_credit";
const SALES_KINDS = new Set(["customer_invoice", "customer_credit"]);

async function createUsdSubsidiary(org: ScratchOrg): Promise<string> {
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`);
  const id = randomUUID();
  await db.execute(sql`
    insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
    values (${id}, ${org.orgId}, ${org.subsidiaryId}, 'US Ops', 'USD', 'US', '{}'::jsonb, false, true, '{}'::jsonb)`);
  // Both sales and purchase parties must transact with the new entity — the
  // same entity-record requirement the posting boundary enforces.
  await db.execute(sql`
    insert into party_subsidiaries (id, org_id, party_id, subsidiary_id)
    select gen_random_uuid(), ${org.orgId}, p.id, ${id}
      from parties p
     where p.org_id = ${org.orgId} and p.kind in ('customer', 'vendor')
    on conflict do nothing`);
  return id;
}

async function makeTaxCode(orgId: string, code: string, accounts: ScratchOrg["accounts"]): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, applies_to, calculation_type, collected_account_id, paid_account_id, is_active)
    values (${id}, ${orgId}, ${code}, ${code}, 'both', 'standard',
            ${accounts.taxOutput}, ${accounts.taxInput}, true)`);
  return id;
}

/** Seed one approved taxable document under an explicit subsidiary. */
async function seedEntityDocument(
  org: ScratchOrg,
  opts: { subsidiaryId: string; kind: DocKind; number: string; taxCodeId: string; amount: string; taxAmount: string; currency: string },
): Promise<void> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const sales = SALES_KINDS.has(opts.kind);
  const accountId = sales ? org.accounts.revenue : org.accounts.cogs;
  await db.transaction(async (tx) => {
    await tx.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total)
      values (${documentId}, ${org.orgId}, ${opts.kind}, 'draft', ${opts.number}, ${opts.subsidiaryId},
              ${sales ? org.customerId : org.vendorId}, ${org.date}, ${org.date},
              ${opts.currency}, '1', ${opts.amount}, ${opts.taxAmount}, ${(Number(opts.amount) + Number(opts.taxAmount)).toFixed(4)})`);
    await tx.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price)
      values (${lineId}, ${org.orgId}, ${documentId}, 1, ${accountId}, ${opts.amount},
              ${opts.amount}, ${opts.taxAmount}, ${opts.taxCodeId}, '1', ${opts.amount})`);
    await tx.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale, collected_account_id,
         paid_account_id, withholding_account_id, overridden)
      values (${org.orgId}, ${lineId}, ${opts.taxCodeId}, 1, '10', ${opts.amount}, ${opts.taxAmount},
              ${opts.taxAmount}, '0.0000', 'standard', false, false, 2,
              ${sales ? org.accounts.taxOutput : null}, ${sales ? null : org.accounts.taxInput},
              null, false)`);
    await tx.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  });
  await postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
}

async function makeEntityForm(
  orgId: string,
  formCode: string,
  lines: { lineCode: string; taxCodeId: string; basis: string; sign: number; sequence: number }[],
): Promise<void> {
  await db.execute(sql`
    insert into tax_return_forms (id, org_id, code, name, submission_channel, is_active)
    values (${randomUUID()}, ${orgId}, ${formCode}, ${formCode}, 'portal_manual', true)`);
  for (const line of lines) {
    await db.execute(sql`
      insert into tax_report_lines
        (id, org_id, report_code, line_code, label, tax_code_id, basis, sign, sequence)
      values (${randomUUID()}, ${orgId}, ${formCode}, ${line.lineCode}, ${line.lineCode},
              ${line.taxCodeId}, ${line.basis}, ${line.sign}, ${line.sequence})`);
  }
}

/** CAD root invoice 200+20 and USD subsidiary invoice 1000+100 on one form. */
async function seedTwoEntityOrg(): Promise<{ org: ScratchOrg; usSub: string; formCode: string }> {
  const org = await createScratchOrg();
  const usSub = await createUsdSubsidiary(org);
  const cadCode = await makeTaxCode(org.orgId, "CAD-TAX", org.accounts);
  const usCode = await makeTaxCode(org.orgId, "US-TAX", org.accounts);
  await seedEntityDocument(org, {
    subsidiaryId: org.subsidiaryId, kind: "customer_invoice", number: "INV-CAD",
    taxCodeId: cadCode, amount: "200.0000", taxAmount: "20.0000", currency: "CAD",
  });
  await seedEntityDocument(org, {
    subsidiaryId: usSub, kind: "customer_invoice", number: "INV-USD",
    taxCodeId: usCode, amount: "1000.0000", taxAmount: "100.0000", currency: "USD",
  });
  const formCode = "ENTITY-MIX";
  await makeEntityForm(org.orgId, formCode, [
    { lineCode: "BASE", taxCodeId: cadCode, basis: "taxable_base", sign: 1, sequence: 10 },
    { lineCode: "BASE", taxCodeId: usCode, basis: "taxable_base", sign: 1, sequence: 11 },
    { lineCode: "TAX", taxCodeId: cadCode, basis: "tax_collected", sign: -1, sequence: 20 },
    { lineCode: "TAX", taxCodeId: usCode, basis: "tax_collected", sign: -1, sequence: 21 },
  ]);
  return { org, usSub, formCode };
}

const boxesOf = (result: { boxes: { lineCode: string; value: string }[] }) =>
  new Map(result.boxes.map((box) => [box.lineCode, box.value]));

test("an entity-scoped return sums only that entity in its functional currency", { skip: !DB }, async () => {
  const { org, usSub, formCode } = await seedTwoEntityOrg();
  try {
    const cad = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
      filingEntity: { subsidiaryIds: [org.subsidiaryId] },
    });
    assert.equal(cad.functionalCurrency, "CAD");
    assert.deepEqual(cad.subsidiaryIds, [org.subsidiaryId]);
    assert.equal(cad.translation, null);
    const cadBoxes = boxesOf(cad);
    // Root invoice only: 200 base, 20 collected (sign-flipped positive).
    assert.equal(cadBoxes.get("BASE"), "200.0000");
    assert.equal(cadBoxes.get("TAX"), "20.0000");

    const usd = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
      filingEntity: { subsidiaryIds: [usSub] },
    });
    assert.equal(usd.functionalCurrency, "USD");
    const usdBoxes = boxesOf(usd);
    // USD-subsidiary invoice only, in USD functional (header rate 1:1).
    assert.equal(usdBoxes.get("BASE"), "1000.0000");
    assert.equal(usdBoxes.get("TAX"), "100.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unscoped multi-currency return fails closed without a policy", { skip: !DB }, async () => {
  const { org, formCode } = await seedTwoEntityOrg();
  try {
    await assert.rejects(
      computeTaxReturn(org.orgId, formCode, org.date, org.date),
      (e: unknown) =>
        e instanceof TaxReturnError &&
        /spans functional currencies \(CAD and USD\)/.test(e.message) &&
        /subsidiaryIds/.test(e.message) &&
        /presentationCurrency/.test(e.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a translated view converts per entity at the declared policy rate with evidence", { skip: !DB }, async () => {
  const { org, usSub, formCode } = await seedTwoEntityOrg();
  try {
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'USD', 'CAD', '2026-07-01', 'spot', '1.3500000000', 'manual')`);
    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
      translation: { presentationCurrency: "CAD" },
    });
    assert.equal(result.functionalCurrency, "CAD");
    const values = boxesOf(result);
    // CAD 200 + USD 1000×1.35; CAD 20 + USD 100×1.35.
    assert.equal(values.get("BASE"), "1550.0000");
    assert.equal(values.get("TAX"), "155.0000");
    assert.ok(result.translation);
    assert.equal(result.translation.presentationCurrency, "CAD");
    assert.equal(result.translation.rateType, "spot");
    assert.equal(result.translation.rateDate, org.date);
    assert.equal(result.translation.entities.length, 2);
    const bySub = new Map(result.translation.entities.map((e) => [e.subsidiaryId, e]));
    assert.equal(bySub.get(org.subsidiaryId)?.currency, "CAD");
    assert.equal(bySub.get(org.subsidiaryId)?.fxRate, "1");
    assert.equal(bySub.get(usSub)?.currency, "USD");
    assert.equal(bySub.get(usSub)?.fxRate, "1.3500000000");
    assert.equal(bySub.get(usSub)?.rateAsOf, "2026-07-01");
    // Per-entity evidence boxes stay in functional currency.
    const usEvidence = new Map(bySub.get(usSub)!.boxes.map((b) => [b.lineCode, b.value]));
    assert.equal(usEvidence.get("BASE"), "1000.0000");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a translated view fails closed when an entity has no rate coverage", { skip: !DB }, async () => {
  const { org, formCode } = await seedTwoEntityOrg();
  try {
    await assert.rejects(
      computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        translation: { presentationCurrency: "CAD" },
      }),
      (e: unknown) => e instanceof TaxReturnError && /cannot translate USD→CAD/.test(e.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a single-currency org stays byte-identical with no policy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const code = await makeTaxCode(org.orgId, "CAD-ONLY", org.accounts);
    await seedEntityDocument(org, {
      subsidiaryId: org.subsidiaryId, kind: "customer_invoice", number: "INV-1",
      taxCodeId: code, amount: "200.0000", taxAmount: "20.0000", currency: "CAD",
    });
    const formCode = "SINGLE-CCY";
    await makeEntityForm(org.orgId, formCode, [
      { lineCode: "BASE", taxCodeId: code, basis: "taxable_base", sign: 1, sequence: 10 },
      { lineCode: "TAX", taxCodeId: code, basis: "tax_collected", sign: -1, sequence: 20 },
    ]);
    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date);
    const values = boxesOf(result);
    assert.equal(values.get("BASE"), "200.0000");
    assert.equal(values.get("TAX"), "20.0000");
    assert.equal(result.functionalCurrency, "CAD");
    assert.equal(result.translation, null);
    assert.equal(result.registrationId, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a pinned registration travels on the return; a foreign one fails closed", { skip: !DB }, async () => {
  const { org, formCode } = await seedTwoEntityOrg();
  try {
    const jurisdictionId = randomUUID();
    await db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
      values (${jurisdictionId}, ${org.orgId}, 'PIN', 'Pinned jurisdiction', 'CA', 'country', 'gst')`);
    const registrationId = randomUUID();
    await db.execute(sql`
      insert into tax_registrations
        (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
      values (${registrationId}, ${org.orgId}, ${jurisdictionId}, '111222333 RT0001', 'quarterly', ${formCode}, true)`);
    const pinned = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
      filingEntity: { subsidiaryIds: [org.subsidiaryId], registrationId },
    });
    assert.equal(pinned.registrationNumber, "111222333 RT0001");
    assert.equal(pinned.registrationId, registrationId);

    await assert.rejects(
      computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [org.subsidiaryId], registrationId: randomUUID() },
      }),
      (e: unknown) => e instanceof TaxReturnError && /was not found in this organization/.test(e.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an unknown or elimination subsidiary fails closed", { skip: !DB }, async () => {
  const { org, formCode } = await seedTwoEntityOrg();
  try {
    await assert.rejects(
      computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [randomUUID()] },
      }),
      (e: unknown) => e instanceof TaxReturnError && /outside this organization/.test(e.message),
    );
    const elimId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${elimId}, ${org.orgId}, ${org.subsidiaryId}, 'Elim', 'CAD', 'CA', '{}'::jsonb, true, true, '{}'::jsonb)`);
    await assert.rejects(
      computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
        filingEntity: { subsidiaryIds: [elimId] },
      }),
      (e: unknown) => e instanceof TaxReturnError && /elimination/.test(e.message),
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a registration-only pin keeps the org-wide return with the pinned number", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const code = await makeTaxCode(org.orgId, "CAD-PIN", org.accounts);
    await seedEntityDocument(org, {
      subsidiaryId: org.subsidiaryId, kind: "customer_invoice", number: "INV-PIN",
      taxCodeId: code, amount: "200.0000", taxAmount: "20.0000", currency: "CAD",
    });
    const formCode = "REG-ONLY";
    await makeEntityForm(org.orgId, formCode, [
      { lineCode: "BASE", taxCodeId: code, basis: "taxable_base", sign: 1, sequence: 10 },
      { lineCode: "TAX", taxCodeId: code, basis: "tax_collected", sign: -1, sequence: 20 },
    ]);
    const jurisdictionId = randomUUID();
    await db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
      values (${jurisdictionId}, ${org.orgId}, 'PINONLY', 'Pin-only jurisdiction', 'CA', 'country', 'gst')`);
    const registrationId = randomUUID();
    await db.execute(sql`
      insert into tax_registrations
        (id, org_id, jurisdiction_id, registration_number, filing_frequency, return_form_code, is_active)
      values (${registrationId}, ${org.orgId}, ${jurisdictionId}, '999888777 RT0001', 'quarterly', ${formCode}, true)`);
    const result = await computeTaxReturn(org.orgId, formCode, org.date, org.date, {}, {
      filingEntity: { subsidiaryIds: [], registrationId },
    });
    const values = boxesOf(result);
    assert.equal(values.get("BASE"), "200.0000");
    assert.equal(values.get("TAX"), "20.0000");
    assert.equal(result.registrationNumber, "999888777 RT0001");
    assert.equal(result.registrationId, registrationId);
    assert.equal(result.functionalCurrency, "CAD");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
