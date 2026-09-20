/**
 * NL payroll pack tests — declarations plus 2026 wiring, no database.
 *
 * Proves: the pack object exists with its slots, regions and certificates;
 * every certificate passes the generic certificate validation; the
 * withholding declaration passes the generic withholding registration; 2026
 * is a published edition and every other year is refused by name; the
 * statutory engine computes 2026 end to end through the pack's declared
 * inputs and refuses anything it has not transcribed.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import {
  certificateDeclarationProblem,
  resolveCertificate,
  type StoredCertificate,
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
import { reduceTaxBases } from "../treatment-bases.ts";
import { NL_PAYROLL_PACK, NL_TAX_YEARS, NL_WITHHOLDING } from "./pack.ts";

test("the NL pack exists and is an installable EUR calendar-year pack", () => {
  assert.equal(NL_PAYROLL_PACK.country, "NL");
  assert.equal(NL_PAYROLL_PACK.installable, true);
  assert.equal(NL_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(NL_PAYROLL_PACK.taxYear, {
    basis: "calendar", startMonth: 1, startDay: 1, namedBy: "opening_year",
  });
  assert.equal(NL_PAYROLL_PACK.statutoryEngineLabel, "Loonbelastingtabellen");
  assert.equal(NL_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  // Retro pay is taxed as bijzondere beloning, never annualized as period
  // income — the pack's nonPeriodic path, not a new engine.
  assert.equal(NL_PAYROLL_PACK.retroactivePayTreatment, "non_periodic");
  // Employee-paid union dues buy no loonheffing deduction.
  assert.equal(NL_PAYROLL_PACK.employeeUnionDuesTaxTreatment, null);
});

test("the NL pack declares the loonheffing as one combined slot, not a Canada-shaped split", () => {
  const slots = NL_PAYROLL_PACK.statutorySlots;
  const keys = slots.map((slot) => slot.key);
  assert.deepEqual(keys, ["loonheffing", "werknemersverzekeringen", "zvw"]);
  const loonheffing = slots[0]!;
  assert.equal(loonheffing.components.length, 1);
  assert.match(loonheffing.components[0]!.name, /Loonbelasting\/premie volksverzekeringen/);
  assert.equal(loonheffing.components[0]!.assessedOn, "taxable_income");
  assert.equal(loonheffing.components[0]!.remittance, "tax_authority");
  // Employer SV is employer-side only: WW/WIA/ZW plus the werkgeversheffing Zvw.
  const employer = slots.flatMap((slot) => slot.components)
    .filter((component) => component.kind === "employer_contribution");
  assert.deepEqual(
    employer.map((component) => component.systemKey),
    ["ww", "wia", "zw", "zvw"],
  );
  for (const component of employer) {
    assert.equal(component.assessedOn, "earnings");
    assert.equal(component.remittance, "tax_authority");
  }
});

test("loonheffing is national: NL is known and supported, no subnational table declared", () => {
  assert.deepEqual([...NL_PAYROLL_PACK.regions.known], ["NL"]);
  assert.deepEqual([...NL_PAYROLL_PACK.regions.supported], ["NL"]);
});

test("the NL pack declares both certificates, and they pass generic validation", () => {
  const declared = NL_PAYROLL_PACK.certificates();
  assert.equal(declared.country, "NL");
  assert.deepEqual(declared.certificates.map((certificate) => certificate.key), ["nl_loonheffingen", "nl_premies"]);
  const [form, premies] = declared.certificates;
  assert.equal(form!.form, "Model opgaaf gegevens voor de loonheffingen");
  assert.equal(form!.storage, "certificate_rows");
  assert.ok(
    form!.fields.some((field) => field.key === "apply_loonheffingskorting" && field.kind === "flag"),
    "the loonheffingskorting question is declared",
  );
  assert.ok(
    form!.fields.some((field) => field.key === "age_class" && field.kind === "choice"),
    "the tabeltoepassing age class is declared",
  );
  // The employer's SV facts are declared too — including the Whk beschikking
  // with no default, because no default is lawful.
  assert.equal(premies!.storage, "certificate_rows");
  const whk = premies!.fields.find((field) => field.key === "whk_percent");
  assert.equal(whk?.kind, "amount");
  assert.equal(whk?.default, undefined);
  for (const certificate of declared.certificates) {
    assert.equal(certificateDeclarationProblem(certificate), null, certificate.key);
  }
});

test("the NL withholding declaration passes the generic registration as implemented", () => {
  registerPayrollWithholding(NL_WITHHOLDING);
  try {
    const region = NL_WITHHOLDING.regions[0]!;
    assert.equal(region.implemented, true);
    assert.equal(region.certificateKey, "nl_loonheffingen");
  } finally {
    unregisterPayrollWithholding("NL");
  }
});

test("2026 is the one published edition; every other year is refused by name", () => {
  assert.equal(NL_TAX_YEARS.country, "NL");
  assert.equal(NL_TAX_YEARS.ratesModule, "engine/src/payroll/nl/rates.ts");
  const published2026 = NL_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 1, "2026 is transcribed");
  for (const year of [2025, 2027]) {
    const published = NL_TAX_YEARS.editions.filter(
      (edition) => edition.year === year && edition.status === "published",
    );
    assert.equal(published.length, 0, `${year} is refused by name`);
  }
});

test("the NL filings declare the loonaangifte programme and a jaaropgaaf that refuses", async () => {
  const filings = NL_PAYROLL_PACK.filings();
  assert.equal(filings.country, "NL");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["nl_loonheffingen"],
  );
  assert.equal(filings.yearEnd.length, 1);
  const jaaropgaaf = filings.yearEnd[0]!;
  assert.equal(jaaropgaaf.key, "jaaropgaaf");
  assert.equal(jaaropgaaf.cadence, "annual");
  assert.equal(jaaropgaaf.parseRowId("anything"), null);
  assert.equal(jaaropgaaf.amendment.supported, false);
  await assert.rejects(() => filings.yearEnd[0]!.population("org", 2026), /no jaaropgaaf file builder/);
});

// ---------------------------------------------------------------------------
// computeStatutory wiring through a stub context (no database: the NL pass
// reads its declared certificates plus the pipeline money, never the ledger
// and never profile columns).
// ---------------------------------------------------------------------------

/**
 * Stored rows for the stub, keyed by certificate — the same shape the
 * certificates table holds, resolved through the pack's own declarations so
 * these tests prove the declaration → engine chain, not a hand-built
 * ResolvedCertificate.
 */
