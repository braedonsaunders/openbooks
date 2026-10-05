import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { postDocument } from "../ledger/posting-document.ts";
import { computeOssReturn, recordOssFxEvidence } from "./oss-return.ts";
import { ossReturnToIrelandXml, ossReturnToMemberStateCsv } from "./oss-exports.ts";
import { computeDistanceTurnover, findSupplyEvidenceConflicts } from "../tax/cross-border-monitor.ts";
import {
  authorityCredentialsForOrg,
  readAuthorityConnectionStatus,
  refreshHmrcToken,
  saveAuthorityCredentials,
} from "../tax/authority-connections.ts";
import { createScratchOrg, createScratchUser, dropScratchOrg } from "../testing/fixtures.ts";

// First-wave follow-ups for cross-border tax: foreign-currency OSS
// translation at the period-end ECB rate with stored evidence, member-state
// transport layouts, the pre-posting evidence-conflict queue, the EUR 10,000
// threshold monitor, and sealed HMRC/ABN credentials.

const DB = !!process.env.OPENBOOKS_DB_URL;

type Org = Awaited<ReturnType<typeof createScratchOrg>>;

async function seedEuroOrg(org: Org): Promise<void> {
  await db.execute(sql`
    insert into currencies (code, name, minor_units)
    values ('EUR', 'Euro', 2), ('USD', 'US dollar', 2), ('GBP', 'Pound sterling', 2)
    on conflict (code) do nothing`);
  await db.execute(sql`update orgs set base_currency = 'EUR' where id = ${org.orgId}`);
  await db.execute(sql`update subsidiaries set base_currency = 'EUR', country = 'IE' where id = ${org.subsidiaryId}`);
  await db.execute(sql`
    update orgs set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features}', '{"crossBorderTax": true}'::jsonb)
     where id = ${org.orgId}`);
  for (const [number, start, end] of [
    [8, "2026-08-01", "2026-08-31"],
    [9, "2026-09-01", "2026-09-30"],
    [10, "2026-10-01", "2026-10-31"],
  ] as const) {
    const calendar = (
      await db.execute<{ id: string }>(sql`
        select fiscal_calendar_id as id from accounting_periods where org_id = ${org.orgId} limit 1`)
    ).rows[0]!.id;
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

/** Draft B2C digital invoice with agreeing evidence signals. */
async function seedDigitalInvoice(
  org: Org,
  actorId: string,
  number: string,
  country: string,
  codeId: string,
  rate: string,
  docDate: string,
  currency = "EUR",
  fxRate = "1",
  base = 1000,
): Promise<string> {
  const documentId = randomUUID();
  const lineId = randomUUID();
  const tax = (base * Number(rate)) / 100;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, subsidiary_id, party_id,
       document_date, posting_date, currency, fx_rate, subtotal, tax_total, total, custom, created_by, updated_by)
    values (${documentId}, ${org.orgId}, 'customer_invoice', 'draft', ${number}, ${org.subsidiaryId},
            ${org.customerId}, ${docDate}, ${docDate}, ${currency}, ${fxRate},
            ${base.toFixed(4)}, ${tax.toFixed(4)}, ${(base + tax).toFixed(4)},
            '{"crossBorder": {"supplyKind": "digital_service", "customerKind": "consumer"}}'::jsonb,
            ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_lines
      (id, org_id, document_id, line_number, account_id, amount, tax_input_amount,
       tax_amount, tax_code_id, quantity, unit_price, created_by, updated_by)
    values (${lineId}, ${org.orgId}, ${documentId}, 1, ${org.accounts.revenue}, ${base.toFixed(4)},
            ${base.toFixed(4)}, ${tax.toFixed(4)}, ${codeId}, '1', ${base.toFixed(4)}, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_line_tax_components
      (org_id, document_line_id, tax_code_id, sequence, rate_percent, taxable_amount,
       tax_amount, recoverable_amount, nonrecoverable_amount, calculation_type,
       price_includes_tax, compound_on_previous, rounding_scale,
       collected_account_id, paid_account_id, withholding_account_id, overridden,
       created_by, updated_by)
    values (${org.orgId}, ${lineId}, ${codeId}, 1, ${rate}, ${base.toFixed(4)},
            ${tax.toFixed(4)}, '0.0000', ${tax.toFixed(4)}, 'standard', false, false, 2,
            ${org.accounts.taxOutput}, null, null, false, ${actorId}, ${actorId})`);
  await db.execute(sql`
    insert into document_supply_evidence (org_id, document_id, kind, country_code, source, observed_on, created_by)
    values (${org.orgId}, ${documentId}, 'billing_address', ${country}, 'checkout', ${docDate}, ${actorId}),
           (${org.orgId}, ${documentId}, 'ip_country', ${country}, 'gateway', ${docDate}, ${actorId})`);
  return documentId;
}

async function approveAndPost(org: Org, documentId: string): Promise<void> {
  await db.execute(sql`update documents set status = 'approved' where id = ${documentId} and org_id = ${org.orgId}`);
  await postDocument(documentId, {
    control: { ar: org.accounts.ar, ap: org.accounts.ap, bank: org.accounts.bank },
  });
}

function stubTransport(payload: unknown, status = 200): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(payload), {
      status,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
}

test("dollar supplies translate at the period-end ECB rate with stored evidence", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await seedEuroOrg(org);
    const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
    const invoiceId = await seedDigitalInvoice(
      org, actorId, "INV-OSS-USD", "DE", deCode, "19.0000", "2026-07-10", "USD", "0.85",
    );
    await approveAndPost(org, invoiceId);
    await db.execute(sql`
      insert into fx_rates (org_id, from_currency, to_currency, as_of, rate_type, rate, source)
      values (${org.orgId}, 'USD', 'EUR', '2026-09-30', 'spot', '0.85', 'ecb')`);

    const oss = await computeOssReturn(db, org.orgId, { scheme: "union", from: "2026-07-01", to: "2026-09-30" });
    assert.equal(oss.currency, "EUR");
    assert.equal(oss.lines.length, 1);
    assert.equal(oss.lines[0]!.baseAmount, "850.0000");
    assert.equal(oss.lines[0]!.taxAmount, "161.5000");
    assert.equal(oss.fx.length, 1);
    assert.equal(oss.fx[0]!.currency, "USD");
    assert.equal(Number(oss.fx[0]!.rate), 0.85);
    assert.equal(oss.fx[0]!.rateAsOf, "2026-09-30");
    assert.match(oss.fx[0]!.digest, /^[0-9a-f]{32,64}$/);

    const recorded = await recordOssFxEvidence(db, org.orgId, actorId, oss);
    assert.equal(recorded.stored, 1);
    const again = await recordOssFxEvidence(db, org.orgId, actorId, oss);
    assert.equal(again.stored, 1);
    const rows = (
      await db.execute<{ currency: string; rate: string }>(sql`
        select currency, rate::text as rate from tax_oss_fx_evidence
         where org_id = ${org.orgId} and scheme = 'union'
           and period_from = '2026-07-01' and period_to = '2026-09-30'`)
    ).rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.currency, "USD");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a currency with no ECB rate refuses by name with the FX remedy", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await seedEuroOrg(org);
    const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
    const invoiceId = await seedDigitalInvoice(
      org, actorId, "INV-OSS-GBP", "DE", deCode, "19.0000", "2026-07-10", "GBP", "1.17",
    );
    await approveAndPost(org, invoiceId);
    await assert.rejects(
      () => computeOssReturn(db, org.orgId, { scheme: "union", from: "2026-07-01", to: "2026-09-30" }),
      /GBP.*ECB rate|ECB rate.*GBP/,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("member-state layouts carry every filed figure with its evidence", async () => {
  const oss = {
    scheme: "union" as const,
    identificationState: "IE",
    registrationNumber: "IE1234567A",
    from: "2026-07-01",
    to: "2026-09-30",
    currency: "EUR" as const,
    lines: [
      {
        consumptionCountry: "DE",
        ratePercent: "19.0000",
        baseAmount: "850.0000",
        taxAmount: "161.5000",
        kind: "supply" as const,
        correctionQuarter: null,
      },
      {
        consumptionCountry: "FR",
        ratePercent: "20.0000",
        baseAmount: "-1000.0000",
        taxAmount: "-200.0000",
        kind: "correction" as const,
        correctionQuarter: "2026-Q2",
      },
    ],
    totalBase: "-150.0000",
    totalTax: "-38.5000",
    fx: [
      {
        currency: "USD",
        rate: "0.85",
        rateAsOf: "2026-09-30",
        rateSource: "ecb",
        digest: "0123456789abcdef0123456789abcdef",
      },
    ],
  };
  const de = ossReturnToMemberStateCsv(oss, "DE");
  assert.match(de, /BZSt/);
  assert.match(de, /Bestimmungsland;Steuersatz;Bemessungsgrundlage;Steuerbetrag/);
  assert.match(de, /MELDUNG;DE;19\.00;850\.00;161\.50/);
  assert.match(de, /KORREKTUR;FR;20\.00;-1000\.00;-200\.00;2026-Q2/);
  assert.match(de, /USD@2026-09-30#/);
  const fr = ossReturnToMemberStateCsv(oss, "FR");
  assert.match(fr, /impots\.gouv\.fr/);
  assert.match(fr, /CORRECTION;FR;20\.00;-1000\.00;-200\.00;2026-Q2/);
  const nl = ossReturnToMemberStateCsv(oss, "NL");
  assert.match(nl, /Belastingdienst/);
  assert.match(nl, /CORRECTIE;FR;20\.00;-1000\.00;-200\.00;2026-Q2/);
  const ie = ossReturnToIrelandXml(oss);
  assert.match(ie, /ROS/);
  assert.match(ie, /<Supply kind="supply" consumptionCountry="DE" vatRate="19\.00" baseAmount="850\.00" vatAmount="161\.50" \/>/);
  assert.match(ie, /<Supply kind="correction" consumptionCountry="FR"[^>]*correctionQuarter="2026-Q2" \/>/);
  assert.match(ie, /<Translation currency="USD" rate="0\.85" rateAsOf="2026-09-30" source="ecb" digest="0123456789abcdef0123456789abcdef" \/>/);
});

test("conflicting evidence surfaces on the draft before posting refuses it", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await seedEuroOrg(org);
    const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
    const cleanId = await seedDigitalInvoice(org, actorId, "INV-OSS-OK", "DE", deCode, "19.0000", "2026-07-10");
    const conflictId = await seedDigitalInvoice(org, actorId, "INV-OSS-BAD", "DE", deCode, "19.0000", "2026-07-11");
    await db.execute(sql`
      update document_supply_evidence set country_code = 'FR'
       where org_id = ${org.orgId} and document_id = ${conflictId} and kind = 'ip_country'`);

    const conflicts = await findSupplyEvidenceConflicts(db, org.orgId);
    assert.equal(conflicts.length, 1);
    assert.equal(conflicts[0]!.documentId, conflictId);
    assert.equal(conflicts[0]!.documentNumber, "INV-OSS-BAD");
    assert.deepEqual(conflicts[0]!.countries, ["DE", "FR"]);
    assert.ok(!conflicts.some((conflict) => conflict.documentId === cleanId));

    await approveAndPost(org, cleanId);
    const afterPosting = await findSupplyEvidenceConflicts(db, org.orgId);
    assert.ok(!afterPosting.some((conflict) => conflict.documentId === cleanId));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the threshold monitor nets credits, translates covered turnover and names the rest", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "OSS Controller", "admin");
    await seedEuroOrg(org);
    const deCode = await seedRateCode(org, actorId, "DE-VAT-S", "DE", "19.0000");
    const first = await seedDigitalInvoice(org, actorId, "INV-TH-1", "DE", deCode, "19.0000", "2026-08-10", "EUR", "1", 6000);
    const second = await seedDigitalInvoice(org, actorId, "INV-TH-2", "DE", deCode, "19.0000", "2026-09-12", "EUR", "1", 5000);
    const uncovered = await seedDigitalInvoice(org, actorId, "INV-TH-3", "DE", deCode, "19.0000", "2026-10-14", "GBP", "1.17", 500);
    await approveAndPost(org, first);
    await approveAndPost(org, second);
    await approveAndPost(org, uncovered);

    const turnover = await computeDistanceTurnover(db, org.orgId, 2026, "2026-12-31");
    assert.equal(turnover.totalEur, "11000.0000");
    assert.equal(turnover.crossed, true);
    assert.deepEqual(turnover.uncoveredCurrencies, ["GBP"]);
    assert.equal(turnover.translated.length, 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("authority credentials seal at rest and drive validation without network", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Tax Admin", "admin");
    await seedEuroOrg(org);

    const abn = await saveAuthorityCredentials(db, org.orgId, actorId, "abn", { guid: "abn-guid-value-1" });
    assert.equal(abn.status, "ready");
    assert.equal(abn.hasCredentials, true);
    assert.ok(!JSON.stringify(abn).includes("abn-guid-value-1"));
    const abnCreds = await authorityCredentialsForOrg(db, org.orgId);
    assert.equal(abnCreds.abnGuid, "abn-guid-value-1");

    await saveAuthorityCredentials(db, org.orgId, actorId, "hmrc", {
      clientId: "hmrc-client-9",
      clientSecret: "hmrc-s3cr3t-9",
      scope: "read:vat",
    });
    const refreshed = await refreshHmrcToken(
      db,
      org.orgId,
      actorId,
      stubTransport({ access_token: "hmrc-tok-1", expires_in: 14_400 }),
    );
    assert.equal(refreshed.status, "ready");
    assert.ok(refreshed.tokenExpiresAt);
    assert.ok(!JSON.stringify(refreshed).includes("hmrc-s3cr3t-9"));
    const hmrcCreds = await authorityCredentialsForOrg(db, org.orgId);
    assert.equal(hmrcCreds.hmrcAccessToken, "hmrc-tok-1");
    const status = await readAuthorityConnectionStatus(db, org.orgId, "hmrc");
    assert.ok(!JSON.stringify(status).includes("hmrc-tok-1"));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
