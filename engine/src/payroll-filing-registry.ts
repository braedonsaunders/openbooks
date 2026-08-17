import { PAYROLL_COUNTRY_PACKS, PayrollPackError } from "./payroll/packs.ts";

/**
 * The payroll FILING registry — the jurisdiction layer's answer to "what does
 * this pack file, and under what identities?".
 *
 * Slip and filing formats are pack DECLARATIONS, not standalone modules the
 * generic year-end surface calls by name. Each pack declares:
 *
 *   - its filing PROGRAM TYPES — the kinds of registration a filing account
 *     can be (a CRA RP program account, a US EIN, a state SUI account), which
 *     is what `payroll_filing_accounts.program_type` is validated against now
 *     that the closed CA/US CHECK constraints are gone from the table;
 *   - its SEPARATION-PAYMENT component mapping — which seeded component
 *     system_keys count as "vacation pay on separation" vs "other monies"
 *     (the ROE's Block 17A/17C; a P45's equivalents), so no builder ever
 *     hardcodes another pack's component keys;
 *   - its YEAR-END FILINGS — label, population query, optional electronic
 *     file builder, optional per-employee issue declaration. The year-end
 *     page and its API routes iterate this declaration and nothing else, so
 *     a UK pack's P60/FPS attaches by declaring itself, with no change to
 *     the generic layer.
 *
 * The registry is deliberately OPEN, like PAYROLL_COUNTRY_PACKS: countries
 * are keys, not a union type. Where a pack does not implement something —
 * no electronic file, no separation mapping, no program types — the absence
 * is declared and every consumer refuses loudly rather than approximating.
 *
 * The built-in declarations live ON the packs (`PayrollCountryPack.filings`,
 * next to statutorySlots/jurisdictions) and are authored in
 * engine/src/payroll/{canada,us}/filings.ts; this module enumerates whatever
 * the pack registry declares plus anything registered at runtime.
 */

// ---------------------------------------------------------------------------
// Declaration types
// ---------------------------------------------------------------------------

/** One kind of filing identity the pack's employers register for. */
export interface PayrollFilingProgramType {
  /** payroll_filing_accounts.program_type value ("ca_rp", "us_ein", …). */
  key: string;
  /** What the agency calls it, for refusal messages and pickers. */
  label: string;
  /**
   * The account carries a state/region code (a per-state SUI account).
   * Enforced both ways: required when true, refused when false.
   */
  requiresRegion?: boolean;
}

/** One column of a filing's population table. Labels are the statutory
 *  form's own field names — proper nouns, rendered as declared. */
export interface PayrollFilingColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  /** Format the cell as money in the org's display locale. */
  money?: boolean;
}

export interface PayrollFilingTotal {
  label: string;
  value: string;
  money?: boolean;
}

/** The population of a filing for one org-year, as a generic table. */
export interface PayrollFilingData {
  columns: PayrollFilingColumn[];
  rows: Record<string, string | number | null>[];
  /** Column whose value uniquely keys a row (for React keys / selection). */
  rowKey: string;
  totals?: PayrollFilingTotal[];
}

export interface PayrollFilingFile {
  filename: string;
  contentType: string;
  body: string;
}

export interface PayrollFilingDownload {
  /** Button label ("Download T4 XML"). */
  label: string;
  /** Transmission caveat shown beside the button. */
  note?: string;
  /**
   * Build the electronic file. `params` are the surface's raw query
   * parameters — each filing parses its own (the ROE parses `employees`)
   * and throws PayrollError naming every problem.
   */
  build(orgId: string, taxYear: number, params: Record<string, string>): Promise<PayrollFilingFile>;
}

/**
 * Declared when the filing is ISSUED per employee with an employer
 * declaration the payroll data cannot supply (the ROE's reason for issue).
 * The surface renders one reason picker + comment per population row and
 * passes the selection to the download builder under `param`.
 */
export interface PayrollFilingIssue {
  /** Query parameter the encoded selection travels under. */
  param: string;
  /** Population column holding the employee id the selection encodes. */
  idColumn: string;
  reasonCodes: readonly { code: string; label: string; commentRequired?: boolean }[];
  commentMaxLength: number;
  maxSelection: number;
}

/** One box of a filing's slip facsimile — the statutory form's own box
 *  number/code, printed label and value (an amount, a date, or text). */
export interface PayrollSlipBox {
  code: string;
  label: string;
  value: string;
  /** Render as an emphasized/computed total line (the form's bold lines). */
  emphasis?: boolean;
}

/**
 * One population row rendered as its statutory slip — the data the generic
 * surface feeds the shared form-faithful facsimile renderer (the same
 * pathway the indirect-tax returns print through). Everything here is the
 * form's own vocabulary: box codes, printed labels, identification fields.
 */
