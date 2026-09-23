import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { sealJson } from "../platform/secrets.ts";
import { createScratchOrg, seedFlowActors } from "../testing/fixtures.ts";
import { buildCemtexFile } from "../payments/rail-cemtex.ts";
import { PaymentError } from "../payments/payment-errors.ts";
import {
  PAYROLL_BANK_FILE_FORMATS,
  payrollBankProfiles,
  payrollOriginatorConfig,
  readTrailerTotals,
  renderPayRunBankFile,
  resolveCemtexCreditor,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";
import { PayrollError } from "./error.ts";

/**
 * Payroll Cemtex (ABA) disbursement — Australian direct credit.
 *
 * The name is `cemtex`, never `aba`: ABA already means the US 9-digit routing
 * number throughout the payments module, and a format keyed `aba` would read
 * as the US concept. The .aba file extension stays — that is what the banks'
 * upload screens ask for.
 *
 * Offsets verified position for position against three concordant published
 * transcriptions (see `buildCemtexFile`): Cemtex's own field tables
 * (cemtexaba.com, retrieved 2026-09-20); M. Cordover's annotated
 * sample-with-comments.aba v1.1 (2013-04-07, CC-BY 3.0 AU), which names the
 * formal APCA BECS Procedures Appendix C2; and the aba-generator 2.1.0
 * schemas. The formal APCA PDF itself is no longer reachable (APCA became
 * AusPayNet in 2017).
 *
 * Three things are under test and they differ in kind:
 *
 * 1. REUSE. Payroll must call the shared AP builder (`buildCemtexFile`), not
 *    carry a second Cemtex implementation. The parity test asserts payroll's
 *    emitted bytes EQUAL the shared builder's output for the same inputs.
 * 2. THE GOLDEN. The emitted bytes asserted character for character: three
 *    120-character records (descriptive 0, two details 1, file-total 7),
 *    CRLF-terminated, every field sliced at its published offset.
 * 3. REFUSAL. An employee row without a shaped BSB/account is a named
 *    refusal — never silently dropped, never coerced (a coerced BSB pays a
 *    stranger).
 *
 * All tests here are pure (no database) except the two rail-reachability
 * tests at the end: the render path takes every input explicitly, which is
 * what makes the stored artifact reproducible evidence.
 */

const CEMTEX_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "44444444-4444-4444-8444-444444444444",
  profileName: "Payroll direct deposit (Cemtex)",
  format: "cemtex",
  currency: "AUD",
  lineEnding: "crlf",
  cemtex: {
    bankAbbreviation: "CBA",
    userName: "ACME PTY LTD",
    userId: "301500",
    traceBsb: "067-102",
    traceAccount: "12341234",
    remitterName: "Acme Payroll",
  },
};

const cemtexInputs = (): PayRunBankFileInputs => ({
  format: "cemtex",
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
      employeeNumber: "EMP-0001", routing: { bsb: "062-692" },
      accountNumber: "43214321",
      bsb: "062-692",
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO SAVER", amount: "1821.5000",
      employeeNumber: "EMP-0002", routing: { bsb: "062001" },
      accountNumber: "123456",
      bsb: "062-001",
    },
  ],
});

const renderCemtex = (inputs = cemtexInputs(), originator = CEMTEX_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "cemtex",
    originator,
    // The release date: the run's pay date backs the DDMMYY processing date.
    fundsDate: "2026-08-21",
    createdAt: new Date("2026-08-14T09:30:00Z"),
    timeZone: "UTC",
  });

/* ------------------------------------------------------------------ */
/* Format registration                                                 */
/* ------------------------------------------------------------------ */

test("the Cemtex format is registered, enabled, and settled in AUD on the cemtex_credit rail", () => {
  const spec = PAYROLL_BANK_FILE_FORMATS.cemtex;
  assert.equal(spec.enabled, true);
  assert.equal(spec.currency, "AUD");
  assert.deepEqual(spec.rails, ["cemtex_credit"]);
  assert.equal(spec.extension, "aba");
  assert.equal(spec.contentType, "text/plain; charset=us-ascii");
  assert.equal(spec.disabledReason, undefined);
});

/* ------------------------------------------------------------------ */
/* Golden file — the emitted bytes, character for character             */
/* ------------------------------------------------------------------ */

