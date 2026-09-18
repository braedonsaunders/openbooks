/**
 * GB pack declaration tests — pure, no database.
 *
 * What these prove: the pack declares its nations, certificates, slots,
 * transcribed 2026/27 edition and refusals through the existing pack
 * channels. The 2026/27 rUK tables ARE transcribed (rates.ts), the engine
 * reads them (compute-statutory.ts), and parity.test.ts proves the numbers;
 * Scotland stays refused by name. Run with `node --import tsx
 * engine/src/payroll/gb/pack.test.ts`.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { taxYearFor } from "../packs.ts";
import { gbPackFilings } from "./filings.ts";
import {
  GB_CERTIFICATES,
  GB_REGIONS,
  GB_WITHHOLDING,
} from "./jurisdictions.ts";
import { GB_PACK_RATES, GB_TAX_YEARS } from "./rates.ts";
import { GB_PACK } from "./pack.ts";

test("GB nations are known, rUK supported, Scotland refused by name", () => {
  assert.deepEqual(GB_REGIONS.known, ["ENG", "SCT", "WLS", "NIR"]);
  assert.deepEqual(GB_REGIONS.supported, ["ENG", "WLS", "NIR"]);
  const scottish = GB_REGIONS.unsupportedReasons?.SCT ?? "";
  assert.match(scottish, /Scottish/);
  assert.match(scottish, /SCT/);
  assert.match(scottish, /no SCT edition is transcribed/);
});

test("withholding implements rUK nations, refuses Scotland, guesses no cross-border rule", () => {
  assert.equal(GB_WITHHOLDING.country, "GB");
  assert.deepEqual(
    GB_WITHHOLDING.regions.map((region) => region.region),
    ["ENG", "SCT", "WLS", "NIR"],
  );
  for (const region of GB_WITHHOLDING.regions) {
    assert.equal(region.implemented, region.region !== "SCT", region.region);
    assert.equal(region.residentWithholding, "unknown", region.region);
    assert.equal(region.residentWithholdingImplemented, false, region.region);
    assert.deepEqual(region.subRegions, [], region.region);
  }
  const scotland = GB_WITHHOLDING.regions.find((region) => region.region === "SCT")!;
  assert.match(scotland.unimplementedReason ?? "", /no SCT edition is transcribed/);
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

test("2026/27 IS transcribed with its edition stamp, and the pack is installable", () => {
  assert.equal(GB_TAX_YEARS.editions.length, 1);
  const [edition] = GB_TAX_YEARS.editions;
  assert.equal(edition!.year, 2026);
  assert.equal(edition!.effectiveFrom, "2026-04-06");
  assert.match(edition!.citation, /rates-and-thresholds-for-employers-2026-to-2027/);
  assert.equal(edition!.status, "published");
  assert.ok(GB_TAX_YEARS.regionsWithOwnTables.includes("SCT"));
  // SCT publishes separately and has no edition: no silent rUK fall-through.
  assert.ok(!GB_TAX_YEARS.editions.some((entry) => entry.region === "SCT"));
  assert.equal(GB_PACK.installable, true);
  assert.equal(GB_PACK.statutoryCurrency, "GBP");
  assert.equal(GB_PACK_RATES.country, "GB");
});

test("the Employment Allowance is tenant-entered, never a computed constant", () => {
  assert.deepEqual(
    GB_PACK_RATES.slots.map((slot) => slot.key),
    ["gb_employment_allowance"],
  );
  const [slot] = GB_PACK_RATES.slots;
  assert.equal(slot!.scope, "org");
  assert.equal(slot!.fields[0]!.max, "10500");
  assert.match(slot!.variesBecause, /single-director/);
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


