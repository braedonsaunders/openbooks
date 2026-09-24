import assert from "node:assert/strict";
import test from "node:test";
import {
  assertEarningsAssessedStable,
  dropIncomeAssessedLines,
} from "./limits.ts";
import {
  PAYROLL_COUNTRY_PACKS,
  PayrollPackError,
  eiColumnSystemKeys,
  employmentJurisdictionsOf,
  employeeSocialInsuranceSystemKeys,
  incomeTaxWithholdingSystemKeys,
  jurisdictionKey,
  labourJurisdictionProblem,
  packStatutoryComponents,
  payrollPack,
  payrollJurisdictionDeclared,
  statutoryAssessment,
  type PayrollAssessedOn,
} from "./packs.ts";

test("inherited object names are never installed payroll country packs", () => {
  for (const country of ["constructor", "toString", "__proto__", "hasOwnProperty"]) {
    assert.throws(() => payrollPack(country), PayrollPackError, country);
    assert.equal(country in PAYROLL_COUNTRY_PACKS, false, country);
  }
  assert.equal(payrollPack("CA"), PAYROLL_COUNTRY_PACKS.CA);
  assert.equal(payrollPack("US"), PAYROLL_COUNTRY_PACKS.US);
});

/**
 * The country packs' `assessedOn` declaration — what each statutory amount is
 * computed FROM, and therefore whether the deduction-protection fixpoint in
 * calculateStub has to re-derive it. Pure: the declaration is data, and these
 * cases never reach a database.
 */

test("every declared statutory component resolves to its class", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const component of packStatutoryComponents(country)) {
      assert.equal(
        statutoryAssessment(country, component.systemKey, component.kind),
        component.assessedOn,
        `${country}/${component.code}`,
      );
    }
  }
});

test("the income taxes are the only income-assessed lines in either pack", () => {
  // Federal income tax (T4127 factor T), Québec income tax (TP-1015 variable
  // A), US FIT, and now US state and local income tax are all computed from
  // income net of pre-tax deductions, so these — and nothing else — are
  // re-derived by the protection fixpoint.
  //
  // SIT and LIT joined the list when state withholding was wired in, and they
  // belong: a pre-tax deferral that moves federal taxable income moves the
  // state's too, so a capped support order that changes one must re-derive the
  // others in the same pass. The failure this guards against is a new levy
  // being added as earnings-assessed by default and then silently NOT being
  // re-derived — the fixpoint would settle on a stale amount.
  const incomeAssessed = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
    packStatutoryComponents(country)
      .filter((component) => component.assessedOn === "taxable_income")
      .map((component) => `${country}/${component.code}`));
  // Each pack's own pack.ts carries the sourcing comment for its lines:
  // GB PAYE (taxable pay after pension deductions, gb/pack.ts PAYE slot);
  // DE LST (Lohnsteuer on zu versteuerndes Einkommen) and SOLI (a surcharge
  // on the LST itself, so it moves with it) plus KIST (Kirchenlohnsteuer on
  // the PAP BK base, which is itself LST-derived) (de/pack.ts);
  // FR PAS (CGI art. 204 A: rate x net imposable, fr/pack.ts:53-54);
  // IE PAYE (cumulative PAYE on taxable pay after pension deductions per the
  // RPN, ie/pack.ts:66-68); AU PAYG (salary-sacrificed amounts move the one
  // withholding, au/pack.ts:77-80); IT IRPEF (reddito complessivo net of
  // oneri deducibili, it/pack.ts:92-93) with ADDREG (same IRPEF base,
  // it/pack.ts:100-101) and ADDCOM (the comune surcharge, it/pack.ts:108-109);
  // NL LH (grondslag reduced by employee pension contributions, nl/pack.ts:148-151);
  // ES IRPF (retribuciones integras less pre-tax minoraciones, es/pack.ts:91-93);
  // Registry order, one entry per income-tax line a pack actually pushes.
  // SG contributes NOTHING here on purpose: Singapore withholds no monthly
  // income tax at all (IRAS assesses annually), so its pack declares no
  // income-tax slot — its absence from this list is that design, asserted.
  assert.deepEqual(incomeAssessed, ["CA/TAX", "CA/QCTAX", "US/FIT", "US/SIT", "US/LIT",
    "GB/PAYE", "DE/LST", "DE/SOLI", "DE/KIST", "FR/PAS", "IE/IEPAYE", "AU/PAYG",
    "IT/IRPEF", "IT/ADDREG", "IT/ADDCOM",
    "NL/LH", "ES/IRPF", "JP/GENSEN", "PL/PIT", "BR/IRRF"]);
});

