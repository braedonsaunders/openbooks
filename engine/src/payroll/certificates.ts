/**
 * Tax certificates — the form an employee files to set their own withholding.
 *
 * Every jurisdiction that withholds income tax has one. The IRS has Form W-4,
 * California has DE 4, New York has IT-2104, Illinois has IL-W-4, the CRA has
 * the TD1 and Revenu Québec has TP-1015.3-V. They ask different questions
 * (allowances, claim codes, exemption amounts, an extra amount per period),
 * they are filed with different authorities, and an employee routinely has
 * SEVERAL on file at once — a federal one, a state one, and in New York a
 * single form that carries three separate allowance counts for the state, the
 * city and Yonkers.
 *
 * The shape this replaces was flat columns on `employee_payroll_profiles`:
 * `federal_claim_code`, `provincial_claim_code`, `filing_status`,
 * `multiple_jobs`, `dependent_credits`, `w4_allowances` … Those columns are
 * two jurisdictions' forms fused into one row. The shape does not extend: the
 * fifty-first column would be `il_line_2_allowances` and the hundredth would be
 * `ny_yonkers_allowances`, every one of them NULL for 98% of employees, every
 * one of them requiring a schema migration, an API change and a UI edit before
 * a state could be turned on.
 *
 * So: a PACK DECLARES the certificates it issues, each with TYPED FIELDS, and
 * an employee's answers are stored AGAINST a declared certificate. Adding
 * California is adding a declaration. The editor renders from the declaration,
 * so it needs no UI edit; validation reads the declaration, so it needs no API
 * edit; the engine reads answers through `certificateAnswers()`, so it needs no
 * calculation edit.
 *
 * Nothing in this module knows a country, a state, a form number or a field
 * name. It knows that certificates exist, that they belong to a jurisdiction
 * scope, that they have typed fields, and that some of them exist to prove
 * NON-RESIDENCE rather than to set an amount.
 *
 * ---------------------------------------------------------------------------
 * On the existing columns
 * ---------------------------------------------------------------------------
 * The federal W-4 and the TD1/TP-1015.3 columns are NOT moved. They are
 * DECLARED, with a `storage: { column: … }` on each field naming the profile
 * column that already holds the answer, and `certificateAnswers()` reads
 * through that mapping. The result is one interface over both storages: the
 * engine, the API and the editor all ask "what did this employee answer on
 * certificate X?" and never know that two of the answers come from a column and
 * forty-nine come from a row.
 *
 * That is deliberate and it is the conservative half of the directive. Moving
 * live federal and Canadian withholding inputs onto a new storage in the same
 * pass as introducing the storage puts the T4127, TP-1015 and Pub 15-T
 * conformance goldens at risk for no functional gain — the goldens would still
 * pass, but they would be proving the migration rather than the tables. The
 * column mapping is the same interface, costs nothing, and leaves the move to a
 * pass whose only job is the move. `PayrollCertificate.storage` is the honest
 * record of which certificates are on which side of that line.
 */
import { PayrollError } from "./error.ts";
import { normalizeDecimal } from "../money/money.ts";

export class PayrollCertificateError extends PayrollError {}

// ---------------------------------------------------------------------------
// Where a certificate is filed
// ---------------------------------------------------------------------------

/**
 * The jurisdiction level a certificate sets withholding for.
 *
 * Three levels, because there are three levels of income tax in the world the
 * packs describe: the country (W-4, TD1), the region inside it (DE 4, IT-2104,
 * TP-1015.3-V), and the sub-region below THAT (Ohio's municipalities and school
 * districts each take their own certificate). `sub_region` is the same word
 * `PayrollRateScope` uses in engine/src/payroll/statutory-rates.ts — one
 * vocabulary for one idea, rather than a parallel one that would have to be
 * translated at every boundary.
 */
export type PayrollJurisdictionLevel = "country" | "region" | "sub_region";

export interface PayrollCertificateScope {
  level: PayrollJurisdictionLevel;
  /** Required at `region` and `sub_region`. */
  region?: string;
  /** Required at `sub_region`. The pack's own sub-region code. */
  subRegion?: string;
}

/**
 * What the certificate is FOR.
 *
 * `withholding` — it sets the amount (W-4, DE 4, IL-W-4, TD1).
 * `non_residence` — it asserts the employee is not a resident of the work
 *   region, which is the condition a reciprocity agreement takes effect on
 *   (PA's REV-419, Illinois's IL-W-5-NR, New York's IT-2104.1, New Jersey's
 *   NJ-165). It usually sets no amount at all: its whole content is "I live
 *   somewhere else, stop withholding here." Separated from `withholding`
 *   because the reciprocity resolver asks a different question of it — "is one
 *   on file?" rather than "what does it say?" — and because a system that
 *   conflates the two withholds the wrong state's tax for anybody who filed one
 *   form and not the other.
 * `exemption` — it claims a statutory exemption from withholding that is not a
 *   residence question (a military spouse under the MSRRA, a religious
 *   objector).
 */
export type PayrollCertificatePurpose = "withholding" | "non_residence" | "exemption";

