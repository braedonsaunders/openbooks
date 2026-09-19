import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { AU_PACK_RATES } from "./payroll/au/rates.ts";
import { CA_PACK_RATES } from "./payroll/canada/rates.ts";
import { declaredPackRates, packSlotAppliesToPopulation, payrollPack } from "./payroll/packs.ts";
import {
  assertConfiguredStatutoryRates,
  buildResolution,
  unconfiguredStatutoryRates,
  type StatutoryRateRow,
} from "./payroll/statutory-rates.ts";
import { US_PACK_RATES } from "./payroll/us/rates.ts";

/**
 * The two-field model: appliesWhen (regions) + whenUnconfigured.
 *
 * A live-but-unconfigured `refuse` slot stops the employee BY NAME with the
 * readiness detector's own sentence; `zero` and `legacy` slots keep today's
 * behaviour — compute when configured, nothing when not, never a refusal.
 * Every case is per scope point (this region, this assigned filing account),
 * never "a rate exists somewhere in the org".
 */

const row = (
  rateKey: string,
  region: string | null,
  filingAccountId: string | null,
  values: Record<string, string>,
): StatutoryRateRow => ({
  id: randomUUID(),
  country: "US",
  rateKey,
  region,
  subRegion: null,
  filingAccountId,
  taxYear: 2026,
  values,
});

test("every declared rate slot answers whenUnconfigured explicitly", () => {
  // Required by the type, pinned by value: a slot nobody decided cannot
  // exist, so the per-slot report below is just reading the declarations.
  const answers = new Map<string, string>();
  for (const pack of declaredPackRates()) {
    for (const slot of pack.slots) {
      assert.ok(
        slot.whenUnconfigured === "refuse"
          || slot.whenUnconfigured === "zero"
          || slot.whenUnconfigured === "legacy",
        `${pack.country}/${slot.key} answers whenUnconfigured`,
      );
      answers.set(`${pack.country}/${slot.key}`, slot.whenUnconfigured);
    }
  }
  // The decided core of this change, read back as data.
  assert.deepEqual(
    [...answers.entries()].filter(([, answer]) => answer === "refuse").map(([key]) => key).sort(),
    [
      "BR/br_fap",
      "BR/br_rat",
      "BR/br_terceiros",
      "CA/ca_hsf",
      "DE/de_kvz",
      "IT/it_addizionale_comunale",
      "IT/it_addizionale_regionale",
      "JP/jp_health_rate",
      "US/us_mi_city",
      "US/us_oh_municipal",
      "US/us_pa_local_eit",
      "US/us_sui",
    ],
  );
  assert.deepEqual(
    [...answers.entries()].filter(([, answer]) => answer === "zero").map(([key]) => key).sort(),
    ["CA/ca_eht", "GB/gb_employment_allowance", "US/us_futa"],
  );
  assert.deepEqual(
    [...answers.entries()].filter(([, answer]) => answer === "legacy").map(([key]) => key).sort(),
    ["AU/au_workers_comp", "FR/fr_atmp", "FR/fr_versement_mobilite", "PL/pl_wypadkowe"],
  );
});

test("TX SUI with nothing configured refuses with the detector's sentence", () => {
  const resolution = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, rows: [], legacy: [],
  });
  const account = randomUUID();
  const point = { region: "TX", filingAccountId: account };
  const [detected] = unconfiguredStatutoryRates(resolution, [point]).filter(
    (item) => item.slotKey === "us_sui",
  );
  assert.ok(detected, "the detector names the SUI gap");
  assert.throws(
    () => assertConfiguredStatutoryRates(resolution, point, "Tex Worker"),
    (error: unknown) =>
      error instanceof Error
      && error.message === `Tex Worker: ${detected!.message}`,
    "the refusal reuses the detector's message verbatim, prefixed by the employee",
  );
});

test("SUI rates on other accounts do not pass the EIN-assigned employee", () => {
  const ein = randomUUID();
  const txSui = randomUUID();
  const otherSui = randomUUID();
  const resolution = buildResolution({
    country: "US",
    taxYear: 2026,
    pack: US_PACK_RATES,
    rows: [
      row("us_sui", "TX", txSui, { rate: "0.034", wageBase: "9000" }),
      row("us_sui", "CA", otherSui, { rate: "0.034", wageBase: "7000" }),
      row("us_sui", "NY", otherSui, { rate: "0.041", wageBase: "12700" }),
    ],
    legacy: [],
  });
  assert.throws(
    () => assertConfiguredStatutoryRates(
      resolution, { region: "TX", filingAccountId: ein }, "Tex Worker",
    ),
    /Tex Worker: no State unemployment \(SUI\) rate is configured for TX · the assigned filing account in 2026/,
    "three good rates elsewhere still refuse for this employee",
  );
  // …while the employee assigned to the account the rate is linked to pays.
  assert.doesNotThrow(() =>
    assertConfiguredStatutoryRates(
      resolution, { region: "TX", filingAccountId: txSui }, "Tex Worker",
    ),
  );
});

