/**
 * The resolution order, tested as a pure function.
 *
 * These cases are written against SYNTHETIC jurisdictions registered under a
 * fake country, not against the US pack. That is deliberate: the resolver's
 * contract is with the DECLARATION, and testing it through real states would
 * make it impossible to tell a resolver bug from a transcription bug, and would
 * quietly bless whatever the US pack happens to declare today.
 *
 * The US pack's own declarations are exercised separately, in
 * engine/src/payroll/us/states/index.test.ts.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  registerPayrollReciprocity, unregisterPayrollReciprocity,
} from "./reciprocity.ts";
import {
  type PayrollRegionWithholding,
  registerPayrollWithholding,
  unregisterPayrollWithholding,
} from "./withholding-jurisdictions.ts";
import { compareRates, resolveWithholding } from "./withholding-resolution.ts";

const COUNTRY = "ZZTEST";

const region = (
  code: string,
  over: Partial<PayrollRegionWithholding> = {},
): PayrollRegionWithholding => ({
  region: code,
  label: `${code} income tax`,
  implemented: true,
  taxesNonresidentWages: true,
  residentWithholding: "not_required",
  residentWithholdingImplemented: false,
  certificateKey: `${code.toLowerCase()}_cert`,
  subRegions: [],
  subRegionConflictRule: "both",
  citation: "test",
  ...over,
});

/** WORK has a city; HOME has a city; NOTAX levies nothing; GONE is unbuilt. */
function setup(): void {
  unregisterPayrollWithholding(COUNTRY);
  unregisterPayrollReciprocity(COUNTRY);
  registerPayrollWithholding({
    country: COUNTRY,
    regions: [
      region("WORK", {
        subRegions: [
          {
            code: "CITY", label: "Work City tax", kind: "city",
            reaches: ["resident", "nonresident"], rateSource: { kind: "pack" },
            citation: "city ordinance", implemented: true,
          },
          {
            code: "OWNTERMS", label: "Independent City tax", kind: "city",
            reaches: ["resident", "nonresident"], rateSource: { kind: "pack" },
            settlesIndependently: true, citation: "separate act", implemented: true,
          },
          {
            code: "UNBUILT", label: "Unbuilt City tax", kind: "city",
            reaches: ["nonresident"], rateSource: { kind: "pack" },
            citation: "city ordinance", implemented: false,
          },
        ],
        openSubRegions: {
          kind: "municipality", label: "Open municipality {code}",
          codePattern: "^\\d{6}$", reaches: ["resident", "nonresident"],
          rateSource: { kind: "tenant", rateKey: "zz_local" },
          citation: "open register", implemented: true,
        },
      }),
      region("HIGHER", { subRegionConflictRule: "higher_rate",
        subRegions: [
          {
            code: "111111", label: "Higher-rule work city", kind: "city",
            reaches: ["nonresident"], rateSource: { kind: "tenant", rateKey: "zz_local" },
            citation: "act", implemented: true,
          },
        ],
        openSubRegions: {
          kind: "municipality", label: "Municipality {code}",
          codePattern: "^\\d{6}$", reaches: ["resident", "nonresident"],
          rateSource: { kind: "tenant", rateKey: "zz_local" },
          citation: "act", implemented: true,
        },
      }),
      region("HOME", {
        subRegions: [{
          code: "HOMECITY", label: "Home City tax", kind: "city",
          reaches: ["resident"], rateSource: { kind: "pack" },
          citation: "city ordinance", implemented: true,
        }],
      }),
      region("NOTAX", {
        taxesNonresidentWages: false,
        residentWithholding: "none",
        residentWithholdingImplemented: true,
      }),
      region("GONE", { implemented: false, unimplementedReason: "nobody transcribed it" }),
      region("STRICT", { residentWithholding: "required", residentWithholdingImplemented: false }),
      region("CREDIT", {
        residentWithholding: "required_net_of_credit", residentWithholdingImplemented: true,
      }),
      region("UNKNOWN", { residentWithholding: "unknown" }),
    ],
  });
  registerPayrollReciprocity({
    country: COUNTRY,
    agreements: [
      {
        workRegion: "WORK", residenceRegion: "HOME", taxedBy: "residence",
        certificateKey: "home_nonres", withoutCertificate: "work_region",
        relievesSubRegionLevies: false, citation: "the agreement",
      },
      {
        workRegion: "WORK", residenceRegion: "CREDIT", taxedBy: "residence",
        certificateKey: null, withoutCertificate: "work_region",
        relievesSubRegionLevies: true, citation: "automatic agreement",
      },
    ],
  });
}

