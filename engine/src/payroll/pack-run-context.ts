/** The run resolved jurisdiction context. Split from packs.ts (ARCH-FILE-SPLIT; pure moves only). */
import { type PayrollAssessedOn, type PayrollCountry, type PayrollCountryPack } from "./pack-types"
import { PAYROLL_COUNTRY_PACKS, packStatutoryComponents, payrollPack, payrollCountry } from "./pack-registry"
import { payrollTaxYear, assertPayrollRegionSupported } from "./pack-tax-years"
import type { PayrollPackRates, PayrollStatutoryRateSlot } from "./statutory-rates.ts"
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts"

/**
 * The run's resolved jurisdiction: ONE country, ONE legal entity, ONE
 * currency, ONE tax year, computed at calculate time and passed down instead
 * of being re-derived per employee, per query and per filing artifact.
 */
export interface PayrollRunContext {
  /** The country pack that governs every statutory decision on this run. */
  country: PayrollCountry;
  /** The legal entity that is the employer of record. */
  subsidiaryId: string;
  subsidiaryName: string;
  /** That entity's functional currency; the run document is denominated in it. */
  currency: string;
  /** Per the pack's year definition — never `payDate.slice(0, 4)`. */
  taxYear: number;
  payDate: string;
}

/**
 * Resolve and assert the run half of the chain: subsidiary ⟹ country ⟹
 * currency. Called once per run, before any employee is calculated.
 *
 * The subsidiary is the employer of record, so its country — not the pay
 * schedule's, not the org's, and emphatically not the first employee's — is
 * what decides which statutory engine runs. `subsidiaries.country` has existed
 * all along and no payroll module read it.
 */
export function resolvePayrollRunContext(input: {
  payDate: string;
  subsidiary: {
    id: string;
    name: string;
    country: string | null;
    baseCurrency: string | null;
  };
  /** documents.currency, once the run document exists. */
  runCurrency?: string | null;
}): PayrollRunContext {
  const { subsidiary } = input;
  const entity = subsidiary.name || subsidiary.id;
  let pack: PayrollCountryPack;
  try {
    pack = payrollPack(subsidiary.country ?? "");
  } catch (error) {
    throw new PayrollJurisdictionError(
      `the ${entity} legal entity is registered in `
      + `${subsidiary.country || "no country"} and cannot run payroll: `
      + `${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // The pack's engine has no currency argument: T4127 returns CAD and
  // Pub 15-T returns USD. A run denominated in anything else files one
  // currency's numbers on the other's return, and every GL leg balances
  // perfectly while doing it.
  const currency = subsidiary.baseCurrency ?? "";
  if (currency !== pack.statutoryCurrency) {
    throw new PayrollJurisdictionError(
      `${entity} is a payroll entity in ${pack.country}, whose statutory engine computes in `
      + `${pack.statutoryCurrency}, but its functional currency is `
      + `${currency || "unset"} — payroll cannot be run until they agree`,
    );
  }
  if (input.runCurrency != null && input.runCurrency !== currency) {
    throw new PayrollJurisdictionError(
      `this pay run is denominated in ${input.runCurrency} but its ${entity} entity's `
      + `functional currency is ${currency}`,
    );
  }

  return {
    country: pack.country,
    subsidiaryId: subsidiary.id,
    subsidiaryName: subsidiary.name,
    currency,
    taxYear: payrollTaxYear(pack.country, input.payDate),
    payDate: input.payDate,
  };
}

/** One employee's resolved place in the chain, agreed with the run's. */
export interface EmployeePayrollContext {
  employeePartyId: string;
  employeeName: string;
  /** Identical to the run's, by construction — it is asserted, not chosen. */
  country: PayrollCountry;
  /** Province (CA) or state (US) of employment, from the profile snapshot. */
  region: string;
  currency: string;
  taxYear: number;
  /** The filing account this employee's slips and remittances belong to. */
  filingAccountId: string | null;
}

/**
 * Resolve and assert the employee half of the chain, reporting EVERY
 * disagreement at once so the payroll administrator fixes the record in one
 * pass instead of one refusal per attempt.
 *
 * Refusing rather than repairing is the point. Each of these disagreements has
 * two plausible readings — the profile is wrong, or the entity assignment is —
 * and the product cannot know which, so it may not quietly pick one and
 * withhold real money against the guess.
 */
