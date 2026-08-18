/**
 * The US state registry, its refusals, and the pack's own declarations.
 *
 * The refusal tests matter as much as the conformance ones. The doctrine this
 * codebase runs on is "refuse loudly rather than approximate", and a doctrine
 * with no test is a comment.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
  certificateDeclarationProblem, packCertificates, payrollCertificate,
  resolveCertificate,
} from "../../certificates.ts";
import { reciprocityAgreement, reciprocityPartners } from "../../reciprocity.ts";
import {
  packWithholding, regionWithholding, subRegionLevy,
} from "../../withholding-jurisdictions.ts";
import { resolveWithholding } from "../../withholding-resolution.ts";
import { NO_WITHHOLDING_STATES, US_STATES } from "../rates.ts";
// The PACK publishes the US declarations now — see the note in conformance.test.ts.
import "../../packs.ts";
import {
  implementedUsStates, requireUsStateWithholding, supportedUsStates,
  unimplementedUsStates, usStatePublication, usStateWithholdingEngines,
} from "./index.ts";

/* --------------------------------------------------------------------- */
/* The gap, measured and closed                                           */
/* --------------------------------------------------------------------- */

test("the pack now withholds state income tax somewhere", () => {
  // The defect this work exists to fix: `regions.supported` was exactly the
  // nine states that levy NO income tax, so the pack supported only the places
  // with nothing to withhold and refused every state that actually taxes wages.
  // Reported in US_STATES order, not delivery order, so the list reads the same
  // everywhere it is printed.
  assert.deepEqual(
    implementedUsStates(),
    ["CA", "GA", "IL", "MA", "MI", "NJ", "NY", "NC", "OH", "PA"],
  );
  for (const state of implementedUsStates()) {
    assert.equal(
      NO_WITHHOLDING_STATES.has(state), false,
      `${state} is claimed as implemented but levies no income tax — that is not coverage`,
    );
  }
});

test("supported states are the implemented ones PLUS the genuinely no-tax ones", () => {
  const supported = supportedUsStates();
  assert.equal(supported.length, 19); // 10 implemented + 9 no-tax
  for (const state of ["CA", "NY", "PA", "IL", "NJ", "OH", "MI", "MA", "GA", "NC",
    "TX", "FL", "WA"]) {
    assert.ok(supported.includes(state), state);
  }
  // Derived, never a second hand-maintained literal: the old list was a literal
  // and nothing in the codebase could tell that all nine entries were no-tax
  // states.
  assert.deepEqual(
    supported,
    US_STATES.filter((state) =>
      implementedUsStates().includes(state) || NO_WITHHOLDING_STATES.has(state)),
  );
});

/* --------------------------------------------------------------------- */
/* Refusals                                                               */
/* --------------------------------------------------------------------- */

test("an untranscribed state is refused BY NAME, with the publication and the file", () => {
  // Massachusetts was this test's example until the second tranche implemented
  // it. Colorado now carries it, which is the point: the list of states this
  // sentence can be written about is supposed to keep shrinking.
  assert.throws(
    () => requireUsStateWithholding("CO"),
    (error: unknown) => {
      const message = (error as Error).message;
      assert.match(message, /CO income tax withholding is not implemented/);
      assert.match(message, /DR 1098/);
      assert.match(message, /engine\/src\/payroll\/us\/states\/co\.ts/);
      // And the doctrine, stated where the operator reads it.
      assert.match(message, /withholding the federal amount.*would each be silently\s+wrong/s);
      assert.match(message, /Implemented today: CA, GA, IL, MA, MI, NJ, NY, NC, OH, PA/);
      return true;
    },
  );
});

test("a no-tax state returns null rather than throwing — nothing to withhold", () => {
  for (const state of NO_WITHHOLDING_STATES) {
    assert.equal(requireUsStateWithholding(state), null, state);
  }
});

test("every unimplemented state names a publication to transcribe", () => {
  // The list stays honest as states are added: a state that levies a tax, has
  // no engine and has no publication entry fails here.
  const missing = unimplementedUsStates().filter((state) => usStatePublication(state) == null);
  assert.deepEqual(missing, [], `no publication recorded for: ${missing.join(", ")}`);
});

