/**
 * IT payroll pack tests — the declaration and the 2025 statutory pass.
 *
 * The pack is installable:true for 2025 (proven by tax-year-2025.test.ts);
 * 2026 is refused by name. Regions stay unsupported by choice (no region
 * publishes its own tables — surtaxes compute from tenant-declared rates),
 * while every withholding entry is implemented. The wrapper glue is tested
 * here with injected rates (no Postgres); the DB resolution lives in the
 * thin production entry only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { IT_CERTIFICATES } from "./certificates.ts";
import {
  ItPayrollRefusal,
  computeItStatutoryWithRates,
} from "./compute-statutory.ts";
import { IT_PACK_FILINGS } from "./filings.ts";
import { IT_JURISDICTIONS } from "./jurisdictions.ts";
import { IT_PAYROLL_PACK } from "./pack.ts";
import { IT_PACK_RATES, IT_TAX_YEARS } from "./rates.ts";
import { IT_REGION_CODES } from "./regions.ts";
import { IT_WITHHOLDING } from "./withholding.ts";

test("IT pack is installable for 2025, computes in EUR on the calendar year", () => {
  assert.equal(IT_PAYROLL_PACK.country, "IT");
  assert.equal(IT_PAYROLL_PACK.installable, true);
  assert.equal(IT_PAYROLL_PACK.statutoryCurrency, "EUR");
  assert.deepEqual(IT_PAYROLL_PACK.taxYear, {
    basis: "calendar",
    startMonth: 1,
    startDay: 1,
    namedBy: "opening_year",
  });
});

test("statutory slots name IRPEF, both addizionali, and both INPS shares", () => {
  const slots = IT_PAYROLL_PACK.statutorySlots;
  assert.deepEqual(slots.map((slot) => slot.key), [
    "irpef",
    "addizionale_regionale",
    "addizionale_comunale",
    "inps",
  ]);
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  assert.equal(byKey.get("irpef")?.components[0]?.systemKey, "income_tax");
  assert.equal(byKey.get("addizionale_regionale")?.components[0]?.systemKey, "regional_surtax");
  assert.equal(byKey.get("addizionale_comunale")?.components[0]?.systemKey, "municipal_surtax");
  for (const key of ["irpef", "addizionale_regionale", "addizionale_comunale"]) {
    assert.equal(byKey.get(key)?.components[0]?.assessedOn, "taxable_income", key);
  }
  const inps = byKey.get("inps")?.components ?? [];
  assert.deepEqual(inps.map((c) => c.kind), ["deduction", "employer_contribution"]);
  for (const component of inps) {
    assert.equal(component.assessedOn, "earnings", component.code);
    assert.equal(component.systemKey, "inps", component.code);
  }
});

test("tenant-entered surtax slots: regionale per region, comunale per sub-region", () => {
  assert.equal(IT_PACK_RATES.country, "IT");
  assert.deepEqual(IT_PACK_RATES.slots.map((s) => s.key), [
    "it_addizionale_regionale",
    "it_addizionale_comunale",
  ]);
  const [reg, com] = IT_PACK_RATES.slots;
  assert.equal(reg!.scope, "region");
  assert.deepEqual(reg!.systemKeys, ["regional_surtax"]);
  assert.equal(com!.scope, "sub_region");
  assert.deepEqual(com!.systemKeys, ["municipal_surtax"]);
  assert.ok(com!.fields.some((f) => f.key === "exemption" && f.required === false));
  assert.equal(IT_PAYROLL_PACK.statutoryRates, IT_PACK_RATES);
});

test("all 20 regions are known, unsupported by choice, withholding implemented", () => {
  assert.equal(IT_REGION_CODES.length, 20);
  assert.deepEqual(IT_PAYROLL_PACK.regions.known, IT_REGION_CODES);
  assert.deepEqual(IT_PAYROLL_PACK.regions.supported, []);
  assert.match(IT_PAYROLL_PACK.regions.unsupportedReason, /tenant-declared rate/);
  assert.equal(IT_WITHHOLDING.country, "IT");
  assert.deepEqual(
    IT_WITHHOLDING.regions.map((region) => region.region),
    IT_REGION_CODES,
  );
  for (const region of IT_WITHHOLDING.regions) {
    assert.equal(region.implemented, true, region.region);
    assert.equal(region.taxesNonresidentWages, false, region.region);
    assert.equal(region.residentWithholdingImplemented, true, region.region);
    const open = region.openSubRegions!;
    assert.equal(open.kind, "comune", region.region);
    assert.equal(open.rateSource.kind, "tenant", region.region);
    assert.equal(
      (open.rateSource as { rateKey: string }).rateKey,
      "it_addizionale_comunale",
      region.region,
    );
    assert.equal(open.certificateKey, "it_detrazioni", region.region);
    assert.equal(open.implemented, true, region.region);
  }
  assert.equal(IT_PAYROLL_PACK.withholding(), IT_WITHHOLDING);
});

test("the certificate carries the engine's employee inputs", () => {
  assert.equal(IT_CERTIFICATES.country, "IT");
  assert.equal(IT_CERTIFICATES.certificates.length, 1);
  const cert = IT_CERTIFICATES.certificates[0]!;
  assert.equal(cert.key, "it_detrazioni");
  const fields = new Map(cert.fields.map((field) => [field.key, field]));
  assert.ok(fields.has("figli_a_carico"), "dependent children are declared");
  assert.ok(fields.has("reddito_complessivo_presunto"), "presumed total income is declared");
  assert.ok(fields.has("titolare_pensione"), "pension status gates the engine");
  assert.ok(fields.has("tempo_determinato"), "fixed-term sets the detrazione floor");
  assert.ok(fields.has("anzianita_post_1995"), "seniority selects the massimale");
  const comune = fields.get("domicilio_comune")!;
  assert.equal(comune.kind, "code");
  assert.deepEqual(comune.subRegion, { side: "residence" });
  for (const field of cert.fields) {
    assert.deepEqual(field.storage ?? { kind: "row" }, { kind: "row" }, field.key);
  }
  assert.equal(IT_PAYROLL_PACK.certificates(), IT_CERTIFICATES);
});

test("2025 is published; 2026 is refused by name", () => {
  const published2025 = IT_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2025 && edition.status === "published",
  );
  assert.equal(published2025.length, 1);
  assert.match(published2025[0]!.citation, /L\. 30 dicembre 2024, n\. 207/);
  const published2026 = IT_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.deepEqual(published2026, []);
  assert.match(IT_TAX_YEARS.scaffold.steps.join("\n"), /L\. 30 dicembre 2025, n\. 199/);
  assert.equal(IT_PAYROLL_PACK.taxYears, IT_TAX_YEARS);
});

function fakeCtx(overrides: {
  taxYear?: number;
  income?: string;
  pensionable?: string;
  region?: string;
  answers?: Record<string, string | null>;
}): { ctx: PayrollStatutoryComputeContext; pushed: { systemKey: string; amount: string; sequence: number }[] } {
  const pushed: { systemKey: string; amount: string; sequence: number }[] = [];
  const answers = overrides.answers ?? {
    domicilio_comune: "H501",
    reddito_complessivo_presunto: null,
    tempo_determinato: null,
    anzianita_post_1995: null,
    titolare_pensione: null,
    coniuge_a_carico: null,
    figli_a_carico: null,
    altri_familiari_a_carico: null,
  };
  const ctx = {
    taxYear: overrides.taxYear ?? 2025,
    income: overrides.income ?? "2500.00",
    nonPeriodic: "0",
    pensionable: overrides.pensionable ?? "2500.00",
    insurable: "0",
    periodsPerYear: 12,
    region: overrides.region ?? "03",
    country: "IT",
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Emp",
    run: {},
    emp: {},
    filingAccountId: null,
    deduction: () => "0",
    pushStatutory: (systemKey, _kind, _desc, amount, sequence) => {
      pushed.push({ systemKey, amount, sequence });
    },
    storedCertificates: [],
    certificateFor: (key) =>
      key === "it_detrazioni"
        ? {
          certificate: IT_CERTIFICATES.certificates[0]!,
          onFile: true,
          effectiveFrom: null,
          answers,
          missing: [],
        }
        : null,
    bool: (value) => value === "true",
    assertRegionSupported: () => {},
    employerLevies: {
      wcbAmount: "0",
      wcbAssessable: "0",
      ehtAmount: "0",
      ehtEarnings: "0",
      hsfAmount: "0",
      hsfEarnings: "0",
    },
    tx: {} as PayrollStatutoryComputeContext["tx"],
  } as PayrollStatutoryComputeContext;
  return { ctx, pushed };
}

test("the statutory pass refuses 2026 with the year before touching rates", async () => {
  await assert.rejects(
    computeItStatutoryWithRates(fakeCtx({ taxYear: 2026 }).ctx, {
      regionalRate: null,
      municipalRate: null,
      municipalExemption: null,
    }),
    (error: unknown) => {
      assert.ok(error instanceof ItPayrollRefusal);
      assert.ok(error instanceof PayrollError);
      assert.match((error as Error).message, /2026/);
      return true;
    },
  );
});

test("missing declared rates refuse naming the scope point", async () => {
  await assert.rejects(
    computeItStatutoryWithRates(fakeCtx({}).ctx, {
      regionalRate: null,
      municipalRate: null,
      municipalExemption: null,
    }),
    /it_addizionale_regionale.*03/,
  );
  await assert.rejects(
    computeItStatutoryWithRates(fakeCtx({}).ctx, {
      regionalRate: "1.23",
      municipalRate: null,
      municipalExemption: null,
    }),
    /it_addizionale_comunale.*H501/,
  );
});

test("wrapper pushes five lines and returns TI/SOMMA factors", async () => {
  const { ctx, pushed } = fakeCtx({});
  const factors = await computeItStatutoryWithRates(ctx, {
    regionalRate: "1.23",
    municipalRate: "0.8",
    municipalExemption: null,
  });
  assert.equal(factors["I"], "2500.00");
  assert.equal(factors["PI"], "2500.00");
  // Annual 30.000: IRPEF netta 3.221,63/12, INPS matches the golden.
  assert.equal(factors["IRPEF"], "268.4700");
  assert.equal(factors["INPS_W"], "229.7500");
  assert.ok("TI" in factors);
  assert.ok("SOMMA" in factors);
  assert.deepEqual(pushed.map((p) => [p.systemKey, p.sequence]), [
    ["income_tax", 110],
    ["regional_surtax", 115],
    ["municipal_surtax", 120],
    ["inps", 130],
    ["inps", 230],
  ]);
});

test("CU and 770 are declared annually, unpopulated, with refused corrections", async () => {
  assert.equal(IT_PACK_FILINGS.country, "IT");
  assert.deepEqual(
    IT_PACK_FILINGS.yearEnd.map((filing) => [filing.key, filing.cadence]),
    [["cu", "annual"], ["770", "annual"]],
  );
  for (const filing of IT_PACK_FILINGS.yearEnd) {
    assert.equal(filing.slip, undefined, `${filing.key} declares no slip builder`);
    assert.match(filing.downloadRefusal ?? "", /no Entratel/, filing.key);
    assert.equal(filing.amendment.supported, false, `${filing.key} names its correction gap`);
    await assert.rejects(
      filing.population("org", 2025),
      /no tax-year edition is transcribed/,
    );
    assert.equal(filing.parseRowId("anything"), null);
  }
  assert.equal(IT_PAYROLL_PACK.filings(), IT_PACK_FILINGS);
});

test("the national festivity calendar is declared with Easter Monday computed", () => {
  assert.equal(IT_JURISDICTIONS.length, 1);
  const italy = IT_JURISDICTIONS[0]!;
  assert.equal(italy.scope, "employment");
  assert.equal(italy.holidays.length, 11);
  const pasquetta = italy.holidays.find((holiday) => holiday.key === "lunedi_angelo")!;
  assert.deepEqual(pasquetta.rule, { kind: "easter_offset", days: 1 });
  assert.equal(italy.holidayPay, null);
  assert.deepEqual(IT_PAYROLL_PACK.jurisdictions, IT_JURISDICTIONS);
  assert.equal(IT_PAYROLL_PACK.withholding(), IT_WITHHOLDING);
});
