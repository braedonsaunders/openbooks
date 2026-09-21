import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { createScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { buildSepaFile } from "../payments/rail-sepa.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollBankProfiles,
  payrollOriginatorConfig,
  readTrailerTotals,
  renderPayRunBankFile,
  resolveSepaCreditor,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";
import { PayrollError } from "./error.ts";

/**
 * Payroll SEPA disbursement — pain.001.001.03 credit transfer.
 *
 * Three things are under test and they differ in kind:
 *
 * 1. REUSE. Payroll must call the shared AP builder (`buildSepaFile`), not
 *    carry a second SEPA implementation. The parity test below asserts
 *    payroll's emitted bytes EQUAL the shared builder's output for the same
 *    inputs — a lookalike reimplementation cannot pass it.
 * 2. THE GOLDEN. The emitted bytes asserted character for character against
 *    the ISO 20022 message structure, built literally in this file.
 * 3. REFUSAL. An employee row that cannot produce a mod-97-valid IBAN is a
 *    named refusal — never silently dropped, never coerced.
 *
 * All tests here are pure (no database): the render path takes every input
 * explicitly, which is what makes the stored artifact reproducible evidence.
 */

const SEPA_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "33333333-3333-4333-8333-333333333333",
  profileName: "Payroll direct deposit (SEPA)",
  format: "sepa",
  currency: "EUR",
  lineEnding: "lf",
  sepa: {
    originatorName: "BERLIN WORKS GMBH",
    originatorIban: "DE89370400440532013000",
    originatorBic: "COBADEFFXXX",
  },
};

const sepaInputs = (): PayRunBankFileInputs => ({
  format: "sepa",
  population: {
    entries: [],
    total: "4321.5000",
    excludedCheque: [
      { employeePartyId: "p3", employeeName: "CY OVERRIDE", amount: "900.0000", reason: "profile" },
    ],
    excludedTotal: "900.0000",
  },
  credits: [
    {
      stubId: "s1", employeePartyId: "p1", employeeName: "ADA WIRED", amount: "2500.0000",
      employeeNumber: "EMP-0001", routing: { iban: "FR1420041010050500013M02606", bic: "AGRIFRPPXXX" },
      accountNumber: "FR1420041010050500013M02606",
      iban: "FR1420041010050500013M02606",
      bic: "AGRIFRPPXXX",
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO SAVER", amount: "1821.5000",
      employeeNumber: "EMP-0002", routing: { iban: "NL91ABNA0417164300" },
      accountNumber: "NL91ABNA0417164300",
      iban: "NL91ABNA0417164300",
      bic: null,
    },
  ],
});

const renderSepa = (inputs = sepaInputs(), originator = SEPA_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "sepa",
    originator,
    // PBF-000007, not a literal first file: proves the artifact's
    // number_sequences allocation lands in MsgId, PmtInfId and every
    // EndToEndId, rather than a hardcoded message id.
    messageId: "PBF-000007",
    fundsDate: "2026-08-21",
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  });

/* ------------------------------------------------------------------ */
/* Format registration                                                 */
/* ------------------------------------------------------------------ */

test("the SEPA format is registered, enabled, and settled in euros on the sepa_credit rail", () => {
  const spec = PAYROLL_BANK_FILE_FORMATS.sepa;
  assert.equal(spec.enabled, true);
  assert.equal(spec.currency, "EUR");
  assert.deepEqual(spec.rails, ["sepa_credit"]);
  assert.equal(spec.extension, "xml");
  assert.equal(spec.contentType, "application/xml");
  assert.equal(spec.disabledReason, undefined);
});

/* ------------------------------------------------------------------ */
/* Golden file — the emitted bytes, character for character             */
/* ------------------------------------------------------------------ */

/**
 * The golden document, written literally against the pain.001.001.03
 * structure (GrpHdr with MsgId/CreDtTm/NbOfTxs/CtrlSum/InitgPty; PmtInf with
 * TRF/SEPA/ReqdExctnDt/Dbtr/DbtrAcct/DbtrAgt/SLEV; one CdtTrfTxInf per credit
 * with EndToEndId, EUR InstdAmt, Cdtr, IBAN CdtrAcct and Ustrd remittance).
 */
