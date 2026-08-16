import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, cmp, toUnits } from "./money.ts";
import { buildCpa005File, encryptAccountNumber } from "./payments.ts";
import {
  NACHA_PAYROLL_ENTRY_CLASS,
  NACHA_PAYROLL_ENTRY_DESCRIPTION,
  PAYROLL_BANK_FILE_EXPORT_ENABLED,
  PAYROLL_BANK_FILE_FORMATS,
  payRunBankFilePopulation,
  readTrailerTotals,
  renderPayRunBankFile,
  type PayRunBankFileInputs,
  type PayrollOriginatorConfig,
} from "./payroll-bank-file.ts";
import {
  generatePayRunBankFile,
  listPayRunBankFiles,
  payRunBankFileAudit,
  payRunBankFileEntitlement,
  releasePayRunBankFile,
} from "./payroll-bank-file-artifact.ts";
import {
  calculatePayRun, commitPayRun, createPayRun, seedPayrollComponents,
} from "./payroll-run.ts";
import { sealJson } from "./secrets.ts";
import { createScratchOrg, seedFlowActors } from "./test-fixtures.ts";

/**
 * Payroll direct deposit.
 *
 * Two things are under test and they differ in kind. The FORMAT tests are pure
 * and byte-exact: a fixed-width money file is either character for character
 * right or it is a rejected file, so the golden below is the whole assertion.
 * The LIFECYCLE tests are about the controls around those bytes — that an
 * unentitled run cannot have them, that a cheque employee never appears in
 * them, that the trailer ties to the ledger, that regenerating produces a
 * second visible artifact rather than editing the first, and that every
 * release is attributable.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/* ------------------------------------------------------------------ */
/* Format enablement                                                   */
/* ------------------------------------------------------------------ */

test("the export is live, and each format states its own enablement", () => {
  assert.equal(PAYROLL_BANK_FILE_EXPORT_ENABLED, true);
  assert.equal(PAYROLL_BANK_FILE_FORMATS.nacha.enabled, true);
  // CPA-005 is deliberately off; see the module header and the canary below.
  assert.equal(PAYROLL_BANK_FILE_FORMATS.cpa005.enabled, false);
  assert.match(PAYROLL_BANK_FILE_FORMATS.cpa005.disabledReason ?? "", /Item Trace Number/);
});

/**
 * ANTI-FALSE-GREEN CANARY.
 *
 * CPA-005 is off for exactly one reason: Payments Canada Standard 005 mandates
 * the internal structure of the Item Trace Number (segment positions 41–62 —
 * destination data centre, originating direct clearer's data centre, file
 * creation number, item sequence, the last three non-zero) and
 * `buildCpa005File` writes twenty-two zeros there, which the standard makes
 * cause for rejecting the item.
 *
 * This test pins that fact together with every offset that IS correct. The day
 * somebody composes the field properly this test fails and forces them to also
 * turn the format on; the day somebody turns the format on without fixing the
 * writer, this test still spells out exactly what was shipped.
 */