test("a code that is not a US state is refused as such, not as a missing engine", () => {
  assert.throws(() => requireUsStateWithholding("ZZ"), /is not a US state or territory code/);
  assert.throws(() => requireUsStateWithholding(""), /\(unset\)/);
});

test("every engine refuses a year it has not transcribed", () => {
  for (const engine of usStateWithholdingEngines()) {
    const published = engine.editions.filter((edition) => edition.status === "published");
    assert.ok(published.length > 0, `${engine.state} declares no published edition`);
    for (const edition of published) {
      assert.ok(edition.citation, `${engine.state} ${edition.year} has no citation`);
      assert.equal(edition.region, engine.state);
    }
  }
});

/* --------------------------------------------------------------------- */
/* Declarations                                                           */
/* --------------------------------------------------------------------- */

test("every declared region is covered, and every implemented one has an engine", () => {
  const declared = packWithholding("US").regions;
  assert.deepEqual(declared.map((region) => region.region), [...US_STATES]);
  for (const region of declared) {
    if (!region.implemented) {
      assert.ok(region.unimplementedReason, `${region.region} refuses without saying why`);
      continue;
    }
    if (region.residentWithholding === "none") continue;
    assert.ok(
      requireUsStateWithholding(region.region),
      `${region.region} is declared implemented but has no engine`,
    );
  }
});

test("every certificate declaration is well formed and cited", () => {
  for (const certificate of packCertificates("US").certificates) {
    assert.equal(certificateDeclarationProblem(certificate), null, certificate.key);
    assert.ok(certificate.citation, `${certificate.key} has no citation`);
    for (const field of certificate.fields) {
      assert.ok(field.help.length > 20, `${certificate.key}.${field.key} help is too thin`);
    }
  }
});

test("the W-4 reads through profile COLUMNS — one interface, two storages", () => {
  // The migration decision, pinned. The federal and Canadian answers stay in the
  // columns that already hold them; the interface is the same one the state
  // certificates use, so nothing above `resolveCertificate` knows the difference.
  const w4 = payrollCertificate("US", "us_w4");
  assert.equal(w4.storage, "profile_columns");
  const resolved = resolveCertificate({
    certificate: w4,
    profile: {
      filing_status: "married_joint", multiple_jobs: true,
      dependent_credits: "4400.0000", additional_tax_per_period: "25.0000",
    },
  });
  assert.equal(resolved.onFile, true);
  assert.equal(resolved.answers.filing_status, "married_joint");
  assert.equal(resolved.answers.multiple_jobs, "true");
  assert.equal(resolved.answers.dependent_credits, "4400.0000");
  // An untouched profile does not look like a signed W-4.
  assert.equal(resolveCertificate({ certificate: w4, profile: {} }).onFile, false);
  // …but the statutory defaults still apply, because a missing W-4 has a rule.
  assert.equal(resolveCertificate({ certificate: w4, profile: {} }).answers.filing_status, "single");
});

test("state certificates store answers in ROWS, never in a new column", () => {
  for (const key of ["us_ca_de4", "us_ny_it2104", "us_il_ilw4", "us_pa_rev419"]) {
    const certificate = payrollCertificate("US", key);
    assert.equal(certificate.storage, "certificate_rows", key);
    for (const field of certificate.fields) {
      assert.notEqual(field.storage?.kind, "column", `${key}.${field.key}`);
    }
  }
});

/* --------------------------------------------------------------------- */
/* Reciprocity, on the real declarations                                  */
/* --------------------------------------------------------------------- */

test("Pennsylvania's six reciprocal partners, on REV-419", () => {
  assert.deepEqual(
    reciprocityPartners("US", "PA").sort(),
    ["IN", "MD", "NJ", "OH", "VA", "WV"],
  );
  const nj = reciprocityAgreement("US", "PA", "NJ")!;
  assert.equal(nj.taxedBy, "residence");
  assert.equal(nj.certificateKey, "us_pa_rev419");
  assert.equal(nj.withoutCertificate, "work_region");
  // The load-bearing one: the agreement relieves the STATE tax and leaves
  // Philadelphia's wage tax and the Act 32 local EIT fully payable.
  assert.equal(nj.relievesSubRegionLevies, false);
});