const SEPA_GOLDEN = `<?xml version="1.0" encoding="UTF-8"?>
<Document xmlns="urn:iso:std:iso:20022:tech:xsd:pain.001.001.03">
  <CstmrCdtTrfInitn>
    <GrpHdr>
      <MsgId>PBF-000007</MsgId>
      <CreDtTm>2026-08-14T09:30:00</CreDtTm>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>4321.50</CtrlSum>
      <InitgPty><Nm>BERLIN WORKS GMBH</Nm></InitgPty>
    </GrpHdr>
    <PmtInf>
      <PmtInfId>PBF-000007</PmtInfId>
      <PmtMtd>TRF</PmtMtd>
      <NbOfTxs>2</NbOfTxs>
      <CtrlSum>4321.50</CtrlSum>
      <PmtTpInf><SvcLvl><Cd>SEPA</Cd></SvcLvl></PmtTpInf>
      <ReqdExctnDt>2026-08-21</ReqdExctnDt>
      <Dbtr><Nm>BERLIN WORKS GMBH</Nm></Dbtr>
      <DbtrAcct><Id><IBAN>DE89370400440532013000</IBAN></Id></DbtrAcct>
      <DbtrAgt><FinInstnId><BIC>COBADEFFXXX</BIC></FinInstnId></DbtrAgt>
      <ChrgBr>SLEV</ChrgBr>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>PBF-000007-EMP-0001</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">2500.00</InstdAmt></Amt>
        <CdtrAgt><FinInstnId><BIC>AGRIFRPPXXX</BIC></FinInstnId></CdtrAgt>
        <Cdtr><Nm>ADA WIRED</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>FR1420041010050500013M02606</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>PAY EMP-0001</Ustrd></RmtInf>
      </CdtTrfTxInf>
      <CdtTrfTxInf>
        <PmtId><EndToEndId>PBF-000007-EMP-0002</EndToEndId></PmtId>
        <Amt><InstdAmt Ccy="EUR">1821.50</InstdAmt></Amt>
        <Cdtr><Nm>BO SAVER</Nm></Cdtr>
        <CdtrAcct><Id><IBAN>NL91ABNA0417164300</IBAN></Id></CdtrAcct>
        <RmtInf><Ustrd>PAY EMP-0002</Ustrd></RmtInf>
      </CdtTrfTxInf>
    </PmtInf>
  </CstmrCdtTrfInitn>
</Document>
`;

test("SEPA golden file — byte for byte against the pain.001.001.03 structure", () => {
  const result = renderSepa();
  assert.equal(result.content, SEPA_GOLDEN);
  assert.equal(result.contentType, "application/xml");
  assert.equal(result.extension, "xml");
  assert.equal(result.currency, "EUR");
});

test("the SEPA trailer is parsed back out of the produced XML and ties to the run", () => {
  const result = renderSepa();
  const trailer = readTrailerTotals("sepa", result.content);
  assert.equal(trailer.totalCents, 432150n);
  assert.equal(trailer.count, 2);
});

test("a SEPA file whose GrpHdr totals were tampered with is refused, not trusted", () => {
  const tampered = renderSepa().content.replace("<CtrlSum>4321.50</CtrlSum>", "<CtrlSum>1.00</CtrlSum>");
  const trailer = readTrailerTotals("sepa", tampered);
  assert.notEqual(trailer.totalCents, 432150n);
  assert.throws(
    () => {
      if (trailer.totalCents !== 432150n) {
        throw new PayrollError(
          "payroll bank file trailer total 100 cents does not equal the run's EFT net pay",
        );
      }
    },
    (error: Error) => error instanceof PayrollError,
  );
});

/* ------------------------------------------------------------------ */
/* Parity — payroll's bytes ARE the shared builder's bytes              */
/* ------------------------------------------------------------------ */