function stubStored(rows: Record<string, Record<string, string>>): StoredCertificate[] {
  return Object.entries(rows).map(([certificateKey, answers]) => ({
    certificateKey,
    answers,
    effectiveFrom: "2026-01-01",
  }));
}

const PREMIES = { awf_laag: "true", aof_hoog: "false", whk_percent: "1.25" };

function stubContext(
  stored: Record<string, Record<string, string>> = { nl_premies: PREMIES },
  overrides: Partial<PayrollStatutoryComputeContext> = {},
): {
  ctx: PayrollStatutoryComputeContext;
  pushed: { systemKey: string; kind: string; amount: string; sequence: number }[];
} {
  const pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] = [];
  const pushStatutory: PushStatutoryFn = (systemKey, kind, _description, amount, sequence) => {
    pushed.push({ systemKey, kind, amount, sequence });
  };
  const storedCertificates = stubStored(stored);
  const ctx: PayrollStatutoryComputeContext = {
    tx: {} as never,
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Werknemer",
    taxYear: 2026,
    country: "NL",
    region: "NL",
    run: { pay_date: "2026-02-13" },
    // No profile column carries an NL fact: emp is empty by construction.
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    // Pipeline money arrives at 4 decimals (the money contract); the engine
    // must accept that shape, not just 2dp.
    income: "999.0000",
    nonPeriodic: "0.0000",
    pensionable: "999.0000",
    insurable: "999.0000",
    deduction: () => "0",
    pushStatutory,
    storedCertificates,
    certificateFor: (key) => {
      const declared = NL_PAYROLL_PACK.certificates().certificates.find((certificate) => certificate.key === key);
      if (!declared) return null;
      return resolveCertificate({ certificate: declared, stored: storedCertificates, asOf: "2026-02-13" });
    },
    bool: (value) => value === "true",
    assertRegionSupported: (region) => {
      if (!(NL_PAYROLL_PACK.regions.supported as readonly string[]).includes(region)) {
        throw new PayrollError(`region ${region} is not supported by the NL payroll pack`);
      }
    },
    employerLevies: EMPTY_EMPLOYER_LEVY_FACTORS,
    ...overrides,
    // NL declares no pre-tax treatments: derived from the final legs (an
    // explicit override wins), so a leg override cannot drift from its base.
    reducedBases: overrides.reducedBases ?? reduceTaxBases(
      [],
      {
        income: overrides.income ?? "999.0000",
        nonPeriodic: overrides.nonPeriodic ?? "0.0000",
        pensionable: overrides.pensionable ?? "999.0000",
        insurable: overrides.insurable ?? "999.0000",
      },
      NL_PAYROLL_PACK.deductionTreatments,
    ),
  };
  return { ctx, pushed };
}