test("employee CPP, CPP2, EI and QPIP are earnings-assessed, like the employer share", () => {
  // T4127 computes C and C2 from pensionable income and EI/QPIP from insurable
  // earnings; no factor-F / F2 / U1 deduction enters those formulas, so a
  // capped pre-tax support order cannot move them.
  for (const [systemKey, kind] of [
    ["cpp", "deduction"], ["cpp2", "deduction"], ["ei", "deduction"], ["qpip", "deduction"],
    ["cpp", "employer_contribution"], ["ei", "employer_contribution"],
    ["qpip", "employer_contribution"], ["wcb", "employer_contribution"],
    ["eht", "employer_contribution"], ["hsf", "employer_contribution"],
  ] as const) {
    assert.equal(statutoryAssessment("CA", systemKey, kind), "earnings", `${systemKey}/${kind}`);
  }
  for (const [systemKey, kind] of [
    ["ss", "deduction"], ["medicare", "deduction"], ["medicare_addl", "deduction"],
    ["ss", "employer_contribution"], ["medicare", "employer_contribution"],
    ["futa", "employer_contribution"], ["suta", "employer_contribution"],
  ] as const) {
    assert.equal(statutoryAssessment("US", systemKey, kind), "earnings", `${systemKey}/${kind}`);
  }
});

test("an undeclared levy stops the run rather than defaulting to a class", () => {
  // The next pack's employer levy — UK secondary NI, an AU payroll tax, another
  // state unemployment scheme — must state its class before it can be pushed.
  assert.throws(
    () => statutoryAssessment("CA", "uk_secondary_ni", "employer_contribution"),
    (error: Error) => {
      assert.ok(error instanceof PayrollPackError);
      assert.match(error.message, /does not declare what uk_secondary_ni/);
      assert.match(error.message, /assessedOn/);
      return true;
    },
  );
  // GB is a registered pack now, so the undeclared-country probe uses "XX".
  assert.throws(() => packStatutoryComponents("XX"), PayrollPackError);
});

test("the YTD income-tax key set derives from the pack declarations", () => {
  // The payslip YTD subquery counts exactly this set. It once carried a
  // five-key CA/US literal and printed YTD tax 0.00 for nine packs, so this
  // pins the derivation's CONTENT: every pack's income-tax withholding is
  // present, and nothing that merely looks like a payroll tax is.
  assert.deepEqual(incomeTaxWithholdingSystemKeys(), [
    "fit", "ie_paye", "income_tax", "irpf", "irrf", "kirchenlohnsteuer",
    "local_income_tax", "lohnsteuer", "loonheffing", "municipal_surtax",
    "pas", "paye", "payg_withholding", "pit", "qc_income_tax",
    "regional_surtax", "solidaritaetszuschlag", "state_income_tax",
  ]);
  // Employee social contributions are deductions remitted to an authority but
  // they are not income tax: CPP/EI/QPIP, NIC, PRSI, USC, ZUS, INPS, the
  // French cotisations, the German Sozialversicherung, Japan's pension and
  // health, Spain's Seguridad Social, Brazil's INSS, Singapore's CPF, and US
  // Social Security / Medicare. Counting any of them overstates YTD tax.
  for (const key of [
    "cpp", "cpp2", "ei", "qpip", "nic", "prsi", "usc",
    "zus_emeryt", "zus_rent", "zus_chor", "zus_zdr", "inps",
    "vieillesse", "csg", "crds", "arrco", "ceg", "cet",
    "kv", "rv", "av", "pv", "pension", "health",
    "ss_cc", "ss_des", "ss_for", "ss_mei", "inss", "cpf_ee",
    "ss", "medicare", "medicare_addl",
  ]) {
    assert.ok(!incomeTaxWithholdingSystemKeys().includes(key), `${key} is not income tax`);
  }
  // Refundable credits increase net rather than withholding it, and employer
  // shares never leave the employee's pay — neither counts as tax withheld.
  for (const key of ["ti_payout", "somma_payout", "wcb", "suta", "futa", "hsf", "sdl"]) {
    assert.ok(!incomeTaxWithholdingSystemKeys().includes(key), `${key} is not withheld income tax`);
  }
  // Round trip: every returned key resolves to a deduction assessed on
  // taxable income in at least one registered pack — the set carries no
  // stray key no pack declares. A key may ALSO have an earnings-assessed
  // credit owner: the annual settlement's refund rail (IT CONG-*, pushed by
  // the pack's settlement compute through the run layer), which settles
  // against the same key the withholdings carry so the remittance nets it.
  for (const key of incomeTaxWithholdingSystemKeys()) {
    const owners = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
      packStatutoryComponents(country).filter((component) => component.systemKey === key));
    assert.ok(owners.length > 0, `${key} is declared by no pack`);
    assert.ok(
      owners.some((owner) => owner.kind === "deduction" && owner.assessedOn === "taxable_income"),
      `${key} has no withholding owner`,
    );
    for (const owner of owners) {
      assert.ok(
        (owner.kind === "deduction" && owner.assessedOn === "taxable_income")
        || (owner.kind === "credit" && owner.assessedOn === "earnings"),
        `${key} owner ${owner.code} is neither the withholding nor its settlement credit`,
      );
    }
  }
});

