import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  type PayRunBankFileFormat,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./bank-file.ts";

/**
 * Bank-file dates are civil days in the org's business time zone — never the
 * server's local day.
 *
 * Every date label written into a bank file (Bacs processing/creation/expiry,
 * NACHA effective/creation, CPA-005 funds/creation, Cemtex release, Zengin
 * transfer, CNAB payment/generation, SEPA execution/creation) derives from an
 * explicit civil day resolved in the org's zone. The same payroll run at the
 * same instant used to produce different creation-day bytes depending on the
 * server TZ (2026-09-23T01:00Z is 2026-09-22 under America/Toronto but
 * 2026-09-23 under UTC), because the rails read Date.getFullYear/getMonth/
 * getDate/getHours off the instant and the pay date was rebuilt as a
 * host-local midnight.
 *
 * These tests render the same run for the same instant in child processes
 * spawned under two maximally separated host zones (Pacific/Kiritimati at
 * UTC+14 and America/Toronto at UTC-4) and assert byte-identical output —
 * a single process cannot prove host independence, since its own zone is
 * fixed. A pre-fix builder fails the identical-bytes assertion on every
 * creation-carrying rail (and on every rail near a local-midnight pay date).
 */

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

// The audit instant: 2026-09-23T01:00Z is Sep 22nd in Toronto, Sep 23rd in
// UTC — the two zones under test disagree on the civil day by construction.
const INSTANT_A = "2026-09-23T01:00:00.000Z";
// Instants straddling org-zone midnight (Toronto, UTC-4 in September):
// 03:59Z is Sep 22nd 23:59 locally, 04:01Z is Sep 23rd 00:01 locally.
const INSTANT_BEFORE_MIDNIGHT = "2026-09-23T03:59:00.000Z";
const INSTANT_AFTER_MIDNIGHT = "2026-09-23T04:01:00.000Z";

const HOST_TZ_A = "Pacific/Kiritimati";
const HOST_TZ_B = "America/Toronto";

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
  format: PayRunBankFileFormat,
  routing: Record<string, string>,
  extra?: Partial<PayRunBankFileInputs["credits"][number]>,
): PayRunBankFileInputs => ({
  format,
  population: SINGLE.population,
  credits: SINGLE.credits.map((credit) => ({ ...credit, routing, ...extra })),
});

const originatorFor = (
  format: PayRunBankFileFormat,
  settings: Record<string, unknown>,
): PayrollOriginatorConfig =>
  ({
    paymentBankProfileId: "99999999-9999-4999-8999-999999999999",
    profileName: `Payroll direct deposit (${format})`,
    format,
    currency: "XXX",
    lineEnding: "crlf",
    ...settings,
  }) as PayrollOriginatorConfig;

interface RailCase {
  format: PayRunBankFileFormat;
  inputs: PayRunBankFileInputs;
  build: Record<string, unknown>;
  /** The creation-day label the org-zone civil day must render as. */
  torontoCreation: string[];
  utcCreation: string[];
  beforeMidnight: string[];
  afterMidnight: string[];
}