test("Illinois's four reciprocal partners, on IL-W-5-NR", () => {
  assert.deepEqual(reciprocityPartners("US", "IL").sort(), ["IA", "KY", "MI", "WI"]);
  assert.equal(reciprocityAgreement("US", "IL", "IA")!.certificateKey, "us_il_ilw5nr");
});

test("NEW YORK HAS NO RECIPROCITY — the canonical NJ/NY case withholds NY in full", () => {
  assert.deepEqual(reciprocityPartners("US", "NY"), []);
  assert.equal(reciprocityAgreement("US", "NY", "NJ"), null);
  const resolved = resolveWithholding({
    country: "US", workRegion: "NY", residenceRegion: "NJ",
  });
  const regions = resolved.levies.filter((levy) => levy.level === "region");
  assert.deepEqual(regions.map((levy) => levy.region), ["NY"]);
  assert.equal(regions[0]!.basis, "nonresident");
  // New Jersey's own claim is now DECLARED — NJ-WT requires the employer to
  // withhold New Jersey tax on a resident's out-of-state wages net of a credit
  // for the other state's — and it is still refused BY NAME, because computing
  // the credit needs New York's withholding as an input and a rule for the
  // part-time case. The refusal changed from "nobody has established New
  // Jersey's rule" to "New Jersey's rule is this and we do not compute it",
  // which is the whole difference the second tranche makes to this case.
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]!.region, "NJ");
  assert.match(blocking[0]!.message, /net of a credit for the work region's tax/);
  assert.match(blocking[0]!.message, /NJ-WT/);
});

test("a New Jersey resident working in PA: reciprocity, with and without REV-419", () => {
  const withForm = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "NJ",
    certificatesOnFile: ["us_pa_rev419"],
  });
  // THE PAIR IS NOW CLOSED. Pennsylvania is relieved and NEW JERSEY IS
  // WITHHELD — which is what a reciprocal agreement is for, and what this case
  // could not do until New Jersey had an engine. Before the second tranche the
  // same call produced no levy at all and a blocking gap saying somebody had to
  // withhold New Jersey tax and this engine could not.
  const withFormRegions = withForm.levies.filter((levy) => levy.level === "region");
  assert.deepEqual(withFormRegions.map((levy) => levy.region), ["NJ"]);
  assert.equal(withFormRegions[0]!.basis, "reciprocity");
  assert.equal(withFormRegions[0]!.certificateKey, "us_nj_njw4");
  assert.deepEqual(withForm.gaps, []);
  assert.match(withForm.trace.join("\n"), /agreement in force/);

  const withoutForm = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "NJ",
  });
  assert.deepEqual(
    withoutForm.levies.filter((levy) => levy.level === "region").map((levy) => levy.region),
    ["PA"],
  );
  assert.equal(withoutForm.reciprocityUnclaimed, true);
  assert.match(
    withoutForm.gaps.find((gap) => gap.severity === "advisory")!.message,
    /us_pa_rev419 with the employer/,
  );
});

test("reciprocity does NOT relieve the Philadelphia wage tax", () => {
  // NJ-WT (September 2025): "The reciprocal agreement does not excuse a
  // Pennsylvania employer from withholding local wage taxes imposed by cities,
  // towns, or other localities in Pennsylvania."
  const resolved = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "NJ",
    certificatesOnFile: ["us_pa_rev419"],
    workSubRegions: ["PHILADELPHIA"],
  });
  const phila = resolved.levies.find((levy) => levy.subRegion === "PHILADELPHIA");
  assert.ok(phila, "Philadelphia was relieved by a state reciprocal agreement — it must not be");
  assert.equal(phila!.reach, "nonresident");
});

test("New Jersey has exactly ONE reciprocal agreement, and it is with Pennsylvania", () => {
  assert.deepEqual(reciprocityPartners("US", "NJ"), ["PA"]);
  const pa = reciprocityAgreement("US", "NJ", "PA")!;
  assert.equal(pa.certificateKey, "us_nj_nj165");
  assert.equal(pa.withoutCertificate, "work_region");
  // MUTUAL, and declared in both directions because the certificate differs by
  // direction: New Jersey takes NJ-165 from a Pennsylvania resident and
  // Pennsylvania takes REV-419 from a New Jersey resident.
  assert.equal(reciprocityAgreement("US", "PA", "NJ")!.certificateKey, "us_pa_rev419");
  // And NOT with New York, in either direction.
  assert.equal(reciprocityAgreement("US", "NJ", "NY"), null);
  assert.equal(reciprocityAgreement("US", "NY", "NJ"), null);
});