/**
 * How a jurisdiction identifies a withholding claim on its own form. See
 * `PayrollCertificate.claimIdentity`; declared so the generic layer branches on
 * the pack's statement rather than on a country/region literal.
 */
export type PayrollClaimIdentity = "code" | "amount";

// ---------------------------------------------------------------------------
// Fields
// ---------------------------------------------------------------------------

/**
 * How one answer is written on the agency's own form, which is how the
 * operator will type it. The kinds are deliberately few: every certificate
 * field in every jurisdiction surveyed reduces to one of them, and a kind that
 * exists for exactly one form is a leak.
 */
export type PayrollCertificateFieldKind =
  /** A named choice from a closed list (filing status, marital status). */
  | "choice"
  /** A whole count (allowances, exemptions). Never money. */
  | "count"
  /** Money, at the declared scale (an exemption amount, an extra per period). */
  | "amount"
  /** A checkbox (the W-4 Step 2 box, an exempt claim). */
  | "flag"
  /** A short free string (a PSD code, a school-district number). */
  | "code";

export interface PayrollCertificateChoice {
  value: string;
  label: string;
  /** Shown under the option in the editor. */
  help?: string;
}

/**
 * Where a declared field's answer physically lives.
 *
 * `row` (the default, and the only shape a NEW certificate may use) — inside
 * the answers object of a stored certificate row.
 *
 * `column` — a named column on `employee_payroll_profiles`. Legal ONLY for the
 * certificates that predate this model (the W-4 and the TD1 family). It is a
 * READ mapping over storage that already exists, exactly as
 * `PayrollPackRates.legacyRows` is a read mapping over the pre-scoping settings
 * blob, and for the same reason: the alternative is a data migration whose
 * failure mode is silently different withholding.
 */
export type PayrollCertificateStorage =
  | { kind: "row" }
  | { kind: "column"; column: string };

export interface PayrollCertificateField {
  /** Stable key inside the answers object. Unique within the certificate. */
  key: string;
  /** The label the agency prints, including the line number where it has one. */
  label: string;
  kind: PayrollCertificateFieldKind;
  /** Required for `choice`. */
  choices?: readonly PayrollCertificateChoice[];
  /** Required for `amount`: the canonical scale answers are stored at. */
  decimals?: number;
  /** Inclusive bounds for `count` and `amount`, as strings. */
  min?: string;
  max?: string;
  /**
   * The value in force when the employee has answered nothing. A certificate
   * field's default is a STATUTORY fact ("no certificate on file is withheld at
   * single with zero allowances"), so the pack states it rather than the engine
   * assuming it.
   */
  default?: string;
  /** Must be answered before the certificate counts as complete. */
  required?: boolean;
  /** Field help, rendered in the `?` popover. Written for the operator. */
  help: string;
  /** See PayrollCertificateStorage. Defaults to `{ kind: "row" }`. */
  storage?: PayrollCertificateStorage;
  /**
   * This answer places the employee INSIDE a sub-region of the certificate's
   * jurisdiction — the address fact `resolveWithholding` takes from its caller
   * and cannot derive.
   *
   * Sub-region membership is a property of an ADDRESS, so something has to
   * record it per employee, and the agencies already ask: Pennsylvania's
   * CLGS-32-6 collects the resident and work PSD codes, Ohio's IT 4 collects
   * the school district of residence, New York's IT-2104 asks whether the
   * employee is a resident of New York City and of Yonkers. Declaring WHICH
   * answer means "this employee is in that jurisdiction, on that side" keeps
   * the mapping in the pack, beside the form, instead of in a `if (state ===
   * "PA")` inside the pay run.
   *
   * `side` is load-bearing and cannot be inferred: New York City reaches
   * residents only and Yonkers reaches both, so a levy code with no side
   * attached is unusable.
   */
  subRegion?: {
    side: "work" | "residence";
    /**
     * For a `flag` field: the sub-region code the answer's truth selects
     * ("NYC"). Omitted for a `code` field, whose ANSWER is the code.
     */
    code?: string;
  };
}