setup();
test.after(() => {
  unregisterPayrollWithholding(COUNTRY);
  unregisterPayrollReciprocity(COUNTRY);
});

type Facts = Omit<Parameters<typeof resolveWithholding>[0], "country">;
const resolve = (over: Facts) => resolveWithholding({ ...over, country: COUNTRY });

/* --------------------------------------------------------------------- */
/* Step 0 — residence normalization                                       */
/* --------------------------------------------------------------------- */

test("an unrecorded residence resolves to the work region, and SAYS SO", () => {
  // The load-bearing back-compatibility case: every profile row written before
  // the residence attribute existed carries null, and refusing to pay them
  // would break every existing US payroll to fix a case most of them are not in.
  const resolved = resolve({ workRegion: "WORK" });
  assert.equal(resolved.residenceRegion, "WORK");
  assert.equal(resolved.residenceSource, "assumed");
  // Assumed, but never silently: the trace carries it so readiness can ask.
  assert.match(resolved.trace.join("\n"), /no residence region recorded/);
  assert.deepEqual(resolved.levies.map((levy) => levy.region), ["WORK"]);
  assert.equal(resolved.levies[0]!.basis, "resident");
});

test("a recorded residence equal to the work region is not a cross-border case", () => {
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "WORK" });
  assert.equal(resolved.residenceSource, "recorded");
  assert.equal(resolved.agreement, null);
  assert.match(resolved.trace.join("\n"), /reciprocity is not consulted/);
});

test("a work region is required — there is no sensible default", () => {
  assert.throws(() => resolve({ workRegion: "" }), /without a work region/);
});

/* --------------------------------------------------------------------- */
/* Step 3a/3b — reciprocity, with and without the certificate             */
/* --------------------------------------------------------------------- */

test("reciprocity WITH the certificate moves the tax to the residence region", () => {
  const resolved = resolve({
    workRegion: "WORK", residenceRegion: "HOME", certificatesOnFile: ["home_nonres"],
  });
  assert.equal(resolved.reciprocityUnclaimed, false);
  const regions = resolved.levies.filter((levy) => levy.level === "region");
  assert.deepEqual(regions.map((levy) => levy.region), ["HOME"]);
  assert.equal(regions[0]!.basis, "reciprocity");
  // The authority is named, because an auditor will ask which form relieved the
  // work region and "the code said so" is not an answer.
  assert.equal(regions[0]!.agreement?.citation, "the agreement");
  assert.equal(resolved.gaps.length, 0);
});

test("reciprocity WITHOUT the certificate withholds the WORK region, loudly", () => {
  // The most valuable case in the file. It is the state most new cross-border
  // hires are in, the withholding is CORRECT, and it is invisible in every
  // system that models reciprocity as a boolean on the employee.
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "HOME" });
  assert.equal(resolved.reciprocityUnclaimed, true);
  const regions = resolved.levies.filter((levy) => levy.level === "region");
  assert.deepEqual(regions.map((levy) => levy.region), ["WORK"]);
  assert.equal(regions[0]!.basis, "nonresident");
  // Advisory, not blocking: withholding the work region is right, and stopping
  // the payroll over a missing form would be wrong.
  const advisory = resolved.gaps.filter((gap) => gap.severity === "advisory");
  assert.equal(advisory.length, 1);
  assert.match(advisory[0]!.message, /home_nonres/);
  assert.match(advisory[0]!.message, /Collect the form/);
});

test("an agreement requiring no certificate applies on its own", () => {
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "CREDIT" });
  assert.equal(resolved.reciprocityUnclaimed, false);
  assert.deepEqual(
    resolved.levies.filter((levy) => levy.level === "region").map((levy) => levy.region),
    ["CREDIT"],
  );
});

test("reciprocity is DIRECTIONAL — the reverse pair has no agreement", () => {
  // WORK→HOME is declared; HOME→WORK is not. A symmetric lookup would relieve
  // the wrong region for the reverse commuter.
  const resolved = resolve({ workRegion: "HOME", residenceRegion: "WORK" });
  assert.equal(resolved.agreement, null);
  assert.deepEqual(
    resolved.levies.filter((levy) => levy.level === "region").map((levy) => levy.region),
    ["HOME"],
  );
});