/**
 * The golden document, written literally field by field against the published
 * record layouts (descriptive 0 / detail 1 / file-total 7, 120 characters
 * each, CRLF-terminated):
 *
 * Descriptive: "0" | trace BSB 067-102 (2–8) | trace account " 12341234"
 * (9–17) | blank (18) | "01" (19–20) | "CBA" (21–23) | 7 blanks (24–30) |
 * "ACME PTY LTD" (31–56) | "301500" (57–62) | "PAYROLL" (63–74) | "210826"
 * (75–80, the pay date) | 4 blanks (81–84) | 36 blanks (85–120).
 *
 * Detail: "1" | BSB (2–8) | account RJ/BF (9–17) | blank (18) | "53" (19–20)
 * | cents ZF (21–30) | title (31–62) | "PAY EMP-000n" (63–80) | trace BSB
 * (81–87) | trace account (88–96) | "Acme Payroll" (97–112) | zeros (113–120).
 *
 * Trailer: "7" | "999-999" (2–8) | 12 blanks | net 432150 (21–30) | credit
 * 432150 (31–40) | debit zeros (41–50) | 24 blanks | "000002" (75–80) |
 * 40 blanks.
 */
const CEMTEX_GOLDEN =
  "0067-102 12341234 01CBA       ACME PTY LTD              301500PAYROLL     210826                                        \r\n" +
  "1062-692 43214321 530000250000ADA WIDGET                      PAY EMP-0001      067-102 12341234Acme Payroll    00000000\r\n" +
  "1062-001   123456 530000182150BO SAVER                        PAY EMP-0002      067-102 12341234Acme Payroll    00000000\r\n" +
  "7999-999            000043215000004321500000000000                        000002                                        \r\n";

test("Cemtex golden file — byte for byte against the published record layouts", () => {
  const result = renderCemtex();
  assert.equal(result.content, CEMTEX_GOLDEN);
  assert.equal(result.contentType, "text/plain; charset=us-ascii");
  assert.equal(result.extension, "aba");
  assert.equal(result.currency, "AUD");
});

test("every golden record is exactly 120 characters with the terminator outside them", () => {
  const result = renderCemtex();
  assert.ok(result.content.endsWith("\r\n"));
  const records = result.content.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 4);
  for (const record of records) assert.equal(record.length, 120);
  assert.equal(records[0]![0], "0");
  assert.equal(records[1]![0], "1");
  assert.equal(records[2]![0], "1");
  assert.equal(records[3]![0], "7");
});

test("the golden trailer ties to the run at its published offsets", () => {
  const result = renderCemtex();
  const trailer = result.content.split("\r\n").find((line) => line[0] === "7")!;
  assert.equal(trailer.slice(1, 8), "999-999");
  assert.equal(BigInt(trailer.slice(30, 40)), 432150n);
  assert.equal(Number(trailer.slice(74, 80)), 2);
  assert.deepEqual(readTrailerTotals("cemtex", result.content), { totalCents: 432150n, count: 2 });
});

/* ------------------------------------------------------------------ */
/* The published worked example — every offset, field by field          */
/* ------------------------------------------------------------------ */

/**
 * Cordover's sample-with-comments.aba carries a 3-line worked example with a
 * character ruler. Payroll cannot reproduce it byte-exactly on purpose: the
 * sample is a generic credit (transaction code 50, description "ABA Test",
 * processing time "1530"), while payroll fixes code 53 (Pay), description
 * "PAYROLL" and a blank processing time. So this test feeds the sample's own
 * inputs through and asserts every field matches at its published offset
 * EXCEPT the three payroll-fixed ones — a lookalike with a shifted layout
 * cannot pass it.
 *
 * Note the sample's own prose/bytes mismatch, recorded here so nobody
 * "fixes" the test toward the comment: the comment credits "BSB 062-292"
 * but the detail record's bytes carry "062-692" at positions 2–8. Bytes win.
 */
test("the published worked example matches at every offset but the payroll-fixed fields", () => {
  const sample = {
    descriptive: "0067-102 12341234 01CBA       Smith John Allan          301500ABA Test    0704131530                                    ",
    detail: "1062-692 43214321 500000000001Smith Joan Emma                 ABA Test CR       067-102 12341234Mr John Smith   00000000",
    trailer: "7999-999            000000000100000000010000000000                        000001                                        ",
  };
  for (const line of Object.values(sample)) assert.equal(line.length, 120);

  const mine = buildCemtexFile({
    settings: {
      bankAbbreviation: "CBA",
      userName: "Smith John Allan",
      userId: "301500",
      traceBsb: "067-102",
      traceAccount: "12341234",
      remitterName: "Mr John Smith",
    },
    processingDate: "2013-04-07",
    payments: [{
      amountCents: 1n,
      bsb: "062-692",
      accountNumber: "43214321",
      accountTitle: "Smith Joan Emma",
      lodgementReference: "ABA Test CR",
    }],
  });
  const [descriptive, detail, trailer] = mine.split("\r\n").filter((line) => line.length > 0);

  // Descriptive: identical except description (63–74) and time (81–84).
  assert.equal(descriptive!.slice(0, 62), sample.descriptive.slice(0, 62));
  assert.equal(descriptive!.slice(62, 74), "PAYROLL     ");
  assert.equal(descriptive!.slice(74, 80), "070413");
  assert.equal(descriptive!.slice(80, 84), "    ");
  assert.equal(descriptive!.slice(84), sample.descriptive.slice(84));
  // Detail: identical except the transaction code (19–20): 53, not 50.
  assert.equal(detail!.slice(0, 18), sample.detail.slice(0, 18));
  assert.equal(detail!.slice(18, 20), "53");
  assert.equal(detail!.slice(20), sample.detail.slice(20));
  // Trailer: identical — one cent in, one cent of credit, count one.
  assert.equal(trailer, sample.trailer);
});