const CASES: RailCase[] = [
  {
    format: "bacs",
    inputs: withCreditRouting("bacs", { sortCode: "20-45-12" }, {
      sortCode: "20-45-12",
      accountNumber: "12345678",
    }),
    build: {
      bacsVolSerial: "000007", bacsFileNumber: "007",
      bacs: {
        serviceUserNumber: "123456",
        originatingSortCode: "60-16-13",
        originatingAccount: "12345678",
        serviceUserName: "ACME LTD",
      },
    },
    // HDR1 creation bYYDDD: Sep 22nd is julian day 265 of 2026, Sep 23rd 266.
    torontoCreation: [" 26265"],
    utcCreation: [" 26266"],
    beforeMidnight: [" 26265"],
    afterMidnight: [" 26266"],
  },
  {
    format: "nacha",
    inputs: withCreditRouting("nacha", { aba: "011401533" }),
    build: {
      fileIdModifier: "A",
      nacha: {
        odfiRouting: "021000021",
        immediateDestination: "021000021",
        immediateOrigin: "1234567890",
        destinationName: "JPMORGAN CHASE",
        originName: "SUMMIT RIDGE BUILDERS",
        companyName: "SUMMIT RIDGE",
        companyId: "1123456789",
      },
    },
    // File-header creation YYMMDDHHMM + modifier.
    torontoCreation: ["2609222100A"],
    utcCreation: ["2609230100A"],
    beforeMidnight: ["2609222359A"],
    afterMidnight: ["2609230001A"],
  },
  {
    format: "cpa005",
    inputs: withCreditRouting("cpa005", { institution: "004", transit: "12345" }),
    build: {
      fileCreationNumber: 7,
      cpa005: {
        originatorId: "0123456789",
        originatorShortName: "SUMMIT RIDGE",
        originatorLongName: "SUMMIT RIDGE BUILDERS LTD",
        dataCentre: "00510",
        originatingDataCentre: "00610",
        institution: "003",
        transit: "00212",
        account: "1234567",
      },
    },
    // A-record creation 0YYDDD.
    torontoCreation: ["026265"],
    utcCreation: ["026266"],
    beforeMidnight: ["026265"],
    afterMidnight: ["026266"],
  },
  {
    format: "sepa",
    inputs: withCreditRouting("sepa", {}, {
      iban: "FR1420041010050500013M02606",
      bic: "AGRIFRPPXXX",
    }),
    build: {
      messageId: "PBF-000007",
      sepa: {
        originatorName: "BERLIN WORKS GMBH",
        originatorIban: "DE89370400440532013000",
        originatorBic: "COBADEFFXXX",
      },
    },
    torontoCreation: ["<CreDtTm>2026-09-22T21:00:00</CreDtTm>"],
    utcCreation: ["<CreDtTm>2026-09-23T01:00:00</CreDtTm>"],
    beforeMidnight: ["<CreDtTm>2026-09-22T23:59:00</CreDtTm>"],
    afterMidnight: ["<CreDtTm>2026-09-23T00:01:00</CreDtTm>"],
  },
  {
    format: "cemtex",
    inputs: withCreditRouting("cemtex", { bsb: "062-692" }, {
      bsb: "062-692",
      accountNumber: "43214321",
    }),
    build: {
      cemtex: {
        bankAbbreviation: "CBA",
        userName: "ACME PTY LTD",
        userId: "301500",
        traceBsb: "067-102",
        traceAccount: "12341234",
        remitterName: "Acme Payroll",
      },
    },
    // Cemtex carries no creation stamp: the release date is the pay date
    // (2026-09-23 → DDMMYY "230926") on every host by construction.
    torontoCreation: ["230926"],
    utcCreation: ["230926"],
    beforeMidnight: ["230926"],
    afterMidnight: ["230926"],
  },
  {
    format: "zengin",
    inputs: withCreditRouting("zengin", { bankCode: "0005", branchCode: "110", depositType: "1" }, {
      bankCode: "0005",
      branchCode: "110",
      depositType: "1",
      payeeKana: "ｴｲﾃﾞｨｰ",
      accountNumber: "8000001",
    }),
    build: {
      zengin: {
        clientCode: "2012345678",
        clientName: "ｶ)ﾔﾏﾀﾞｼｮｳｼﾞ",
        bankCode: "0005",
        branchCode: "110",
        depositType: "1",
        accountNumber: "1234567",
        bankName: "",
        branchName: "",
      },
    },
    // Zengin carries no creation stamp: the transfer date is the pay date
    // (2026-09-23 → MMDD "0923") on every host by construction.
    torontoCreation: ["0923"],
    utcCreation: ["0923"],
    beforeMidnight: ["0923"],
    afterMidnight: ["0923"],
  },
  {
    format: "cnab240",
    inputs: withCreditRouting(
      "cnab240",
      { banco: "001", agencia: "4321", agenciaDv: "2", contaDv: "3", cpfCnpj: "11144477735" },
      {
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
      },
    ),
    build: {
      cnabNsa: "000007",
      cnab240bb: {
        cnpjEmpresa: "12345678000195",
        convenio: "123456789",
        agencia: "1234",
        agenciaDv: "0",
        conta: "123456",
        contaDv: "1",
        nomeEmpresa: "EMPRESA EXEMPLO LTDA",
        versaoLayoutArquivo: "084",
      },
    },
    // Header data de geração DDMMYYYY + hora HHMMSS.
    torontoCreation: ["22092026", "210000"],
    utcCreation: ["23092026", "010000"],
    beforeMidnight: ["22092026", "235900"],
    afterMidnight: ["23092026", "000100"],
  },
];