test("the register social-insurance key set derives from the pack declarations", () => {
  // The payroll register's `cpp_fica` and `ei` columns jointly count
  // exactly this set (`ei` takes eiColumnSystemKeys(), `cpp_fica` the
  // structural complement). The columns once carried a CA/US factor literal
  // (C + C2 + SS + MED + MED2, EI) that printed 0.00 for eleven packs and
  // dropped QPIP everywhere, so this pins the derivation's CONTENT: every
  // pack's employee social insurance is present, and nothing that is not
  // withheld from the employee is.
  assert.deepEqual(employeeSocialInsuranceSystemKeys(), [
    "arrco", "av", "ceg", "cet", "cpf_ee", "cpp", "cpp2", "crds",
    "csg", "ei", "health", "inps", "inss", "kv", "medicare",
    "medicare_addl", "nic", "pension", "prsi", "pv", "qpip", "rv",
    "ss", "ss_cc", "ss_des", "ss_for", "ss_mei", "usc", "vieillesse",
    "zus_chor", "zus_emeryt", "zus_rent", "zus_zdr",
  ]);
  // QPIP is the named reason this set exists: the old register buckets
  // dropped Québec parental insurance entirely — real withheld money with
  // no column. The derivation picks it up because the CA pack declares it
  // an earnings-assessed employee deduction.
  assert.ok(employeeSocialInsuranceSystemKeys().includes("qpip"), "QPIP is counted");
  // Income-tax withholding is the complement, never the content: counting
  // any of it here would overstate social insurance exactly as far as the
  // income-tax column would then understate it.
  for (const key of incomeTaxWithholdingSystemKeys()) {
    assert.ok(!employeeSocialInsuranceSystemKeys().includes(key), `${key} is income tax, not social insurance`);
  }
  // Employer shares accrue at employer cost and refundable credits increase
  // net — neither is withheld from the employee, so neither counts here.
  for (const key of ["ti_payout", "somma_payout", "wcb", "suta", "futa", "hsf", "sdl", "fgts"]) {
    assert.ok(!employeeSocialInsuranceSystemKeys().includes(key), `${key} is not withheld social insurance`);
  }
  // Round trip: every returned key is put in the set by an earnings-assessed
  // deduction at least one pack declares — the set carries no stray key no
  // pack declares. (Several keys are shared with an employer share under
  // the same system_key — CPP, EI, QPIP, INPS, PRSI, ARRCO … — so the
  // quantifier is "some declarant", not "every declarant".)
  for (const key of employeeSocialInsuranceSystemKeys()) {
    const declarants = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
      packStatutoryComponents(country).filter((component) => component.systemKey === key));
    assert.ok(declarants.length > 0, `${key} is declared by no pack`);
    assert.ok(
      declarants.some((owner) => owner.kind === "deduction" && owner.assessedOn === "earnings"),
      `${key} has no earnings-assessed deduction declarant`,
    );
  }
  // Jointly exhaustive: every statutory deduction lands in exactly one of
  // the two register buckets — no withheld money invisible, none double.
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const component of packStatutoryComponents(country)) {
      if (component.kind !== "deduction") continue;
      const inIncome = incomeTaxWithholdingSystemKeys().includes(component.systemKey);
      const inSocial = employeeSocialInsuranceSystemKeys().includes(component.systemKey);
      assert.ok(inIncome !== inSocial, `${country}:${component.systemKey} lands in exactly one bucket`);
    }
  }
});

