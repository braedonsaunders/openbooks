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

/**
 * When a filing is due — the deadline class that decides which surface owns
 * it. REQUIRED, like a component's `assessedOn` (packs.ts): a new pack must
 * answer, because the generic layer cannot guess a statute's rhythm.
 *
 *   - `annual`: one filing per employer-year (T4, W-2, RL-1, P60).
 *   - `quarterly`: one filing per employer-quarter (Form 941).
 *   - `separation`: one filing per interruption of earnings, due within days
 *     of the employee event (the ROE, a UK P45) — an event document, never a
 *     year-end one, so the year-end surface must not list it.
 */
export type PayrollFilingCadence = "annual" | "quarterly" | "separation";

export const PAYROLL_FILING_CADENCES: readonly PayrollFilingCadence[] = [
  "annual",
  "quarterly",
  "separation",
];

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

// ---------------------------------------------------------------------------
// The filing LIFECYCLE — original → amended → cancelled
// ---------------------------------------------------------------------------

/**
 * What an issued artifact IS. Agency-neutral by construction:
 *
 *   - `original`  — the first filing of this population for the year.
 *   - `amended`   — a restatement of slips that SHOULD exist but were wrong.
 *   - `cancelled` — a declaration that slips should never have existed at all
 *     (an employee on the wrong entity, a duplicate return).
 *
 * Amend and cancel are DIFFERENT operations, not two flavours of edit, and
 * every agency treats them differently: the CRA stamps a report-type code on
 * the same T4 XML, the IRS uses a wholly separate correction form. The
 * generic layer carries the state; the pack carries the mechanics.
 */
export type PayrollFilingRevision = "original" | "amended" | "cancelled";

export const PAYROLL_FILING_REVISIONS: readonly PayrollFilingRevision[] = [
  "original",
  "amended",
  "cancelled",
];

/** The revisions that CORRECT an artifact already issued. */
export type PayrollFilingCorrectionKind = Exclude<PayrollFilingRevision, "original">;

/** One value as it was printed on an issued artifact. */
export interface PayrollFilingReportedField {
  /** The statutory box code, when the field is a box; null for identification. */
  code: string | null;
  label: string;
  value: string;
}

/**
 * The snapshot of what ONE row reported on ONE issued artifact — the
 * "previously reported" column every correction form asks for.
 */
export interface PayrollFilingReported {
  fields: PayrollFilingReportedField[];
  /**
   * Identity facts that must be COMPARED but never displayed (a SIN, an SSN).
   * The pack supplies a keyed fingerprint, so "the number changed" is
   * provable without the number ever leaving the sealed profile column.
   */
  confidential: { label: string; fingerprint: string }[];
}

/** One difference between what was reported and what is true now. */
export interface PayrollFilingFieldChange {
  code: string | null;
  label: string;
  /** Null when the field is confidential and its values must not be shown. */
  previous: string | null;
  current: string | null;
  /** The change is real; the values are withheld because they identify. */
  redacted: boolean;
}

/**
 * Everything a pack needs to render or transmit ONE row's correction: what
 * was reported, what is true now, and exactly which fields moved. All three
 * are computed by the generic layer from the pack's own slip declaration, so
 * a correction form never re-derives the delta and can never disagree with
 * the delta the operator approved on screen.
 */
export interface PayrollFilingCorrectionRow {
  rowId: string;
  /** The row's first declared column value (the employee, the quarter…). */
  label: string;
  revision: PayrollFilingCorrectionKind;
  previously: PayrollFilingReported;
  /** The slip as the ledger and master data produce it TODAY. */
  current: PayrollFilingSlipData;
  changes: PayrollFilingFieldChange[];
}

/** The electronic correction file, when the pack produces one. */
export interface PayrollFilingCorrectionDownload {
  label: string;
  note?: string;
  build(input: {
    orgId: string;
    taxYear: number;
    revision: PayrollFilingCorrectionKind;
    rows: readonly PayrollFilingCorrectionRow[];
  }): Promise<PayrollFilingFile>;
}

/**
 * Whether — and HOW — a filing can be corrected once it has been issued.
 *
 * REQUIRED on every declared filing, like `cadence`, and a discriminated
 * union so a pack must answer one of exactly two ways: "yes, and here are the
 * agency's mechanics", or "no, and here is why". Nothing inherits another
 * pack's correction rules by omission, and nothing silently produces an
 * approximation of a statutory correction.
 */
