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

const BACS_SETTINGS = {
  serviceUserNumber: "123456",
  originatingSortCode: "60-16-13",
  originatingAccount: "12345678",
  serviceUserName: "ACME LTD",
};

const ZENGIN_SETTINGS = {
  clientCode: "2012345678",
  clientName: "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ",
  bankCode: "0005",
  branchCode: "110",
  depositType: "1",
  accountNumber: "1234567",
  bankName: "",
  branchName: "",
};

const CNAB240_SETTINGS = {
  cnpjEmpresa: "12345678000195",
  convenio: "123456789",
  agencia: "1234",
  agenciaDv: "0",
  conta: "123456",
  contaDv: "1",
  nomeEmpresa: "EMPRESA EXEMPLO LTDA",
  versaoLayoutArquivo: "084",
};

const originatorFor = (
  format: PayRunBankFileFormat,
  settings: {
    cpa005?: unknown;
    nacha?: unknown;
    sepa?: unknown;
    cemtex?: unknown;
    bacs?: unknown;
    zengin?: unknown;
    cnab240bb?: unknown;
  },
): PayrollOriginatorConfig =>
  ({
    paymentBankProfileId: "99999999-9999-4999-8999-999999999999",
    profileName: `Payroll direct deposit (${format})`,
    format,
    currency: PAYROLL_BANK_FILE_FORMATS[format].currency,
    lineEnding: "crlf",
    ...settings,
  }) as PayrollOriginatorConfig;

const CREATED_AT = new Date("2026-08-14T09:30:00Z");

/* ------------------------------------------------------------------ */
/* Each declared format renders through its OWN builder                */
/* ------------------------------------------------------------------ */

test("cpa005 renders 1464-character CPA records through the CPA builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "cpa005", { institution: "004", transit: "12345" }),
    {
      orgId: "org", documentId: "doc", format: "cpa005",
      originator: originatorFor("cpa005", { cpa005: CPA005_SETTINGS }),
      fileCreationNumber: 7, fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
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
    withCreditRouting(SINGLE, "nacha", { aba: "011401533", accountType: "checking" }),
    {
      orgId: "org", documentId: "doc", format: "nacha",
      originator: originatorFor("nacha", { nacha: NACHA_SETTINGS }),
      fileIdModifier: "A", fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
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
      messageId: "PBF-000007", fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
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
      fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]![0], "0");
  for (const record of records) assert.equal(record.length, 120);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "aba");
  assert.equal(result.currency, "AUD");
});

test("bacs renders Standard 18 records through the Bacs builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "bacs", { sortCode: "20-45-12" }, {
      sortCode: "20-45-12",
      accountNumber: "12345678",
    }),
    {
      orgId: "org", documentId: "doc", format: "bacs",
      originator: originatorFor("bacs", { bacs: BACS_SETTINGS }),
      bacsVolSerial: "000007", bacsFileNumber: "007",
      fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]!.slice(0, 4), "VOL1");
  assert.equal(records[records.length - 1]!.slice(0, 4), "UTL1");
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "txt");
  assert.equal(result.currency, "GBP");
});

test("zengin renders 120-character 給与振込 records through the Zengin builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "zengin", { bankCode: "0005", branchCode: "110", depositType: "1" }, {
      bankCode: "0005",
      branchCode: "110",
      depositType: "1",
      payeeKana: "ｴｲﾃﾞｨｰ",
      accountNumber: "8000001",
    }),
    {
      orgId: "org", documentId: "doc", format: "zengin",
      originator: originatorFor("zengin", { zengin: ZENGIN_SETTINGS }),
      fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]![0], "1");
  for (const record of records) assert.equal(record.length, 120);
  // JPY has no minor unit: 2500.0000 ledger units is 2500 yen, not 250000 cents.
  assert.deepEqual(result.trailer, { totalCents: 2500n, count: 1 });
  assert.equal(result.extension, "txt");
  assert.equal(result.currency, "JPY");
  assert.ok(result.contentBytes, "Zengin must hand the bank Shift_JIS bytes, not UTF-8");
});