test("the register EI column rule is the stated pair, inside the derived set", () => {
  // Labels are frozen jurisdiction names, so the EI column cannot be
  // derived into by declaration: it keeps EI (legacy continuity) plus QPIP
  // (the mandated fold — QPIP was in neither bucket). The pair is pinned
  // exactly so a drift (a third key, a dropped key) fails loudly here
  // rather than moving a statutory total silently.
  assert.deepEqual(eiColumnSystemKeys(), ["ei", "qpip"]);
  // Both keys resolve to earnings-assessed deductions at least one pack
  // declares — the rule can never count money outside the derived bucket.
  // (The subset direction is enforced again at bind time, where a stray
  // key would invent money; this pins the content.)
  for (const key of eiColumnSystemKeys()) {
    assert.ok(
      employeeSocialInsuranceSystemKeys().includes(key),
      `${key} is inside the derived social set`,
    );
    const declarants = Object.keys(PAYROLL_COUNTRY_PACKS).flatMap((country) =>
      packStatutoryComponents(country).filter((component) => component.systemKey === key));
    assert.ok(
      declarants.some((owner) => owner.kind === "deduction" && owner.assessedOn === "earnings"),
      `${key} has an earnings-assessed deduction declarant`,
    );
  }
});

test("a pack's component codes are unique, so a slot account cannot be ambiguous", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    const codes = packStatutoryComponents(country).map((component) => component.code);
    assert.equal(new Set(codes).size, codes.length, country);
  }
});

test("a protection pass re-derives the declared income-assessed lines and nothing else", () => {
  // The pipeline's rule, driven by the real CA declaration: a pre-tax support
  // order changes tax, so tax is dropped and recomputed; CPP, EI and the WCB
  // premium are assessed on earnings and stand from the first pass.
  const line = (component: string, systemKey: string,
                kind: "deduction" | "employer_contribution", amount: string,
                projectId: string | null = null) => ({
    component, amount, projectId,
    assessedOn: statutoryAssessment("CA", systemKey, kind) as PayrollAssessedOn,
  });
  const firstPass = () => [
    line("WCB/WSIB", "wcb", "employer_contribution", "18.00", "job-a"),
    line("WCB/WSIB", "wcb", "employer_contribution", "12.01", "job-b"),
    line("Income tax", "income_tax", "deduction", "310.55"),
    line("CPP", "cpp", "deduction", "142.66"),
    line("EI", "ei", "deduction", "38.40"),
  ];

  const first = firstPass();
  const lines = firstPass();
  dropIncomeAssessedLines(lines);
  assert.deepEqual(
    lines.map((l) => l.component),
    ["WCB/WSIB", "WCB/WSIB", "CPP", "EI"],
    "only the income-assessed line is dropped",
  );
  lines.push(line("Income tax", "income_tax", "deduction", "347.12"));

  const earnings = (
    set: readonly { component: string; amount: string; projectId: string | null; assessedOn: PayrollAssessedOn }[],
  ) => set.filter((l) => l.assessedOn === "earnings");
  assertEarningsAssessedStable("Terry Worker", earnings(first), earnings(lines));
  assert.notEqual(
    lines.find((l) => l.component === "Income tax")!.amount,
    first.find((l) => l.component === "Income tax")!.amount,
  );
});

// ---------------------------------------------------------------------------
// The labour jurisdiction: the employment attribute, validated against the
// pack declarations
// ---------------------------------------------------------------------------

