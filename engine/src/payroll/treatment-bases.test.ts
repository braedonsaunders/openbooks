/**
 * Pack-declared pre-tax treatments, computed generically (unit partition).
 *
 * The contract under test: each generic base less the deduction lines
 * carrying a treatment the pack declares as reducing that base; undeclared
 * keys and `"none"` subtract nothing; and a protected order iterates only
 * when its treatment moves the statutory pass.
 */
import assert from "node:assert/strict";
import test from "node:test";
// Load-order rule (see pack-load-order.test.ts): packs first, registry
// last — and never a direct leaf import of the CA/US packs, whose subtree
// closes the registry cycle. CA and US come from PAYROLL_COUNTRY_PACKS.
import { AU_PAYROLL_PACK } from "./au/pack.ts";
import { GB_PACK } from "./gb/pack.ts";
import { IE_PAYROLL_PACK } from "./ie/pack.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import {
  protectionTreatmentIterates,
  reduceTaxBases,
} from "./treatment-bases.ts";

const CA_PAYROLL_PACK = PAYROLL_COUNTRY_PACKS["CA"]!;
const US_PAYROLL_PACK = PAYROLL_COUNTRY_PACKS["US"]!;

const BASES = {
  income: "3653.8500",
  nonPeriodic: "0.0000",
  pensionable: "3653.8500",
  insurable: "3653.8500",
};

const SACRIFICE = {
  kind: "deduction",
  amount: "200.0000",
  taxTreatment: "salary_sacrifice",
} as const;

test("AU salary sacrifice reduces the income leg and leaves the other three whole", () => {
  const reduced = reduceTaxBases(
    [
      { kind: "earning", amount: "3653.8500" },
      { ...SACRIFICE },
    ],
    BASES,
    AU_PAYROLL_PACK.deductionTreatments,
  );
  assert.equal(reduced.income, "3453.8500");
  assert.equal(reduced.nonPeriodic, "0.0000");
  assert.equal(reduced.pensionable, "3653.8500");
  assert.equal(reduced.insurable, "3653.8500");
});

test("after-tax lines and undeclared keys never reduce any base", () => {
  const lines = [
    { kind: "deduction", amount: "200.0000", taxTreatment: "none" },
    // A Canadian factor stamped on an AU run is inert: AU declares no such key.
    { kind: "deduction", amount: "200.0000", taxTreatment: "pension_f" },
  ];
  const reduced = reduceTaxBases(lines, BASES, AU_PAYROLL_PACK.deductionTreatments);
  assert.deepEqual(reduced, BASES);
});

test("a foreign factor is inert outside its own pack (no cross-pack leak)", () => {
  const lines = [{ kind: "deduction", amount: "200.0000", taxTreatment: "salary_sacrifice" }];
  for (const pack of [CA_PAYROLL_PACK, GB_PACK, IE_PAYROLL_PACK, US_PAYROLL_PACK]) {
    const reduced = reduceTaxBases(lines, BASES, pack.deductionTreatments);
    assert.deepEqual(
      reduced,
      BASES,
      `${pack.country}: an undeclared salary_sacrifice key must not move any base`,
    );
  }
});

test("every declared treatment reduces income and never a social-insurance leg", () => {
  for (const [country, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    for (const treatment of pack.deductionTreatments) {
      assert.ok(
        treatment.reduces.includes("income"),
        `${country}.${treatment.key}: an income-tax treatment reduces the income leg`,
      );
      assert.ok(
        !treatment.reduces.includes("pensionable") && !treatment.reduces.includes("insurable"),
        `${country}.${treatment.key}: no treatment in the fleet moves a social-insurance base`,
      );
    }
  }
});

test("protection iterates for a declared reducing treatment and unknown tags, never for after-tax", () => {
  const au = AU_PAYROLL_PACK.deductionTreatments;
  assert.equal(protectionTreatmentIterates(au, "salary_sacrifice"), true);
  assert.equal(protectionTreatmentIterates(au, "none"), false);
  assert.equal(protectionTreatmentIterates(au, null), false);
  assert.equal(protectionTreatmentIterates(au, undefined), false);
  // Fail closed: a tag the pack does not declare may still move money
  // elsewhere, so the fast path must not price it once and walk away.
  assert.equal(protectionTreatmentIterates(au, "pension_f"), true);
  // A declared-but-empty vocabulary iterates nothing.
  assert.equal(protectionTreatmentIterates([], "salary_sacrifice"), true);
  assert.equal(protectionTreatmentIterates([], "none"), false);
});