test("cnab240 renders 240-character records through the CNAB 240 BB builder", () => {
  const result = renderPayRunBankFile(
    withCreditRouting(SINGLE, "cnab240", { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" }, {
      accountNumber: "987654",
      cnab240: {
        bancoFavorecido: "001",
        agencia: "04321",
        agenciaDv: "2",
        contaDv: "3",
        dac: null,
        inscricaoTipo: "1",
        inscricaoNumero: "11144477735",
      },
    }),
    {
      orgId: "org", documentId: "doc", format: "cnab240",
      originator: originatorFor("cnab240", { cnab240bb: CNAB240_SETTINGS }),
      cnabNsa: "000007", fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
    },
  );
  const records = result.content.split(/\r?\n/).filter((line) => line.length > 0);
  assert.equal(records[0]!.slice(0, 3), "001");
  for (const record of records) assert.equal(record.length, 240);
  assert.deepEqual(result.trailer, { totalCents: 250_000n, count: 1 });
  assert.equal(result.extension, "rem");
  assert.equal(result.currency, "BRL");
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
    {
      format: "bacs",
      inputs: withCreditRouting(SINGLE, "bacs", {}, { sortCode: "20-45-12" }),
      originator: originatorFor("bacs", { nacha: NACHA_SETTINGS }),
      message: /Bacs originator configuration is missing/,
    },
    {
      format: "zengin",
      inputs: withCreditRouting(SINGLE, "zengin", {}, {
        bankCode: "0005", branchCode: "110", depositType: "1", payeeKana: "ｴｲﾃﾞｨｰ",
      }),
      originator: originatorFor("zengin", { nacha: NACHA_SETTINGS }),
      message: /Zengin originator configuration is missing/,
    },
    {
      format: "cnab240",
      inputs: withCreditRouting(SINGLE, "cnab240", {}, {
        cnab240: {
          bancoFavorecido: "001", agencia: "04321", agenciaDv: "2", contaDv: "3",
          dac: null, inscricaoTipo: "1", inscricaoNumero: "11144477735",
        },
      }),
      originator: originatorFor("cnab240", { nacha: NACHA_SETTINGS }),
      message: /CNAB 240 originator configuration is missing/,
    },
  ];
  assert.equal(
    cases.length,
    Object.keys(PAYROLL_BANK_FILE_FORMATS).length,
    "every declared format must have a cross-wired originator case — an unwired format is the fall-through this test exists to catch",
  );
  for (const { format, inputs, originator, message } of cases) {
    assert.throws(
      () =>
        renderPayRunBankFile(inputs, {
          orgId: "org", documentId: "doc", format, originator,
          fileCreationNumber: 7, fileIdModifier: "A", messageId: "PBF-000007",
          fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
        }),
      message,
      `${format} did not reach its own builder`,
    );
  }
});

/* ------------------------------------------------------------------ */
/* The record-length table declares every format, including null       */
/* ------------------------------------------------------------------ */

test("the record-length table declares every format — sepa's and bacs's nulls are stated, not inherited", () => {
  // SEPA is XML (length-delimited by markup). Bacs mixes 80-character labels
  // with 100-character data, so there is no single width to assert here —
  // the builder asserts each record's own width. Elixir-0 will declare null
  // for the delimited reason once its builder exists; a format with no
  // entry fails tsc at the Record literal.
  assert.deepEqual(PAYROLL_BANK_FILE_RECORD_LENGTHS, {
    cpa005: 1464,
    nacha: 94,
    sepa: null,
    cemtex: 120,
    bacs: null,
    zengin: 120,
    cnab240: 240,
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
        fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
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
    withCreditRouting(SINGLE, "nacha", { aba: "011401533", accountType: "checking" }),
    {
      orgId: "org", documentId: "doc", format: "nacha",
      originator: originatorFor("nacha", { nacha: NACHA_SETTINGS }),
      fileIdModifier: "A", fundsDate: "2026-08-21", createdAt: CREATED_AT, timeZone: "UTC",
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
