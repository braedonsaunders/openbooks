import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { createScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { buildBacsFile } from "../payments/rail-formatters.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import {
  isValidSortCode,
  normalizeGbAccountNumber,
  normalizeSortCode,
  validateBacsSettings,
} from "../payments/rail-settings.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollBankProfiles,
  payrollOriginatorConfig,
  readTrailerTotals,
  renderPayRunBankFile,
  resolveBacsCreditor,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";
import { PayrollError } from "./error.ts";

/**
 * Payroll Bacs disbursement — Standard 18 Direct Credit.
 *
 * The name is `bacs`, the rail `bacs_credit`, the currency GBP; GB bank
 * details are a 6-digit sort code plus an 8-digit account number, never an
 * IBAN. The writer is the shared AP builder (`buildBacsFile`,
 * engine/src/payments/rail-formatters.ts), whose evidence log names every
 * source with publisher, edition and date: Bacs' own Translation Guide v1.1
 * (2017), The Access Group's position-level transcription (retrieved
 * 2026-09-20), PayBatch's open-source implementation with asserted field
 * slices, and the standard18-bacs validator's skeleton. The money bytes (the
 * 100-char code-99 credit record) are triple-sourced with a worked example;
 * the label/contra/trailer envelope offsets are single-transcription and fail
 * loud at bank validation — see the builder.
 *
 * Three things are under test and they differ in kind:
 *
 * 1. REUSE. Payroll must call the shared AP builder (`buildBacsFile`), not
 *    carry a second Standard 18 implementation. The parity test asserts
 *    payroll's emitted bytes EQUAL the shared builder's output for the same
 *    inputs, and the worked-example test asserts the builder's bytes against
 *    an INDEPENDENT implementation's asserted field slices.
 * 2. THE GOLDEN. The emitted bytes asserted character for character: 80-char
 *    VOL1/HDR1/HDR2/UHL1 labels, two 100-char code-99 credits, the code-17
 *    debit contra, EOF1/EOF2, the 80-char UTL1 trailer — CRLF-terminated,
 *    every field sliced at its published offset.
 * 3. REFUSAL. An employee row without a shaped sort code/account is a named
 *    refusal with the cheque remedy — never silently dropped, never coerced
 *    (a coerced sort code pays a stranger); the whole file refuses rather
 *    than paying some and dropping another.
 *
 * All tests here are pure (no database) except the rail-reachability test at
 * the end: the render path takes every input explicitly, which is what makes
 * the stored artifact reproducible evidence.
 */

const BACS_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "55555555-5555-4555-8555-555555555555",
  profileName: "Payroll direct deposit (Bacs)",
  format: "bacs",
  currency: "GBP",
  lineEnding: "crlf",
  bacs: {
    serviceUserNumber: "123456",
    originatingSortCode: "60-16-13",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  },
};

const bacsInputs = (): PayRunBankFileInputs => ({
  format: "bacs",
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
      stubId: "s1", employeePartyId: "p1", employeeName: "ADA WIDGET", amount: "2500.0000",
      employeeNumber: "EMP-0001", routing: { sortCode: "20-45-12" },
      accountNumber: "12345678",
      sortCode: "20-45-12",
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO SAVER", amount: "1821.5000",
      employeeNumber: "EMP-0002", routing: { sortCode: "601613" },
      accountNumber: "87654321",
      sortCode: "60-16-13",
    },
  ],
});

const renderBacs = (inputs = bacsInputs(), originator = BACS_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "bacs",
    originator,
    bacsVolSerial: "000007",
    bacsFileNumber: "007",
    // The processing date: the run's pay date backs the UHL1 bYYDDD date.
    fundsDate: "2026-08-21",
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  });

/* ------------------------------------------------------------------ */
/* Format registration                                                 */
/* ------------------------------------------------------------------ */

test("the Bacs format is registered, enabled, and settled in GBP on the bacs_credit rail", () => {
  const spec = PAYROLL_BANK_FILE_FORMATS.bacs;
  assert.equal(spec.enabled, true);
  assert.equal(spec.currency, "GBP");
  assert.deepEqual(spec.rails, ["bacs_credit"]);
  assert.equal(spec.extension, "txt");
  assert.equal(spec.contentType, "text/plain; charset=us-ascii");
  assert.equal(spec.disabledReason, undefined);
});

/* ------------------------------------------------------------------ */
/* Golden file — the emitted bytes, character for character             */
/* ------------------------------------------------------------------ */