export interface PayrollFilingSlipData {
  /** Facsimile layout key (the web layer's TAX_FORM_LAYOUTS entry, e.g.
   *  "CA_T4"). A code with no layout entry renders via the generic
   *  government-form layout — declared data, never a bespoke table. */
  formCode: string;
  /** The statutory form's printed name. */
  formName: string;
  /** The form's own printed identifier ("T4", "RL-1", "Form W-2"). */
  formNumber?: string;
  /** Identification fields printed above the box grid (employee, account…). */
  headerFields: { label: string; value: string }[];
  boxes: PayrollSlipBox[];
  /** Instruction/disclosure notes printed on the slip (published gaps live
   *  here — on the paper they qualify, not as loose page prose). */
  notes?: string[];
}

/** Declared when the filing renders one population row as a slip. */
export interface PayrollFilingSlip {
  /**
   * Build one row's slip by the population's `rowKey` value. Throws
   * PayrollError naming the problem (unknown row, undeclarable block…).
   */
  build(orgId: string, taxYear: number, rowId: string): Promise<PayrollFilingSlipData>;
}

export interface PayrollYearEndFiling {
  /** Stable key within the pack ("t4", "roe", "941", "w2", "p60"). */
  key: string;
  /** The statutory form's name — a jurisdictional proper noun. */
  label: string;
  description?: string;
  emptyText?: string;
  /** The rows that belong on this filing for the year. */
  population(orgId: string, taxYear: number): Promise<PayrollFilingData>;
  /** One row rendered as its statutory slip, when the pack declares it. */
  slip?: PayrollFilingSlip;
  /** The electronic file, when the pack produces one. */
  download?: PayrollFilingDownload;
  /** Why no file exists, when it does not — named, never implied. */
  downloadRefusal?: string;
  issue?: PayrollFilingIssue;
}

/** How separation payments map onto the pack's seeded components. */
export interface PayrollSeparationPayments {
  /** system_keys reported as vacation pay paid because employment ended. */
  vacationPay: readonly string[];
  /** system_keys reported as other monies (bonus, retiring allowance…). */
  otherMonies: readonly string[];
}

export interface PayrollPackFilings {
  country: string;
  programTypes: readonly PayrollFilingProgramType[];
  separationPayments?: PayrollSeparationPayments;
  yearEnd: readonly PayrollYearEndFiling[];
}

// ---------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------

/**
 * Packs registered beyond the built-ins. The built-in CA/US declarations are
 * reached lazily (never at module-evaluation time) because the declaration
 * modules import the builder modules, which import this one — a cycle that is
 * safe precisely as long as nothing here touches their consts during load.
 */
const EXTRA = new Map<string, PayrollPackFilings>();

/** Year-end filings registered onto an EXISTING pack's declaration (the
 *  Quebec RL-1 attaches to CA this way, from its own module). */
const EXTRA_FILINGS = new Map<string, PayrollYearEndFiling[]>();

function builtins(): readonly PayrollPackFilings[] {
  return Object.values(PAYROLL_COUNTRY_PACKS).map((pack) => pack.filings());
}

/** A pack's declaration merged with any filings registered onto it. */
function withExtensions(pack: PayrollPackFilings): PayrollPackFilings {
  const extra = EXTRA_FILINGS.get(pack.country);
  if (!extra || extra.length === 0) return pack;
  return { ...pack, yearEnd: [...pack.yearEnd, ...extra] };
}

/** Every pack's filing declaration, built-ins first, in registration order. */
export function declaredPayrollFilings(): PayrollPackFilings[] {
  return [...builtins(), ...EXTRA.values()].map(withExtensions);
}

/**
 * Register a pack's filing declaration. Open by design — a new country is a
 * registration, never an edit to a union type. Refuses duplicates (two
 * declarations for one country would be two sources of statutory truth) and
 * duplicate filing/program keys within the declaration.
 */
export function registerPayrollFilings(declaration: PayrollPackFilings): void {
  if (!declaration.country) throw new PayrollPackError("a payroll filing declaration must name its country");
  if (declaredPayrollFilings().some((pack) => pack.country === declaration.country)) {
    throw new PayrollPackError(
      `payroll filings for ${declaration.country} are already declared — a country has exactly one filing declaration`,
    );
  }
  const filingKeys = declaration.yearEnd.map((filing) => filing.key);
  if (new Set(filingKeys).size !== filingKeys.length) {
    throw new PayrollPackError(`the ${declaration.country} filing declaration repeats a filing key`);
  }
  const programKeys = declaration.programTypes.map((programType) => programType.key);
  if (new Set(programKeys).size !== programKeys.length) {
    throw new PayrollPackError(`the ${declaration.country} filing declaration repeats a program type`);
  }
  EXTRA.set(declaration.country, declaration);
}