/* --------------------------------------------------------------------- */
/* Step 3d — the residence region's own claim                             */
/* --------------------------------------------------------------------- */

test("a residence region that requires withholding we cannot compute BLOCKS", () => {
  // Refuse, don't approximate. Withholding only the work region here
  // under-withholds by the entire residence-region liability, and nothing
  // downstream can detect it.
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "STRICT" });
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!.message, /requires the employer to withhold on wages earned outside/);
  // The work region is still resolved — the gap is additive, not a replacement.
  assert.ok(resolved.levies.some((levy) => levy.region === "WORK"));
});

test("an UNESTABLISHED residence rule blocks rather than picking a side", () => {
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "UNKNOWN" });
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!.message, /has not established whether/);
  assert.match(blocking[0]!.message, /neither is assumed/);
});

test("a residence region with a computable credit rule names the region to credit", () => {
  const resolved = resolve({ workRegion: "HOME", residenceRegion: "CREDIT" });
  const residence = resolved.levies.find((levy) => levy.side === "residence");
  assert.equal(residence?.region, "CREDIT");
  assert.equal(residence?.basis, "resident_out_of_region");
  // The work region must be computed first — this is why step 1 is step 1.
  assert.equal(residence?.creditAgainstRegion, "HOME");
  assert.equal(resolved.levies[0]!.region, "HOME");
});

test("a residence region with no wage tax makes no claim", () => {
  const resolved = resolve({ workRegion: "WORK", residenceRegion: "NOTAX" });
  assert.deepEqual(resolved.levies.map((levy) => levy.region), ["WORK"]);
  assert.equal(resolved.gaps.length, 0);
});

test("a no-tax work region withholds nothing and is not an error", () => {
  const resolved = resolve({ workRegion: "NOTAX", residenceRegion: "NOTAX" });
  assert.deepEqual(resolved.levies, []);
  assert.deepEqual(resolved.gaps, []);
  assert.match(resolved.trace.join("\n"), /levies no wage income tax/);
});

test("an unimplemented region blocks by NAME with the declared reason", () => {
  const resolved = resolve({ workRegion: "GONE", residenceRegion: "GONE" });
  assert.equal(resolved.levies.length, 0);
  assert.equal(resolved.gaps[0]!.severity, "blocking");
  assert.match(resolved.gaps[0]!.message, /nobody transcribed it/);
});

/* --------------------------------------------------------------------- */
/* Steps 4-5 — sub-region levies                                          */
/* --------------------------------------------------------------------- */

test("a work-side sub-region levy reaches nonresidents; a residence-side one residents", () => {
  const resolved = resolve({
    workRegion: "WORK", residenceRegion: "HOME",
    certificatesOnFile: ["home_nonres"],
    workSubRegions: ["CITY"], residenceSubRegions: ["HOMECITY"],
  });
  const subs = resolved.levies.filter((levy) => levy.level === "sub_region");
  assert.deepEqual(
    subs.map((levy) => [levy.subRegion, levy.reach, levy.side]),
    [["HOMECITY", "resident", "residence"], ["CITY", "nonresident", "work"]],
  );
});

test("reciprocity does NOT cascade to a sub-region levy that declares it does not", () => {
  // The Philadelphia case in miniature. The state tax moved to the residence
  // region; the city tax stands, and the trace says why.
  const resolved = resolve({
    workRegion: "WORK", residenceRegion: "HOME",
    certificatesOnFile: ["home_nonres"], workSubRegions: ["CITY"],
  });
  assert.ok(resolved.levies.some((levy) => levy.subRegion === "CITY"));
  assert.match(resolved.trace.join("\n"), /does not bind a sub-region/);
});

test("reciprocity DOES cascade when the agreement says it reaches sub-regions", () => {
  const resolved = resolve({
    workRegion: "WORK", residenceRegion: "CREDIT", workSubRegions: ["CITY"],
  });
  assert.equal(resolved.levies.some((levy) => levy.subRegion === "CITY"), false);
  assert.match(resolved.trace.join("\n"), /is relieved by the/);
});

test("a levy that does not reach this side is skipped, not withheld", () => {
  // HOMECITY reaches residents only. Someone who WORKS there and lives
  // elsewhere owes it nothing.
  const resolved = resolve({
    workRegion: "HOME", residenceRegion: "HOME", workSubRegions: ["HOMECITY"],
    residenceSubRegions: [],
  });
  assert.equal(resolved.levies.filter((levy) => levy.level === "sub_region").length, 0);
  assert.match(resolved.trace.join("\n"), /does not reach nonresidents/);
});