/**
 * The golden document, written literally field by field against the published
 * record layouts (labels 80 chars, data 100 chars, CRLF-terminated):
 *
 * VOL1: "VOL1" | serial "000007" (5–10) | blank (11) | 20 blanks (12–31) |
 * 6 blanks (32–37) | owner 38–51 (38–41 blank, 42–47 SUN "123456", 48–51
 * blank) | 28 blanks (52–79) | "1" (80).
 *
 * HDR1: "HDR1" | "A" (5) | SUN (6–11) | "S" (12) | 2 spaces (13–14) | space
 * (15) | SUN (16–21) | serial (22–27) | "0001" | "0001" | generation spaces |
 * version spaces | creation " 26226" (42–47, 2026-08-14) | expiry " 26240"
 * (48–53, processing + 7 days) | blank | "000000" block count | 13 spaces |
 * 7 spaces.
 *
 * HDR2: "HDR2" | "F" | "02000" | "00100" (single processing day) | 35 spaces
 * | "00" | 28 spaces.
 *
 * UHL1: "UHL1" | processing " 26233" (5–10, the pay date 2026-08-21) |
 * "999999" (11–16) | 4 spaces | "00" (21–22) | zeros (23–28) | "1 DAILY  "
 * (29–37) | "007" (38–40) | 7 spaces | 7 audit spaces | 26 spaces.
 *
 * Detail: sort (1–6) | account (7–14) | "0" (15) | "99" (16–17) | orig sort
 * (18–23) | orig account (24–31) | 4 spaces (32–35) | pence ZF (36–46) |
 * "ACME LTD" (47–64) | "PAY EMP-000n" (65–82) | employee name (83–100).
 *
 * Contra: orig sort/account twice | "0" | "17" | orig sort/account | 4 spaces
 * | file total (36–46) | "ACME LTD" (47–64) | "CONTRA" + 12 spaces (65–82) |
 * "ACME LTD" (83–100).
 *
 * EOF1/EOF2 repeat HDR1/HDR2 positions 5–80. UTL1: "UTL1" | debit total
 * "0000000432150" (5–17) | credit total "0000000432150" (18–30) | "0000001"
 * (31–37, the one contra) | "0000002" (38–44) | 10 spaces | 26 spaces.
 */
const BACS_GOLDEN =
  "VOL1000007                               123456                                1\r\n" +
  "HDR1A123456S   12345600000700010001       26226 26240 000000                    \r\n" +
  "HDR2F0200000100                                   00                            \r\n" +
  "UHL1 26233999999    000000001 DAILY  007                                        \r\n" +
  "2045121234567809960161312345678    00000250000ACME LTD          PAY EMP-0001      ADA WIDGET        \r\n" +
  "6016138765432109960161312345678    00000182150ACME LTD          PAY EMP-0002      BO SAVER          \r\n" +
  "6016131234567801760161312345678    00000432150ACME LTD          CONTRA            ACME LTD          \r\n" +
  "EOF1A123456S   12345600000700010001       26226 26240 000000                    \r\n" +
  "EOF2F0200000100                                   00                            \r\n" +
  "UTL10000000432150000000043215000000010000002                                    \r\n";

test("Bacs golden file — byte for byte against the published record layouts", () => {
  const result = renderBacs();
  assert.equal(result.content, BACS_GOLDEN);
  assert.equal(result.contentType, "text/plain; charset=us-ascii");
  assert.equal(result.extension, "txt");
  assert.equal(result.currency, "GBP");
});

test("every golden record carries its label and exact width, terminators outside", () => {
  const result = renderBacs();
  assert.ok(result.content.endsWith("\r\n"));
  const records = result.content.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 10);
  const widths: Record<string, number> = {
    VOL1: 80, HDR1: 80, HDR2: 80, UHL1: 80, EOF1: 80, EOF2: 80, UTL1: 80,
  };
  for (const record of records) {
    const label = record.slice(0, 4);
    if (label in widths) assert.equal(record.length, widths[label]);
    else assert.equal(record.length, 100);
  }
  assert.equal(records[0]!.slice(0, 4), "VOL1");
  assert.equal(records[4]![15], "9");
  assert.equal(records[4]!.slice(15, 17), "99");
  assert.equal(records[6]!.slice(15, 17), "17");
  assert.equal(records[9]!.slice(0, 4), "UTL1");
});

test("the golden trailer ties to the run at its published offsets", () => {
  const result = renderBacs();
  const trailer = result.content.split("\r\n").find((line) => line.slice(0, 4) === "UTL1")!;
  assert.equal(trailer.slice(4, 17), "0000000432150");
  assert.equal(trailer.slice(17, 30), "0000000432150");
  assert.equal(trailer.slice(30, 37), "0000001");
  assert.equal(trailer.slice(37, 44), "0000002");
  assert.deepEqual(readTrailerTotals("bacs", result.content), { totalCents: 432150n, count: 2 });
});