/**
 * Register ONE year-end filing onto an already-declared pack. This is how a
 * jurisdiction-within-a-country attaches its own slip without owning the
 * pack's declaration — the Quebec RL-1 (Revenu Québec) registers onto CA
 * from engine/src/payroll/canada/quebec, and the generic surface picks it up
 * through the same enumeration as everything else.
 */
export function registerYearEndFiling(country: string, filing: PayrollYearEndFiling): void {
  const pack = payrollPackFilings(country); // refuses an undeclared pack by name
  const declared = pack.yearEnd.find((existing) => existing.key === filing.key);
  if (declared) {
    // Registering the IDENTICAL declaration twice is an idempotent no-op —
    // the RL-1 is carried on the CA pack's own declaration AND registered by
    // its bootstrap, and both must be the one object. A DIFFERENT declaration
    // under the same key is two sources of statutory truth and refused.
    if (declared === filing) return;
    throw new PayrollPackError(
      `the ${country} payroll pack already declares a "${filing.key}" filing`,
    );
  }
  EXTRA_FILINGS.set(country, [...(EXTRA_FILINGS.get(country) ?? []), filing]);
}

/** Remove a non-built-in registration (test isolation only). */
export function unregisterPayrollFilings(country: string): void {
  EXTRA.delete(country);
  EXTRA_FILINGS.delete(country);
}

/** The declaration for a country, or a refusal naming the ones that exist. */
export function payrollPackFilings(country: string): PayrollPackFilings {
  const pack = declaredPayrollFilings().find((declared) => declared.country === country);
  if (!pack) {
    throw new PayrollPackError(
      `no payroll pack declares filings for ${country || "(unset)"} — filings are declared for `
      + declaredPayrollFilings().map((declared) => declared.country).join(", "),
    );
  }
  return pack;
}

/** One year-end filing by pack + key, or a refusal naming what is declared. */
export function yearEndFiling(country: string, key: string): PayrollYearEndFiling {
  const pack = payrollPackFilings(country);
  const filing = pack.yearEnd.find((declared) => declared.key === key);
  if (!filing) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares no "${key}" filing — it declares `
      + (pack.yearEnd.map((declared) => declared.key).join(", ") || "none"),
    );
  }
  return filing;
}

/**
 * The pack's separation-payment component mapping. A pack that has not
 * declared one cannot attribute separation monies (the ROE's Block 17A/17C),
 * so the builder refuses instead of silently filing 0.00 — which is exactly
 * what the hardcoded 'vacation_payout'/'bonus' keys did to any pack whose
 * component keys differ.
 */
export function separationPaymentKeys(country: string): PayrollSeparationPayments {
  const pack = payrollPackFilings(country);
  if (!pack.separationPayments) {
    throw new PayrollPackError(
      `the ${country} payroll pack declares no separation-payment component mapping — `
      + "declare which component system_keys are vacation pay vs other monies on separation "
      + "before its separation filing can be built",
    );
  }
  return pack.separationPayments;
}

// ---------------------------------------------------------------------------
// Filing-account validation — replaces the dropped CHECK constraints
// ---------------------------------------------------------------------------

/**
 * Validate a payroll filing account against the pack's declared program
 * types. This is the API-boundary control that replaced the DB CHECKs
 * (payroll_filing_accounts_country / _program / _program_country / _state),
 * which enumerated CA/US and could not represent any registered pack.
 *
 * Returns the problem as a sentence, or null when the account is
 * representable. The caller (the setup route) turns a sentence into a 400.
 */
export function filingAccountProblem(input: {
  country: string;
  programType: string;
  stateCode: string | null;
}): string | null {
  const country = input.country || "";
  const pack = declaredPayrollFilings().find((declared) => declared.country === country);
  if (!pack) {
    return `no payroll pack declares filing program types for ${country || "(unset)"} — `
      + `filing accounts exist for ${declaredPayrollFilings().map((declared) => declared.country).join(", ")}`;
  }
  const programType = pack.programTypes.find((declared) => declared.key === input.programType);
  if (!programType) {
    return `the ${country} payroll pack does not file under program type `
      + `"${input.programType || "(unset)"}" — it declares `
      + (pack.programTypes.map((declared) => `${declared.key} (${declared.label})`).join(", ") || "none");
  }
  const hasRegion = input.stateCode != null && input.stateCode !== "";
  if (programType.requiresRegion && !hasRegion) {
    return `a ${programType.label} account is registered per state/region — a state code is required`;
  }
  if (!programType.requiresRegion && hasRegion) {
    return `a ${programType.label} account carries no state/region code — remove it or choose a per-state program type`;
  }
  return null;
}
