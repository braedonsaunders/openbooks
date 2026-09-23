/**
 * IT payroll pack tests — the declaration and the statutory pass.
 *
 * The pack is installable:true for 2025 (proven by tax-year-2025.test.ts)
 * and 2026 (proven by tax-year-2026.test.ts); later years are refused by
 * name. All 20 regions are supported (no region publishes its own tables —
 * surtaxes compute from tenant-declared rates), and every withholding entry
 * is implemented. The wrapper glue is tested here with injected rates (no
 * Postgres); the DB resolution lives in the thin production entry only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { add, cmp } from "../../money/money.ts";
import { PayrollError } from "../error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
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
import {
  jurisdictionKey,
  payrollJurisdictionDeclared,
} from "../packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "../holidays.ts";

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
  // The TI/somma payouts ride the IRPEF slot as generic credits: the reclaim
  // lands on the same F24 liability, so there is one account choice, not two.
  // The conguaglio refund rides it the same way (CONG-IRPEF): the run layer
  // pushes refunds through declared credit rows because the remittance only
  // nets credit-KIND components.
  const irpef = byKey.get("irpef")?.components ?? [];
  assert.deepEqual(irpef.map((c) => c.code), ["IRPEF", "CONG-IRPEF", "TI", "SOMMA"]);
  for (const component of irpef.slice(1)) {
    assert.equal(component.kind, "credit", component.code);
    assert.equal(component.assessedOn, "earnings", component.code);
    assert.equal(component.remittance, "tax_authority", component.code);
  }
  assert.deepEqual(irpef.slice(1).map((c) => c.systemKey), ["income_tax", "ti_payout", "somma_payout"]);
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

test("all 20 regions are known, all supported, withholding implemented", () => {
  assert.equal(IT_REGION_CODES.length, 20);
  assert.deepEqual(IT_PAYROLL_PACK.regions.known, IT_REGION_CODES);
  // This used to assert supported === [], reading `supported` as "the region
  // publishes its own withholding tables". It means "the engine computes the
  // region's income tax end to end", which IT does (IRPEF + addizionale from
  // the tenant-declared rate, identically for all 20). Under the old reading
  // Link 4 of resolveEmployeePayrollContext refused every Italian employee
  // before a line was computed. supported and withholding.implemented are the
  // same fact and are now asserted equal — see
  // ../installable-region-coverage.test.ts.
  assert.deepEqual(IT_PAYROLL_PACK.regions.supported, IT_REGION_CODES);
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

test("2025 and 2026 are published; later years are refused by name", () => {
  const published2025 = IT_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2025 && edition.status === "published",
  );
  assert.equal(published2025.length, 1);
  assert.match(published2025[0]!.citation, /L\. 30 dicembre 2024, n\. 207/);
  // Inverted (was: 2026 refused): the 2026 edition transcribed L. 199/2025's
  // 33% second bracket. Never delete this — invert it again when 2027 lands.
  const published2026 = IT_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 1);
  assert.match(published2026[0]!.citation, /L\. 30 dicembre 2025, n\. 199/);
  assert.match(IT_TAX_YEARS.scaffold.steps.join("\n"), /L\. 30 dicembre 2025, n\. 199/);
  assert.equal(IT_PAYROLL_PACK.taxYears, IT_TAX_YEARS);
});

function fakeCtx(overrides: {
  taxYear?: number;
  income?: string;
  pensionable?: string;
  nonPeriodic?: string;
  pensionableNonPeriodic?: string;
  region?: string;
  answers?: Record<string, string | null>;
}): { ctx: PayrollStatutoryComputeContext; pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] } {
  const pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] = [];
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
    nonPeriodic: overrides.nonPeriodic ?? "0",
    pensionable: overrides.pensionable ?? "2500.00",
    // Omitted on purpose unless the test passes it: unit-constructed contexts
    // without the split keep legacy math, and the engine always provides it.
    pensionableNonPeriodic: overrides.pensionableNonPeriodic,
    insurable: "0",
    reducedBases: reduceTaxBases(
      [],
      {
        income: overrides.income ?? "2500.00",
        nonPeriodic: "0",
        pensionable: overrides.pensionable ?? "2500.00",
        insurable: "0",
      },
      IT_PAYROLL_PACK.deductionTreatments,
    ),
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
    pushStatutory: (systemKey, kind, _desc, amount, sequence) => {
      // Like the real createPushStatutory: zero amounts never become lines.
      if (cmp(amount, "0") === 0) return;
      pushed.push({ systemKey, kind, amount, sequence });
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

test("the statutory pass computes 2026 and refuses untranscribed years by name", async () => {
  // 2026 computes through the same glue (null rates refuse at the scope
  // point, not at the year gate — the year is transcribed).
  await assert.rejects(
    computeItStatutoryWithRates(fakeCtx({ taxYear: 2026 }).ctx, {
      regionalRate: null,
      municipalRate: null,
      municipalExemption: null,
    }),
    /it_addizionale_regionale.*03/,
  );
  // Both sides of the transcribed window refuse with the year before
  // touching rates: 2024 (prior) and 2027 (future). Never extrapolate.
  for (const taxYear of [2024, 2027]) {
    await assert.rejects(
      computeItStatutoryWithRates(fakeCtx({ taxYear }).ctx, {
        regionalRate: null,
        municipalRate: null,
        municipalExemption: null,
      }),
      (error: unknown) => {
        assert.ok(error instanceof ItPayrollRefusal);
        assert.ok(error instanceof PayrollError);
        assert.match((error as Error).message, new RegExp(`tax year ${taxYear}`));
        assert.match((error as Error).message, /2025 and 2026 are the transcribed/);
        return true;
      },
    );
  }
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

test("a 9.500 worker is paid +141,96/month in credits, and YTD matches cash", async () => {
  // The whole argument for the generic `credit` kind, pinned end to end:
  // annual 9.500,04 (791,67 x 12, no pensionable base) owes TI 1.200 +
  // somma 5,3% x 9.500,04 = 503,50 a year = 100,00 + 41,96 a month. Before
  // the credit channel this refused by name; as factors it would have
  // underpaid every monthly net by 141,96 while YTD claimed 1.703,50 paid.
  const { ctx, pushed } = fakeCtx({ income: "791.67", pensionable: "0.00" });
  const factors = await computeItStatutoryWithRates(ctx, {
    regionalRate: "1.23",
    municipalRate: "0.8",
    municipalExemption: null,
  });
  assert.equal(factors["TI"], "100.0000");
  assert.equal(factors["SOMMA"], "41.9600");
  const ti = pushed.find((p) => p.systemKey === "ti_payout")!;
  const somma = pushed.find((p) => p.systemKey === "somma_payout")!;
  assert.equal(ti.kind, "credit");
  assert.equal(somma.kind, "credit");
  // The stub lines ARE the cash, the factors ARE what year-to-date reads:
  // equal amounts, and together the 141,96 the month is owed.
  assert.equal(ti.amount, factors["TI"]);
  assert.equal(somma.amount, factors["SOMMA"]);
  assert.equal(add(ti.amount, somma.amount), "141.9600");
  assert.deepEqual(pushed.map((p) => [p.systemKey, p.kind, p.sequence]), [
    ["income_tax", "deduction", 110],
    ["regional_surtax", "deduction", 115],
    ["municipal_surtax", "deduction", 120],
    ["ti_payout", "credit", 140],
    ["somma_payout", "credit", 145],
  ]);
});

test("a one-off bonus counts once in the INPS base and still withholds IRPEF", async () => {
  // A December bonus with no periodic income: the 20000 one-off is
  // pensionable, so the pensionable leg carries it and nonPeriodic adds it
  // again. Annualising the whole leg priced 13 months of INPS (a 260000
  // base: 2160.98 a month), wiping the lavoroNet so IRPEF priced zero and no
  // income_tax line was pushed at all. The recurring leg annualises; the
  // one-off enters once: INPS on 20000, IRPEF on what remains.
  const { ctx, pushed } = fakeCtx({
    taxYear: 2026,
    income: "0.0000",
    pensionable: "20000.0000",
    nonPeriodic: "20000.0000",
    pensionableNonPeriodic: "20000.0000",
  });
  const factors = await computeItStatutoryWithRates(ctx, {
    regionalRate: "1.23",
    municipalRate: "0.8",
    municipalExemption: null,
  });
  assert.equal(factors["INPS_W"], "153.1700");
  // Hand-verified: lavoroNet 20000 − 1838.00 = 18162; lorda 23% = 4177.26;
  // detrazione lavoro 1910 + 1190 × 9838/13000 (4dp truncated) = 2810.47;
  // netta 1366.79, /12 half-up = 113.90.
  assert.equal(factors["IRPEF"], "113.9000");
  const inps = pushed.find((p) => p.systemKey === "inps" && p.kind === "deduction")!;
  assert.equal(inps.amount, factors["INPS_W"]);
  const irpef = pushed.find((p) => p.systemKey === "income_tax");
  assert.ok(irpef, "IRPEF is pushed, not suppressed as zero");
  assert.equal(irpef!.amount, factors["IRPEF"]);
});

test("wrapper pushes five lines when no payout is owed, TI/SOMMA factors zero", async () => {
  const { ctx, pushed } = fakeCtx({});
  const factors = await computeItStatutoryWithRates(ctx, {
    regionalRate: "1.23",
    municipalRate: "0.8",
    municipalExemption: null,
  });
  assert.equal(factors["I"], "2500.00");
  assert.equal(factors["PI"], "2500.00");
  // Annual 30.000: IRPEF netta 3.221,63/12, INPS matches the golden.
  // TI and somma are 0 here, so no credit lines are pushed (pushStatutory
  // skips zeros) while the factors stay present at zero for YTD shape.
  assert.equal(factors["IRPEF"], "268.4700");
  assert.equal(factors["INPS_W"], "229.7500");
  assert.equal(factors["TI"], "0.0000");
  assert.equal(factors["SOMMA"], "0.0000");
  assert.deepEqual(pushed.map((p) => [p.systemKey, p.sequence]), [
    ["income_tax", 110],
    ["regional_surtax", 115],
    ["municipal_surtax", 120],
    ["inps", 130],
    ["inps", 230],
  ]);
});

test("CU is populated with a slip; the 770 stays declared and refused", async () => {
  assert.equal(IT_PACK_FILINGS.country, "IT");
  assert.deepEqual(
    IT_PACK_FILINGS.yearEnd.map((filing) => [filing.key, filing.cadence]),
    [["cu", "annual"], ["770", "annual"]],
  );
  const cu = IT_PACK_FILINGS.yearEnd.find((filing) => filing.key === "cu")!;
  assert.ok(cu.slip, "the CU declares its employee slip builder");
  assert.match(cu.downloadRefusal ?? "", /Entratel/, "cu names its missing telematic file");
  assert.equal(cu.amendment.supported, false, "the CU names its correction gap");
  // Year gates fire before any query, so they run without a database; the
  // 2025 population itself is DB-owned (see cu.integration.test.ts).
  await assert.rejects(cu.population("org", 2024), /no transcribed tables/);
  await assert.rejects(cu.population("org", 2026), /CU 2027/);
  assert.equal(cu.parseRowId("anything"), null);
  const employee = "123e4567-e89b-12d3-a456-426614174000";
  assert.deepEqual(cu.parseRowId(employee), { employees: [employee], accounts: [] });
  const settanta = IT_PACK_FILINGS.yearEnd.find((filing) => filing.key === "770")!;
  assert.equal(settanta.slip, undefined, "770 declares no slip builder");
  assert.match(settanta.downloadRefusal ?? "", /no Entratel/, "770");
  assert.equal(settanta.amendment.supported, false, "770 names its correction gap");
  await assert.rejects(
    settanta.population("org", 2025),
    /no filing population is transcribed/,
  );
  await assert.rejects(
    settanta.population("org", 2026),
    /no filing population is transcribed/,
  );
  assert.equal(settanta.parseRowId("anything"), null);
  assert.equal(IT_PAYROLL_PACK.filings(), IT_PACK_FILINGS);
});

test("the national festivity calendar is declared with Easter Monday computed", () => {
  assert.equal(IT_JURISDICTIONS.length, 20);
  const italy = IT_JURISDICTIONS.find((j) => j.key === "IT-01")!;
  assert.equal(italy.scope, "employment");
  assert.equal(italy.holidays.length, 11);
  const pasquetta = italy.holidays.find((holiday) => holiday.key === "lunedi_angelo")!;
  assert.deepEqual(pasquetta.rule, { kind: "easter_offset", days: 1 });
  assert.equal(italy.holidayPay, null);
  assert.deepEqual(IT_PAYROLL_PACK.jurisdictions, IT_JURISDICTIONS);
  assert.equal(IT_PAYROLL_PACK.withholding(), IT_WITHHOLDING);
});

test("IT profile jurisdictions resolve to declared region calendars", () => {
  // Every profile names its ISTAT region, so the engine resolves
  // jurisdictionKey("IT", "<code>") = "IT-<code>". A bare "IT" key
  // declares a calendar no employee reaches, and the
  // undeclared-jurisdiction gate then refuses every period containing a
  // mandatory holiday. One entry per region sharing the national festività
  // (ES precedent); regional patron-saint days stay unmodelled by design.
  const byKey = new Map(IT_PAYROLL_PACK.jurisdictions.map((j) => [j.key, j]));
  assert.equal(IT_PAYROLL_PACK.jurisdictions.length, 20);
  for (const code of IT_PAYROLL_PACK.regions.known) {
    assert.equal(jurisdictionKey("IT", code), `IT-${code}`);
    assert.equal(payrollJurisdictionDeclared(`IT-${code}`), true, code);
    assert.equal(byKey.get(`IT-${code}`)?.holidays.length, 11, code);
  }
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "IT",
      jurisdiction: "IT-01",
      from: "2026-01-01",
      to: "2026-01-31",
    }),
    null,
  );
});