test("the golden UHL1 processing date is the run's pay date in bYYDDD", () => {
  const result = renderBacs();
  const uhl1 = result.content.split("\r\n").find((line) => line.slice(0, 4) === "UHL1")!;
  // 2026-08-21 is Julian day 233 of 2026: " 26233".
  assert.equal(uhl1.slice(4, 10), " 26233");
});

/* ------------------------------------------------------------------ */
/* The independent worked example — every data offset, field by field   */
/* ------------------------------------------------------------------ */

/**
 * PayBatch's test suite (victorsaly/batch-payment-app, test/run.js) asserts
 * its own Standard 18 record slice by slice for these inputs: dest
 * 12-34-56/12345678, origin 090122/11223344, 150.50, ref INV-1001, name
 * "Beneficiary Ltd". This test feeds the same inputs through the shared
 * builder and asserts the same slices — a lookalike with a shifted layout
 * cannot pass it, and agreement here is agreement between two independent
 * transcriptions, not with ourselves.
 */
test("the independent worked example matches at every data offset", () => {
  const mine = buildBacsFile({
    settings: {
      serviceUserNumber: "654321",
      originatingSortCode: "090122",
      originatingAccount: "11223344",
      serviceUserName: "ORIGINATOR",
    },
    processingDate: new Date("2026-08-21T00:00:00"),
    creationDate: new Date(2026, 7, 14, 9, 30, 0),
    volSerial: "000001",
    fileNumber: "001",
    payments: [{
      amountCents: 15050n,
      sortCode: "12-34-56",
      accountNumber: "12345678",
      accountName: "Beneficiary Ltd",
      reference: "INV-1001",
    }],
  });
  const detail = mine.split("\r\n").find((line) => line.length === 100)!;
  assert.equal(detail.slice(0, 6), "123456");
  assert.equal(detail.slice(6, 14), "12345678");
  assert.equal(detail.slice(14, 15), "0");
  assert.equal(detail.slice(15, 17), "99");
  assert.equal(detail.slice(17, 23), "090122");
  assert.equal(detail.slice(23, 31), "11223344");
  assert.equal(detail.slice(35, 46), "00000015050");
  assert.equal(detail.slice(64, 82), "INV-1001".padEnd(18, " "));
  assert.equal(detail.slice(82, 100), "BENEFICIARY LTD".padEnd(18, " "));
});

/* ------------------------------------------------------------------ */
/* Parity — payroll's bytes ARE the shared builder's bytes              */
/* ------------------------------------------------------------------ */

test("payroll's Bacs output equals the shared AP builder's output for the same inputs", () => {
  const viaPayroll = renderBacs().content;
  // The same mapping payroll applies, written out longhand. If payroll ever
  // forks its own Standard 18 writer, this diverges.
  const viaSharedBuilder = buildBacsFile({
    settings: BACS_ORIGINATOR.bacs!,
    processingDate: new Date("2026-08-21T00:00:00"),
    creationDate: new Date(2026, 7, 14, 9, 30, 0),
    volSerial: "000007",
    fileNumber: "007",
    payments: [
      {
        amountCents: 250000n,
        sortCode: "20-45-12",
        accountNumber: "12345678",
        accountName: "ADA WIDGET",
        reference: "PAY EMP-0001",
      },
      {
        amountCents: 182150n,
        sortCode: "60-16-13",
        accountNumber: "87654321",
        accountName: "BO SAVER",
        reference: "PAY EMP-0002",
      },
    ],
  });
  assert.equal(viaPayroll, viaSharedBuilder);
});

/* ------------------------------------------------------------------ */
/* Refusal — unusable bank details refuse the whole file                */
/* ------------------------------------------------------------------ */

test("a missing sort code names the employee and the cheque fallback", () => {
  const resolved = resolveBacsCreditor("ADA WIDGET", {}, "12345678");
  if (resolved.ok) assert.fail("a missing sort code must not resolve");
  assert.match(resolved.reason, /ADA WIDGET/);
  assert.match(resolved.reason, /sort code/);
  assert.match(resolved.reason, /cheque/);
});