/* ------------------------------------------------------------------ */
/* Parity — payroll's bytes ARE the shared builder's bytes              */
/* ------------------------------------------------------------------ */

test("payroll's Cemtex output equals the shared AP builder's output for the same inputs", () => {
  const viaPayroll = renderCemtex().content;
  // The same mapping payroll applies, written out longhand. If payroll ever
  // forks its own 120-column writer, this diverges.
  const viaSharedBuilder = buildCemtexFile({
    settings: CEMTEX_ORIGINATOR.cemtex!,
    processingDate: "2026-08-21",
    payments: [
      {
        amountCents: 250000n,
        bsb: "062-692",
        accountNumber: "43214321",
        accountTitle: "ADA WIDGET",
        lodgementReference: "PAY EMP-0001",
      },
      {
        amountCents: 182150n,
        bsb: "062-001",
        accountNumber: "123456",
        accountTitle: "BO SAVER",
        lodgementReference: "PAY EMP-0002",
      },
    ],
  });
  assert.equal(viaPayroll, viaSharedBuilder);
});

/* ------------------------------------------------------------------ */
/* Refusal — unusable bank details refuse the whole file                */
/* ------------------------------------------------------------------ */

test("a missing BSB names the employee and the cheque fallback", () => {
  const resolved = resolveCemtexCreditor("ADA WIDGET", {}, "43214321");
  if (resolved.ok) assert.fail("a missing BSB must not resolve");
  assert.match(resolved.reason, /ADA WIDGET/);
  assert.match(resolved.reason, /BSB/);
  assert.match(resolved.reason, /cheque/);
});