export interface PayrollCertificate {
  /**
   * Stable key, unique across the pack. Convention is
   * `<country>_<region?>_<form>` lowercased ("us_w4", "us_ca_de4",
   * "us_ny_it2104", "us_pa_rev419"), but nothing depends on the shape.
   */
  key: string;
  /** The agency's form number, exactly as printed ("DE 4", "IT-2104"). */
  form: string;
  /** What the agency titles it. */
  label: string;
  scope: PayrollCertificateScope;
  purpose: PayrollCertificatePurpose;
  /**
   * How this jurisdiction identifies the employee's claim on the form: by a
   * CODE (a small integer the formula table maps to an amount — the CRA's
   * TD1 claim codes 0–10) or by an AMOUNT the employee writes on the form
   * (Revenu Québec's TP-1015.3-V line 10).
   *
   * Declared here, beside the fields, because it is a property of the
   * JURISDICTION'S FORM, not of the product: the API validates a claim code
   * against this declaration and refuses a code for an amount jurisdiction
   * by name, instead of a `if (country === "CA" && region === "QC")` in a
   * shared route. Absent means the certificate declares no claim-identity
   * rule (a non-residence or exemption form, or a certificate whose claim is
   * carried entirely by other fields).
   */
  claimIdentity?: PayrollClaimIdentity;
  /**
   * A filed form may stop authorizing its answers on a pack-defined renewal
   * date. The date is calculated from the row's effective date so historical
   * payroll remains reproducible; `validThrough` is inclusive.
   */
  validity?:
    | {
      kind: "calendar_year_end";
      appliesWhen?: { field: string; values: readonly string[] };
    }
    | {
      kind: "following_year_date";
      monthDay: `${number}${number}-${number}${number}`;
      appliesWhen?: { field: string; values: readonly string[] };
    };
  /** The publication or statute the form and its fields come from. */
  citation: string;
  /** One sentence for the operator: when does an employee file this? */
  summary: string;
  fields: readonly PayrollCertificateField[];
  /**
   * True when EVERY field maps to an existing profile column — the pre-model
   * certificates. Declared rather than derived so the state of the migration is
   * a fact the product can report, not something a caller has to infer by
   * inspecting fields.
   */
  storage: "profile_columns" | "certificate_rows";
}

// ---------------------------------------------------------------------------
// Declaration registry
// ---------------------------------------------------------------------------

export interface PayrollPackCertificates {
  country: string;
  certificates: readonly PayrollCertificate[];
}

const EXTRA = new Map<string, PayrollPackCertificates>();
const BUILT_INS = new Map<string, PayrollPackCertificates>();
const SOURCES = new Map<string, () => PayrollPackCertificates>();

/**
 * Register a pack's declaration LAZILY — the shape a country pack uses.
 *
 * The pack member is a THUNK (`certificates: () => PayrollPackCertificates`,
 * engine/src/payroll/packs.ts) for the same reason `filings` is: the modules
 * that author these declarations import the pack's own rate and engine modules,
 * so dereferencing them while `packs.ts` is still evaluating would read a
 * half-initialized module. Registering the thunk costs nothing at
 * module-evaluation time and the declaration is built, validated and cached on
 * the first READ — by which time every module involved has finished loading.
 */
export function registerPayrollCertificateSource(
  country: string,
  source: () => PayrollPackCertificates,
): void {
  if (!country) {
    throw new PayrollCertificateError("a payroll certificate source must name its country");
  }
  SOURCES.set(country, source);
}

/** Build and register every pending pack declaration. Idempotent. */
function materializeSources(): void {
  if (SOURCES.size === 0) return;
  for (const [country, source] of [...SOURCES]) {
    if (BUILT_INS.has(country) || EXTRA.has(country)) {
      SOURCES.delete(country);
      continue;
    }
    // The source is dropped only once it has produced a declaration that
    // registered cleanly: a throwing pack must keep throwing the same sentence
    // on the next read rather than silently becoming "no declaration".
    const declaration = source();
    registerPayrollCertificates(declaration, { builtIn: true });
    SOURCES.delete(country);
  }
}

/**
 * Register a pack's certificate declaration.
 *
 * Built-ins register themselves from their own pack module (the arrangement
 * `{us,canada}/filings.ts` and `{us,canada}/rates.ts` already use), so this
 * module imports no pack and cannot be the second module in an import cycle.
 */
export function registerPayrollCertificates(
  declaration: PayrollPackCertificates,
  options: { builtIn?: boolean } = {},
): void {
  if (!declaration.country) {
    throw new PayrollCertificateError("a payroll certificate declaration must name its country");
  }
  const target = options.builtIn ? BUILT_INS : EXTRA;
  const other = options.builtIn ? EXTRA : BUILT_INS;
  if (other.has(declaration.country) || (target.has(declaration.country) && !options.builtIn)) {
    throw new PayrollCertificateError(
      `payroll certificates for ${declaration.country} are already declared — a country has `
      + "exactly one certificate declaration",
    );
  }
  const keys = declaration.certificates.map((certificate) => certificate.key);
  if (new Set(keys).size !== keys.length) {
    throw new PayrollCertificateError(
      `the ${declaration.country} certificate declaration repeats a certificate key`,
    );
  }
  for (const certificate of declaration.certificates) {
    const problem = certificateDeclarationProblem(certificate);
    if (problem) {
      throw new PayrollCertificateError(`${declaration.country} · ${certificate.key}: ${problem}`);
    }
  }
  target.set(declaration.country, declaration);
}

export function declaredPayrollCertificates(): PayrollPackCertificates[] {
  materializeSources();
  return [...BUILT_INS.values(), ...EXTRA.values()];
}

/** A pack's declaration, or a refusal naming the packs that have one. */
export function packCertificates(country: string): PayrollPackCertificates {
  const declared = declaredPayrollCertificates().find((entry) => entry.country === country);
  if (!declared) {
    throw new PayrollCertificateError(
      `the ${country || "(unset)"} payroll pack declares no tax certificates — a pack must `
      + "declare the forms its employees file to set their withholding. Declared for: "
      + (declaredPayrollCertificates().map((entry) => entry.country).join(", ") || "none"),
    );
  }
  return declared;
}