test("Ohio's five reciprocal partners, on the IT 4's own waiver", () => {
  assert.deepEqual(reciprocityPartners("US", "OH").sort(), ["IN", "KY", "MI", "PA", "WV"]);
  const mi = reciprocityAgreement("US", "OH", "MI")!;
  assert.equal(mi.taxedBy, "residence");
  assert.equal(mi.certificateKey, "us_oh_it4");
  assert.equal(mi.withoutCertificate, "work_region");
  // The IT 4 waives Ohio AND SCHOOL DISTRICT withholding and says nothing about
  // municipal income tax, which the state cannot waive on a municipality's
  // behalf.
  assert.equal(mi.relievesSubRegionLevies, false);
  // Ohio and Michigan are reciprocal in BOTH directions, and each direction
  // names its own paperwork.
  assert.equal(reciprocityAgreement("US", "MI", "OH")!.certificateKey, "us_mi_nonresidency");
});

test("Michigan's SIX reciprocal partners, on a certificate the state does not print", () => {
  // Illinois, Indiana, Kentucky, Minnesota, Ohio and Wisconsin. Minnesota and
  // Illinois are the two most often dropped from a half-remembered list.
  assert.deepEqual(
    reciprocityPartners("US", "MI").sort(), ["IL", "IN", "KY", "MN", "OH", "WI"],
  );
  const ohio = reciprocityAgreement("US", "MI", "OH")!;
  assert.equal(ohio.taxedBy, "residence");
  // Form 446: "Treasury does not furnish nonresidency certificates. The
  // employer may develop a form or obtain a letter from the employee … The
  // employer keeps the form as its authority not to withhold." So there is a
  // certificate; it just has no form number. Declaring it keeps the agreement
  // from applying to someone who never told their employer in writing.
  assert.equal(ohio.certificateKey, "us_mi_nonresidency");
  assert.equal(ohio.withoutCertificate, "work_region");
  assert.equal(ohio.relievesSubRegionLevies, false);
  const nonresidency = payrollCertificate("US", "us_mi_nonresidency");
  assert.equal(nonresidency.purpose, "non_residence");
  assert.equal(nonresidency.form, "(employer-developed)");
});

test("an agreement with an UNIMPLEMENTED partner refuses — it never withholds zero", () => {
  // The trap this whole tranche was warned about: Ohio's agreement with Indiana
  // is real, so it is declared, and Indiana has no engine. With the waiver on
  // file Ohio withholds nothing and Indiana's tax is owed instead — so the run
  // must STOP and name Indiana, not quietly pay the employee with no state tax
  // withheld at all.
  const resolved = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "IN",
    certificatesOnFile: ["us_oh_it4"],
  });
  assert.deepEqual(resolved.levies.filter((levy) => levy.level === "region"), []);
  const blocking = resolved.gaps.filter((gap) => gap.severity === "blocking");
  assert.equal(blocking.length, 1);
  assert.equal(blocking[0]!.region, "IN");
  assert.match(blocking[0]!.message, /IN income tax withholding is not implemented/);
  assert.match(blocking[0]!.message, /Departmental Notice #1/);

  // Without the waiver, Ohio withholds — correctly — and says why.
  const withoutWaiver = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "IN",
  });
  assert.deepEqual(
    withoutWaiver.levies.filter((levy) => levy.level === "region").map((levy) => levy.region),
    ["OH"],
  );
  assert.equal(withoutWaiver.reciprocityUnclaimed, true);
});

test("a Michigan resident working in Ohio is withheld MICHIGAN, both engines present", () => {
  // Both ends of this pair are implemented, so it resolves to a computable
  // answer rather than a refusal — the same thing NJ/PA now does.
  const resolved = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "MI",
    certificatesOnFile: ["us_oh_it4"],
  });
  const regions = resolved.levies.filter((levy) => levy.level === "region");
  assert.deepEqual(regions.map((levy) => levy.region), ["MI"]);
  assert.equal(regions[0]!.basis, "reciprocity");
  assert.deepEqual(resolved.gaps, []);
});

