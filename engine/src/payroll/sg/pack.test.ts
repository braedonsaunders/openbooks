/**
 * SG payroll pack tests — declarations plus 2026 wiring, no database.
 *
 * Proves: the pack object exists with its slots, regions and certificates;
 * every certificate passes the generic certificate validation; the
 * withholding declaration passes the generic withholding registration with
 * SG implemented (equal to regions.supported); 2026 is a published edition
 * and every other year is refused by name; the statutory engine computes
 * 2026 end to end through the pack's declared inputs and refuses anything
 * it has not transcribed — including the deliberate absence of any
 * income-tax withholding slot.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../../payroll-error.ts";
import {
  certificateDeclarationProblem,
} from "../certificates.ts";
import type {
  PayrollStatutoryComputeContext,
  PushStatutoryFn,
} from "../statutory-context.ts";
import { EMPTY_EMPLOYER_LEVY_FACTORS } from "../statutory-context.ts";
import {
  registerPayrollWithholding,
  unregisterPayrollWithholding,
} from "../withholding-jurisdictions.ts";
import { SG_PAYROLL_PACK, SG_TAX_YEARS, SG_WITHHOLDING } from "./pack.ts";

test("the SG pack exists and is an installable SGD calendar-year pack", () => {
  assert.equal(SG_PAYROLL_PACK.country, "SG");
  assert.equal(SG_PAYROLL_PACK.installable, true);
  assert.equal(SG_PAYROLL_PACK.statutoryCurrency, "SGD");
  assert.deepEqual(SG_PAYROLL_PACK.taxYear, {
    basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
  });
  assert.equal(SG_PAYROLL_PACK.statutoryEngineLabel, "CPF");
  assert.equal(SG_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // Bonuses and backpay are Additional Wages with a year-dependent ceiling,
  // never annualized into the month's OW — the pack's nonPeriodic path.
  assert.equal(SG_PAYROLL_PACK.retroactivePayTreatment, "non_periodic");
  // Union dues buy no CPF treatment.
  assert.equal(SG_PAYROLL_PACK.employeeUnionDuesTaxTreatment, null);
});

test("the SG pack declares CPF and SDL slots — and NO income-tax slot", () => {
  const slots = SG_PAYROLL_PACK.statutorySlots;
  assert.deepEqual(slots.map((slot) => slot.key), ["cpf", "sdl"]);
  const [cpf, sdl] = slots;
  assert.deepEqual(cpf!.components.map((c) => c.systemKey), ["cpf_ee", "cpf_er"]);
  assert.equal(cpf!.components[0]!.kind, "deduction");
  assert.equal(cpf!.components[1]!.kind, "employer_contribution");
  assert.deepEqual(sdl!.components.map((c) => c.systemKey), ["sdl"]);
  // CPF prices on OW and SDL on monthly total wages: no pre-tax deduction
  // enters either formula, so every line is earnings-assessed and the
  // protection fixpoint never re-derives one.
  for (const component of slots.flatMap((slot) => slot.components)) {
    assert.equal(component.assessedOn, "earnings", component.systemKey);
    assert.equal(component.remittance, "tax_authority", component.systemKey);
  }
  // The honest absence: a monthly income-tax withholding line would be an
  // invented tax — IRAS assesses annually from reported IR8A/AIS data.
  assert.ok(
    !slots.flatMap((slot) => slot.components).some((c) => /tax|irpf|paye|fit/i.test(c.systemKey)),
    "no income-tax withholding component is declared",
  );
});

test("CPF/SDL are national: SG is known and supported, the single region", () => {
  assert.deepEqual([...SG_PAYROLL_PACK.regions.known], ["SG"]);
  assert.deepEqual([...SG_PAYROLL_PACK.regions.supported], ["SG"]);
});

test("the SG pack declares the CPF-status certificate, and it passes generic validation", () => {
  const declared = SG_PAYROLL_PACK.certificates();
  assert.equal(declared.country, "SG");
  assert.equal(declared.certificates.length, 1);
  const [form] = declared.certificates;
  assert.equal(form!.key, "sg_cpf_status");
  assert.equal(form!.storage, "certificate_rows");
  assert.ok(
    form!.fields.some((field) => field.key === "cpf_status" && field.kind === "choice"),
    "the CPF-status question is declared",
  );
  assert.ok(
    form!.fields.some((field) => field.key === "age_band" && field.kind === "choice"),
    "the age-band question is declared",
  );
  for (const certificate of declared.certificates) {
    assert.equal(certificateDeclarationProblem(certificate), null, certificate.key);
  }
});

test("the SG withholding declaration passes generic registration with SG implemented", () => {
  registerPayrollWithholding(SG_WITHHOLDING);
  try {
    const region = SG_WITHHOLDING.regions[0]!;
    assert.equal(region.region, "SG");
    // Implemented is the same fact regions.supported states: the pack
    // determines SG's monthly withholding answer end to end, and that answer
    // is "withhold nothing" — there is no income-tax line to price.
    assert.equal(region.implemented, true);
    assert.equal(region.taxesNonresidentWages, false);
  } finally {
    unregisterPayrollWithholding("SG");
  }
});

test("2026 is the one published edition; every other year is refused by name", () => {
  assert.equal(SG_TAX_YEARS.country, "SG");
  assert.equal(SG_TAX_YEARS.ratesModule, "engine/src/payroll/sg/rates.ts");
  const published2026 = SG_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 1, "2026 is transcribed");
  for (const year of [2025, 2027]) {
    const published = SG_TAX_YEARS.editions.filter(
      (edition) => edition.year === year && edition.status === "published",
    );
    assert.equal(published.length, 0, `${year} is refused by name`);
  }
});

test("the SG filings declare the CPF programme and refusing IR8A + IR21 filings", async () => {
  const filings = SG_PAYROLL_PACK.filings();
  assert.equal(filings.country, "SG");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["sg_cpf"],
  );
  assert.deepEqual(
    filings.yearEnd.map((filing) => filing.key),
    ["ir8a", "ir21"],
  );
  const ir21 = filings.yearEnd.find((filing) => filing.key === "ir21")!;
  assert.equal(ir21.cadence, "separation");
  for (const filing of filings.yearEnd) {
    assert.equal(filing.parseRowId("anything"), null);
    assert.equal(filing.amendment.supported, false);
  }
  await assert.rejects(() => filings.yearEnd[0]!.population("org", 2026), /no IR8A\/AIS file builder/);
  await assert.rejects(() => ir21.population("org", 2026), /no IR21 builder/);
});

// ---------------------------------------------------------------------------
// computeStatutory wiring through a stub context (no database: the SG pass
// reads the declared certificate and line-set inputs only, never the ledger).
// ---------------------------------------------------------------------------

function stubContext(overrides: Partial<PayrollStatutoryComputeContext> = {}): {
  ctx: PayrollStatutoryComputeContext;
  pushed: { systemKey: string; kind: string; amount: string; sequence: number }[];
} {
  const pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] = [];
  const pushStatutory: PushStatutoryFn = (systemKey, kind, _description, amount, sequence) => {
    pushed.push({ systemKey, kind, amount, sequence });
  };
  const ctx: PayrollStatutoryComputeContext = {
    tx: {} as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Employee",
    taxYear: 2026,
    country: "SG",
    region: "SG",
    run: { pay_date: "2026-02-13" },
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: "4500.00",
    nonPeriodic: "0",
    pensionable: "4500.00",
    insurable: "4500.00",
    deduction: () => "0",
    pushStatutory,
    storedCertificates: [],
    certificateFor: () => ({
      certificate: SG_PAYROLL_PACK.certificates().certificates[0]!,
      onFile: true,
      effectiveFrom: "2026-01-01",
      answers: { cpf_status: "citizen", age_band: "le55" },
      missing: [],
    }),
    bool: (value) => value === "true",
    assertRegionSupported: (region) => {
      if (!(SG_PAYROLL_PACK.regions.supported as readonly string[]).includes(region)) {
        throw new PayrollError(`region ${region} is not supported by the SG payroll pack`);
      }
    },
    employerLevies: EMPTY_EMPLOYER_LEVY_FACTORS,
    ...overrides,
  };
  return { ctx, pushed };
}

test("computeStatutory prices a 2026 OW month end to end (the adapter path)", async () => {
  const { ctx, pushed } = stubContext();
  const factors = await SG_PAYROLL_PACK.computeStatutory(ctx);
  // $4,500 OW, citizen, 55 & below: the Board's §2 example reads 765 / 900.
  assert.equal(factors["CPF_EE"], "900.0000");
  assert.equal(factors["CPF_ER"], "765.0000");
  assert.equal(factors["CPF_TOTAL"], "1665.0000");
  // SDL: 0.25% of $4,500 = $11.25 (the Board's example C).
  assert.equal(factors["SDL"], "11.2500");
  // Every pushed line rides a declared component, with its declared kind.
  // Keyed as plain `string`: inferring the key from `c.kind` gives a narrow
  // template-literal union that a pushed line's widened `kind` cannot satisfy.
  const declared = new Map<string, number>(
    SG_PAYROLL_PACK.statutorySlots.flatMap((slot) =>
      slot.components.map((c) => [`${c.systemKey}|${c.kind}`, c.sequence] as const)),
  );
  assert.deepEqual(
    pushed.map((line) => line.systemKey).sort(),
    ["cpf_ee", "cpf_er", "sdl"],
  );
  for (const line of pushed) {
    assert.ok(declared.has(`${line.systemKey}|${line.kind}`), `${line.systemKey}/${line.kind} declared`);
    assert.equal(line.sequence, declared.get(`${line.systemKey}|${line.kind}`));
  }
  assert.equal(pushed.find((line) => line.systemKey === "cpf_ee")?.amount, "900.0000");
  assert.equal(pushed.find((line) => line.systemKey === "cpf_er")?.amount, "765.0000");
  assert.equal(pushed.find((line) => line.systemKey === "sdl")?.amount, "11.2500");
});

test("computeStatutory refuses without the certificate, and refuses foreign/PR/aged statuses", async () => {
  const { ctx: noCert } = stubContext({ certificateFor: () => null });
  await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(noCert), /without the sg_cpf_status certificate/);
  for (const [status, band, pattern] of [
    ["foreigner", "le55", /no CPF for a foreign employee/],
    ["spr_1st_year", "le55", /graduated rates/],
    ["citizen", "b60_65", /age band/],
  ] as const) {
    const { ctx } = stubContext({
      certificateFor: () => ({
        certificate: SG_PAYROLL_PACK.certificates().certificates[0]!,
        onFile: true,
        effectiveFrom: "2026-01-01",
        answers: { cpf_status: status, age_band: band },
        missing: [],
      }),
    });
    await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(ctx), pattern, `${status}/${band}`);
  }
});

test("computeStatutory refuses AW, non-monthly periods, wrong years and wrong regions", async () => {
  const { ctx: withAw } = stubContext({ nonPeriodic: "500.00" });
  await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(withAw), /refuses Additional Wages/);
  const { ctx: weekly } = stubContext({ periodsPerYear: 52 });
  await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(weekly), /only 12 monthly periods/);
  const { ctx: wrongYear } = stubContext({ taxYear: 2027 });
  await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(wrongYear), /no transcribed CPF tables/);
  const { ctx: wrongRegion } = stubContext({ region: "MY" });
  await assert.rejects(() => SG_PAYROLL_PACK.computeStatutory(wrongRegion), /not supported/);
});