/**
 * The pack's declared field answered through an `employee_payroll_profiles`
 * column — the read mapping the profile editor renders and the profile POST
 * validates against, so neither reimplements a pack's form (the W-4's choice
 * set, the TD1's 0–10 claim-code band). First match wins: packs keep one
 * column on one certificate family, and the thirteen provincial TD1s share
 * their three columns deliberately, with identical shapes.
 */
export function profileColumnField(country: string, column: string): PayrollCertificateField | null {
  for (const certificate of packCertificates(country).certificates) {
    for (const field of certificate.fields) {
      if (field.storage?.kind === "column" && field.storage.column === column) {
        return field;
      }
    }
  }
  return null;
}

/**
 * The allowed answers for a column-mapped `choice` field (the W-4 filing
 * statuses), or null when the pack declares no such field for the column —
 * which refuses the answer rather than inheriting another pack's choices.
 */
export function profileColumnChoices(country: string, column: string): readonly string[] | null {
  const field = profileColumnField(country, column);
  if (!field || field.kind !== "choice" || !field.choices) return null;
  return field.choices.map((choice) => choice.value);
}

/**
 * The inclusive integer band for a column-mapped `count` field (TD1 claim
 * codes 0–10, W-4 allowances 0–99), or null when the pack declares no such
 * field for the column.
 */
export function profileColumnCountBounds(
  country: string,
  column: string,
): { min: number; max: number } | null {
  const field = profileColumnField(country, column);
  if (!field || field.kind !== "count") return null;
  const min = field.min == null ? 0 : Number(field.min);
  const max = field.max == null ? Number.MAX_SAFE_INTEGER : Number(field.max);
  if (!Number.isInteger(min) || !Number.isInteger(max)) return null;
  return { min, max };
}

/**
 * The region-level withholding certificate a pack declares for `region` — the
 * form whose `claimIdentity` rule the profile API reads — or null when the
 * pack declares none for that region. Region-scoped because the same profile
 * column (`provincial_claim_code`) is shared by every regional form, so a
 * country-wide column lookup cannot tell one region's rule from another's.
 */
export function regionWithholdingCertificate(
  country: string,
  region: string | null | undefined,
): PayrollCertificate | null {
  if (!region) return null;
  for (const certificate of packCertificates(country).certificates) {
    if (
      certificate.scope.level === "region"
      && certificate.scope.region === region
      && certificate.purpose === "withholding"
    ) {
      return certificate;
    }
  }
  return null;
}

/** One certificate, or a refusal listing what the pack declares. */
export function payrollCertificate(country: string, key: string): PayrollCertificate {
  const pack = packCertificates(country);
  const found = pack.certificates.find((certificate) => certificate.key === key);
  if (!found) {
    throw new PayrollCertificateError(
      `the ${country} payroll pack declares no "${key}" tax certificate — it declares `
      + (pack.certificates.map((certificate) => certificate.key).join(", ") || "none"),
    );
  }
  return found;
}

// ---------------------------------------------------------------------------
// Declaration validation
// ---------------------------------------------------------------------------

/** Why a declaration is malformed, or null. Enforced at registration. */
export function certificateDeclarationProblem(certificate: PayrollCertificate): string | null {
  if (!certificate.key) return "a certificate must have a key";
  if (!certificate.citation) return "a certificate must cite the publication its fields come from";
  if (certificate.claimIdentity && certificate.purpose !== "withholding") {
    return "claimIdentity describes a withholding claim and applies only to a withholding certificate";
  }
  const { level, region, subRegion } = certificate.scope;
  if (level !== "country" && !region) {
    return `a ${level}-level certificate must name its region`;
  }
  if (level === "country" && region) {
    return "a country-level certificate carries no region";
  }
  if (level === "sub_region" && !subRegion) {
    return "a sub_region-level certificate must name its sub-region";
  }
  if (level !== "sub_region" && subRegion) {
    return `a ${level}-level certificate carries no sub-region`;
  }
  const keys = certificate.fields.map((field) => field.key);
  if (new Set(keys).size !== keys.length) return "the certificate repeats a field key";
  const allColumns = certificate.fields.length > 0
    && certificate.fields.every((field) => field.storage?.kind === "column");
  if (certificate.storage === "profile_columns" && !allColumns) {
    return "declared as profile_columns but not every field names a column";
  }
  if (certificate.storage === "certificate_rows"
    && certificate.fields.some((field) => field.storage?.kind === "column")) {
    return "declared as certificate_rows but a field still names a profile column — a new "
      + "certificate stores its answers in a row";
  }
  for (const field of certificate.fields) {
    const problem = fieldDeclarationProblem(field);
    if (problem) return `${field.key}: ${problem}`;
  }
  return null;
}

/**
 * Why a set of answers is not storable against a certificate declaration, or
 * null. The WRITE half of the typed readers below: the certificates API and
 * any other entry surface validate here, so an answer the declaration does
 * not admit is refused before it is stored — never stored where no engine
 * reads it, and never read back as a surprise.
 *
 * Mirrors `resolveCertificate`'s precedence: an absent or empty answer falls
 * back to the field's declared default at read time, so it is only a problem
 * when the field is required AND declares no default. Stored answers stay
 * canonical ("true"/"false" for flags, the field's decimal scale for
 * amounts): the readers accept legacy spellings, the writer does not mint
 * them.
 */
