import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { computeOssReturn, ossReturnToCsv } from "./oss-return.ts";
import { requestDocumentVoid } from "../ledger/document-void.ts";
import { recordSupplyEvidence } from "../tax/cross-border-records.ts";
import { isoDateOf, utcDateFromParts } from "../platform/civil-date.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

// Union OSS from posted B2C digital invoices: DE and FR sales aggregate by
// consumption state and rate, and an October credit against a July invoice
// returns as a correction to Q3 — never by rewriting the filed quarter.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedEuroOrg(org: Org): Promise<void> {
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('EUR', 'Euro', 2)
    on conflict (code) do nothing`);
  await db.execute(sql`update orgs set base_currency = 'EUR' where id = ${org.orgId}`);
  await db.execute(
    sql`update subsidiaries set base_currency = 'EUR', country = 'IE' where id = ${org.subsidiaryId}`,
  );
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"crossBorderTax": true}'::jsonb)
     where id = ${org.orgId}`);
  for (const [number, start, end] of [
    [1, "2026-01-01", "2026-01-31"],
    [2, "2026-02-01", "2026-02-28"],
    [3, "2026-03-01", "2026-03-31"],
    [4, "2026-04-01", "2026-04-30"],
    [5, "2026-05-01", "2026-05-31"],
    [6, "2026-06-01", "2026-06-30"],
    [8, "2026-08-01", "2026-08-31"],
    [9, "2026-09-01", "2026-09-30"],
    [10, "2026-10-01", "2026-10-31"],
  ] as const) {
    const calendar = (
      await db.execute<{ id: string }>(
        sql`
        select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`,
        "objects",
      )
    )[0]!.id;
    await db.execute(sql`
      insert into accounting_periods (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
      values (${randomUUID()}, ${org.orgId}, 2026, ${number}, ${`2026-0${number}`}, ${start}, ${end}, false, ${calendar})`);
  }
  await db.execute(sql`
    insert into tax_oss_registrations (id, org_id, subsidiary_id, scheme, identification_state, registration_number, effective_from, is_active)
    values (${randomUUID()}, ${org.orgId}, ${org.subsidiaryId}, 'union', 'IE', 'IE1234567A', '2026-01-01', true)`);
}

async function seedRateCode(
  org: Org,
  actorId: string,
  code: string,
  country: string,
  rate: string,
): Promise<string> {
  const codeId = randomUUID();
  await db.execute(sql`
    insert into tax_codes
      (id, org_id, code, name, country, applies_to, calculation_type, collected_account_id, paid_account_id, is_active, created_by, updated_by)
    values (${codeId}, ${org.orgId}, ${code}, ${`${country} standard`}, ${country}, 'sales', 'standard',
            ${org.accounts.taxOutput}, ${org.accounts.taxInput}, true, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from, created_by, updated_by)
    values (${randomUUID()}, ${org.orgId}, ${codeId}, ${rate}, '2020-01-01', ${actorId}, ${actorId})`);
  return codeId;
}

/** Draft B2C digital invoice with two agreeing evidence signals. */
async function seedDigitalInvoice(
  org: Org,
  actorId: string,
  number: string,
  country: string,
  codeId: string,
  rate: string,
  docDate: string,
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const tax = (1000 * Number(rate)) / 100;
  const taxText = `${tax.toFixed(4)}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${number}, ${org.subsidiaryId},
            ${org.customerId}, ${docDate}, ${docDate}, 'EUR', '1',
            '1000.0000', ${taxText}, ${(1000 + tax).toFixed(4)},
            '{"crossBorder": {"supplyKind": "digital_service", "customerKind": "consumer"}}'::jsonb,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
       tax_amount, tax_code_id, quantity, unit_price, created_by, updated_by)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, '1000.0000',
            '1000.0000', ${taxText}, ${codeId}, '1', '1000.0000', ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_line_tax_components
      (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
       tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
       price_includes_tax, compound_on_previous, rounding_scale,
       collected_account_id, paid_account_id, withholding_account_id, overridden,
       created_by, updated_by)
    values (${org.orgId}, ${lineId}, ${codeId}, 1, ${rate}, '1000.0000',
            ${taxText}, '0.0000', ${taxText}, 'standard', false, false, 2,
            ${org.accounts.taxOutput}, null, null, false, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_supply_evidence (org_id, document_id, kind, country_code, source, observed_on, created_by)
    values (${org.orgId}, ${documentId}, 'billing_address', ${country}, 'checkout', ${docDate}, ${actorId}),
           (${org.orgId}, ${documentId}, 'ip_country', ${country}, 'gateway', ${docDate}, ${actorId})`);
  return documentId;
}

