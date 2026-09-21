import assert from "node:assert/strict";
import test from "node:test";
import {
  NACHA_PAYROLL_ENTRY_CLASS,
  NACHA_PAYROLL_ENTRY_DESCRIPTION,
  PAYROLL_BANK_FILE_FORMATS,
  PAYROLL_BANK_FILE_RECORD_LENGTHS,
  readTrailerTotals,
  renderPayRunBankFile,
  type PayRunBankFileFormat,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";

/**
 * The format dispatcher.
 *
 * renderPayRunBankFile used to end its builder ternary on
 * `buildNachaPayroll`, its record-length ternary on `null`, its trailer
 * reader on the NACHA file-control parse, its originator resolver on
 * `resolveNacha`, and its credit addressing on the NACHA `else` — so every
 * format without an arm silently took the American rail (and a Brazilian run
 * reported an American configuration problem). The dispatch is now a set of
 * total lookups (Record<PayRunBankFileFormat, ...>) plus exhaustive switches
 * with never-bindings, so declaring a format without wiring it fails tsc.
 *
 * These tests pin the runtime half of that: every declared format renders
 * through its OWN builder (bytes or a builder-identifying property, never
 * merely "no exception"), and anything the dispatcher does not know is
 * refused BY ITS OWN NAME — even when the bytes fed in are another rail's
 * well-formed file. The compile-time half (a throwaway union member fails
 * tsc at every dispatch site) is demonstrated on the branch, not here: a
 * committed test cannot assert its own compilation failure.
 */

const SINGLE: PayRunBankFileInputs = {
  format: "cpa005",
  population: { entries: [], total: "2500.0000", excludedCheque: [], excludedTotal: "0.0000" },
  credits: [
    {
      stubId: "s1", employeePartyId: "p1", employeeName: "ADA WIRED", amount: "2500.0000",
      employeeNumber: "EMP-0001", routing: {}, accountNumber: "000123456789",
    },
  ],
};

const withCreditRouting = (
  inputs: PayRunBankFileInputs,
  format: PayRunBankFileFormat,
  routing: Record<string, string>,
  extra?: Partial<PayRunBankFileInputs["credits"][number]>,
): PayRunBankFileInputs => ({
  format,
  population: inputs.population,
  credits: inputs.credits.map((credit) => ({ ...credit, routing, ...extra })),
});

const CPA005_SETTINGS = {
  originatorId: "0123456789",
  originatorShortName: "SUMMIT RIDGE",
  originatorLongName: "SUMMIT RIDGE BUILDERS LTD",
  dataCentre: "00510",
  originatingDataCentre: "00610",
  institution: "003",
  transit: "00212",
  account: "1234567",
  transactionCode: "200",
};

const NACHA_SETTINGS = {
  odfiRouting: "021000021",
  immediateDestination: "021000021",
  immediateOrigin: "1234567890",
  destinationName: "JPMORGAN CHASE",
  originName: "SUMMIT RIDGE BUILDERS",
  companyName: "SUMMIT RIDGE",
  companyId: "1123456789",
  entryClassCode: NACHA_PAYROLL_ENTRY_CLASS,
  entryDescription: NACHA_PAYROLL_ENTRY_DESCRIPTION,
};

const SEPA_SETTINGS = {
  originatorName: "BERLIN WORKS GMBH",
  originatorIban: "DE89370400440532013000",
  originatorBic: "COBADEFFXXX",
};

const CEMTEX_SETTINGS = {
  bankAbbreviation: "CBA",
  userName: "ACME PTY LTD",
  userId: "301500",
  traceBsb: "067-102",
  traceAccount: "12341234",
  remitterName: "Acme Payroll",
};

const originatorFor = (
  format: PayRunBankFileFormat,
  settings: { cpa005?: unknown; nacha?: unknown; sepa?: unknown; cemtex?: unknown },
): PayrollOriginatorConfig =>
  ({
    paymentBankProfileId: "99999999-9999-4999-8999-999999999999",
    profileName: `Payroll direct deposit (${format})`,
    format,
    currency: PAYROLL_BANK_FILE_FORMATS[format].currency,
    lineEnding: "crlf",
    ...settings,
  }) as PayrollOriginatorConfig;

const CREATED_AT = new Date(2026, 7, 14, 9, 30, 0);

/* ------------------------------------------------------------------ */
/* Each declared format renders through its OWN builder                */
/* ------------------------------------------------------------------ */

test("cpa005 renders 1464-character CPA records through the CPA builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "cpa005", { institution: "004", transit: "12345" }),
    {
      orgId: "org", documentId: "doc", format: "cpa005",
      originator: originatorFor("cpa005", { cpa005: CPA005_SETTINGS }),
      fileCreationNumber: 7, fundsDate: "2026-08-21", createdAt: CREATED_AT,
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]![0], "A");
  for (const record of records) assert.equal(record.length, 1464);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "txt");
  assert.equal(result.currency, "CAD");
});

test("nacha renders 94-character ACH records through the NACHA builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "nacha", { aba: "011401533" }),
    {
      orgId: "org", documentId: "doc", format: "nacha",
      originator: originatorFor("nacha", { nacha: NACHA_SETTINGS }),
      fileIdModifier: "A", fundsDate: "2026-08-21", createdAt: CREATED_AT,
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]![0], "1");
  for (const record of records) assert.equal(record.length, 94);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "ach");
  assert.equal(result.currency, "USD");
});