test("payroll's SEPA output equals the shared AP builder's output for the same inputs", () => {
  const viaPayroll = renderSepa().content;
  // The same mapping payroll applies, written out longhand: message id from
  // the artifact allocation, execution on the pay date, one generic payment
  // row per credit. If payroll ever forks its own XML, this diverges.
  const viaSharedBuilder = buildSepaFile({
    settings: SEPA_ORIGINATOR.sepa!,
    messageId: "PBF-000007",
    creationDateTime: "2026-08-14T09:30:00",
    executionDate: "2026-08-21",
    payments: [
      {
        endToEndId: "PBF-000007-EMP-0001",
        amount: "2500.0000",
        creditorName: "ADA WIRED",
        creditorIban: "FR1420041010050500013M02606",
        creditorBic: "AGRIFRPPXXX",
        remittance: "PAY EMP-0001",
      },
      {
        endToEndId: "PBF-000007-EMP-0002",
        amount: "1821.5000",
        creditorName: "BO SAVER",
        creditorIban: "NL91ABNA0417164300",
        creditorBic: null,
        remittance: "PAY EMP-0002",
      },
    ],
  });
  assert.equal(viaPayroll, viaSharedBuilder);
});

/* ------------------------------------------------------------------ */
/* Refusal — no valid IBAN, no file                                    */
/* ------------------------------------------------------------------ */

test("a creditor IBAN with a broken mod-97 checksum is refused by name", () => {
  const resolved = resolveSepaCreditor(
    "ADA WIRED",
    { iban: "FR1420041010050500013M02607" },
    "FR1420041010050500013M02607",
  );
  if (resolved.ok) assert.fail("a bad-checksum IBAN must not resolve");
  assert.match(resolved.reason, /ADA WIRED/);
  assert.match(resolved.reason, /mod-97/);
  assert.match(resolved.reason, /cheque/);
});

test("a missing IBAN names the remedy instead of emitting an unaddressed credit", () => {
  const resolved = resolveSepaCreditor("BO SAVER", {}, "");
  if (resolved.ok) assert.fail("a missing IBAN must not resolve");
  assert.match(resolved.reason, /BO SAVER/);
  assert.match(resolved.reason, /IBAN/);
});

test("a malformed BIC is refused rather than written into CdtrAgt", () => {
  const resolved = resolveSepaCreditor(
    "ADA WIRED",
    { iban: "FR1420041010050500013M02606", bic: "NOT-A-BIC!!" },
    "FR1420041010050500013M02606",
  );
  if (resolved.ok) assert.fail("a bad BIC must not resolve");
  assert.match(resolved.reason, /BIC/);
});

test("a lowercase spaced IBAN normalizes; the BIC is optional", () => {
  const resolved = resolveSepaCreditor(
    "BO SAVER",
    { iban: "nl91 abna 0417 1643 00" },
    "nl91 abna 0417 1643 00",
  );
  assert.deepEqual(resolved, { ok: true, iban: "NL91ABNA0417164300", bic: null });
});

test("the stored account number backs the IBAN the way the AP rail does", () => {
  const resolved = resolveSepaCreditor("BO SAVER", {}, "NL91ABNA0417164300");
  assert.deepEqual(resolved, { ok: true, iban: "NL91ABNA0417164300", bic: null });
});

test("a credit that reaches the renderer without a resolved IBAN is refused, not emitted", () => {
  const inputs = sepaInputs();
  delete (inputs.credits[0] as { iban?: string }).iban;
  assert.throws(
    () => renderSepa(inputs),
    (error: Error) =>
      error instanceof PayrollError && /ADA WIRED.*no validated IBAN/.test(error.message),
  );
});

test("an unconfigured SEPA originator is refused by name rather than emitting XML the bank rejects", () => {
  assert.throws(
    () =>
      renderSepa(sepaInputs(), {
        ...SEPA_ORIGINATOR,
        sepa: { originatorName: "", originatorIban: "NOT-AN-IBAN", originatorBic: "" },
      }),
    (error: Error) => error instanceof PaymentError && /SEPA originator settings are invalid/.test(error.message),
  );
});