/* --------------------------------------------------------------------- */
/* Sub-regions, on the real declarations                                  */
/* --------------------------------------------------------------------- */

test("New York City reaches residents only — a commuter owes nothing", () => {
  const nyc = subRegionLevy("US", "NY", "NYC")!;
  assert.deepEqual(nyc.reaches, ["resident"]);
  const commuter = resolveWithholding({
    country: "US", workRegion: "NY", residenceRegion: "NY",
    workSubRegions: ["NYC"], residenceSubRegions: [],
  });
  assert.equal(commuter.levies.some((levy) => levy.subRegion === "NYC"), false);
  const resident = resolveWithholding({
    country: "US", workRegion: "NY", residenceRegion: "NY",
    workSubRegions: [], residenceSubRegions: ["NYC"],
  });
  assert.ok(resident.levies.some((levy) => levy.subRegion === "NYC"));
});

test("Yonkers reaches BOTH — two different taxes on two populations", () => {
  assert.deepEqual(subRegionLevy("US", "NY", "YONKERS")!.reaches, ["resident", "nonresident"]);
  // A New York City resident working in Yonkers owes both, independently.
  const both = resolveWithholding({
    country: "US", workRegion: "NY", residenceRegion: "NY",
    workSubRegions: ["YONKERS"], residenceSubRegions: ["NYC"],
  });
  assert.deepEqual(
    both.levies.filter((levy) => levy.level === "sub_region")
      .map((levy) => [levy.subRegion, levy.reach]),
    [["NYC", "resident"], ["YONKERS", "nonresident"]],
  );
});

test("Pennsylvania admits any six-digit PSD code, and refuses anything else", () => {
  assert.ok(subRegionLevy("US", "PA", "390101"));
  assert.equal(subRegionLevy("US", "PA", "39010")?.code, undefined);
  const resolved = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "PA", workSubRegions: ["ALLENTOWN"],
  });
  assert.match(resolved.gaps[0]!.message, /Act 32 taxing jurisdiction by a code matching/);
});

test("Act 32 higher-of, on DCED's own worked case", () => {
  // Bethlehem resident (total resident 1.000%, PSD 480202) working in Allentown
  // (nonresident 1.280%, PSD 390101). DCED's application computes "EIT 1.280%".
  const resolved = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "PA",
    workSubRegions: ["390101"], residenceSubRegions: ["480202"],
    subRegionRates: { "390101:nonresident": "0.0128", "480202:resident": "0.0100" },
  });
  const subs = resolved.levies.filter((levy) => levy.level === "sub_region");
  assert.equal(subs.length, 1);
  assert.equal(subs[0]!.subRegion, "390101");
});

test("Philadelphia follows RESIDENCE even for a job elsewhere in Pennsylvania", () => {
  // DCED: "Act 32 does not apply. Employers are required to withhold the
  // Philadelphia resident rate for employees who live in Philadelphia, but work
  // outside of Philadelphia." So it must not be weighed against the work
  // municipality's Act 32 rate — it overrides it.
  const resolved = resolveWithholding({
    country: "US", workRegion: "PA", residenceRegion: "PA",
    workSubRegions: ["700102"], residenceSubRegions: ["PHILADELPHIA"],
    subRegionRates: { "700102:nonresident": "0.0100" },
  });
  const subs = resolved.levies.filter((levy) => levy.level === "sub_region");
  assert.ok(subs.some((levy) => levy.subRegion === "PHILADELPHIA"));
  assert.match(resolved.trace.join("\n"), /settles independently/);
});

test("Ohio's school districts follow RESIDENCE, and an unknown code is refused by name", () => {
  const district = subRegionLevy("US", "OH", "0303")!;
  assert.deepEqual(district.reaches, ["resident"]);
  assert.equal(district.kind, "school district");
  assert.equal(district.rateSource.kind, "pack");

  // A commuter INTO a taxing district owes it nothing; a resident owes it on
  // wages earned anywhere.
  const commuter = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "OH", workSubRegions: ["0303"],
  });
  assert.equal(commuter.levies.some((levy) => levy.subRegion === "0303"), false);
  const resident = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "OH", residenceSubRegions: ["0303"],
  });
  assert.ok(resident.levies.some((levy) => levy.subRegion === "0303"));

  // A four-digit code that is not a taxing district is not admitted by the
  // municipal pattern either, so it is refused rather than silently ignored.
  const wrong = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "OH", residenceSubRegions: ["9999"],
  });
  assert.equal(wrong.gaps.length, 1);
  assert.match(wrong.gaps[0]!.message, /"9999" is not a sub-region the US pack declares inside OH/);
});