/**
 * `jurisdictionKey` maps an employee to the employment-standards rules that
 * govern them. Deriving it from the work region alone is wrong for an employer
 * regulated by a different labour jurisdiction than the one its employees work
 * in: that jurisdiction has its own statutory holiday calendar AND its own
 * holiday-pay formula, so without an attribute for it the employment silently
 * inherited the region's answers.
 */

test("the region derivation is unchanged when no labour jurisdiction is set", () => {
  assert.equal(jurisdictionKey("CA", "ON"), "CA-ON");
  assert.equal(jurisdictionKey("US", "TX"), "US-TX");
  // No region at all still keys as the country — the pre-existing behaviour.
  assert.equal(jurisdictionKey("CA", null), "CA");
  assert.equal(jurisdictionKey("CA", ""), "CA");
  // Explicitly absent, in every shape the column and the API can produce.
  assert.equal(jurisdictionKey("CA", "ON", null), "CA-ON");
  assert.equal(jurisdictionKey("CA", "ON", ""), "CA-ON");
  assert.equal(jurisdictionKey("CA", "ON", "   "), "CA-ON");
});

test("an explicit labour jurisdiction wins over the region derivation", () => {
  // An employee working in Ontario for a federally regulated employer: the
  // Canada Labour Code governs the employment, the ESA does not.
  assert.equal(jurisdictionKey("CA", "ON", "CA"), "CA");
  // And it is honoured whatever the region, including Québec.
  assert.equal(jurisdictionKey("CA", "QC", "CA"), "CA");
  // A cross-province posting: the declared jurisdiction, not the work region.
  assert.equal(jurisdictionKey("CA", "AB", "CA-BC"), "CA-BC");
  assert.equal(jurisdictionKey("US", "TX", "US"), "US");
  // Case and whitespace are normalized, not rejected — the keys are uppercase.
  assert.equal(jurisdictionKey("CA", "ON", " ca-bc "), "CA-BC");
  // Whatever it resolves to, the packs must actually declare it: that is what
  // makes the holiday calendar resolvable rather than a guess.
  assert.ok(payrollJurisdictionDeclared(jurisdictionKey("CA", "ON", "CA")));
});

test("every declared employment jurisdiction is an acceptable labour jurisdiction", () => {
  for (const country of Object.keys(PAYROLL_COUNTRY_PACKS)) {
    for (const jurisdiction of employmentJurisdictionsOf(country)) {
      assert.equal(
        labourJurisdictionProblem(country, jurisdiction.key),
        null,
        `${country}/${jurisdiction.key}`,
      );
      // Accepting it means the holiday layer can resolve it.
      assert.ok(payrollJurisdictionDeclared(jurisdictionKey(country, "ON", jurisdiction.key)));
    }
  }
});

test("an empty labour jurisdiction is not a problem — it means derive from the region", () => {
  assert.equal(labourJurisdictionProblem("CA", null), null);
  assert.equal(labourJurisdictionProblem("CA", ""), null);
  assert.equal(labourJurisdictionProblem("CA", "  "), null);
});

test("an undeclared labour jurisdiction is refused BY NAME, listing what is declared", () => {
  // 'CA-ZZ' is the region an employee employed outside any province carries.
  // No employment-standards act governs it, and accepting it would let the
  // employment fall back on the work region's calendar — the exact
  // substitution the attribute exists to prevent.
  const problem = labourJurisdictionProblem("CA", "CA-ZZ");
  assert.ok(problem);
  assert.match(problem!, /CA-ZZ/, "names the refused value");
  assert.match(problem!, /no payroll pack declares/);
  assert.match(problem!, /CA-ON/, "lists what IS declared");

  // A typo is refused the same way.
  assert.match(labourJurisdictionProblem("CA", "CA-ONT")!, /CA-ONT/);
  assert.ok(labourJurisdictionProblem("CA", "ON"), "a region code is not a jurisdiction key");
});

test("a tax administration's own calendar is refused as a labour jurisdiction", () => {
  // CA-CRA is declared, and it is emphatically not an employment calendar: it
  // carries Easter Monday and the Civic Holiday, which no province's ESA lists,
  // and it exists to move remittance due dates.
  const problem = labourJurisdictionProblem("CA", "CA-CRA");
  assert.ok(problem);
  assert.match(problem!, /CA-CRA/);
  assert.match(problem!, /tax_administration/);
  assert.ok(labourJurisdictionProblem("CA", "CA-CRA-QC"));
});