test("computeStatutory prices a 2026 maandloon end to end (korting + premies via certificates)", async () => {
  const { ctx, pushed } = stubContext({
    nl_loonheffingen: { apply_loonheffingskorting: "true" },
    nl_premies: PREMIES,
  });
  const factors = await NL_PAYROLL_PACK.computeStatutory(ctx);
  // € 999,00 with korting: the witte maandtabel's "met" column reads 13,83.
  assert.equal(factors["LH"], "13.8300");
  assert.equal(factors["X"], "166.0000");
  assert.equal(factors["AHK"], "3115.0000");
  assert.equal(factors["ARK"], "1004.0000");
  const lh = pushed.find((line) => line.systemKey === "loonheffing");
  assert.equal(lh?.amount, "13.8300");
  assert.equal(lh?.sequence, 110);
  const ww = pushed.find((line) => line.systemKey === "ww");
  assert.equal(ww?.amount, "27.3700");
  const wia = pushed.find((line) => line.systemKey === "wia");
  // Aof € 62,64 + Whk € 12,49, each rounded to the cent before the line sums them.
  assert.equal(wia?.amount, "75.1300");
  const zvw = pushed.find((line) => line.systemKey === "zvw");
  assert.equal(zvw?.amount, "60.9400");
});

test("computeStatutory without the opgaaf prices without korting", async () => {
  const { ctx } = stubContext();
  const factors = await NL_PAYROLL_PACK.computeStatutory(ctx);
  // € 999,00 zonder korting: the maandtabel's "zonder" column reads 357,08.
  assert.equal(factors["LH"], "357.0800");
  assert.equal(factors["AHK"], "0.0000");
  assert.equal(factors["ARK"], "0.0000");
});

test("computeStatutory refuses SV premiums without the declared SV facts", async () => {
  const { ctx } = stubContext({});
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory(ctx), /AWf/);
});

test("computeStatutory refuses an undeclared age class by name", async () => {
  const { ctx } = stubContext({
    nl_loonheffingen: { age_class: "aow_1970" },
    nl_premies: PREMIES,
  });
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory(ctx), /age_class|is not one of/);
});

test("computeStatutory refuses an untranscribed tax year and an unsupported region", async () => {
  const { ctx: wrongYear } = stubContext({ nl_premies: PREMIES }, { taxYear: 2027 });
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory(wrongYear), /no transcribed loonheffing tables/);
  const { ctx: wrongRegion } = stubContext({ nl_premies: PREMIES }, { region: "DE" });
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory(wrongRegion), /not supported/);
});

test("computeStatutory refuses a bonus by name", async () => {
  const { ctx } = stubContext({ nl_premies: PREMIES }, { nonPeriodic: "500.0000" });
  await assert.rejects(() => NL_PAYROLL_PACK.computeStatutory(ctx), /bijzondere beloningen/);
});