test("CPA-005 canary: the item trace number is still zero-filled, so the format stays off", () => {
  const content = buildCpa005File({
    settings: {
      originatorId: "0123456789",
      originatorShortName: "SUMMIT RIDGE",
      originatorLongName: "SUMMIT RIDGE BUILDERS LTD",
      dataCentre: "00510",
      institution: "003",
      transit: "00212",
      account: "1234567",
      transactionCode: "200", // Payments Canada Standard 007: 200 = Payroll Deposit
    },
    fileCreationNumber: 1,
    fileCreationDate: new Date(2026, 7, 14),
    payments: [
      {
        amountCents: 250_000n,
        fundsDate: new Date(2026, 7, 21),
        institution: "004",
        transit: "12345",
        accountNumber: "000123456789",
        payeeName: "ADA WIRED",
        crossReference: "PAY EMP-0001",
      },
    ],
  });
  const records = content.split("\r\n").filter((line) => line.length > 0);
  assert.equal(records.length, 3, "A + one C + Z");
  for (const record of records) assert.equal(record.length, 1464);

  // A record — every offset confirmed against Standard 005 Section D.
  assert.equal(records[0]![0], "A");
  assert.equal(records[0]!.slice(1, 10), "000000001", "record sequence starts at literal one");
  assert.equal(records[0]!.slice(10, 20), "0123456789", "originator id, positions 11-20");
  assert.equal(records[0]!.slice(20, 24), "0001", "file creation number, positions 21-24");
  // 0yyddd: 2026-08-14 is day 226 of a non-leap year.
  assert.equal(records[0]!.slice(24, 30), "026226", "creation date, positions 25-30");
  assert.equal(records[0]!.slice(30, 35), "00510", "destination data centre, positions 31-35");
  assert.equal(records[0]!.slice(35, 55), " ".repeat(20), "reserved communication area");
  assert.equal(records[0]!.slice(55, 58), "CAD", "currency, positions 56-58");

  // C record — one 240-character credit segment at positions 25-264.
  assert.equal(records[1]![0], "C");
  assert.equal(records[1]!.slice(1, 10), "000000002", "sequence increments by one");
  const segment = records[1]!.slice(24, 264);
  assert.equal(segment.length, 240);
  assert.equal(segment.slice(0, 3), "200", "transaction type = payroll deposit");
  assert.equal(segment.slice(3, 13), "0000250000", "amount, unsigned implied cents");
  assert.equal(segment.slice(13, 19), "026233", "date funds available (2026-08-21 = day 233)");
  assert.equal(segment.slice(19, 28), "000412345", "payee institutional id = 0 + institution + transit");
  assert.equal(segment.slice(28, 40), "000123456789", "payee account number");
  assert.equal(segment.slice(65, 80), "SUMMIT RIDGE   ", "originator short name");
  assert.equal(segment.slice(80, 110), "ADA WIRED".padEnd(30), "payee name");
  assert.equal(segment.slice(229, 240), "0".repeat(11), "invalid data element id must be zeros");

  // THE DEFECT that keeps the format disabled.
  assert.equal(
    segment.slice(40, 62),
    "0".repeat(22),
    "item trace number is zero-filled — CPA-005 stays disabled until it is composed",
  );

  // Z record.
  assert.equal(records[2]![0], "Z");
  assert.equal(records[2]!.slice(24, 38), "0".repeat(14), "no debit value");
  assert.equal(records[2]!.slice(38, 46), "0".repeat(8), "no debit count");
  assert.equal(records[2]!.slice(46, 60), "00000000250000", "credit value, positions 47-60");
  assert.equal(records[2]!.slice(60, 68), "00000001", "credit count, positions 61-68");
});

/* ------------------------------------------------------------------ */
/* NACHA — the golden file                                             */
/* ------------------------------------------------------------------ */

const NACHA_ORIGINATOR: PayrollOriginatorConfig = {
  paymentBankProfileId: "11111111-1111-4111-8111-111111111111",
  profileName: "Payroll direct deposit",
  format: "nacha",
  currency: "USD",
  lineEnding: "lf",
  nacha: {
    odfiRouting: "021000021",
    immediateDestination: "021000021",
    immediateOrigin: "1234567890",
    destinationName: "JPMORGAN CHASE",
    originName: "SUMMIT RIDGE BUILDERS",
    companyName: "SUMMIT RIDGE",
    companyId: "1123456789",
    entryClassCode: NACHA_PAYROLL_ENTRY_CLASS,
    entryDescription: NACHA_PAYROLL_ENTRY_DESCRIPTION,
  },
};

const nachaInputs = (): PayRunBankFileInputs => ({
  format: "nacha",
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
      employeeNumber: "EMP-0001", routing: { aba: "011401533" }, accountNumber: "000123456789",
    },
    {
      stubId: "s2", employeePartyId: "p2", employeeName: "BO SAVER", amount: "1821.5000",
      employeeNumber: "EMP-0002", routing: { aba: "121000248", accountType: "savings" },
      accountNumber: "987654321",
    },
  ],
});

const renderNacha = (inputs = nachaInputs(), originator = NACHA_ORIGINATOR) =>
  renderPayRunBankFile(inputs, {
    orgId: "org",
    documentId: "doc",
    format: "nacha",
    originator,
    fileIdModifier: "A",
    fundsDate: "2026-08-21",
    // Local-time construction keeps the golden independent of the test box's
    // timezone: the writer reads local Y/M/D and H:M.
    createdAt: new Date(2026, 7, 14, 9, 30, 0),
  });

/**
 * The golden file, character for character.
 *
 * Verified field by field against Nacha's *ACH Guide for Developers*
 * (achdevguide.nacha.org/ach-file-details) and corroborated against Hancock
 * Whitney's ACH input file structure guide. Every record is exactly 94
 * characters; the file is blocked to ten with all-nine filler records.
 */
const NACHA_GOLDEN = [
  "101 02100002112345678902608140930A094101JPMORGAN CHASE         SUMMIT RIDGE BUILDERS          ",
  "5220SUMMIT RIDGE                        1123456789PPDPAYROLL         260821   1021000020000001",
  "622011401533000123456789     0000250000EMP-0001       ADA WIRED               0021000020000001",
  "632121000248987654321        0000182150EMP-0002       BO SAVER                0021000020000002",
  "822000000200132401770000000000000000004321501123456789                         021000020000001",
  "9000001000001000000020013240177000000000000000000432150                                       ",
  "9".repeat(94),
  "9".repeat(94),
  "9".repeat(94),
  "9".repeat(94),
].join("\n") + "\n";