export function certificateAnswersProblem(
  certificate: PayrollCertificate,
  answers: Record<string, unknown>,
): string | null {
  if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
    return "answers must be an object keyed by field key";
  }
  const byKey = new Map(certificate.fields.map((field) => [field.key, field]));
  for (const key of Object.keys(answers)) {
    if (!byKey.has(key)) {
      return `"${key}" is not a field of ${certificate.form} — it declares `
        + (certificate.fields.map((field) => field.key).join(", ") || "no fields");
    }
  }
  for (const field of certificate.fields) {
    const raw = answers[field.key];
    if (raw === undefined || raw === null || raw === "") {
      if (field.required && field.default == null) return `"${field.key}" is required on ${certificate.form}`;
      continue;
    }
    if (typeof raw !== "string") return `"${field.key}" must be a string answer`;
    const value = raw.trim();
    if (value === "") {
      if (field.required && field.default == null) return `"${field.key}" is required on ${certificate.form}`;
      continue;
    }
    const problem = fieldAnswerProblem(certificate, field, value);
    if (problem) return problem;
  }
  return null;
}

/** Compare two same-scale decimal strings without floating point. */
function compareScaled(a: string, b: string): number {
  const norm = (s: string): { neg: boolean; whole: string; frac: string } => {
    const neg = s.startsWith("-");
    const unsigned = neg ? s.slice(1) : s;
    const [whole = "0", frac = ""] = unsigned.split(".");
    return { neg, whole: whole.replace(/^0+(?=\d)/, ""), frac };
  };
  const x = norm(a);
  const y = norm(b);
  if (x.neg !== y.neg) return x.neg ? -1 : 1;
  const xa = x.whole.padStart(y.whole.length, "0");
  const ya = y.whole.padStart(x.whole.length, "0");
  // Same-width whole parts and same-scale fracs: digit strings compare
  // lexicographically exactly as the numbers compare.
  const xs = xa + x.frac;
  const ys = ya + y.frac;
  const order = xs < ys ? -1 : xs > ys ? 1 : 0;
  return x.neg ? -order : order;
}

function fieldAnswerProblem(
  certificate: PayrollCertificate,
  field: PayrollCertificateField,
  value: string,
): string | null {
  const at = `${certificate.form} · ${field.label}`;
  if (field.kind === "choice") {
    if (!field.choices!.some((choice) => choice.value === value)) {
      return `${at}: "${value}" is not one of `
        + field.choices!.map((choice) => choice.value).join(", ");
    }
    return null;
  }
  if (field.kind === "flag") {
    if (value !== "true" && value !== "false") {
      return `${at}: "${value}" is not "true" or "false"`;
    }
    return null;
  }
  if (field.kind === "count") {
    if (!/^\d+$/.test(value)) return `${at}: "${value}" is not a whole count`;
    const count = Number(value);
    if (field.min != null && count < Number(field.min)) return `${at}: ${count} is below the declared minimum ${field.min}`;
    if (field.max != null && count > Number(field.max)) return `${at}: ${count} is above the declared maximum ${field.max}`;
    return null;
  }
  if (field.kind === "amount") {
    let canonical: string;
    try {
      canonical = normalizeDecimal(value, field.decimals!);
    } catch {
      return `${at}: "${value}" is not a decimal at up to ${field.decimals} places`;
    }
    // Bounds compare at the declared scale: normalize the bound the same
    // way so "10" and "10.00" compare equal.
    if (field.min != null) {
      const bound = normalizeDecimal(field.min, field.decimals!);
      if (compareScaled(canonical, bound) < 0) return `${at}: ${value} is below the declared minimum ${field.min}`;
    }
    if (field.max != null) {
      const bound = normalizeDecimal(field.max, field.decimals!);
      if (compareScaled(canonical, bound) > 0) return `${at}: ${value} is above the declared maximum ${field.max}`;
    }
    return null;
  }
  // `code`: the answer IS the jurisdiction/member code — free text, nonempty
  // (emptiness is "unanswered" and handled above).
  return null;
}