test("a malformed sort code is refused rather than written into the sort-code field", () => {
  for (const bad of ["12345", "1234567", "ABCDEF", "20-45-1", ""]) {
    const resolved = resolveBacsCreditor("ADA WIDGET", { sortCode: bad }, "12345678");
    if (resolved.ok) assert.fail(`sort code "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a six-digit sort code without hyphens canonicalizes — the hyphens are formatting, not identity", () => {
  assert.deepEqual(resolveBacsCreditor("BO SAVER", { sortCode: "601613" }, "87654321"), {
    ok: true, sortCode: "60-16-13", accountNumber: "87654321",
  });
});

test("an account number that is not exactly eight digits is refused, never truncated or padded", () => {
  for (const bad of ["1234567", "123456789", "ABCDEFGH", "", "00000000"]) {
    const resolved = resolveBacsCreditor("ADA WIDGET", { sortCode: "20-45-12" }, bad);
    if (resolved.ok) assert.fail(`account "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a credit that reaches the renderer without a resolved sort code is refused, not emitted", () => {
  const inputs = bacsInputs();
  delete (inputs.credits[0] as { sortCode?: string }).sortCode;
  assert.throws(
    () => renderBacs(inputs),
    (error: Error) =>
      error instanceof PayrollError && /ADA WIDGET.*no validated sort code/.test(error.message),
  );
});

test("an unconfigured Bacs originator is refused by name rather than emitting bytes the bank misreads", () => {
  assert.throws(
    () =>
      renderBacs(bacsInputs(), {
        ...BACS_ORIGINATOR,
        bacs: {
          serviceUserNumber: "12",
          originatingSortCode: "bogus",
          originatingAccount: "",
          serviceUserName: "",
        },
      }),
    (error: Error) => error instanceof PaymentError && /Bacs originator settings are invalid/.test(error.message),
  );
});

test("a Bacs profile cannot render another format — the mismatch names bacs", () => {
  assert.throws(
    () =>
      renderPayRunBankFile(
        {
          format: "sepa",
          population: { entries: [], total: "0.0000", excludedCheque: [], excludedTotal: "0.0000" },
          credits: [],
        },
        {
          orgId: "org",
          documentId: "doc",
          format: "sepa",
          originator: BACS_ORIGINATOR,
          messageId: "PBF-000007",
          fundsDate: "2026-08-21",
          createdAt: new Date(2026, 7, 14, 9, 30, 0),
        },
      ),
    (error: Error) => error instanceof PayrollError && /originates bacs, not sepa/.test(error.message),
  );
});

test("Bacs requires its allocated serial and file number — never re-derived", () => {
  const base = {
    orgId: "org",
    documentId: "doc",
    format: "bacs" as const,
    originator: BACS_ORIGINATOR,
    fundsDate: "2026-08-21",
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  };
  assert.throws(
    () => renderPayRunBankFile(bacsInputs(), { ...base, bacsFileNumber: "007" }),
    (error: Error) => error instanceof PayrollError && /VOL1 serial/.test(error.message),
  );
  assert.throws(
    () => renderPayRunBankFile(bacsInputs(), { ...base, bacsVolSerial: "000007" }),
    (error: Error) => error instanceof PayrollError && /file number/.test(error.message),
  );
});

test("a sub-cent Bacs credit is refused rather than truncated into the trailer", () => {
  const inputs = bacsInputs();
  inputs.credits[0]!.amount = "2500.0050";
  // The population total tracks the credit so the test reaches the sub-cent
  // gate rather than the entries-total gate (which fires first, by design).
  inputs.population.total = "4321.5050";
  assert.throws(
    () => renderBacs(inputs),
    (error: Error) => error instanceof PayrollError && /whole number of cents/.test(error.message),
  );
});

test("a file total past the 11-digit pence field is refused, not silently unbalanced", () => {
  const inputs = bacsInputs();
  inputs.credits[0]!.amount = "9999999999.9900";
  inputs.population.total = "10000001821.4900";
  assert.throws(
    () => renderBacs(inputs),
    (error: Error) => error instanceof PaymentError && /does not fit in 11 digits/.test(error.message),
  );
});

test("a Bacs file with no readable UTL1 trailer is refused, not tied to a NACHA record", () => {
  assert.throws(
    () => readTrailerTotals("bacs", "VOL1000007" + " ".repeat(72) + "\r\n"),
    (error: Error) => error instanceof PayrollError && /no readable UTL1/.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Validators — the real pure functions, never doubles                  */
/* ------------------------------------------------------------------ */

test("normalizeSortCode canonicalizes six digits and refuses everything else", () => {
  assert.equal(normalizeSortCode("204512"), "20-45-12");
  assert.equal(normalizeSortCode("20-45-12"), "20-45-12");
  assert.equal(normalizeSortCode("20 45 12"), "20-45-12");
  assert.equal(normalizeSortCode("12345"), null);
  assert.equal(normalizeSortCode("1234567"), null);
  assert.equal(normalizeSortCode("ABCDEF"), null);
  assert.equal(normalizeSortCode(""), null);
  assert.equal(isValidSortCode("20-45-12"), true);
  assert.equal(isValidSortCode("20451"), false);
});

test("normalizeGbAccountNumber resolves exactly eight digits and refuses the rest", () => {
  assert.equal(normalizeGbAccountNumber("12345678"), "12345678");
  assert.equal(normalizeGbAccountNumber("1234 5678"), "12345678");
  assert.equal(normalizeGbAccountNumber("1234567"), null);
  assert.equal(normalizeGbAccountNumber("123456789"), null);
  assert.equal(normalizeGbAccountNumber("ABCDEFGH"), null);
  assert.equal(normalizeGbAccountNumber(""), null);
  assert.equal(normalizeGbAccountNumber("00000000"), null);
});

test("validateBacsSettings accepts a complete originator and names every gap", () => {
  const good = validateBacsSettings({
    serviceUserNumber: "123456",
    originatingSortCode: "601613",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  });
  if (!good.ok) assert.fail(`expected a valid Bacs originator: ${good.missing.join(", ")}`);
  assert.deepEqual(good.settings, {
    serviceUserNumber: "123456",
    originatingSortCode: "60-16-13",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  });
  const bad = validateBacsSettings({
    serviceUserNumber: "12",
    originatingSortCode: "bogus",
    originatingAccount: "",
    serviceUserName: "",
  });
  if (bad.ok) assert.fail("a malformed Bacs originator must not validate");
  assert.match(bad.missing.join(", "), /serviceUserNumber/);
  assert.match(bad.missing.join(", "), /originatingSortCode/);
});

/* ------------------------------------------------------------------ */
/* Rail reachability — the originator configuration the GB persona run  */
/* could not find (DB-gated; skipped in the unit partition)            */
/* ------------------------------------------------------------------ */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A scratch org with a bacs_credit bank profile carrying the given secrets. */
async function bacsProfileOrg(secrets: Record<string, unknown>) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bankAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${bankAccountId}, ${org.orgId}, '1090', 'Payroll funding bank', 'asset_bank', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  // The built-in BACS-CREDIT format is GB-scoped and settles GBP — the same
  // definition AP would originate supplier payments on.
  const formatId = randomUUID();
  await db.execute(sql`
    insert into payment_formats (id, org_id, code, name, rail, direction, country, currency,
                                 file_extension, content_type, settings, is_active, created_by, updated_by)
    values (${formatId}, ${org.orgId}, 'BACS-CREDIT', 'Bacs Standard 18 credit transfer', 'bacs_credit', 'credit',
            'GB', 'GBP', 'txt', 'text/plain; charset=us-ascii', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit (Bacs)', ${bankAccountId}, ${formatId},
            'GBP', 'GB', ${sealJson(secrets)}, '{}'::jsonb, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, profileId };
}

test("a bacs_credit bank profile is listed for payroll and resolves its originator", { skip: !DB }, async () => {
  const fx = await bacsProfileOrg({
    serviceUserNumber: "123456",
    originatingSortCode: "60-16-13",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  });
  // Reachable: the operator's picker sees the profile, on the bacs format,
  // fully configured — the "No originating bank profile is set up" dead end
  // from the GB persona run is gone for this rail.
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.deepEqual(
    profiles.map((p) => ({ name: p.name, format: p.format, currency: p.currency, configured: p.configured })),
    [{
      name: "Payroll direct deposit (Bacs)",
      format: "bacs",
      currency: "GBP",
      configured: true,
    }],
  );
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (!resolved.ok) assert.fail(`expected a configured Bacs originator: ${resolved.missing.join(", ")}`);
  assert.equal(resolved.format, "bacs");
  assert.equal(resolved.config.currency, "GBP");
  assert.deepEqual(resolved.config.bacs, {
    serviceUserNumber: "123456",
    originatingSortCode: "60-16-13",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  });
});

test("a bacs profile with a malformed SUN is listed as not configured, naming it", { skip: !DB }, async () => {
  const fx = await bacsProfileOrg({
    serviceUserNumber: "bogus",
    originatingSortCode: "60-16-13",
    originatingAccount: "12345678",
    serviceUserName: "ACME LTD",
  });
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.equal(profiles[0]?.configured, false);
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (resolved.ok) assert.fail("a malformed SUN must not resolve");
  assert.match(resolved.missing.join(", "), /serviceUserNumber/);
});