test("another country's labour jurisdiction is refused", () => {
  // The employer of record does not sit in it, so it cannot govern.
  const problem = labourJurisdictionProblem("CA", "US-TX");
  assert.ok(problem);
  assert.match(problem!, /US-TX/);
  assert.match(problem!, /another country/);
  assert.ok(labourJurisdictionProblem("US", "CA-ON"));
});

test("a country no pack declares refuses rather than answering", () => {
  assert.throws(() => labourJurisdictionProblem("ZZ", "ZZ"), PayrollPackError);
});

test("every installable pack names its statutory engine and declares withholding buckets", () => {
  // F-t08-012: the stub register and stub header summarized every run into
  // hardcoded CA buckets because nothing forced the packs to declare their
  // own. The review UI reads these declarations, so a pack that stays silent
  // about its engine label or its employee withholding components renders
  // another country's columns.
  const packs = Object.values(PAYROLL_COUNTRY_PACKS).filter((pack) => pack.installable)
  assert.ok(packs.length >= 2, "expected at least the CA and US packs")
  for (const pack of packs) {
    assert.ok(
      typeof pack.statutoryEngineLabel === "string" && pack.statutoryEngineLabel.length > 0,
      `${pack.country} declares no statutory engine label for the trace heading`,
    )
    const withholding = pack.statutorySlots.flatMap((slot) =>
      slot.components.filter((component) => component.kind === "deduction"),
    )
    assert.ok(
      withholding.length > 0,
      `${pack.country} declares no employee withholding components for the register buckets`,
    )
    for (const component of withholding) {
      assert.ok(component.name.length > 0, `${pack.country}/${component.code} has no bucket label`)
    }
  }
});

test("every remittance schedule declares a non-empty, unique frequency settings key", () => {
  // declaredRemittanceFrequencySettingsKeys() is a bare .map with no dedup
  // while its sibling declaredRemittanceVendorSettingsKeys() builds a Set —
  // yet the frequency helper's doc comment claims "the same derivation
  // pattern as the vendor keys". A duplicate key would validate a value
  // against whichever schedule loads first, so the same input changes verdict
  // when an unrelated pack installs, silently, on a frequency that drives
  // when money is due. Deduping would hide that pack-authoring mistake behind
  // silent first-one-wins, so fail loudly here instead.
  const owners = new Map<string, string>()
  for (const [country, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
    for (const schedule of pack.remittanceSchedules ?? []) {
      // Same location format allRemittanceSchedules() builds for its own
      // errors: a duplicate message must identify both schedules, not just
      // their country — "both CA and CA" tells a pack author with several
      // schedules in one country nothing about which two collide.
      const where = `the ${country} payroll pack's remittance schedule for ${schedule.vendorSettingsKey || "(no vendor key)"}`
      assert.ok(
        schedule.frequencySettingsKey,
        `${where} names no frequency settings key`,
      )
      const prior = owners.get(schedule.frequencySettingsKey)
      assert.equal(
        prior,
        undefined,
        `frequency settings key "${schedule.frequencySettingsKey}" is declared by both ${prior} and ${where}`,
      )
      owners.set(schedule.frequencySettingsKey, where)
    }
  }
  // Non-vacuity: an empty schedule list would pass every assertion above.
  assert.ok(owners.size >= 2, "expected more than one declared frequency key")
})

test("the CA pack declares the QPIP program base under its own stub factor (C-12)", () => {
  // If the declaration goes missing, run-stub-compute stops storing IE_QPIP
  // and every slip reader silently falls back to the EI base — the exact
  // defect C-12 removes. Pin the wiring: program key, factor key, and the
  // Québec-only program staying out of the US pack.
  const ca = payrollPack("CA");
  const programs = ca.contributionPrograms ?? [];
  const qpip = programs.find((program) => program.key === "qpip");
  assert.ok(qpip, "the CA pack declares a qpip contribution program");
  assert.equal(qpip.stubFactorKey, "IE_QPIP");
  assert.deepEqual(payrollPack("US").contributionPrograms ?? [], []);
});