test("an unimplemented sub-region levy BLOCKS by name rather than withholding zero", () => {
  const resolved = resolve({ workRegion: "WORK", workSubRegions: ["UNBUILT"] });
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!.message, /Unbuilt City tax levies its own income tax/);
  assert.match(blocking[0]!.message, /would under-withhold/);
});

test("an unknown sub-region code blocks and quotes the declared code pattern", () => {
  const resolved = resolve({ workRegion: "WORK", workSubRegions: ["NOPE"] });
  assert.match(resolved.gaps[0]!.message, /is not a sub-region/);
  assert.match(resolved.gaps[0]!.message, /identifies each municipality by a code matching/);
});

test("an OPEN sub-region registry admits a code matching the declared pattern", () => {
  // Pennsylvania's 2,500 PSD codes cannot be enumerated in a pack, so the pack
  // declares the SHAPE and the employer supplies the jurisdiction.
  const resolved = resolve({ workRegion: "WORK", workSubRegions: ["123456"] });
  const sub = resolved.levies.find((levy) => levy.level === "sub_region");
  assert.equal(sub?.subRegion, "123456");
  assert.equal(sub?.label, "Open municipality 123456");
});

test("a levy declared settlesIndependently leaves the conflict comparison entirely", () => {
  const resolved = resolve({
    workRegion: "WORK", residenceRegion: "WORK",
    workSubRegions: ["OWNTERMS"], residenceSubRegions: ["CITY"],
  });
  assert.ok(resolved.levies.some((levy) => levy.subRegion === "OWNTERMS"));
  assert.match(resolved.trace.join("\n"), /settles independently/);
});

/* --------------------------------------------------------------------- */
/* Step 5 — higher_rate                                                   */
/* --------------------------------------------------------------------- */

test("higher_rate picks the work-location rate when it is higher", () => {
  // DCED's own worked case: Bethlehem resident at 1.000% working in Allentown
  // at 1.280% nonresident → 1.280% is withheld.
  const resolved = resolve({
    workRegion: "HIGHER", residenceRegion: "HIGHER",
    workSubRegions: ["111111"], residenceSubRegions: ["222222"],
    subRegionRates: { "111111:nonresident": "0.0128", "222222:resident": "0.0100" },
  });
  const subs = resolved.levies.filter((levy) => levy.level === "sub_region");
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.subRegion, "111111");
  // Remitted on the resident basis: the higher-of rule picks a RATE, and the
  // residence jurisdiction is the destination.
  assert.equal(subs[0]!.basis, "resident");
});

test("higher_rate keeps the residence rate when it is higher", () => {
  const resolved = resolve({
    workRegion: "HIGHER", residenceRegion: "HIGHER",
    workSubRegions: ["111111"], residenceSubRegions: ["222222"],
    subRegionRates: { "111111:nonresident": "0.0130", "222222:resident": "0.0160" },
  });
  const subs = resolved.levies.filter((levy) => levy.level === "sub_region");
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.subRegion, "222222");
});

test("higher_rate with a missing rate BLOCKS rather than picking a side", () => {
  const resolved = resolve({
    workRegion: "HIGHER", residenceRegion: "HIGHER",
    workSubRegions: ["111111"], residenceSubRegions: ["222222"],
    subRegionRates: { "222222:resident": "0.0100" },
  });
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.match(blocking[0]!.message, /rate has not been entered/);
});

/* --------------------------------------------------------------------- */
/* Rate comparison                                                        */
/* --------------------------------------------------------------------- */

test("rates compare exactly, with no float in the path", () => {
  // Which jurisdiction receives an employee's money must not depend on which
  // side of a binary rounding boundary a rate falls.
  assert.equal(compareRates("0.0128", "0.0100"), 1);
  assert.equal(compareRates("0.0100", "0.0128"), -1);
  assert.equal(compareRates("0.01", "0.0100"), 0);
  assert.equal(compareRates("0.010000001", "0.01"), 1);
  // Differing integer widths must not compare as strings.
  assert.equal(compareRates("10", "9.9999"), 1);
  assert.equal(compareRates("0.9", "10"), -1);
  // 0.1 + 0.2 territory: exact decimal strings, never parsed to a double.
  assert.equal(compareRates("0.30000000000000004", "0.3"), 1);
  assert.throws(() => compareRates("-0.01", "0.01"), /non-negative decimal rate/);
});