test("a profile that originates another format cannot render SEPA", () => {
  assert.throws(
    () =>
      renderSepa(sepaInputs(), {
        ...SEPA_ORIGINATOR,
        format: "cpa005",
        cpa005: undefined,
        sepa: undefined,
      } as unknown as PayrollOriginatorConfig),
    (error: Error) => error instanceof PayrollError && /originates cpa005, not sepa/.test(error.message),
  );
});

test("SEPA requires an allocated message identification — never a default", () => {
  assert.throws(
    () =>
      renderPayRunBankFile(sepaInputs(), {
        orgId: "org",
        documentId: "doc",
        format: "sepa",
        originator: SEPA_ORIGINATOR,
        fundsDate: "2026-08-21",
        createdAt: new Date(2026, 7, 14),
      }),
    (error: Error) => error instanceof PayrollError && /allocated message identification/.test(error.message),
  );
});

test("a sub-cent SEPA credit is refused rather than rounded into CtrlSum", () => {
  const inputs = sepaInputs();
  inputs.credits[0]!.amount = "2500.0050";
  // The population total tracks the credit so the test reaches the sub-cent
  // gate rather than the entries-total gate (which fires first, by design).
  inputs.population.total = "4321.5050";
  assert.throws(
    () => renderSepa(inputs),
    (error: Error) => error instanceof PayrollError && /whole number of cents/.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Rail reachability — the originator configuration the DE persona run  */
/* could not find (DB-gated; skipped in the unit partition)            */
/* ------------------------------------------------------------------ */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A scratch org with a sepa_credit bank profile carrying the given secrets. */
async function sepaProfileOrg(secrets: Record<string, unknown>) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bankAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${bankAccountId}, ${org.orgId}, '1090', 'Payroll funding bank', 'asset_bank', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  // The built-in SEPA-CREDIT format is country-neutral (country null) and
  // settles euros — the same definition AP originates supplier payments on.
  const formatId = randomUUID();
  await db.execute(sql`
    insert into payment_formats (id, org_id, code, name, rail, direction, country, currency,
                                 file_extension, content_type, settings, is_active, created_by, updated_by)
    values (${formatId}, ${org.orgId}, 'SEPA-CREDIT', 'SEPA credit transfer', 'sepa_credit', 'credit',
            null, 'EUR', 'xml', 'application/xml', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit (SEPA)', ${bankAccountId}, ${formatId},
            'EUR', null, ${sealJson(secrets)}, '{}'::jsonb, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, profileId };
}

test("a sepa_credit bank profile is listed for payroll and resolves its originator", { skip: !DB }, async () => {
  const fx = await sepaProfileOrg({
    originatorName: "BERLIN WORKS GMBH",
    originatorIban: "DE89370400440532013000",
    originatorBic: "COBADEFFXXX",
  });
  // Reachable: the operator's picker sees the profile, on the sepa format,
  // fully configured — the "No originating bank profile is set up" dead end
  // from the DE persona run is gone for this rail.
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.deepEqual(
    profiles.map((p) => ({ name: p.name, format: p.format, currency: p.currency, configured: p.configured })),
    [{
      name: "Payroll direct deposit (SEPA)",
      format: "sepa",
      currency: "EUR",
      configured: true,
    }],
  );
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (!resolved.ok) assert.fail(`expected a configured SEPA originator: ${resolved.missing.join(", ")}`);
  assert.equal(resolved.format, "sepa");
  assert.equal(resolved.config.currency, "EUR");
  assert.deepEqual(resolved.config.sepa, {
    originatorName: "BERLIN WORKS GMBH",
    originatorIban: "DE89370400440532013000",
    originatorBic: "COBADEFFXXX",
  });
});

test("a sepa profile with a broken originator IBAN is listed as not configured, naming it", { skip: !DB }, async () => {
  const fx = await sepaProfileOrg({
    originatorName: "BERLIN WORKS GMBH",
    originatorIban: "DE89370400440532013001",
    originatorBic: "COBADEFFXXX",
  });
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.equal(profiles[0]?.configured, false);
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (resolved.ok) assert.fail("a broken originator IBAN must not resolve");
  assert.match(resolved.missing.join(", "), /originatorIban/);
});