test("NACHA golden file — byte for byte", () => {
  const result = renderNacha();
  assert.equal(result.content, NACHA_GOLDEN);
  assert.equal(result.contentType, "text/plain; charset=us-ascii");
  assert.equal(result.extension, "ach");
  assert.equal(result.currency, "USD");
  // us-ascii: byte length must equal character length, or every fixed-width
  // field after a multi-byte character has shifted.
  assert.equal(Buffer.from(result.content, "utf8").length, result.content.length);
});

test("NACHA record layout — every field at its published offset", () => {
  const records = renderNacha().content.split("\n").filter((line) => line.length > 0);
  assert.equal(records.length, 10, "blocked to a multiple of ten");
  for (const record of records) assert.equal(record.length, 94);

  const [header, batch, first, second, batchControl, fileControl] = records as string[];

  // File header (1).
  assert.equal(header.slice(0, 1), "1");
  assert.equal(header.slice(1, 3), "01", "priority code");
  assert.equal(header.slice(3, 13), " 021000021", "immediate destination, right-justified in 10");
  assert.equal(header.slice(13, 23), "1234567890", "immediate origin");
  assert.equal(header.slice(23, 29), "260814", "file creation date YYMMDD");
  assert.equal(header.slice(29, 33), "0930", "file creation time HHMM");
  assert.equal(header.slice(33, 34), "A", "file ID modifier");
  assert.equal(header.slice(34, 37), "094", "record size");
  assert.equal(header.slice(37, 39), "10", "blocking factor");
  assert.equal(header.slice(39, 40), "1", "format code");
  assert.equal(header.slice(40, 63), "JPMORGAN CHASE".padEnd(23));
  assert.equal(header.slice(63, 86), "SUMMIT RIDGE BUILDERS".padEnd(23));
  assert.equal(header.slice(86, 94), " ".repeat(8), "reference code");

  // Batch header (5): 220 = credits only.
  assert.equal(batch.slice(0, 4), "5220");
  assert.equal(batch.slice(4, 20), "SUMMIT RIDGE".padEnd(16));
  assert.equal(batch.slice(20, 40), " ".repeat(20), "company discretionary data");
  assert.equal(batch.slice(40, 50), "1123456789", "company identification");
  assert.equal(batch.slice(50, 53), "PPD", "consumer direct deposit, never CCD");
  // Mandatory since the Nacha rule effective 20 March 2026.
  assert.equal(batch.slice(53, 63), "PAYROLL".padEnd(10), "company entry description");
  assert.equal(batch.slice(63, 69), " ".repeat(6), "company descriptive date left blank");
  assert.equal(batch.slice(69, 75), "260821", "effective entry date is the pay date");
  assert.equal(batch.slice(75, 78), " ".repeat(3), "settlement date is filled by the ACH operator");
  assert.equal(batch.slice(78, 79), "1", "originator status code");
  assert.equal(batch.slice(79, 87), "02100002", "originating DFI, first 8 of the ODFI routing");
  assert.equal(batch.slice(87, 94), "0000001", "batch number");

  // Entry detail (6): 22 = checking credit, 32 = savings credit.
  assert.equal(first.slice(0, 3), "622");
  assert.equal(first.slice(3, 11), "01140153", "receiving DFI identification");
  assert.equal(first.slice(11, 12), "3", "ninth routing digit is the check digit");
  assert.equal(first.slice(12, 29), "000123456789".padEnd(17), "DFI account number");
  assert.equal(first.slice(29, 39), "0000250000", "amount, unsigned implied cents");
  assert.equal(first.slice(39, 54), "EMP-0001".padEnd(15), "identification number");
  assert.equal(first.slice(54, 76), "ADA WIRED".padEnd(22), "receiving individual name");
  assert.equal(first.slice(76, 78), "  ", "discretionary data");
  assert.equal(first.slice(78, 79), "0", "no addenda");
  assert.equal(first.slice(79, 94), "021000020000001", "trace = ODFI 8 + 7-digit sequence");
  assert.equal(second.slice(0, 3), "632", "savings credit");
  assert.equal(second.slice(29, 39), "0000182150");
  assert.equal(second.slice(79, 94), "021000020000002");

  // Batch control (8).
  assert.equal(batchControl.slice(0, 4), "8220");
  assert.equal(batchControl.slice(4, 10), "000002", "entry/addenda count");
  assert.equal(batchControl.slice(10, 20), "0013240177", "entry hash");
  assert.equal(
    Number("01140153") + Number("12100024"),
    13_240_177,
    "hash is the sum of the 8-digit receiving DFI ids",
  );
  assert.equal(batchControl.slice(20, 32), "0".repeat(12), "no debits on a payroll credit file");
  assert.equal(batchControl.slice(32, 44), "000000432150", "total credit amount");
  assert.equal(batchControl.slice(44, 54), "1123456789");
  assert.equal(batchControl.slice(54, 73), " ".repeat(19), "message authentication code blank");
  assert.equal(batchControl.slice(73, 79), " ".repeat(6), "reserved");
  assert.equal(batchControl.slice(79, 87), "02100002");
  assert.equal(batchControl.slice(87, 94), "0000001");

  // File control (9).
  assert.equal(fileControl.slice(0, 1), "9");
  assert.equal(fileControl.slice(1, 7), "000001", "batch count");
  assert.equal(fileControl.slice(7, 13), "000001", "block count = ceil(10 records / 10)");
  assert.equal(fileControl.slice(13, 21), "00000002", "entry/addenda count");
  assert.equal(fileControl.slice(21, 31), "0013240177");
  assert.equal(fileControl.slice(31, 43), "0".repeat(12));
  assert.equal(fileControl.slice(43, 55), "000000432150");
  assert.equal(fileControl.slice(55, 94), " ".repeat(39), "reserved");
});