export function resolveEmployeePayrollContext(input: {
  run: PayrollRunContext;
  employee: {
    partyId: string;
    name: string;
    /** employee_payroll_profiles.country — the pack the employee is set to. */
    country: string | null;
    /** employee_payroll_profiles.province — province or state. */
    region: string | null;
    /** parties.subsidiary_id and its country, when the employee is entity-scoped. */
    subsidiaryId?: string | null;
    subsidiaryCountry?: string | null;
    /** The effective payroll_filing_accounts row and the country it files in. */
    filingAccountId?: string | null;
    filingAccountCountry?: string | null;
    filingAccountNumber?: string | null;
  };
}): EmployeePayrollContext {
  const { run, employee } = input;
  const who = employee.name || employee.partyId;
  const problems: string[] = [];

  // Link 1 — the employee's declared pack must be the run entity's pack.
  let country: PayrollCountry | null = null;
  try {
    country = payrollCountry(employee.country);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  if (country && country !== run.country) {
    problems.push(
      `their payroll profile is on the ${country} country pack, but this run pays from `
      + `${run.subsidiaryName} (${run.country} legal entity) — employees on the ${country} pack `
      + `cannot be paid ${run.country} statutory withholdings`,
    );
  }

  // Link 2 — the employee's OWN legal entity, when they are scoped to one.
  // An org-wide pay schedule pays across subsidiaries, which is exactly how a
  // US-entity employee ended up on a Canadian run with nothing complaining.
  if (employee.subsidiaryCountry && employee.subsidiaryCountry !== run.country) {
    problems.push(
      `their legal entity is in ${employee.subsidiaryCountry} but this run pays from `
      + `${run.subsidiaryName} (${run.country}) — pay them from a pay schedule scoped to `
      + "their own entity",
    );
  }

  // Link 3 — the filing account. Slips and remittances go to the tax
  // authority named by the account, so a CRA program account on a US employee
  // is a false return, not a mislabel.
  if (employee.filingAccountCountry && employee.filingAccountCountry !== run.country) {
    problems.push(
      `their payroll filing account ${employee.filingAccountNumber ?? employee.filingAccountId} `
      + `files in ${employee.filingAccountCountry} — this run files in ${run.country}`,
    );
  }

  // Link 4 — the jurisdiction inside the country must be one the pack can
  // actually withhold for.
  const region = employee.region ?? "";
  try {
    assertPayrollRegionSupported(country ?? run.country, region);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }

  if (problems.length > 0) {
    // No employee name here: the caller reports it through its own
    // per-employee channel (PayRunCalculation.errors[].employee, rendered as
    // "name: message"), so prefixing it would print the name twice.
    throw new PayrollJurisdictionError(problems.join("; "));
  }

  return {
    employeePartyId: employee.partyId,
    employeeName: who,
    country: run.country,
    region,
    currency: run.currency,
    taxYear: run.taxYear,
    filingAccountId: employee.filingAccountId ?? null,
  };
}

/**
 * What the pack says this statutory line is assessed on — the engine's only
 * input for deciding whether a protection pass must re-derive it.
 *
 * Undeclared is a hard error, never a default: a new levy that nobody
 * classified must stop the run rather than silently pick a class and either go
 * stale or be double-pushed.
 */
// ---------------------------------------------------------------------------
// Statutory rate declarations, read off the pack registry
// ---------------------------------------------------------------------------
//
// These lived in `statutory-rates.ts` and read this registry from there — the
// edge that closed the F-reg-003 cycle. A function whose whole job is "ask
// every pack" belongs with the registry, so they live here now; the
// calculation half in `statutory-rates.ts` takes the declarations as
// parameters instead.

/**
 * Every pack's rate declaration, read off the pack registry — the same shape
 * as `declaredPayrollFilings()`. The declarations are authored in each pack's
 * own rate module beside the constants they sit next to and carried on
 * `PayrollCountryPack.statutoryRates`; a closed list here would be a second
 * registry a new pack has to edit after declaring itself.
 */
export function declaredPackRates(): PayrollPackRates[] {
  return Object.values(PAYROLL_COUNTRY_PACKS).map((pack) => pack.statutoryRates);
}

/** A pack's rate declaration, or a refusal naming the packs that have one. */
export function packRates(country: string): PayrollPackRates {
  const declared = declaredPackRates().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollPackError(
      `the ${country || "(unset)"} payroll pack declares no statutory rate slots — a pack must `
      + "declare which of its statutory rates are tenant-entered and at what scope. Declared for: "
      + (declaredPackRates().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/** One slot, or a refusal listing what the pack declares. */
export function statutoryRateSlot(country: string, slotKey: string): PayrollStatutoryRateSlot {
  const pack = packRates(country);
  const slot = pack.slots.find((declared) => declared.key === slotKey);
  if (!slot) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares no "${slotKey}" statutory rate — it declares `
      + (pack.slots.map((declared) => declared.key).join(", ") || "none"),
    );
  }
  return slot;
}

/*
 * No `packsMissingRateDeclarations` probe remains: the declaration is a
 * required `PayrollCountryPack` field read off the pack above, so every
 * installable pack answers by construction and there is no list to fall
 * behind. The third-country pack test asserts the derivation.
 */

export function statutoryAssessment(
  country: string,
  systemKey: string,
  kind: "deduction" | "employer_contribution" | "credit",
): PayrollAssessedOn {
  const declared = packStatutoryComponents(country)
    .filter((component) => component.systemKey === systemKey && component.kind === kind);
  const assessedOn = declared[0]?.assessedOn;
  if (!assessedOn) {
    throw new PayrollPackError(
      `the ${country} payroll pack does not declare what ${systemKey}/${kind} is assessed on — `
      + "add the component to its statutory slot in engine/src/payroll/packs.ts with an "
      + "assessedOn of 'earnings' (gross/pensionable/insurable) or 'taxable_income' "
      + "(income after pre-tax deductions)",
    );
  }
  if (declared.some((component) => component.assessedOn !== assessedOn)) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares conflicting assessedOn values for ${systemKey}/${kind}`,
    );
  }
  return assessedOn;
}
