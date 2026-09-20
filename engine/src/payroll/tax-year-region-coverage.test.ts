import assert from "node:assert/strict";
import test from "node:test";
import { formatInZone } from "../platform/business-date.ts";
import { now } from "../platform/clock.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  declaredPayrollTaxYears,
  payrollTaxYearForDate,
  payrollTaxYearProblem,
} from "./packs.ts";

/**
 * The current-year guard, for REGIONS THAT PUBLISH THEIR OWN STATUTORY TABLES.
 *
 * `tax-years.test.ts` holds every installable pack to supporting its own current
 * tax year. Its instrument reads `entry.supported` — the COUNTRY scope — and
 * stops there, even though `payrollTaxYearCoverage()` computes and hands it
 * `entry.regions[]` with per-region `supported` and `draft`. So a region whose
 * own tables lapse is invisible to it: the country's year is loaded, the guard
 * is green, and every employee in that region is refused by name at calculation
 * time.
 *
 * That is not hypothetical, and it is not rare — it is ANNUAL. The rollover
 * generator's own header describes it: "the CRA's T4127 transcribed and
 * published while Revenu Québec's TP-1015 for the same year is not out yet
 * still scaffolds the Quebec half, because 'published' is per SCOPE, not per
 * year." Every January, Canada spends weeks in exactly the state this test
 * exists to name.
 *
 * NO ALLOW-LIST, because the packs already declare the difference between "we
 * deliberately do not cover this region" and "this region's tables should be
 * loaded and are not". Spain declares `regionsWithOwnTables: ["NC", "PV"]` and
 * leaves both OUT of its region coverage's `supported` list, with a reason per
 * region: Navarra and the Basque Historical Territories apply the foral IRPF
 * regime, each Hacienda Foral publishes its own retention tables, and AEAT
 * tables never cover them. A Navarrese employee is refused with that sentence,
 * which is correct behaviour over guessing, so this guard must not go red for
 * it — and does not, because Spain never claimed the region.
 *
 * Quebec is the opposite declaration: claimed AND carrying its own editions. A
 * guard that could not tell those two apart would have to be allow-listed, and
 * an allow-list here would eventually hide the January it matters.
 */

/** Regions a pack claims to support, from its own declaration. */
function claimedRegions(country: string): readonly string[] {
  const pack = PAYROLL_COUNTRY_PACKS[country as keyof typeof PAYROLL_COUNTRY_PACKS] as
    | { regions?: { supported?: readonly string[] } }
    | undefined;
  return pack?.regions?.supported ?? [];
}

/**
 * The instrument: which CLAIMED region of an installable pack does not have its
 * pack's current tax year loaded. The year comes from the pack's own definition,
 * so a fiscal-year pack is asked about its own year and not the calendar's.
 */
function currentYearRegionGaps(today: string): string[] {
  const gaps: string[] = [];
  for (const declared of declaredPayrollTaxYears()) {
    const pack = PAYROLL_COUNTRY_PACKS[declared.country as keyof typeof PAYROLL_COUNTRY_PACKS] as
      | { installable?: boolean }
      | undefined;
    if (pack?.installable !== true) continue;
    const ownTables = declared.regionsWithOwnTables ?? [];
    if (ownTables.length === 0) continue;
    const claimed = claimedRegions(declared.country);
    const current = payrollTaxYearForDate(declared.country, today).taxYear;
    for (const region of ownTables) {
      // A region the pack does not claim is refused by name at calculation time
      // with the pack's own declared reason. That is the intended state, not a
      // gap — Spain's foral communities are the live example.
      if (!claimed.includes(region)) continue;
      const problem = payrollTaxYearProblem(declared.country, current, region);
      if (problem !== null) {
        gaps.push(
          `${declared.country}-${region} publishes its own statutory tables and does not support `
          + `the current tax year ${current} (${problem.kind}) — see ${declared.ratesModule}`,
        );
      }
    }
  }
  return gaps;
}

test("every claimed region that publishes its own tables supports its current tax year", () => {
  // LIVE, on the product's own business date, so this starts failing the day a
  // region's tables lapse rather than the day someone remembers to look.
  assert.deepEqual(currentYearRegionGaps(formatInZone(now(), "UTC")), []);
});

test("the instrument names a region whose own tables lapse, and ignores an unclaimed one", () => {
  const today = formatInZone(now(), "UTC");

  // FAIL direction, built from the real registry rather than a synthetic pack:
  // a year no jurisdiction has transcribed stands in for "this region's tables
  // are not out yet", which is what every January looks like for Quebec.
  const claimedWithOwnTables = declaredPayrollTaxYears().flatMap((declared) =>
    (declared.regionsWithOwnTables ?? [])
      .filter((region) => claimedRegions(declared.country).includes(region))
      .map((region) => ({ country: declared.country, region })));
  assert.ok(
    claimedWithOwnTables.length > 0,
    "no pack claims a region with its own tables — this guard would be vacuous",
  );
  for (const { country, region } of claimedWithOwnTables) {
    const unloaded = payrollTaxYearForDate(country, today).taxYear + 50;
    const problem = payrollTaxYearProblem(country, unloaded, region);
    assert.ok(
      problem !== null,
      `${country}-${region} reports no problem for tax year ${unloaded}, which nobody has `
      + "transcribed — the region scope is not being consulted at all",
    );
  }

  // Spain's foral communities are declared with their own tables AND left out
  // of the claimed set, so they must NOT appear as gaps. If a later change
  // transcribes them, this assertion is what tells whoever did it to add them
  // to the claimed list too.
  const es = declaredPayrollTaxYears().find((declared) => declared.country === "ES");
  assert.ok(es, "the ES pack no longer declares tax years");
  const foral = (es.regionsWithOwnTables ?? []).filter((region) =>
    !claimedRegions("ES").includes(region));
  assert.deepEqual(
    [...foral].sort(),
    ["NC", "PV"],
    "Spain's unclaimed own-table regions changed: the foral IRPF communities are NC and PV, and a "
    + "change here means either a transcription landed (add it to the claimed list) or coverage "
    + "silently narrowed",
  );
  for (const region of foral) {
    assert.ok(
      payrollTaxYearProblem("ES", payrollTaxYearForDate("ES", today).taxYear, region) !== null,
      `ES-${region} now reports a loaded current year while still unclaimed — a region cannot be `
      + "loaded and unsupported at once",
    );
  }
});