function fieldDeclarationProblem(field: PayrollCertificateField): string | null {
  if (!field.help) return "every certificate field needs help text — the operator is reading a "
    + "tax form they did not write";
  if (field.kind === "choice") {
    if (!field.choices || field.choices.length === 0) return "a choice field must declare choices";
    const values = field.choices.map((choice) => choice.value);
    if (new Set(values).size !== values.length) return "a choice field repeats a value";
    if (field.default != null && !values.includes(field.default)) {
      return `the default "${field.default}" is not one of the declared choices`;
    }
  } else if (field.choices) {
    return `a ${field.kind} field declares no choices`;
  }
  if (field.kind === "amount" && field.decimals == null) {
    return "an amount field must declare the scale its answers are stored at";
  }
  if (field.kind !== "amount" && field.decimals != null) {
    return `a ${field.kind} field carries no decimal scale`;
  }
  if (field.subRegion) {
    if (field.kind !== "code" && field.kind !== "flag") {
      return `a ${field.kind} field cannot name a sub-region — an allowance count or a dollar `
        + "amount is not a jurisdiction";
    }
    if (field.kind === "flag" && !field.subRegion.code) {
      return "a flag field that names a sub-region must say WHICH one (subRegion.code) — its "
        + "answer is a yes, not a code";
    }
    if (field.kind === "code" && field.subRegion.code) {
      return "a code field's ANSWER is the sub-region code, so it must not also declare one";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Sub-region membership
// ---------------------------------------------------------------------------

/** A jurisdiction below the region the employee is in, and on which side. */
export interface CertificateSubRegion {
  side: "work" | "residence";
  /** The pack's own sub-region code. */
  code: string;
  /** The certificate and field the answer came from, for the trace. */
  source: string;
}

/**
 * Every sub-region the employee's answers place them in.
 *
 * The generic half of the address problem: `resolveWithholding` takes the codes
 * from its caller because it cannot derive them, and this is where the caller
 * gets them — from the packs' own declarations, never from a list of city names
 * in engine code.
 */
export function certificateSubRegions(resolved: ResolvedCertificate): CertificateSubRegion[] {
  const found: CertificateSubRegion[] = [];
  for (const field of resolved.certificate.fields) {
    if (!field.subRegion) continue;
    const source = `${resolved.certificate.form} · ${field.label}`;
    if (field.kind === "flag") {
      if (certificateFlag(resolved, field.key)) {
        found.push({ side: field.subRegion.side, code: field.subRegion.code!, source });
      }
      continue;
    }
    const code = certificateCode(resolved, field.key);
    if (code) found.push({ side: field.subRegion.side, code, source });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** One stored certificate, as the storage layer hands it over. */
export interface StoredCertificate {
  certificateKey: string;
  /**
   * The jurisdiction point the row was filed for — the certificate's own
   * scope, enforced at POST. Optional because rows predate the scoping check;
   * an absent point reads as unscoped, which the scope revalidation treats
   * as a mismatch on a scoped certificate rather than as a match.
   */
  region?: string | null;
  /** The sub-region point, present only on sub_region-level certificates. */
  subRegion?: string | null;
  /** Answers keyed by field key. Values are strings at the declared scale. */
  answers: Record<string, string>;
  /** The date the employee signed it — the effective date of the answers. */
  effectiveFrom: string | null;
  /** Superseded certificates stay on file; only the current one is read. */
  supersededOn?: string | null;
}

/**
 * The resolved answers for one certificate: every declared field, with the
 * employee's answer, the pack's default, or null.
 *
 * `onFile` is the question reciprocity asks and is NOT the same as "some field
 * has a value": a non-residence certificate's whole content may be the fact of
 * its existence.
 */
export interface ResolvedCertificate {
  certificate: PayrollCertificate;
  onFile: boolean;
  effectiveFrom: string | null;
  /** Every declared field key → answer, default, or null. */
  answers: Record<string, string | null>;
  /** Required fields with no answer and no default. */
  missing: string[];
}

/** The profile row, as far as this module is concerned: a bag of columns. */
export type ProfileColumns = Record<string, unknown>;

/**
 * The resolved certificate for a jurisdiction that publishes NONE.
 *
 * Pennsylvania is the case: its rate is flat, there is nothing an employee
 * could elect, and it prints no withholding allowance certificate at all. An
 * engine still takes a `ResolvedCertificate` because the interface is one
 * shape, and this is the honest value for "there is no form" — reading any
 * field from it throws by name, which is what should happen to an engine
 * reaching for an answer its jurisdiction never asked for.
 */
export function emptyResolvedCertificate(label = "no certificate"): ResolvedCertificate {
  return {
    certificate: {
      key: "", form: "(none)", label, scope: { level: "country" },
      purpose: "withholding", citation: label, summary: label,
      fields: [], storage: "certificate_rows",
    },
    onFile: false,
    effectiveFrom: null,
    answers: {},
    missing: [],
  };
}

function columnAnswer(profile: ProfileColumns, column: string): string | null {
  const raw = profile[column];
  if (raw == null || raw === "") return null;
  if (typeof raw === "boolean") return raw ? "true" : "false";
  return String(raw);
}

/**
 * Resolve one declared certificate against what is stored.
 *
 * Precedence, most specific first:
 *   1. the employee's answer on a stored certificate ROW;
 *   2. the employee's answer in the profile COLUMN the field declares, for the
 *      pre-model certificates;
 *   3. the field's declared default, which is a statutory fact and not a guess;
 *   4. null — and if the field is required, it is reported in `missing` rather
 *      than substituted.
 *
 * Pure. No database, no clock: `asOf` is passed in, because "which certificate
 * is in force on the pay date" must be answerable for a prior period being
 * re-run and `new Date()` is not a payroll input.
 */
export function resolveCertificate(input: {
  certificate: PayrollCertificate;
  stored?: readonly StoredCertificate[];
  profile?: ProfileColumns;
  /** The pay date the answers are read as of. */
  asOf?: string;
}): ResolvedCertificate {
  const { certificate, profile = {}, asOf } = input;
  const candidates = (input.stored ?? [])
    .filter((row) => row.certificateKey === certificate.key)
    .filter((row) => !row.supersededOn || !asOf || row.supersededOn > asOf)
    .filter((row) => !row.effectiveFrom || !asOf || row.effectiveFrom <= asOf)
    .filter((row) => {
      if (!certificate.validity || !asOf) return true;
      const condition = certificate.validity.appliesWhen;
      if (condition && !condition.values.includes(row.answers[condition.field] ?? "")) return true;
      // An undated row cannot prove that an annually renewable election is
      // still current. Ignore it so the statutory no-current-certificate rule
      // applies instead of carrying a stale exemption forward.
      if (!row.effectiveFrom) return false;
      const year = Number(row.effectiveFrom.slice(0, 4));
      const validThrough = certificate.validity.kind === "calendar_year_end"
        ? `${year}-12-31`
        : `${year + 1}-${certificate.validity.monthDay}`;
      return asOf <= validThrough;
    })
    .sort((a, b) => (a.effectiveFrom ?? "").localeCompare(b.effectiveFrom ?? ""));
  const current = candidates[candidates.length - 1];

  const answers: Record<string, string | null> = {};
  const missing: string[] = [];
  for (const field of certificate.fields) {
    const fromRow = current?.answers?.[field.key];
    const fromColumn = field.storage?.kind === "column"
      ? columnAnswer(profile, field.storage.column)
      : null;
    const answer = fromRow != null && fromRow !== ""
      ? fromRow
      : fromColumn ?? field.default ?? null;
    answers[field.key] = answer;
    if (answer == null && field.required) missing.push(field.key);
  }

  // A column-backed certificate is "on file" when the employee has actually
  // answered something — otherwise every US employee would appear to hold a
  // signed W-4 the day the country column defaulted.
  const columnAnswered = certificate.fields.some((field) =>
    field.storage?.kind === "column" && columnAnswer(profile, field.storage.column) != null);

  return {
    certificate,
    onFile: current != null || columnAnswered,
    effectiveFrom: current?.effectiveFrom ?? null,
    answers,
    missing,
  };
}

// ---------------------------------------------------------------------------
// Scope revalidation — the read path's second check
// ---------------------------------------------------------------------------

/** A stored certificate the employee's current scope cannot honour. */
export interface StoredCertificateScopeMismatch {
  certificateKey: string;
  region: string | null;
  subRegion: string | null;
  /** Ready to show: names the certificate, the scope, and the remedy. */
  message: string;
}

/**
 * Revalidate every stored certificate against the pack's declaration and the
 * employee's CURRENT work and residence regions.
 *
 * The POST route scopes new filings to the employee's own region, but rows
 * filed before that check — and employees who moved regions after filing —
 * leave rows whose jurisdiction point no longer matches. Key membership alone
 * would then grant reciprocity, or answers would drive the wrong region's
 * table, with no gap. A mismatched row is EXCLUDED from the valid set and
 * reported, so the run withholds without it and names it instead of
 * honouring it silently.
 *
 * Pure: the caller supplies the regions it already resolved (the run reads
 * them from the profile once), and raises the mismatches through its own
 * refusal channel.
 */
export function revalidateStoredCertificates(input: {
  stored: readonly StoredCertificate[];
  country: string;
  workRegion: string;
  residenceRegion: string;
}): { valid: StoredCertificate[]; mismatched: StoredCertificateScopeMismatch[] } {
  const { stored, country, workRegion, residenceRegion } = input;
  const valid: StoredCertificate[] = [];
  const mismatched: StoredCertificateScopeMismatch[] = [];
  for (const row of stored) {
    let declared: PayrollCertificate;
    try {
      declared = payrollCertificate(country, row.certificateKey);
    } catch {
      mismatched.push({
        certificateKey: row.certificateKey,
        region: row.region ?? null,
        subRegion: row.subRegion ?? null,
        message:
          `"${row.certificateKey}" is on file for this employee but the ${country} payroll pack `
          + "declares no such certificate — it is ignored. "
          + "File the certificate the pack declares, or correct the profile if the employee moved packs.",
      });
      continue;
    }
    const { level, region: scopeRegion, subRegion: scopeSubRegion } = declared.scope;
    const rowRegion = row.region ?? null;
    const rowSubRegion = row.subRegion ?? null;
    const inScopeRegion = scopeRegion === workRegion || scopeRegion === residenceRegion;
    if (level === "country") {
      if (rowRegion !== null || rowSubRegion !== null) {
        mismatched.push({
          certificateKey: row.certificateKey, region: rowRegion, subRegion: rowSubRegion,
          message:
            `"${declared.form}" is a country-level certificate and carries no region, but this row `
            + `is filed for ${rowRegion ?? rowSubRegion} — it is ignored. `
            + "File the certificate without a region, or correct the profile if the employee moved.",
        });
        continue;
      }
    } else if (level === "region") {
      if (rowRegion !== scopeRegion) {
        mismatched.push({
          certificateKey: row.certificateKey, region: rowRegion, subRegion: rowSubRegion,
          message:
            `"${declared.form}" files for region "${scopeRegion}", but this row is filed for `
            + `"${rowRegion ?? "(no region)"}" — it is ignored. `
            + "File the certificate for its own region, or correct the profile if the employee moved.",
        });
        continue;
      }
      if (!inScopeRegion) {
        mismatched.push({
          certificateKey: row.certificateKey, region: rowRegion, subRegion: rowSubRegion,
          message:
            `"${declared.form}" is scoped to ${scopeRegion}, but this employee now works in `
            + `${workRegion} and resides in ${residenceRegion} — it is ignored. `
            + "Correct the profile regions if they are wrong, or file the certificate "
            + "the employee's own region declares.",
        });
        continue;
      }
    } else {
      if (rowRegion !== scopeRegion || rowSubRegion !== scopeSubRegion) {
        mismatched.push({
          certificateKey: row.certificateKey, region: rowRegion, subRegion: rowSubRegion,
          message:
            `"${declared.form}" files for "${scopeRegion ?? ""}/${scopeSubRegion ?? ""}", but this row `
            + `is filed for "${rowRegion ?? "(no region)"}/${rowSubRegion ?? "(no sub-region)"}" — it is ignored. `
            + "File the certificate for its own jurisdiction, or correct the profile if the employee moved.",
        });
        continue;
      }
      if (!inScopeRegion) {
        mismatched.push({
          certificateKey: row.certificateKey, region: rowRegion, subRegion: rowSubRegion,
          message:
            `"${declared.form}" is scoped to ${scopeRegion}, but this employee now works in `
            + `${workRegion} and resides in ${residenceRegion} — it is ignored. `
            + "Correct the profile regions if they are wrong, or file the certificate "
            + "the employee's own region declares.",
        });
        continue;
      }
    }
    valid.push(row);
  }
  return { valid, mismatched };
}

// ---------------------------------------------------------------------------
// Typed readers — the engine's side of the interface
// ---------------------------------------------------------------------------

/**
 * Read one answer at its declared kind, refusing a value the declaration does
 * not admit. The engines never touch `answers` directly: a state engine that
 * did `Number(answers.allowances)` would silently withhold from zero for
 * `"two"`, and would accept `"3.5"` allowances.
 */
export function certificateChoice(
  resolved: ResolvedCertificate,
  key: string,
): string | null {
  const field = declaredField(resolved, key, "choice");
  const value = resolved.answers[key] ?? null;
  if (value == null) return null;
  if (!field.choices!.some((choice) => choice.value === value)) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label}: "${value}" is not one of `
      + field.choices!.map((choice) => choice.value).join(", "),
    );
  }
  return value;
}

export function certificateCount(resolved: ResolvedCertificate, key: string): number | null {
  const field = declaredField(resolved, key, "count");
  const value = resolved.answers[key] ?? null;
  if (value == null || value === "") return null;
  if (!/^\d+$/.test(value.trim())) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label}: "${value}" is not a whole number of `
      + "allowances",
    );
  }
  const count = Number(value.trim());
  if (field.min != null && count < Number(field.min)) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label}: ${count} is below the declared minimum `
      + field.min,
    );
  }
  if (field.max != null && count > Number(field.max)) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label}: ${count} is above the declared maximum `
      + field.max,
    );
  }
  return count;
}