test("the record terminator is tenant configuration, and never part of a record", () => {
  // Nacha's published guide defines the 94-character record and says nothing
  // about terminators; acceptance is per-ODFI, so the choice is configuration.
  const crlf = renderNacha(nachaInputs(), { ...NACHA_ORIGINATOR, lineEnding: "crlf" });
  assert.equal(crlf.content, NACHA_GOLDEN.replaceAll("\n", "\r\n"));
  for (const record of crlf.content.split("\r\n").filter((line) => line.length > 0)) {
    assert.equal(record.length, 94);
  }
  // The totals read the same whichever terminator the ODFI wants.
  assert.deepEqual(readTrailerTotals("nacha", crlf.content), { totalCents: 432_150n, count: 2 });
});

test("a disabled format cannot be rendered even with a valid configuration", () => {
  assert.throws(
    () =>
      renderPayRunBankFile(
        { format: "cpa005", population: nachaInputs().population, credits: [] },
        {
          orgId: "org", documentId: "doc", format: "cpa005",
          originator: { ...NACHA_ORIGINATOR, format: "cpa005" },
          fileCreationNumber: 1, fundsDate: "2026-08-21", createdAt: new Date(2026, 7, 14),
        },
      ),
    /Item Trace Number/,
  );
});

/* ------------------------------------------------------------------ */
/* The control total                                                   */
/* ------------------------------------------------------------------ */

test("the control total is read back out of the bytes, not assumed", () => {
  const result = renderNacha();
  assert.equal(result.trailer.totalCents, 432_150n);
  assert.equal(result.trailer.count, 2);
  assert.equal(result.total, "4321.5000");
  // Independently: the trailer field, sliced straight out of the golden.
  const fileControl = result.content.split("\n").find((l) => l[0] === "9" && !/^9{94}$/.test(l))!;
  assert.equal(BigInt(fileControl.slice(43, 55)), 432_150n);
  assert.equal(Number(result.total) * 100, Number(result.trailer.totalCents));
});

test("a file whose trailer would disagree with the run is refused, not written", () => {
  // The population claims a total the credits do not add up to — the shape of a
  // filter that silently drops one employee's credit.
  const tampered = nachaInputs();
  tampered.population.total = "5000.0000";
  assert.throws(
    () => renderNacha(tampered),
    /entries total 4321\.5000 but the EFT population is 5000\.0000/,
  );
});

test("a sub-cent credit is refused rather than rounded into the file", () => {
  // numeric(19,4) can hold a fraction of a cent; a bank file cannot express one,
  // and rounding it here would put the trailer out by that fraction.
  const subCent = nachaInputs();
  subCent.credits[0]!.amount = "2500.0050";
  subCent.population.total = "4321.5050";
  assert.throws(() => renderNacha(subCent), /not a whole number of cents/);
});

/* ------------------------------------------------------------------ */
/* The lifecycle, against a real database                              */
/* ------------------------------------------------------------------ */

interface Fixture {
  orgId: string; subsidiaryId: string; actorId: string; scheduleId: string; profileId: string;
}

const account = async (orgId: string, number: string, name: string, type: string) => {
  const id = randomUUID();
  await db.execute(sql`
    insert into accounts (id, org_id, number, name, type, is_summary, is_active, eliminate,
                          reconcilable, required_dimensions, custom, subsidiary_include_children)
    values (${id}, ${orgId}, ${number}, ${name}, ${type}, false, true, false, false,
            '[]'::jsonb, '{}'::jsonb, true)`);
  return id;
};