export type PayrollFilingAmendment =
  | {
    supported: false;
    /** Why this filing cannot be corrected here — named, never implied. */
    refusal: string;
  }
  | {
    supported: true;
    /**
     * Which corrections the agency accepts for THIS filing. A Form 941 can
     * be amended (941-X) but never cancelled — you cannot un-file a quarter.
     */
    revisions: readonly PayrollFilingCorrectionKind[];
    /**
     * How the agency carries the correction:
     *   - `same_form`       — the original form re-filed under a report-type
     *     code (the CRA's T4 XML `RPT_TCD` A/C);
     *   - `correction_form` — a distinct form carrying BOTH previously
     *     reported and corrected amounts (the IRS's W-2c/W-3c, 941-X).
     */
    vehicle: "same_form" | "correction_form";
    /** The correction form's printed name; required for `correction_form`. */
    formLabel?: string;
    /** Render one correction as its statutory form. */
    slip?: {
      build(row: PayrollFilingCorrectionRow, orgId: string, taxYear: number):
      Promise<PayrollFilingSlipData>;
    };
    download?: PayrollFilingCorrectionDownload;
    /** Why there is no correction FILE, when there is none. */
    downloadRefusal?: string;
    /**
     * Confidential identity facts to compare by fingerprint (the SIN on a T4,
     * the SSN on a W-2). Server-side only: the fingerprints are stored in the
     * snapshot and never returned to a browser — only "changed" is.
     */
    confidential?(orgId: string, taxYear: number, rowId: string):
    Promise<{ label: string; fingerprint: string }[]>;
  };

export interface PayrollYearEndFiling {
  /** Stable key within the pack ("t4", "roe", "941", "w2", "p60"). */
  key: string;
  /** The statutory form's name — a jurisdictional proper noun. */
  label: string;
  /**
   * The filing's deadline class. Required — the surfaces split on it (the
   * year-end page shows annual + quarterly; separation filings live on the
   * Separations surface and the termination run's Finish step).
   */
  cadence: PayrollFilingCadence;
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
  /**
   * How this filing is CORRECTED once issued. Required — every employer
   * eventually files a wrong slip, and a pack that says nothing would
   * silently inherit another agency's correction rules.
   */
  amendment: PayrollFilingAmendment;
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
  for (const filing of declaration.yearEnd) {
    assertCadence(declaration.country, filing);
    assertAmendment(declaration.country, filing);
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
  assertCadence(country, filing);
  assertAmendment(country, filing);
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

/** A filing without a declared cadence cannot be routed to a surface. */
function assertCadence(country: string, filing: PayrollYearEndFiling): void {
  if (!PAYROLL_FILING_CADENCES.includes(filing.cadence)) {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing declares no cadence — declare `
      + `${PAYROLL_FILING_CADENCES.join(", ")} so the filing lands on the right surface `
      + "(a separation document must never masquerade as a year-end return)",
    );
  }
}

/**
 * A filing that has not declared how it is CORRECTED cannot be issued
 * responsibly. This is deliberately as strict as `assertCadence`: the
 * alternative to a declaration is a default, and a default correction rule is
 * one agency's rules applied to another agency's form.
 */
function assertAmendment(country: string, filing: PayrollYearEndFiling): void {
  const amendment = filing.amendment as PayrollFilingAmendment | undefined;
  if (!amendment || typeof amendment.supported !== "boolean") {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing declares no amendment support — declare `
      + "{ supported: false, refusal } or { supported: true, revisions, vehicle } so a "
      + "correction is either produced to the agency's own rules or refused by name "
      + "(no filing may silently inherit another agency's correction mechanics)",
    );
  }
  if (!amendment.supported) {
    if (!amendment.refusal || !amendment.refusal.trim()) {
      throw new PayrollPackError(
        `the ${country} "${filing.key}" filing declares no amendment support and no reason — `
        + "a refusal must say why, by name",
      );
    }
    return;
  }
  const revisions = amendment.revisions ?? [];
  if (revisions.length === 0) {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing supports amendment but names no revisions — `
      + "declare which of amended, cancelled the agency accepts",
    );
  }
  for (const revision of revisions) {
    if (revision !== "amended" && revision !== "cancelled") {
      throw new PayrollPackError(
        `the ${country} "${filing.key}" filing declares an unknown revision "${revision}" — `
        + "corrections are amended or cancelled",
      );
    }
  }
  if (amendment.vehicle !== "same_form" && amendment.vehicle !== "correction_form") {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing declares no correction vehicle — `
      + "same_form (a report-type code on the original form) or correction_form "
      + "(a distinct form carrying previously reported and corrected amounts)",
    );
  }
  if (amendment.vehicle === "correction_form" && !amendment.formLabel?.trim()) {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing corrects on a separate form but does not name it — `
      + "declare formLabel (\"Form W-2c\", \"Form 941-X\")",
    );
  }
  if (!amendment.download && !amendment.downloadRefusal?.trim()) {
    throw new PayrollPackError(
      `the ${country} "${filing.key}" filing declares neither a correction file nor a reason `
      + "there is none — an absent electronic correction must be named, never implied",
    );
  }
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