test("sepa renders pain.001 XML through the SEPA builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "sepa", { iban: "FR1420041010050500013M02606" }, {
      iban: "FR1420041010050500013M02606",
      bic: "AGRIFRPPXXX",
    }),
    {
      orgId: "org", documentId: "doc", format: "sepa",
      originator: originatorFor("sepa", { sepa: SEPA_SETTINGS }),
      messageId: "PBF-000007", fundsDate: "2026-08-21", createdAt: CREATED_AT,
    },
  );
  assert.match(result.content, /pain\.001/);
  assert.match(result.content, /PBF-000007/);
  assert.match(result.content, /<CtrlSum>2500\.00<\/CtrlSum>/);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "xml");
  assert.equal(result.currency, "EUR");
});

test("cemtex renders 120-character records through the Cemtex builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "cemtex", { bsb: "062-692" }, { bsb: "062-692", accountNumber: "43214321" }),
    {
      orgId: "org", documentId: "doc", format: "cemtex",
      originator: originatorFor("cemtex", { cemtex: CEMTEX_SETTINGS }),
      fundsDate: "2026-08-21", createdAt: CREATED_AT,
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]![0], "0");
  for (const record of records) assert.equal(record.length, 120);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "aba");
  assert.equal(result.currency, "AUD");
});

/* ------------------------------------------------------------------ */
/* Each arm reaches its own builder: cross-wired originators name      */
/* the REQUESTED rail, never the rail the old default would have run   */
/* ------------------------------------------------------------------ */

test("each format's arm runs its own builder, proved by cross-wired originators", () => {
  // Every originator below carries a VALID other rail's settings and none of
  // the requested rail's — so whichever builder the arm reaches refuses with
  // the requested rail's own missing-configuration message. Before the fix,
  // an unwired format fell through to buildNachaPayroll and every one of
  // these read "NACHA originator configuration is missing".
  const cases: {
    format: PayRunBankFileFormat;
    inputs: PayRunBankFileInputs;
    originator: PayrollOriginatorConfig;
    message: RegExp;
  }[] = [
    {
      format: "cpa005",
      inputs: withCreditRouting(SINGLE, "cpa005", { institution: "004", transit: "12345" }),
      originator: originatorFor("cpa005", { nacha: NACHA_SETTINGS }),
      message: /CPA-005 originator configuration is missing/,
    },
    {
      format: "nacha",
      inputs: withCreditRouting(SINGLE, "nacha", { aba: "011401533" }),
      originator: originatorFor("nacha", { cpa005: CPA005_SETTINGS }),
      message: /NACHA originator configuration is missing/,
    },
    {
      format: "sepa",
      inputs: withCreditRouting(SINGLE, "sepa", {}, {
        iban: "FR1420041010050500013M02606",
        bic: null,
      }),
      originator: originatorFor("sepa", { nacha: NACHA_SETTINGS }),
      message: /SEPA originator configuration is missing/,
    },
    {
      format: "cemtex",
      inputs: withCreditRouting(SINGLE, "cemtex", {}, { bsb: "062-692" }),
      originator: originatorFor("cemtex", { nacha: NACHA_SETTINGS }),
      message: /Cemtex originator configuration is missing/,
    },
  ];
  for (const { format, inputs, originator, message } of cases) {
    assert.throws(
      () =>
        renderPayRunBankFile(inputs, {
          orgId: "org", documentId: "doc", format, originator,
          fileCreationNumber: 7, fileIdModifier: "A", messageId: "PBF-000007",
          fundsDate: "2026-08-21", createdAt: CREATED_AT,
        }),
      message,
      `${format} did not reach its own builder`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The record-length table declares every format, including null       */
/* ------------------------------------------------------------------ */

test("the record-length table declares every format — sepa's null is stated, not inherited", () => {
  // Elixir-0 will declare null here for the same stated reason (delimited,
  // not fixed-width) once its builder exists; a format with no entry fails
  // tsc at the Record literal.
  assert.deepEqual(PAYROLL_BANK_FILE_RECORD_LENGTHS, {
    cpa005: 1464,
    nacha: 94,
    sepa: null,
    cemtex: 120,
  });
});

/* ------------------------------------------------------------------ */
/* Unknown formats are refused BY NAME — never as another rail         */
/* ------------------------------------------------------------------ */

test("render refuses an unknown format by its own name, never as NACHA", () => {
  const format = "zz-unknown" as PayRunBankFileFormat;
  const originator = {
    paymentBankProfileId: "p", profileName: "mystery profile", format,
    currency: "ZZZ", lineEnding: "lf",
  } as unknown as PayrollOriginatorConfig;
  assert.throws(
    () =>
      renderPayRunBankFile({ ...SINGLE, format }, {
        orgId: "org", documentId: "doc", format, originator,
        fundsDate: "2026-08-21", createdAt: CREATED_AT,
      }),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /unknown payroll bank-file format "zz-unknown"/);
      assert.doesNotMatch(message, /NACHA/);
      return true;
    },
  );
});

test("the trailer reader refuses an unknown format by name, even fed well-formed NACHA bytes", () => {
  const nacha = renderPayRunBankFile(
    withCreditRouting(SINGLE, "nacha", { aba: "011401533" }),
    {
      orgId: "org", documentId: "doc", format: "nacha",
      originator: originatorFor("nacha", { nacha: NACHA_SETTINGS }),
      fileIdModifier: "A", fundsDate: "2026-08-21", createdAt: CREATED_AT,
    },
  );
  // Sanity: those bytes really are a readable NACHA file-control trailer.
  assert.deepEqual(readTrailerTotals("nacha", nacha.content), {
    totalCents: 250_000n,
    count: 1,
  });
  // Before the fix the foreign format fell into the NACHA tail and returned
  // these same totals; now it is refused by its own name.
  assert.throws(
    () => readTrailerTotals("zz-unknown" as PayRunBankFileFormat, nacha.content),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /unknown payroll bank-file format "zz-unknown"/);
      assert.doesNotMatch(message, /NACHA/);
      return true;
    },
  );
});