/** A payroll org whose NACHA originator profile is configured the payroll way. */
async function payrollOrg(overrides: Record<string, unknown> = {}): Promise<Fixture> {
  const org = await createScratchOrg();
  const actorId = (await seedFlowActors(org.orgId)).adminId;
  const accounts = {
    wageExpense: await account(org.orgId, "6000", "Wages expense", "expense"),
    burdenExpense: await account(org.orgId, "6010", "Payroll burden", "expense"),
    netPayable: await account(org.orgId, "2300", "Wages payable", "liability_current"),
    craPayable: await account(org.orgId, "2310", "CRA payable", "liability_current"),
    vacationPayable: await account(org.orgId, "2320", "Vacation payable", "liability_current"),
    bank: await account(org.orgId, "1090", "Payroll funding bank", "asset_bank"),
  };
  await db.execute(sql`
    update orgs set settings = settings || ${JSON.stringify({
      payroll: {
        wageExpenseAccountId: accounts.wageExpense,
        burdenExpenseAccountId: accounts.burdenExpense,
        netPayAccountId: accounts.netPayable,
        cppPayableAccountId: accounts.craPayable,
        eiPayableAccountId: accounts.craPayable,
        taxPayableAccountId: accounts.craPayable,
        vacationPayableAccountId: accounts.vacationPayable,
        wagesTo: "expense",
      },
    })}::jsonb where id = ${org.orgId}`);
  await seedPayrollComponents(org.orgId, actorId);

  const scheduleId = randomUUID();
  await db.execute(sql`
    insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end,
                               pay_date_offset_days, is_active, created_by, updated_by)
    values (${scheduleId}, ${org.orgId}, 'Biweekly', 'biweekly', 26, '2026-07-18', 3, true,
            ${actorId}, ${actorId})`);

  // The tenant's originator configuration — the ONLY place institution-assigned
  // values come from. Anything absent is a named refusal, never a default.
  const formatId = randomUUID();
  await db.execute(sql`
    insert into payment_formats (id, org_id, code, name, rail, direction, country, currency,
                                 file_extension, content_type, settings, is_active, created_by, updated_by)
    values (${formatId}, ${org.orgId}, 'NACHA-CREDIT', 'NACHA ACH credit', 'nacha_credit', 'credit',
            'US', 'USD', 'ach', 'text/plain; charset=us-ascii', '{}'::jsonb, true, ${actorId}, ${actorId})`);
  const profileId = randomUUID();
  await db.execute(sql`
    insert into payment_bank_profiles (id, org_id, name, bank_account_id, payment_format_id, currency,
                                       country, originator_secrets_encrypted, settings, is_active,
                                       created_by, updated_by)
    values (${profileId}, ${org.orgId}, 'Payroll direct deposit', ${accounts.bank}, ${formatId}, 'USD',
            'US', ${sealJson({
              odfiRouting: "021000021",
              immediateDestination: "021000021",
              immediateOrigin: "1234567890",
              destinationName: "JPMORGAN CHASE",
              originName: "SUMMIT RIDGE BUILDERS",
              companyName: "SUMMIT RIDGE",
              companyId: "1123456789",
              ...overrides,
            })}, '{}'::jsonb, true, ${actorId}, ${actorId})`);

  return { orgId: org.orgId, subsidiaryId: org.subsidiaryId, actorId, scheduleId, profileId };
}

