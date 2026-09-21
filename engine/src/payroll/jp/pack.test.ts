/**
 * JP payroll pack tests — the declaration and the 2026 statutory pass.
 *
 * The pack is installable:true for 2026 (proven by withholding-2026.test.ts
 * goldens); every other year is refused by name. All 47 prefectures are
 * known AND supported with withholding implemented — `supported` asks
 * whether the engine computes, not whether the pack publishes a table, and
 * the missing health rate refuses at the rate channel (see ./pack.ts).
 * The adapter glue is tested here with injected rates (no Postgres); the DB
 * resolution lives in the thin production entry only.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { PayrollError } from "../error.ts";
import { PayrollPackError } from "../payroll-error.ts";
import type { PayrollStatutoryComputeContext } from "../statutory-context.ts";
import { reduceTaxBases } from "../treatment-bases.ts";
import { JP_CERTIFICATES } from "./certificates.ts";
import {
  computeJpStatutoryWithRates,
} from "./compute-statutory.ts";
import { jpPackFilings } from "./filings.ts";
import { JP_JURISDICTIONS } from "./jurisdictions.ts";
import { JP_PAYROLL_PACK } from "./pack.ts";
import { JP_PACK_RATES, JP_REFUSED_2026, JP_TAX_YEARS } from "./rates.ts";
import { JP_PREFECTURE_CODES } from "./regions.ts";
import { JP_WITHHOLDING } from "./withholding.ts";
import {
  jurisdictionKey,
  payrollJurisdictionDeclared,
} from "../packs.ts";
import { undeclaredJurisdictionHolidayConflict } from "../holidays.ts";

test("JP pack is installable for 2026, computes in JPY on the calendar year", () => {
  assert.equal(JP_PAYROLL_PACK.country, "JP");
  assert.equal(JP_PAYROLL_PACK.installable, true);
  assert.equal(JP_PAYROLL_PACK.statutoryCurrency, "JPY");
  assert.deepEqual(JP_PAYROLL_PACK.taxYear, {
    basis: "calendar",
    startMonth: 1,
    startDay: 1,
    namedBy: "opening_year",
  });
  // Two authorities, no single vendor. The generic remittance layer must not
  // inherit another authority's party.
  assert.equal(JP_PAYROLL_PACK.remittanceVendorSettingsKey, null);
  assert.equal(JP_PAYROLL_PACK.statutoryEngineLabel, "月額表");
  assert.equal(JP_PAYROLL_PACK.retroactivePayTreatment, "periodic");
});

test("statutory slots name gensen, pension, and health with both shares", () => {
  const slots = JP_PAYROLL_PACK.statutorySlots;
  assert.deepEqual(slots.map((slot) => slot.key), [
    "gensen",
    "kosei_nenkin",
    "kenko_hoken",
  ]);
  const byKey = new Map(slots.map((slot) => [slot.key, slot]));
  assert.equal(byKey.get("gensen")?.components[0]?.systemKey, "income_tax");
  assert.equal(byKey.get("gensen")?.components[0]?.assessedOn, "taxable_income");
  for (const key of ["kosei_nenkin", "kenko_hoken"]) {
    const components = byKey.get(key)?.components ?? [];
    assert.deepEqual(components.map((c) => c.kind), ["deduction", "employer_contribution"], key);
    for (const component of components) {
      assert.equal(component.assessedOn, "earnings", component.code);
      // The destination varies by employer (JPS account / insurer), never a
      // single statutory vendor — external, like France's caisse lines.
      assert.equal(component.remittance, "external", component.code);
    }
  }
  assert.equal(byKey.get("gensen")?.components[0]?.remittance, "tax_authority");
  assert.equal(JP_PAYROLL_PACK.computeStatutory.name, "computeJpStatutory");
});

test("health rate is a tenant-declared per-prefecture slot", () => {
  assert.equal(JP_PACK_RATES.country, "JP");
  assert.deepEqual(JP_PACK_RATES.slots.map((s) => s.key), ["jp_health_rate"]);
  const slot = JP_PACK_RATES.slots[0]!;
  assert.equal(slot.scope, "region");
  assert.deepEqual(slot.systemKeys, ["health"]);
  assert.equal(JP_PAYROLL_PACK.statutoryRates, JP_PACK_RATES);
});

test("all 47 prefectures are known, all supported, withholding implemented", () => {
  assert.equal(JP_PREFECTURE_CODES.length, 47);
  assert.deepEqual(JP_PAYROLL_PACK.regions.known, JP_PREFECTURE_CODES);
  // `supported` means the engine computes — which it does for every
  // prefecture once the health rate is known — and withholding.implemented
  // is the same fact (see ../installable-region-coverage.test.ts).
  assert.deepEqual(JP_PAYROLL_PACK.regions.supported, JP_PREFECTURE_CODES);
  assert.equal(JP_WITHHOLDING.country, "JP");
  assert.deepEqual(
    JP_WITHHOLDING.regions.map((region) => region.region),
    JP_PREFECTURE_CODES,
  );
  for (const region of JP_WITHHOLDING.regions) {
    assert.equal(region.implemented, true, region.region);
    assert.equal(region.taxesNonresidentWages, false, region.region);
    assert.equal(region.residentWithholding, "required", region.region);
    assert.equal(region.residentWithholdingImplemented, true, region.region);
    assert.equal(region.certificateKey, "jp_fuyo", region.region);
  }
  assert.equal(JP_PAYROLL_PACK.withholding(), JP_WITHHOLDING);
});

test("the certificate carries the 甲欄 inputs; absence means 乙欄", () => {
  assert.equal(JP_CERTIFICATES.country, "JP");
  // Since 0191 a second, column-backed declaration carries the payer-held
  // 標準報酬 grade and kaigo status (`jp_hyojun`) — the 扶養控除等申告書
  // itself is unchanged, still first, still the only row-backed form.
  assert.deepEqual(
    JP_CERTIFICATES.certificates.map((certificate) => [certificate.key, certificate.storage]),
    [["jp_fuyo", "certificate_rows"], ["jp_hyojun", "profile_columns"]],
  );
  const cert = JP_CERTIFICATES.certificates[0]!;
  assert.equal(cert.key, "jp_fuyo");
  const fields = new Map(cert.fields.map((field) => [field.key, field]));
  assert.ok(fields.has("fuyo_count"), "dependent count is declared");
  assert.ok(fields.has("honnin_shogai"), "person attributes stack on the count");
  assert.ok(fields.has("hitori_oya"), "ひとり親 is its own category");
  assert.ok(fields.has("kafu"), "寡婦 is its own category");
  assert.ok(fields.has("kinro_gakusei"), "勤労学生 stacks on the count");
  assert.ok(fields.has("kazoku_shogai_kasan"), "disabled family members stack on the count");
  assert.equal(JP_PAYROLL_PACK.certificates(), JP_CERTIFICATES);
});

test("2026 is published; the ledger names every refusal", () => {
  const published2026 = JP_TAX_YEARS.editions.filter(
    (edition) => edition.year === 2026 && edition.status === "published",
  );
  assert.equal(published2026.length, 1);
  assert.match(published2026[0]!.citation, /令和8年分/);
  assert.deepEqual(JP_TAX_YEARS.regionsWithOwnTables, []);
  assert.equal(JP_PAYROLL_PACK.taxYears, JP_TAX_YEARS);
  const refused = JP_REFUSED_2026.join("\n");
  for (const name of ["住民税", "年末調整", "日額表", "賞与", "雇用保険", "介護保険", "子ども・子育て拠出金"]) {
    assert.ok(refused.includes(name), `ledger names ${name}`);
  }
});

test("filings declare the establishment program; year-end filings refuse by name", () => {
  const filings = jpPackFilings();
  assert.equal(filings.country, "JP");
  assert.deepEqual(filings.programTypes.map((program) => program.key), ["jp_shaho_jigyosho"]);
  // The three statutory year-end filings are DECLARED (see ./filings.test.ts
  // for the refusal proofs) but none populates: 年末調整 is not performed,
  // so no 年調年税額 exists to report.
  assert.deepEqual(filings.yearEnd.map((filing) => filing.key), [
    "gensenchoshu",
    "kyuyo_shiharai_hokokusho",
    "hotei_chosho_gokeihyo",
  ]);
  // One declaration function, never a divergent copy: the pack serves the
  // same builder the tests prove (fresh closures defeat deepEqual, so the
  // assertion is reference identity, not structure).
  assert.equal(JP_PAYROLL_PACK.filings, jpPackFilings);
});

test("the holiday calendar carries 14 computed holidays; equinoxes stay out", () => {
  assert.equal(JP_JURISDICTIONS.length, 47);
  const japan = JP_JURISDICTIONS.find((j) => j.key === "JP-13")!;
  assert.equal(japan.scope, "employment");
  assert.equal(japan.holidays.length, 14);
  const seijin = japan.holidays.find((holiday) => holiday.key === "seijin_no_hi")!;
  assert.deepEqual(seijin.rule, { kind: "nth_weekday", month: 1, weekday: 1, nth: 2 });
  for (const equinox of ["shunbun_no_hi", "shubun_no_hi"]) {
    assert.equal(japan.holidays.some((holiday) => holiday.key === equinox), false, equinox);
  }
  assert.equal(japan.holidayPay, null);
  assert.deepEqual(JP_PAYROLL_PACK.jurisdictions, JP_JURISDICTIONS);
});

function fakeCtx(overrides: {
  taxYear?: number;
  income?: string;
  nonPeriodic?: string;
  periodsPerYear?: number;
  region?: string;
  emp?: Record<string, string | null>;
  answers?: Record<string, string | null> | null;
}): { ctx: PayrollStatutoryComputeContext; pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] } {
  const pushed: { systemKey: string; kind: string; amount: string; sequence: number }[] = [];
  const answers = overrides.answers === undefined
    ? {
      fuyo_count: "0",
      honnin_shogai: null,
      hitori_oya: null,
      kafu: null,
      kinro_gakusei: null,
      kazoku_shogai_kasan: null,
    }
    : overrides.answers;
  const ctx = {
    taxYear: overrides.taxYear ?? 2026,
    income: overrides.income ?? "300000.0000",
    nonPeriodic: overrides.nonPeriodic ?? "0.0000",
    pensionable: "0.0000",
    insurable: "0.0000",
    reducedBases: reduceTaxBases(
      [],
      {
        income: overrides.income ?? "300000.0000",
        nonPeriodic: overrides.nonPeriodic ?? "0.0000",
        pensionable: "0.0000",
        insurable: "0.0000",
      },
      JP_PAYROLL_PACK.deductionTreatments,
    ),
    periodsPerYear: overrides.periodsPerYear ?? 12,
    region: overrides.region ?? "13",
    country: "JP",
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Emp",
    run: {},
    emp: overrides.emp ?? { jp_hyojun_hoshu: "300000", jp_kaigo_dainigou: "false" },
    filingAccountId: null,
    deduction: () => "0",
    pushStatutory: (systemKey, kind, _desc, amount, sequence) => {
      pushed.push({ systemKey, kind, amount, sequence });
    },
    storedCertificates: [],
    certificateFor: (key) =>
      key === "jp_fuyo" && answers !== null
        ? {
          certificate: JP_CERTIFICATES.certificates[0]!,
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

const TOKYO_RATE = { healthRate: "9.85" };

test("mechanism 3: the year resolver throws on BOTH sides of 2026", async () => {
  for (const taxYear of [2025, 2027]) {
    await assert.rejects(
      computeJpStatutoryWithRates(fakeCtx({ taxYear }).ctx, TOKYO_RATE),
      (error: unknown) => {
        assert.ok(error instanceof PayrollPackError);
        assert.ok(error instanceof PayrollError);
        assert.match((error as Error).message, new RegExp(String(taxYear)));
        return true;
      },
    );
  }
});

test("adapter: a monthly 甲 payslip computes end to end and pushes five lines", async () => {
  // Gross 300,000, grade 300,000, 0人, Tokyo 9.85%: pension 27,450, health
  // 14,775, base 257,775 → gensen 6,430 (row 71). Both employer shares push
  // under the same systemKey as the employee share, never employer-side
  // pension/health keys — the push path proves the declaration covers them.
  const { ctx, pushed } = fakeCtx({});
  const factors = await computeJpStatutoryWithRates(ctx, TOKYO_RATE);
  assert.equal(factors["JP_GENSEN_BASE"], "257775");
  assert.equal(factors["JP_GENSEN"], "6430");
  assert.equal(factors["JP_PENSION_W"], "27450");
  assert.equal(factors["JP_PENSION_ER"], "27450");
  assert.equal(factors["JP_HEALTH_W"], "14775");
  assert.equal(factors["JP_HEALTH_ER"], "14775");
  assert.deepEqual(pushed.map((p) => [p.systemKey, p.kind, p.amount, p.sequence]), [
    ["income_tax", "deduction", "6430", 110],
    ["pension", "deduction", "27450", 120],
    ["health", "deduction", "14775", 130],
    ["pension", "employer_contribution", "27450", 220],
    ["health", "employer_contribution", "14775", 230],
  ]);
});

test("adapter: no certificate on file prices the 乙欄", async () => {
  const { ctx, pushed } = fakeCtx({ answers: null });
  const factors = await computeJpStatutoryWithRates(ctx, TOKYO_RATE);
  assert.equal(factors["JP_GENSEN"], "38600");
  assert.equal(pushed[0]?.systemKey, "income_tax");
  assert.equal(pushed[0]?.amount, "38600");
});

test("adapter: dependent flags stack onto the 甲欄 count", async () => {
  const { ctx } = fakeCtx({
    answers: {
      fuyo_count: "1",
      honnin_shogai: "true",
      hitori_oya: null,
      kafu: null,
      kinro_gakusei: null,
      kazoku_shogai_kasan: "1",
    },
  });
  // 1 + 1 (本人障害) + 1 (家族) = 3人 → row 71 → 1,580.
  const factors = await computeJpStatutoryWithRates(ctx, TOKYO_RATE);
  assert.equal(factors["JP_GENSEN"], "1580");
});

test("adapter refusals name the missing channel", async () => {
  // Unconfigured prefecture rate.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({}).ctx, { healthRate: null }),
    /jp_health_rate.*13/,
  );
  // Unknown prefecture.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ region: "99" }).ctx, TOKYO_RATE),
    /not a known JIS prefecture/,
  );
  // Non-monthly cadence.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ periodsPerYear: 13 }).ctx, TOKYO_RATE),
    /monthly payroll only/,
  );
  // Bonus money without the bonus table.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ nonPeriodic: "50000.0000" }).ctx, TOKYO_RATE),
    /賞与/,
  );
  // No grade on file.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ emp: { jp_hyojun_hoshu: null, jp_kaigo_dainigou: "false" } }).ctx, TOKYO_RATE),
    /jp_hyojun_hoshu/,
  );
  // Unknown grade value.
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ emp: { jp_hyojun_hoshu: "99000", jp_kaigo_dainigou: "false" } }).ctx, TOKYO_RATE),
    /matches no 厚生年金 grade/,
  );
  // 介護第2号 refuses; undeclared status refuses too (never defaults down).
  for (const kaigo of ["true", null]) {
    await assert.rejects(
      computeJpStatutoryWithRates(
        fakeCtx({ emp: { jp_hyojun_hoshu: "300000", jp_kaigo_dainigou: kaigo } }).ctx,
        TOKYO_RATE,
      ),
      /jp_kaigo_dainigou/,
    );
  }
  // Eight dependents: the 1,610円 rule is not transcribed.
  await assert.rejects(
    computeJpStatutoryWithRates(
      fakeCtx({
        answers: {
          fuyo_count: "8",
          honnin_shogai: null,
          hitori_oya: null,
          kafu: null,
          kinro_gakusei: null,
          kazoku_shogai_kasan: null,
        },
      }).ctx,
      TOKYO_RATE,
    ),
    /0–7/,
  );
  // Base at the formula rows refuses.
  await assert.rejects(
    computeJpStatutoryWithRates(
      fakeCtx({ income: "900000.0000", emp: { jp_hyojun_hoshu: "650000", jp_kaigo_dainigou: "false" } }).ctx,
      TOKYO_RATE,
    ),
    /740,000/,
  );
  // Sub-yen gross refuses (JPY has no minor unit).
  await assert.rejects(
    computeJpStatutoryWithRates(fakeCtx({ income: "300000.5000" }).ctx, TOKYO_RATE),
    /whole yen/,
  );
});

test("JP profile jurisdictions resolve to declared prefecture calendars", () => {
  // Every profile names its JIS prefecture, so the engine resolves
  // jurisdictionKey("JP", "<code>") = "JP-<code>". A bare "JP" key
  // declares a calendar no employee reaches, and the
  // undeclared-jurisdiction gate then refuses every period containing a
  // mandatory holiday. One entry per prefecture sharing the national
  // 国民の祝日 (ES precedent); the equinoxes stay out exactly as before.
  const byKey = new Map(JP_PAYROLL_PACK.jurisdictions.map((j) => [j.key, j]));
  assert.equal(JP_PAYROLL_PACK.jurisdictions.length, 47);
  for (const code of JP_PAYROLL_PACK.regions.known) {
    assert.equal(jurisdictionKey("JP", code), `JP-${code}`);
    assert.equal(payrollJurisdictionDeclared(`JP-${code}`), true, code);
    assert.equal(byKey.get(`JP-${code}`)?.holidays.length, 14, code);
  }
  assert.equal(
    undeclaredJurisdictionHolidayConflict({
      country: "JP",
      jurisdiction: "JP-13",
      from: "2026-01-01",
      to: "2026-01-31",
    }),
    null,
  );
});