test("a resolving SUI rate computes — no refusal", () => {
  const account = randomUUID();
  const resolution = buildResolution({
    country: "US",
    taxYear: 2026,
    pack: US_PACK_RATES,
    rows: [row("us_sui", "TX", account, { rate: "0.027", wageBase: "9000" })],
    legacy: [],
  });
  assert.doesNotThrow(() =>
    assertConfiguredStatutoryRates(resolution, { region: "TX", filingAccountId: account }, "Tex Worker"),
  );
});

test("QC HSF unconfigured refuses; ON never evaluates it", () => {
  const resolution = buildResolution({
    country: "CA", taxYear: 2026, pack: CA_PACK_RATES, rows: [], legacy: [],
  });
  assert.throws(
    () => assertConfiguredStatutoryRates(
      resolution, { region: "QC", filingAccountId: null }, "Jean Tremblay",
    ),
    /Jean Tremblay: no Health services fund is configured for QC in 2026 — nothing is being accrued for it/,
  );
  assert.doesNotThrow(() =>
    assertConfiguredStatutoryRates(
      resolution, { region: "ON", filingAccountId: null }, "Ontario Worker",
    ),
  );
});

test("EHT in Ontario unconfigured is legitimate zero — no refusal", () => {
  const resolution = buildResolution({
    country: "CA", taxYear: 2026, pack: CA_PACK_RATES, rows: [], legacy: [],
  });
  assert.doesNotThrow(() =>
    assertConfiguredStatutoryRates(
      resolution, { region: "ON", filingAccountId: null }, "Ontario Worker",
    ),
  );
});

test("account slots apply by population: QC-only slots absent for ON, demanded when unknown", () => {
  // Through the registry, never a direct pack import (which closes the
  // load-order cycle F-reg-002 extracted payroll-error.ts to break).
  const slot = (key: string) => payrollPack("CA").statutorySlots.find((s) => s.key === key)!;
  const on = new Map([["CA", new Set<string | null>(["ON"])]]);
  const qc = new Map([["CA", new Set<string | null>(["QC"])]]);
  const mixed = new Map([["CA", new Set<string | null>(["ON", "QC"])]]);
  for (const key of ["qc_income_tax", "qpip", "hsf"]) {
    assert.equal(packSlotAppliesToPopulation(slot(key), "CA", on), false, `${key} inert for ON`);
    assert.equal(packSlotAppliesToPopulation(slot(key), "CA", qc), true, `${key} live for QC`);
    assert.equal(packSlotAppliesToPopulation(slot(key), "CA", mixed), true, `${key} live for mixed`);
  }
  assert.equal(packSlotAppliesToPopulation(slot("eht"), "CA", on), true, "EHT live for ON");
  assert.equal(
    packSlotAppliesToPopulation(slot("eht"), "CA", new Map([["CA", new Set(["AB"])]])),
    false, "EHT inert where no levying province works",
  );
  for (const key of ["income_tax", "cpp", "ei", "vacation", "wcb"]) {
    assert.equal(packSlotAppliesToPopulation(slot(key), "CA", on), true, `${key} everywhere`);
  }
  // Fail-closed: no population, or a null region, still demands.
  assert.equal(packSlotAppliesToPopulation(slot("hsf"), "CA", undefined), true);
  assert.equal(packSlotAppliesToPopulation(slot("hsf"), "CA", new Map()), true);
  assert.equal(
    packSlotAppliesToPopulation(slot("hsf"), "CA", new Map([["CA", new Set([null])]])),
    true,
  );
});

test("legacy and zero slots keep today's behaviour when unconfigured", () => {
  const au = buildResolution({
    country: "AU", taxYear: 2026, pack: AU_PACK_RATES, rows: [], legacy: [],
  });
  assert.doesNotThrow(() =>
    assertConfiguredStatutoryRates(au, { region: "NSW", filingAccountId: null }, "Sydney Worker"),
  );
  const us = buildResolution({
    country: "US", taxYear: 2026, pack: US_PACK_RATES, rows: [], legacy: [],
  });
  // us_futa is `zero`: the detector still reports it (readiness stays
  // advisory-complete) but the money path never refuses on it.
  assert.ok(
    unconfiguredStatutoryRates(us, [{ region: "TX", filingAccountId: null }])
      .some((item) => item.slotKey === "us_futa"),
  );
});