/**
 * A money answer, canonicalized to the field's declared scale by money.ts —
 * which refuses a value that would lose precision, so a typo cannot become a
 * rounded-off exemption.
 */
export function certificateAmount(resolved: ResolvedCertificate, key: string): string | null {
  const field = declaredField(resolved, key, "amount");
  const value = resolved.answers[key] ?? null;
  if (value == null || value === "") return null;
  try {
    return normalizeDecimal(value, field.decimals!);
  } catch (error) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label}: `
      + (error instanceof Error ? error.message : String(error)),
    );
  }
}

export function certificateFlag(resolved: ResolvedCertificate, key: string): boolean {
  declaredField(resolved, key, "flag");
  const value = resolved.answers[key] ?? null;
  return value === "true" || value === "1" || value === "yes";
}

export function certificateCode(resolved: ResolvedCertificate, key: string): string | null {
  declaredField(resolved, key, "code");
  const value = resolved.answers[key] ?? null;
  return value == null || value === "" ? null : value.trim();
}

function declaredField(
  resolved: ResolvedCertificate,
  key: string,
  kind: PayrollCertificateFieldKind,
): PayrollCertificateField {
  const field = resolved.certificate.fields.find((declared) => declared.key === key);
  if (!field) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} declares no "${key}" field — it declares `
      + (resolved.certificate.fields.map((declared) => declared.key).join(", ") || "none"),
    );
  }
  if (field.kind !== kind) {
    throw new PayrollCertificateError(
      `${resolved.certificate.form} ${field.label} is a ${field.kind} field, read as a ${kind}`,
    );
  }
  return field;
}