test("a malformed BSB is refused rather than written into the BSB field", () => {
  for (const bad of ["12345", "1234567", "ABC-DEF", "06269", ""]) {
    const resolved = resolveCemtexCreditor("ADA WIDGET", { bsb: bad }, "43214321");
    if (resolved.ok) assert.fail(`BSB "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a six-digit BSB without a hyphen canonicalizes — the hyphen is formatting, not identity", () => {
  assert.deepEqual(resolveCemtexCreditor("BO SAVER", { bsb: "062001" }, "123456"), {
    ok: true, bsb: "062-001", accountNumber: "123456",
  });
});

test("an account number that cannot fit the 9-character field is refused, never truncated", () => {
  for (const bad of ["1234567890", "ABC123", "", "00000000"]) {
    const resolved = resolveCemtexCreditor("ADA WIDGET", { bsb: "062-692" }, bad);
    if (resolved.ok) assert.fail(`account "${bad}" must not resolve`);
    assert.match(resolved.reason, /ADA WIDGET/);
  }
});

test("a credit that reaches the renderer without a resolved BSB is refused, not emitted", () => {
  const inputs = cemtexInputs();
  delete (inputs.credits[0] as { bsb?: string }).bsb;
  assert.throws(
    () => renderCemtex(inputs),
    (error: Error) =>
      error instanceof PayrollError && /ADA WIDGET.*no validated BSB/.test(error.message),
  );
});

test("an unconfigured Cemtex originator is refused by name rather than emitting bytes the bank misreads", () => {
  assert.throws(
    () =>
      renderCemtex(cemtexInputs(), {
        ...CEMTEX_ORIGINATOR,
        cemtex: {
          bankAbbreviation: "XX",
          userName: "",
          userId: "not-digits",
          traceBsb: "bogus",
          traceAccount: "",
          remitterName: "",
        },
      }),
    (error: Error) => error instanceof PaymentError && /Cemtex originator settings are invalid/.test(error.message),
  );
});

test("a profile that originates another format cannot render Cemtex", () => {
  assert.throws(
    () =>
      renderCemtex(cemtexInputs(), {
        ...CEMTEX_ORIGINATOR,
        format: "nacha",
        nacha: undefined,
        cemtex: undefined,
      } as unknown as PayrollOriginatorConfig),
    (error: Error) => error instanceof PayrollError && /originates nacha, not cemtex/.test(error.message),
  );
});

test("a sub-cent Cemtex credit is refused rather than truncated into the trailer", () => {
  const inputs = cemtexInputs();
  inputs.credits[0]!.amount = "2500.0050";
  // The population total tracks the credit so the test reaches the sub-cent
  // gate rather than the entries-total gate (which fires first, by design).
  inputs.population.total = "4321.5050";
  assert.throws(
    () => renderCemtex(inputs),
    (error: Error) => error instanceof PayrollError && /whole number of cents/.test(error.message),
  );
});

test("a run past the 500-record file cap is refused, not silently over-long", () => {
  const credits = Array.from({ length: 501 }, (_, i) => ({
    stubId: `s${i}`, employeePartyId: `p${i}`, employeeName: `EMP ${i}`, amount: "100.0000",
    employeeNumber: `EMP-${i}`, routing: { bsb: "062-692" },
    accountNumber: "43214321",
    bsb: "062-692",
  }));
  const inputs: PayRunBankFileInputs = {
    format: "cemtex",
    population: { entries: [], total: "50100.0000", excludedCheque: [], excludedTotal: "0.0000" },
    credits,
  };
  assert.throws(
    () => renderCemtex(inputs),
    (error: Error) => error instanceof PaymentError && /at most 500/.test(error.message),
  );
});

/* ------------------------------------------------------------------ */
/* Rail reachability — the originator configuration the AU persona run  */
/* could not find (DB-gated; skipped in the unit partition)            */
/* ------------------------------------------------------------------ */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** A scratch org with a cemtex_credit bank profile carrying the given secrets. */
async function cemtexProfileOrg(secrets: Record<string, unknown>) {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const bankAccountId = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${bankAccountId}, ${org.orgId}, '1090', 'Payroll funding bank', 'asset_bank', false, true,
            false, false, '[]'::jsonb, '{}'::jsonb, true)`);
  // The built-in CEMTEX-CREDIT format is AU-scoped and settles AUD — the same
  // definition AP would originate supplier payments on.
  const formatId = randomUUID();
  await db.execute(sql`
    insert into payment_formats (id, org_id, code, name, rail, direction, country, currency,
                                 file_extension, content_type, settings, is_active, created_by, updated_by)
    values (${formatId}, ${org.orgId}, 'CEMTEX-CREDIT', 'Cemtex (ABA) credit transfer', 'cemtex_credit', 'credit',
            'AU', 'AUD', 'aba', 'text/plain; charset=us-ascii', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit (Cemtex)', ${bankAccountId}, ${formatId},
            'AUD', 'AU', ${sealJson(secrets)}, '{}'::jsonb, true, ${actorId}, ${actorId})`);
  return { orgId: org.orgId, profileId };
}

test("a cemtex_credit bank profile is listed for payroll and resolves its originator", { skip: !DB }, async () => {
  const fx = await cemtexProfileOrg({
    bankAbbreviation: "CBA",
    userName: "ACME PTY LTD",
    userId: "301500",
    traceBsb: "067-102",
    traceAccount: "12341234",
    remitterName: "Acme Payroll",
  });
  // Reachable: the operator's picker sees the profile, on the cemtex format,
  // fully configured — the "No originating bank profile is set up" dead end
  // from the AU persona run is gone for this rail.
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.deepEqual(
    profiles.map((p) => ({ name: p.name, format: p.format, currency: p.currency, configured: p.configured })),
    [{
      name: "Payroll direct deposit (Cemtex)",
      format: "cemtex",
      currency: "AUD",
      configured: true,
    }],
  );
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (!resolved.ok) assert.fail(`expected a configured Cemtex originator: ${resolved.missing.join(", ")}`);
  assert.equal(resolved.format, "cemtex");
  assert.equal(resolved.config.currency, "AUD");
  assert.deepEqual(resolved.config.cemtex, {
    bankAbbreviation: "CBA",
    userName: "ACME PTY LTD",
    userId: "301500",
    traceBsb: "067-102",
    traceAccount: "12341234",
    remitterName: "Acme Payroll",
  });
});

test("a cemtex profile with a malformed trace BSB is listed as not configured, naming it", { skip: !DB }, async () => {
  const fx = await cemtexProfileOrg({
    bankAbbreviation: "CBA",
    userName: "ACME PTY LTD",
    userId: "301500",
    traceBsb: "bogus",
    traceAccount: "12341234",
    remitterName: "Acme Payroll",
  });
  const profiles = await payrollBankProfiles(fx.orgId);
  assert.equal(profiles[0]?.configured, false);
  const resolved = await payrollOriginatorConfig(fx.orgId, fx.profileId);
  if (resolved.ok) assert.fail("a malformed trace BSB must not resolve");
  assert.match(resolved.missing.join(", "), /traceBsb/);
});