test("Ohio admits any municipality by name, and school district plus city both apply", () => {
  // The open registry: the pack cannot enumerate several hundred
  // municipalities, so it declares the shape and the employer supplies the
  // rate. A code that does not match the shape is still refused.
  assert.ok(subRegionLevy("US", "OH", "WESTERVILLE"));
  assert.equal(subRegionLevy("US", "OH", "westerville"), null);
  assert.equal(subRegionLevy("US", "OH", "COLUMBUS")!.rateSource.kind, "tenant");

  // A Westerville resident (school district 2514) working in Columbus owes the
  // Columbus municipal tax on the work side and the school district tax on the
  // residence side. They are different taxes levied by different authorities:
  // both are withheld, and neither is settled against the other.
  const resolved = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "OH",
    workSubRegions: ["COLUMBUS"], residenceSubRegions: ["2514"],
  });
  assert.deepEqual(
    resolved.levies.filter((levy) => levy.level === "sub_region")
      .map((levy) => [levy.subRegion, levy.reach]),
    [["2514", "resident"], ["COLUMBUS", "nonresident"]],
  );
});

test("Ohio reciprocity relieves the STATE, and leaves the city standing", () => {
  // The IT 4's waiver names Ohio and school district withholding only. A
  // Kentucky resident working in Cincinnati is relieved of Ohio tax and pays
  // Cincinnati in full — the same shape as Philadelphia under Pennsylvania's
  // agreements, and the same reason `relievesSubRegionLevies` exists.
  const resolved = resolveWithholding({
    country: "US", workRegion: "OH", residenceRegion: "KY",
    certificatesOnFile: ["us_oh_it4"],
    workSubRegions: ["CINCINNATI"],
  });
  assert.ok(resolved.levies.some((levy) => levy.subRegion === "CINCINNATI"));
  assert.equal(resolved.levies.some((levy) => levy.level === "region"), false);
});

test("Michigan's city list is CLOSED — an unlisted city is not a jurisdiction", () => {
  assert.equal(regionWithholding("US", "MI").subRegions.length, 24);
  assert.equal(regionWithholding("US", "MI").openSubRegions, undefined);
  assert.equal(subRegionLevy("US", "MI", "DETROIT")!.rateSource.kind, "pack");
  assert.equal(subRegionLevy("US", "MI", "LANSING")!.rateSource.kind, "tenant");
  const resolved = resolveWithholding({
    country: "US", workRegion: "MI", residenceRegion: "MI", workSubRegions: ["ANN_ARBOR"],
  });
  assert.equal(resolved.gaps.length, 1);
  assert.match(
    resolved.gaps[0]!.message,
    /"ANN_ARBOR" is not a sub-region the US pack declares inside MI/,
  );
});

test("Illinois declares no sub-region levies, because it constitutionally has none", () => {
  assert.deepEqual(regionWithholding("US", "IL").subRegions, []);
  assert.equal(regionWithholding("US", "IL").openSubRegions, undefined);
});

/* --------------------------------------------------------------------- */
/* The common path is unchanged                                           */
/* --------------------------------------------------------------------- */

test("an employee with no residence recorded resolves exactly as before", () => {
  // Every profile row written before the residence attribute existed carries
  // null. Those employees must keep calculating identically.
  for (const state of ["CA", "NY", "PA", "IL", "NJ", "OH", "MI", "MA", "GA", "NC"]) {
    const resolved = resolveWithholding({ country: "US", workRegion: state });
    assert.equal(resolved.residenceSource, "assumed");
    assert.deepEqual(resolved.levies.map((levy) => levy.region), [state]);
    assert.deepEqual(resolved.gaps, []);
  }
  // And a no-tax state still withholds nothing, with no complaint.
  const texas = resolveWithholding({ country: "US", workRegion: "TX" });
  assert.deepEqual(texas.levies, []);
  assert.deepEqual(texas.gaps, []);
});