async function employee(fx: Fixture, name: string, opts: {
  partyMethod?: string | null;
  profileMethod?: string | null;
  bank?: { aba: string; accountType?: string } | null;
  employeeNumber?: string;
} = {}): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into parties (id, org_id, kind, display_name, is_active, payment_method, custom)
    values (${id}, ${fx.orgId}, 'person', ${name}, true, ${opts.partyMethod ?? null}, '{}'::jsonb)`);
  await db.execute(sql`
    insert into employee_roles (id, org_id, party_id, employee_number)
    values (${randomUUID()}, ${fx.orgId}, ${id}, ${opts.employeeNumber ?? null})`);
  await db.execute(sql`
    insert into labor_cost_rates (org_id, employee_party_id, currency, rate, basis, annual_hours,
                                  effective_from, is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, 'CAD', '30', 'hour', '2080', '2026-01-01', true,
            ${fx.actorId}, ${fx.actorId})`);
  await db.execute(sql`
    insert into employee_payroll_profiles (org_id, employee_party_id, pay_schedule_id, province,
                                           pay_basis, federal_claim_code, provincial_claim_code,
                                           vacation_percent, vacation_method, payment_method,
                                           is_active, created_by, updated_by)
    values (${fx.orgId}, ${id}, ${fx.scheduleId}, 'ON', 'hourly', 1, 1, '4', 'accrue',
            ${opts.profileMethod ?? null}, true, ${fx.actorId}, ${fx.actorId})`);
  if (opts.bank) {
    await db.execute(sql`
      insert into party_bank_accounts (org_id, party_id, bank_name, country, currency, routing,
                                       account_number_encrypted, account_last_four, approval_status,
                                       is_active, created_by, updated_by)
      values (${fx.orgId}, ${id}, 'Test Bank', 'US', 'USD', ${JSON.stringify(opts.bank)}::jsonb,
              ${encryptAccountNumber("000123456789")}, '6789', 'approved', true,
              ${fx.actorId}, ${fx.actorId})`);
  }
  return id;
}

const hours = async (fx: Fixture, employeeId: string, workedOn: string, qty: string) =>
  await db.execute(sql`
    insert into time_entries (org_id, employee_party_id, worked_on, hours, status,
                              is_billable, billing_status, costing_basis, created_by, updated_by)
    values (${fx.orgId}, ${employeeId}, ${workedOn}, ${qty}, 'approved',
            false, 'unbilled', 'actual', ${fx.actorId}, ${fx.actorId})`);

/**
 * A calculated, USD, mixed-rail run. Three employees on purpose: one genuine
 * EFT, one with nothing configured (cheque by default) and one who holds
 * approved bank details but is paid on paper by a payroll override — the exact
 * person a naive "has bank details" filter would pay twice.
 */
async function mixedRun(fx: Fixture) {
  const wired = await employee(fx, "Ada Wired", {
    partyMethod: "eft", bank: { aba: "011401533" }, employeeNumber: "EMP-0001",
  });
  const paper = await employee(fx, "Bo Paper", { employeeNumber: "EMP-0002" });
  const overridden = await employee(fx, "Cy Override", {
    partyMethod: "eft", profileMethod: "cheque", bank: { aba: "121000248" }, employeeNumber: "EMP-0003",
  });
  for (const id of [wired, paper, overridden]) {
    for (const day of ["2026-07-06", "2026-07-08", "2026-07-10", "2026-07-14"]) {
      await hours(fx, id, day, "20");
    }
  }
  const run = await createPayRun({
    orgId: fx.orgId, actorId: fx.actorId, payScheduleId: fx.scheduleId,
    periodStart: "2026-07-05", periodEnd: "2026-07-18",
  });
  const calc = await calculatePayRun({
    orgId: fx.orgId, documentId: run.documentId, actorId: fx.actorId,
  });
  assert.deepEqual(calc.errors, []);
  // The NACHA rail settles in USD; the run must match or the amounts would be
  // read as the wrong currency's cents.
  await db.execute(sql`
    insert into currencies (code, name, minor_units) values ('USD', 'US Dollar', 2)
    on conflict (code) do nothing`);
  await db.execute(sql`update documents set currency = 'USD' where id = ${run.documentId}`);
  return { documentId: run.documentId, wired, paper, overridden };
}

test("a run that is not committed cannot have a bank file, and says why", { skip: !DB }, async () => {
  const fx = await payrollOrg();
  const { documentId } = await mixedRun(fx);

  const before = await payRunBankFileEntitlement(fx.orgId, documentId);
  assert.equal(before.entitled, false);
  assert.equal(before.refusal?.code, "notCommitted");
  assert.match(before.refusal!.reason, /commit the pay run/);
  await assert.rejects(
    generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    }),
    /commit the pay run/,
  );

  await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });
  const after = await payRunBankFileEntitlement(fx.orgId, documentId);
  assert.equal(after.entitled, true);
  assert.equal(after.refusal, null);
});

test("a run already recorded as paid is refused by name", { skip: !DB }, async () => {
  const fx = await payrollOrg();
  const { documentId } = await mixedRun(fx);
  await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });
  await db.execute(sql`
    update pay_runs set paid_at = now() where org_id = ${fx.orgId} and document_id = ${documentId}`);

  const entitlement = await payRunBankFileEntitlement(fx.orgId, documentId);
  assert.equal(entitlement.entitled, false);
  assert.equal(entitlement.refusal?.code, "alreadyPaid");
  assert.match(entitlement.refusal!.reason, /pay everybody a second time/);
  await assert.rejects(
    generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    }),
    /already recorded as paid/,
  );
});

test("a voided run is refused by name", { skip: !DB }, async () => {
  const fx = await payrollOrg();
  const { documentId } = await mixedRun(fx);
  await db.execute(sql`
    update pay_runs set run_status = 'voided' where org_id = ${fx.orgId} and document_id = ${documentId}`);
  const entitlement = await payRunBankFileEntitlement(fx.orgId, documentId);
  assert.equal(entitlement.refusal?.code, "voided");
  assert.match(entitlement.refusal!.reason, /voided/);
});

test("unconfigured originator values are named, never defaulted", { skip: !DB }, async () => {
  const fx = await payrollOrg({ odfiRouting: "", companyId: "" });
  const { documentId } = await mixedRun(fx);
  await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });
  await assert.rejects(
    generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    }),
    /odfiRouting[\s\S]*companyId/,
  );
});

test("an AP-shaped profile (CCD) is refused rather than reused for wages", { skip: !DB }, async () => {
  const fx = await payrollOrg({ entryClassCode: "CCD" });
  const { documentId } = await mixedRun(fx);
  await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });
  await assert.rejects(
    generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    }),
    /must be PPD/,
  );
});

test(
  "the file carries the EFT rail only, ties to the ledger, and is immutable evidence",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    const { documentId, wired, overridden, paper } = await mixedRun(fx);
    await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });

    const population = await payRunBankFilePopulation(fx.orgId, documentId);
    assert.deepEqual(population.entries.map((e) => e.employeePartyId), [wired]);
    assert.deepEqual(
      population.excludedCheque.map((e) => e.employeePartyId).sort(),
      [overridden, paper].sort(),
    );

    const artifact = await generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    });

    // --- cheque exclusion is recorded WITH its reason ----------------------
    assert.equal(artifact.entryCount, 1);
    assert.deepEqual(
      artifact.excludedCheque.map((e) => e.employeePartyId).sort(),
      [overridden, paper].sort(),
    );
    // Cy Override holds approved bank details and is STILL not on the file:
    // crediting him as well as handing him paper is the double payment this
    // whole split exists to prevent.
    assert.equal(
      artifact.excludedCheque.find((e) => e.employeePartyId === overridden)!.reason,
      "profile",
    );
    assert.equal(
      artifact.excludedCheque.find((e) => e.employeePartyId === paper)!.reason,
      "default",
    );

    // --- the control total equals the run's EFT net pay --------------------
    assert.equal(artifact.controlTotal, population.total);
    assert.equal(artifact.excludedTotal, population.excludedTotal);
    const netTotal = ((await db.execute(sql`
      select net_total::text as net from pay_runs
       where org_id = ${fx.orgId} and document_id = ${documentId}`)) as unknown as
      { rows: { net: string }[] }).rows[0]!.net;
    // money.ts, not JS numbers: 5185.20 + 455.25 is 5640.450000000001 in
    // binary floating point, and a payroll tie-out that only holds to within
    // an epsilon is not a tie-out.
    assert.equal(cmp(add(artifact.controlTotal, artifact.excludedTotal), netTotal), 0);

    // --- numbering allocated once, off number_sequences --------------------
    assert.equal(artifact.sequenceNumber, 1);
    assert.match(artifact.fileNumber, /^PBF-\d+$/);
    assert.equal(artifact.fileIdModifier, "A");
    assert.equal(artifact.fileCreationNumber, null, "NACHA carries a modifier, not a CPA number");
    assert.match(artifact.filename, /^PBF-\d+-NACHA-.*\.ach$/);

    // --- the stored bytes are the file, and its trailer ties to the ledger --
    const released = await releasePayRunBankFile(fx.orgId, artifact.id, fx.actorId);
    const text = released.bytes.toString("utf8");
    const trailer = readTrailerTotals("nacha", text);
    assert.equal(trailer.count, 1);
    assert.equal(trailer.totalCents, toUnits(artifact.controlTotal) / 100n);
    // Nobody on paper appears anywhere in the characters.
    assert.equal(text.includes("EMP-0003"), false, "a cheque employee must not be in the file");
    assert.equal(text.includes("EMP-0002"), false, "a cheque employee must not be in the file");
    assert.equal(text.includes("EMP-0001"), true);

    // --- the row itself refuses to be edited or deleted --------------------
    // Drizzle wraps the driver error, so the database's own words are on the
    // cause chain rather than the top-level message.
    const dbSaid = (pattern: RegExp) => (error: unknown) => {
      let current: unknown = error;
      while (current) {
        if (pattern.test(String((current as Error).message ?? ""))) return true;
        current = (current as { cause?: unknown }).cause;
      }
      return false;
    };
    await assert.rejects(
      db.execute(sql`update pay_run_bank_files set control_total = '1.00' where id = ${artifact.id}`),
      dbSaid(/is immutable/),
    );
    await assert.rejects(
      db.execute(sql`delete from pay_run_bank_files where id = ${artifact.id}`),
      dbSaid(/cannot be deleted/),
    );
  },
);

test(
  "regenerating creates a distinct artifact and supersedes the old one — never mutates it",
  { skip: !DB },
  async () => {
    const fx = await payrollOrg();
    const { documentId } = await mixedRun(fx);
    await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });

    const first = await generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
    });

    // Pressing the button again with no explanation is refused: the operator
    // would otherwise hold two live files for one payday without knowing it.
    await assert.rejects(
      generatePayRunBankFile({
        orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
      }),
      /pays every employee twice/,
    );

    const second = await generatePayRunBankFile({
      orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
      supersedeReason: "bank rejected the first transmission",
    });

    assert.notEqual(second.id, first.id);
    assert.equal(second.sequenceNumber, 2);
    // Visibly distinguishable, which is the whole point: a different file
    // number, a different filename and a different NACHA file ID modifier, so
    // the bank cannot mistake one for a retransmission of the other.
    assert.notEqual(second.fileNumber, first.fileNumber);
    assert.notEqual(second.filename, first.filename);
    assert.notEqual(second.fileIdModifier, first.fileIdModifier);
    assert.equal(first.fileIdModifier, "A");
    assert.equal(second.fileIdModifier, "B");

    const all = await listPayRunBankFiles(fx.orgId, documentId);
    assert.equal(all.length, 2, "the old artifact still exists in full");
    const reloadedFirst = all.find((a) => a.id === first.id)!;
    assert.equal(reloadedFirst.status, "superseded");
    assert.equal(reloadedFirst.supersedeReason, "bank rejected the first transmission");
    // Not overwritten: every byte-defining value is exactly what it was.
    assert.equal(reloadedFirst.contentHash, first.contentHash);
    assert.equal(reloadedFirst.controlTotal, first.controlTotal);
    assert.equal(reloadedFirst.filename, first.filename);
    assert.equal(all.find((a) => a.id === second.id)!.status, "generated");

    // Both sets of bytes survive independently, and they are different files.
    const oldBytes = await releasePayRunBankFile(fx.orgId, first.id, fx.actorId);
    const newBytes = await releasePayRunBankFile(fx.orgId, second.id, fx.actorId);
    assert.notEqual(oldBytes.bytes.toString("utf8"), newBytes.bytes.toString("utf8"));
    assert.equal(oldBytes.artifact.status, "superseded", "releasing it does not reinstate it");
  },
);

test("every release is audited, and tampered bytes are refused", { skip: !DB }, async () => {
  const fx = await payrollOrg();
  const { documentId } = await mixedRun(fx);
  await commitPayRun({ orgId: fx.orgId, documentId, actorId: fx.actorId });
  const artifact = await generatePayRunBankFile({
    orgId: fx.orgId, documentId, actorId: fx.actorId, paymentBankProfileId: fx.profileId,
  });

  assert.equal(artifact.releaseCount, 0);
  assert.equal(artifact.status, "generated");

  const first = await releasePayRunBankFile(fx.orgId, artifact.id, fx.actorId);
  assert.equal(first.artifact.releaseCount, 1);
  assert.equal(first.artifact.status, "released");
  assert.ok(first.artifact.firstReleasedAt);

  const second = await releasePayRunBankFile(fx.orgId, artifact.id, fx.actorId);
  assert.equal(second.artifact.releaseCount, 2);
  // Same bytes both times — a release is not a regeneration.
  assert.equal(second.bytes.toString("utf8"), first.bytes.toString("utf8"));

  const audit = await payRunBankFileAudit(fx.orgId, documentId);
  assert.equal(audit.filter((e) => e.event === "release").length, 2);
  assert.equal(audit.filter((e) => e.event === "generate").length, 1);
  for (const entry of audit) {
    assert.equal(entry.artifactId, artifact.id);
    assert.equal(entry.actorId, fx.actorId, "every event names who");
    assert.ok(entry.at, "every event names when");
  }
  const release = audit.find((entry) => entry.event === "release")!;
  assert.equal(release.changes.channel, "download");
  assert.equal(release.changes.contentHash, artifact.contentHash);
  assert.equal(release.changes.fileNumber, artifact.fileNumber);

  // Corrupt the stored bytes behind the artifact's back — only possible with
  // the immutability trigger disabled, which is itself the proof it works. The
  // hash no longer matches what was generated, so the file is not handed over.
  await db.execute(sql`alter table file_blobs disable trigger payroll_bank_file_blob_immutable`);
  await db.execute(sql`
    update file_blobs set bytes = ${Buffer.from("tampered")}
     where version_id = (select file_version_id from pay_run_bank_files where id = ${artifact.id})`);
  await db.execute(sql`alter table file_blobs enable trigger payroll_bank_file_blob_immutable`);
  await assert.rejects(
    releasePayRunBankFile(fx.orgId, artifact.id, fx.actorId),
    /no longer matches its recorded sha256/,
  );
});