/** Render one case in a child process under the given host TZ; return raw bytes. */
function renderUnderHostTz(
  rail: RailCase,
  hostTz: string,
  orgZone: string,
  createdAtIso: string,
): string {
  const childScript = `
    const { renderPayRunBankFile } = await import("file://${REPO_ROOT}/engine/src/payroll/bank-file.ts");
    const payload = JSON.parse(process.env.OB_CASE);
    const result = renderPayRunBankFile(payload.inputs, {
      orgId: "org",
      documentId: "doc",
      format: payload.format,
      originator: payload.originator,
      ...payload.buildArgs,
      fundsDate: "2026-09-23",
      createdAt: new Date(payload.createdAtIso),
      timeZone: payload.orgZone,
    });
    process.stdout.write(Buffer.from(result.content, "utf8").toString("base64"));
  `;
  // The rail's originator settings ride under their settings key; the
  // bank-allocated numbers (file creation number, modifier, serials) ride
  // alongside as build args — split them back out for the build input.
  const settingsKeys = new Set(["cpa005", "nacha", "sepa", "cemtex", "bacs", "zengin", "cnab240bb"]);
  const settings = Object.fromEntries(Object.entries(rail.build).filter(([key]) => settingsKeys.has(key)));
  const buildArgs = Object.fromEntries(Object.entries(rail.build).filter(([key]) => !settingsKeys.has(key)));
  const payload = JSON.stringify({
    format: rail.format,
    inputs: rail.inputs,
    originator: originatorFor(rail.format, settings),
    buildArgs,
    createdAtIso,
    orgZone,
  });
  return execFileSync(
    process.execPath,
    ["--import", "tsx", "--input-type=module", "-e", childScript],
    {
      cwd: REPO_ROOT,
      env: { ...process.env, TZ: hostTz, OB_CASE: payload },
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
    },
  ).trim();
}

const decode = (base64: string): string => Buffer.from(base64, "base64").toString("utf8");

for (const rail of CASES) {
  test(`${rail.format}: the same run at the same instant renders byte-identical files under hostile host zones`, () => {
    // UTC+14 versus UTC-4: a host-local renderer dates INSTANT_A (01:00Z)
    // Sep 23rd on the first box and Sep 22nd on the second.
    const fromKiritimati = renderUnderHostTz(rail, HOST_TZ_A, "America/Toronto", INSTANT_A);
    const fromTorontoHost = renderUnderHostTz(rail, HOST_TZ_B, "America/Toronto", INSTANT_A);
    assert.equal(
      fromTorontoHost,
      fromKiritimati,
      `${rail.format} renders different bytes on different host zones`,
    );
    // And the shared bytes carry the ORG zone's civil day (Sep 22nd), not
    // either host's local day.
    const content = decode(fromKiritimati);
    for (const label of rail.torontoCreation) {
      assert.ok(
        content.includes(label),
        `${rail.format} creation label is not the org-zone civil day: missing ${JSON.stringify(label)}`,
      );
    }
  });

  test(`${rail.format}: the creation day is the UTC civil day for a UTC org`, () => {
    // Same instant, UTC org: Sep 23rd — rendered under the hostile host zone
    // so a host-local reader would print Sep 23rd 15:00, not 01:00.
    const content = decode(renderUnderHostTz(rail, HOST_TZ_A, "UTC", INSTANT_A));
    for (const label of rail.utcCreation) {
      assert.ok(
        content.includes(label),
        `${rail.format} creation label is not the UTC civil day: missing ${JSON.stringify(label)}`,
      );
    }
  });

  test(`${rail.format}: instants straddling org-zone midnight land on their own civil days`, () => {
    // 03:59Z is Sep 22nd 23:59 in Toronto; 04:01Z is Sep 23rd 00:01. A
    // host-local renderer under Kiritimati dates BOTH Sep 23rd.
    const before = decode(renderUnderHostTz(rail, HOST_TZ_A, "America/Toronto", INSTANT_BEFORE_MIDNIGHT));
    const after = decode(renderUnderHostTz(rail, HOST_TZ_A, "America/Toronto", INSTANT_AFTER_MIDNIGHT));
    for (const label of rail.beforeMidnight) {
      assert.ok(
        before.includes(label),
        `${rail.format} pre-midnight instant missed its civil day: missing ${JSON.stringify(label)}`,
      );
    }
    for (const label of rail.afterMidnight) {
      assert.ok(
        after.includes(label),
        `${rail.format} post-midnight instant missed its civil day: missing ${JSON.stringify(label)}`,
      );
    }
  });
}