async function approveDocument(org: Org, documentId: string): Promise<void> {
  await db.execute(
    sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`,
  );
}

const CONTROL = (org: Org) => ({
  ar: org.accounts.ar,
  ap: org.accounts.ap,
  bank: org.accounts.bank,
});

test(
  "B2C sales to DE and FR aggregate into the Union OSS return by state and rate",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
      await seedEuroOrg(org);
      const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
      const frCode = await seedRateCode(org, actorId, "FR-VAT-S", "FR", "20.0000");
      const deInvoice = await seedDigitalInvoice(
        org,
        actorId,
        "INV-OSS-DE",
        "DE",
        deCode,
        "19.0000",
        "2026-07-10",
      );
      const frInvoice = await seedDigitalInvoice(
        org,
        actorId,
        "INV-OSS-FR",
        "FR",
        frCode,
        "20.0000",
        "2026-07-12",
      );
      await approveDocument(org, deInvoice);
      await approveDocument(org, frInvoice);
      await postDocument(deInvoice, { control: CONTROL(org) });
      await postDocument(frInvoice, { control: CONTROL(org) });

      const oss = await computeOssReturn(db, org.orgId, {
        scheme: "union",
        from: "2026-07-01",
        to: "2026-09-30",
      });
      assert.equal(oss.identificationState, "IE");
      assert.equal(oss.currency, "EUR");
      assert.equal(oss.lines.length, 2);
      const de = oss.lines.find((line) => line.consumptionCountry === "DE")!;
      assert.equal(de.ratePercent, "19.0000");
      assert.equal(de.baseAmount, "1000.0000");
      assert.equal(de.taxAmount, "190.0000");
      assert.equal(de.kind, "supply");
      const fr = oss.lines.find((line) => line.consumptionCountry === "FR")!;
      assert.equal(fr.taxAmount, "200.0000");
      assert.equal(oss.totalTax, "390.0000");

      const csv = ossReturnToCsv(oss);
      assert.match(csv, /DE;19\.00;1000\.00;190\.00/);
      assert.match(csv, /FR;20\.00;1000\.00;200\.00/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a credit in a later quarter becomes a correction line for the original quarter",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
      await seedEuroOrg(org);
      const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
      const invoiceId = await seedDigitalInvoice(
        org,
        actorId,
        "INV-OSS-DE2",
        "DE",
        deCode,
        "19.0000",
        "2026-07-10",
      );
      await approveDocument(org, invoiceId);
      await postDocument(invoiceId, { control: CONTROL(org) });

      const creditId = randomUUID();
      const creditLineId = randomUUID();
      await db.execute(sql`
      insert into documents
        (id, org_id, kind, status, document_number, subsidiary_id, party_id,
         document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom, created_by, updated_by)
      values (${creditId}, ${org.orgId}, 'customer_credit', 'draft', 'CR-OSS-DE2', ${org.subsidiaryId},
              ${org.customerId}, '2026-10-05', '2026-10-05', 'EUR', '1',
              '1000.0000', '190.0000', '1190.0000',
              '{"crossBorder": {"supplyKind": "digital_service", "customerKind": "consumer"}}'::jsonb,
              ${actorId}, ${actorId})`);
      await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
         tax_amount, tax_code_id, quantity, unit_price, created_by, updated_by)
      values (${creditLineId}, ${org.orgId}, ${creditId}, 1, ${org.accounts.revenue}, '1000.0000',
              '1000.0000', '190.0000', ${deCode}, '1', '1000.0000', ${actorId}, ${actorId})`);
      await db.execute(sql`
      insert into document_line_tax_components
        (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
         tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
         price_includes_tax, compound_on_previous, rounding_scale,
         collected_account_id, paid_account_id, withholding_account_id, overridden,
         created_by, updated_by)
      values (${org.orgId}, ${creditLineId}, ${deCode}, 1, '19.0000', '1000.0000',
              '190.0000', '0.0000', '190.0000', 'standard', false, false, 2,
              ${org.accounts.taxOutput}, null, null, false, ${actorId}, ${actorId})`);
      // The corrected invoice is named through the product path, which records
      // a `corrects` relationship — never an identifier string in custom JSON.
      await recordSupplyEvidence(
        db,
        org.orgId,
        creditId,
        {
          election: {
            supplyKind: "digital_service",
            customerKind: "consumer",
            correctsDocumentId: invoiceId,
          },
          evidence: [
            { kind: "billing_address", country: "DE", source: "checkout" },
            { kind: "ip_country", country: "DE", source: "gateway" },
          ],
        },
        actorId,
      );
      await approveDocument(org, creditId);
      await postDocument(creditId, { control: CONTROL(org) });

      const q4 = await computeOssReturn(db, org.orgId, {
        scheme: "union",
        from: "2026-10-01",
        to: "2026-12-31",
      });
      assert.equal(q4.lines.length, 1);
      assert.equal(q4.lines[0]!.kind, "correction");
      assert.equal(q4.lines[0]!.correctionQuarter, "2026-Q3");
      assert.equal(q4.lines[0]!.baseAmount, "-1000.0000");
      assert.equal(q4.lines[0]!.taxAmount, "-190.0000");
      assert.match(ossReturnToCsv(q4), /CORRECTION;DE;19\.00;-1000\.00;-190\.00;2026-Q3/);
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test(
  "a supply voided in a later quarter remains in its original return and corrects there",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
      await seedEuroOrg(org);
      const today = (
        await db.execute<{ today: string }>(sql`select current_date::text as today`, "objects")
      )[0]!.today;
      const currentYear = Number(today.slice(0, 4));
      const currentMonth = Number(today.slice(5, 7));
      const currentQuarter = Math.ceil(currentMonth / 3);
      const currentQuarterStartMonth = (currentQuarter - 1) * 3 + 1;
      const previousQuarter = currentQuarter === 1 ? 4 : currentQuarter - 1;
      const previousQuarterYear = currentQuarter === 1 ? currentYear - 1 : currentYear;
      const previousQuarterStartMonth = (previousQuarter - 1) * 3 + 1;
      const quarterStart = (year: number, month: number) =>
        `${year}-${String(month).padStart(2, "0")}-01`;
      const monthEnd = (year: number, month: number) => {
        return isoDateOf(utcDateFromParts(year, month, 0));
      };
      const quarterEnd = (year: number, month: number) => monthEnd(year, month + 2);
      const invoiceDate = `${quarterStart(previousQuarterYear, previousQuarterStartMonth).slice(0, 8)}15`;
      const previousFrom = quarterStart(previousQuarterYear, previousQuarterStartMonth);
      const previousTo = quarterEnd(previousQuarterYear, previousQuarterStartMonth);
      const currentFrom = quarterStart(currentYear, currentQuarterStartMonth);
      const currentTo = quarterEnd(currentYear, currentQuarterStartMonth);
      for (const date of [invoiceDate, today]) {
        const covering = (
          await db.execute<{ id: string }>(
            sql`
        select id from accounting_periods where org_id = ${org.orgId}
          and starts_on <= ${date}::date and ends_on >= ${date}::date limit 1`,
            "objects",
          )
        )[0];
        if (!covering) {
          const [year, month] = date.slice(0, 7).split("-").map(Number);
          const calendar = (
            await db.execute<{ id: string }>(
              sql`
          select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`,
              "objects",
            )
          )[0]!.id;
          await db.execute(sql`
          insert into accounting_periods
            (id, org_id, fiscal_year, period_number, name, starts_on, ends_on, is_adjustment, fiscal_calendar_id)
          values (${randomUUID()}, ${org.orgId}, ${year}, ${month}, ${`${year}-${String(month).padStart(2, "0")}`},
                  ${quarterStart(year!, month!)}, ${monthEnd(year!, month!)}, false, ${calendar})`);
        }
      }
      const deCode = await seedRateCode(org, actorId, "DE-VAT-VOID", "DE", "19.0000");
      const invoiceId = await seedDigitalInvoice(
        org,
        actorId,
        "INV-OSS-VOID",
        "DE",
        deCode,
        "19.0000",
        invoiceDate,
      );
      await approveDocument(org, invoiceId);
      await postDocument(invoiceId, { control: CONTROL(org) });
      const voided = await requestDocumentVoid({
        orgId: org.orgId,
        actorId,
        documentId: invoiceId,
        reason: "Customer transaction cancelled",
        reversalDate: today,
        allowedSubsidiaryIds: null,
      });
      assert.equal(voided.status, "voided");

      const original = await computeOssReturn(db, org.orgId, {
        scheme: "union",
        from: previousFrom,
        to: previousTo,
      });
      assert.equal(original.lines.length, 1);
      assert.equal(original.lines[0]!.baseAmount, "1000.0000");
      assert.equal(original.lines[0]!.taxAmount, "190.0000");
      const correction = await computeOssReturn(db, org.orgId, {
        scheme: "union",
        from: currentFrom,
        to: currentTo,
      });
      assert.equal(correction.lines.length, 1);
      assert.equal(correction.lines[0]!.kind, "correction");
      assert.equal(
        correction.lines[0]!.correctionQuarter,
        `${previousQuarterYear}-Q${previousQuarter}`,
      );
      assert.equal(correction.lines[0]!.baseAmount, "-1000.0000");
      assert.equal(correction.lines[0]!.taxAmount, "-190.0000");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("conflicting evidence refuses posting and names both countries", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await seedEuroOrg(org);
    const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
    const documentId = await seedDigitalInvoice(
      org,
      actorId,
      "INV-OSS-XX",
      "DE",
      deCode,
      "19.0000",
      "2026-07-10",
    );
    await db.execute(sql`
      update document_supply_evidence set country_code = 'FR'
       where org_id = ${org.orgId} and document_id = ${documentId} and kind = 'ip_country'`);
    await approveDocument(org, documentId);
    await assert.rejects(
      () => postDocument(documentId, { control: CONTROL(org) }),
      /DE.*FR|FR.*DE/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
