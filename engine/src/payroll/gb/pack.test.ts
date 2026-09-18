/**
 * GB pack skeleton tests — pure, no database.
 *
 * What these prove: the pack declares its nations, certificates, slots and
 * refusals through the existing pack channels, transcribes NOTHING (no bands,
 * no thresholds, no rates anywhere in `engine/src/payroll/gb/`), and refuses
 * every calculation by name. Run with `node --import tsx
 * engine/src/payroll/gb/pack.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { taxYearFor } from "../packs.ts";
import type {
  PayrollStatutoryComputeContext,
  PushStatutoryFn,
} from "../statutory-context.ts";
import { computeGbStatutory } from "./compute-statutory.ts";
import { gbPackFilings } from "./filings.ts";
import {
  GB_CERTIFICATES,
  GB_REGIONS,
  GB_WITHHOLDING,
} from "./jurisdictions.ts";
import { GB_PACK_RATES, GB_TAX_YEARS } from "./rates.ts";
import { GB_COUNTRY_CODE, GB_PACK } from "./pack.ts";

test("GB nations are known and none are supported, with Scotland refused by name", () => {
  assert.deepEqual(GB_REGIONS.known, ["ENG", "SCT", "WLS", "NIR"]);
  assert.deepEqual(GB_REGIONS.supported, []);
  assert.match(GB_REGIONS.unsupportedReason, /not transcribed/);
  const scottish = GB_REGIONS.unsupportedReasons?.SCT ?? "";
  assert.match(scottish, /Scottish/);
  assert.match(scottish, /SCT/);
});

test("withholding declares four unimplemented nations and guesses no cross-border rule", () => {
  assert.equal(GB_WITHHOLDING.country, "GB");
  assert.deepEqual(
    GB_WITHHOLDING.regions.map((region) => region.region),
    ["ENG", "SCT", "WLS", "NIR"],
  );
  for (const region of GB_WITHHOLDING.regions) {
    assert.equal(region.implemented, false, region.region);
    assert.equal(region.residentWithholding, "unknown", region.region);
    assert.equal(region.residentWithholdingImplemented, false, region.region);
    assert.deepEqual(region.subRegions, [], region.region);
  }
});

test("certificates are a starter checklist and a coding notice, not a W-4 clone", () => {
  assert.equal(GB_CERTIFICATES.country, "GB");
  assert.deepEqual(
    GB_CERTIFICATES.certificates.map((certificate) => certificate.key),
    ["gb_starter_checklist", "gb_tax_code_notice"],
  );
  const [checklist, notice] = GB_CERTIFICATES.certificates;
  const declaration = checklist!.fields.find((field) => field.key === "starter_declaration")!;
  assert.deepEqual(
    declaration.choices!.map((choice) => choice.value),
    ["A", "B", "C"],
  );
  // No allowances, no filing statuses, no extra-withholding amount: the
  // checklist routes to an emergency code and HMRC issues the real one.
  for (const field of [...checklist!.fields, ...notice!.fields]) {
    assert.ok(!/allowance|filing_status|extra/i.test(field.key), field.key);
  }
  // The tax code rides the channel's short-free-string kind; the Scottish S
  // prefix lives inside the value, so no separate Scottish certificate exists.
  const taxCode = notice!.fields.find((field) => field.key === "tax_code")!;
  assert.equal(taxCode.kind, "code");
});

test("slots are PAYE plus employee/employer NIC only — no loan, no pension", () => {
  assert.deepEqual(
    GB_PACK.statutorySlots.map((slot) => slot.key),
    ["paye", "nic"],
  );
  const [paye, nic] = GB_PACK.statutorySlots;
  assert.equal(paye!.components[0]!.assessedOn, "taxable_income");
  assert.deepEqual(
    nic!.components.map((component) => component.kind),
    ["deduction", "employer_contribution"],
  );
  for (const component of nic!.components) {
    assert.equal(component.assessedOn, "earnings");
  }
});

test("no year is transcribed and the pack is not installable", () => {
  assert.deepEqual(GB_TAX_YEARS.editions, []);
  assert.ok(GB_TAX_YEARS.regionsWithOwnTables.includes("SCT"));
  assert.equal(GB_PACK.installable, false);
  assert.equal(GB_PACK.statutoryCurrency, "GBP");
  assert.equal(GB_PACK_RATES.country, "GB");
});

test("the GB tax year opens 6 April and is named for the opening year", () => {
  assert.equal(taxYearFor(GB_PACK.taxYear, "2026-04-05"), 2025);
  assert.equal(taxYearFor(GB_PACK.taxYear, "2026-04-06"), 2026);
  assert.equal(taxYearFor(GB_PACK.taxYear, "2027-04-05"), 2026);
});

test("filings declare the PAYE program type and no year-end return yet", () => {
  const filings = gbPackFilings();
  assert.equal(filings.country, "GB");
  assert.deepEqual(
    filings.programTypes.map((program) => program.key),
    ["gb_paye"],
  );
  assert.deepEqual(filings.yearEnd, []);
});

function gbContext(overrides: { taxYear: number }): PayrollStatutoryComputeContext {
  return {
    tx: {},
    orgId: "org",
    documentId: "doc",
    employeePartyId: "emp",
    employeeName: "Test Employee",
    taxYear: overrides.taxYear,
    country: GB_COUNTRY_CODE,
    region: "ENG",
    run: {},
    emp: {},
    filingAccountId: null,
    periodsPerYear: 12,
    income: "0",
    nonPeriodic: "0",
    pensionable: "0",
    insurable: "0",
    deduction: () => "0",
    pushStatutory: (() => {}) as unknown as PushStatutoryFn,
    storedCertificates: [],
    certificateFor: () => null,
    bool: () => false,
    assertRegionSupported: () => {},
    employerLevies: {},
  } as unknown as PayrollStatutoryComputeContext;
}

test("computeGbStatutory refuses the untranscribed year by name", async () => {
  await assert.rejects(
    computeGbStatutory(gbContext({ taxYear: 2026 })),
    /no transcribed.*tables for 2026/,
  );
});
