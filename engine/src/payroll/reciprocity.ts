/**
 * Reciprocity — an agreement between two jurisdictions about which one taxes a
 * cross-border worker.
 *
 * The canonical case: a New Jersey resident who works in Pennsylvania. Without
 * an agreement, Pennsylvania would withhold on wages earned in Pennsylvania and
 * New Jersey would tax its resident on the same wages, and the employee would
 * unpick it on two annual returns. Pennsylvania and New Jersey have an
 * agreement, so Pennsylvania withholds nothing and New Jersey's tax is withheld
 * instead — but ONLY if the employee has filed Pennsylvania's Form REV-419 with
 * their employer. If they have not, Pennsylvania tax is withheld, correctly and
 * annoyingly, and the employee files to get it back.
 *
 * That last sentence is the entire reason this is a declared relation and not
 * an `if`. Three facts have to travel together and every payroll system that
 * gets this wrong has separated them:
 *
 *   1. WHICH pair of regions — directional, because agreements are not always
 *      symmetric and because the resolution has to know which side is the work
 *      side.
 *   2. WHICH region's tax applies when the agreement is in force.
 *   3. WHAT HAPPENS when the certificate has not been filed — which is the
 *      common case for a new hire, and where the money actually goes wrong.
 *
 * Nothing here knows a country or a state. An agreement is a row; the resolver
 * (engine/src/payroll/withholding-resolution.ts) reads rows.
 */
import { PayrollError } from "../payroll-error.ts";

export class PayrollReciprocityError extends PayrollError {}

/**
 * Which region taxes the wages when an agreement is in force.
 *
 * Every US reciprocal agreement is `residence` — that is what the agreements
 * are for. It is declared anyway rather than assumed, because "reciprocity
 * means the residence state taxes" is a US-shaped generalization and the
 * generic layer must not carry one.
 */
export type PayrollReciprocityTaxedBy = "residence" | "work";

/**
 * What the employer withholds when the agreement's certificate is NOT on file.
 *
 * `work_region` — the work region's tax is withheld exactly as though no
 *   agreement existed. This is the real rule in every US state surveyed: the
 *   agreement is elective and the certificate is how the employee elects it.
 * `residence_region` — the agreement applies automatically and the certificate
 *   is a formality. Declared for completeness; no US pair uses it.
 * `refuse` — the pack cannot say, so the run stops and names the employee.
 *   Better than either guess where a jurisdiction's rule is genuinely unclear.
 */
export type PayrollReciprocityDefault = "work_region" | "residence_region" | "refuse";

export interface PayrollReciprocityAgreement {
  /** The region where the work is physically performed. */
  workRegion: string;
  /** The region where the employee resides. */
  residenceRegion: string;
  taxedBy: PayrollReciprocityTaxedBy;
  /**
   * The `non_residence` certificate the employee must have on file for the
   * agreement to take effect (engine/src/payroll/certificates.ts). Null when
   * the jurisdiction requires no form.
   */
  certificateKey: string | null;
  /** See PayrollReciprocityDefault. */
  withoutCertificate: PayrollReciprocityDefault;
  /**
   * Does the agreement also relieve the SUB-REGION levies of the work region?
   * It usually does not: Pennsylvania's reciprocal agreements relieve the state
   * personal income tax and leave Philadelphia's wage tax fully payable by a
   * New Jersey commuter. A system that let reciprocity cascade downward would
   * under-withhold a city tax that the city will eventually assess with
   * interest.
   */
  relievesSubRegionLevies: boolean;
  /** The agreement, statute or department notice this is asserted from. */
  citation: string;
}

export interface PayrollPackReciprocity {
  country: string;
  agreements: readonly PayrollReciprocityAgreement[];
  /**
   * Cross-country agreements are out of scope by construction: an employee is
   * on exactly one country pack. Declared as a note so the omission is a
   * decision on the record rather than an oversight.
   */
  crossCountryNote?: string;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const BUILT_INS = new Map<string, PayrollPackReciprocity>();
const EXTRA = new Map<string, PayrollPackReciprocity>();
const SOURCES = new Map<string, () => PayrollPackReciprocity>();

/**
 * Register a pack's declaration LAZILY. See
 * `registerPayrollCertificateSource` — the same arrangement, for the same
 * module-evaluation reason.
 */
export function registerPayrollReciprocitySource(
  country: string,
  source: () => PayrollPackReciprocity,
): void {
  if (!country) {
    throw new PayrollReciprocityError("a payroll reciprocity source must name its country");
  }
  SOURCES.set(country, source);
}

function materializeSources(): void {
  if (SOURCES.size === 0) return;
  for (const [country, source] of [...SOURCES]) {
    if (BUILT_INS.has(country) || EXTRA.has(country)) {
      SOURCES.delete(country);
      continue;
    }
    const declaration = source();
    registerPayrollReciprocity(declaration, { builtIn: true });
    SOURCES.delete(country);
  }
}

export function registerPayrollReciprocity(
  declaration: PayrollPackReciprocity,
  options: { builtIn?: boolean } = {},
): void {
  if (!declaration.country) {
    throw new PayrollReciprocityError("a payroll reciprocity declaration must name its country");
  }
  const target = options.builtIn ? BUILT_INS : EXTRA;
  const other = options.builtIn ? EXTRA : BUILT_INS;
  if (other.has(declaration.country) || (target.has(declaration.country) && !options.builtIn)) {
    throw new PayrollReciprocityError(
      `payroll reciprocity for ${declaration.country} is already declared`,
    );
  }
  const seen = new Set<string>();
  for (const agreement of declaration.agreements) {
    if (agreement.workRegion === agreement.residenceRegion) {
      throw new PayrollReciprocityError(
        `${declaration.country}: a reciprocity agreement relates two DIFFERENT regions — `
        + `${agreement.workRegion} is declared with itself`,
      );
    }
    const key = `${agreement.workRegion}>${agreement.residenceRegion}`;
    if (seen.has(key)) {
      throw new PayrollReciprocityError(
        `${declaration.country}: two reciprocity agreements for work in ${agreement.workRegion} `
        + `by a resident of ${agreement.residenceRegion} — the resolution would be ambiguous`,
      );
    }
    seen.add(key);
    if (!agreement.citation) {
      throw new PayrollReciprocityError(
        `${declaration.country}: the ${key} reciprocity agreement must cite its authority`,
      );
    }
  }
  target.set(declaration.country, declaration);
}

export function unregisterPayrollReciprocity(country: string): void {
  EXTRA.delete(country);
}

export function declaredPayrollReciprocity(): PayrollPackReciprocity[] {
  materializeSources();
  return [...BUILT_INS.values(), ...EXTRA.values()];
}

/**
 * A pack's reciprocity declaration. Unlike the other registries this one does
 * NOT refuse a pack that has none — "this country has no interstate agreements"
 * is a legitimate and common answer, and forcing a pack to declare an empty
 * list to say it would be ceremony. An absent declaration and an empty list
 * mean the same thing and both resolve to "no agreement", which is the correct
 * default: without an agreement, the work region taxes the wages.
 */
export function packReciprocity(country: string): PayrollPackReciprocity {
  return declaredPayrollReciprocity().find((entry) => entry.country === country)
    ?? { country, agreements: [] };
}

/**
 * The agreement governing work in `workRegion` by a resident of
 * `residenceRegion`, or null.
 *
 * DIRECTIONAL. Illinois and Iowa have a mutual agreement, but it is declared as
 * two rows, because the certificate differs by direction (Illinois takes Form
 * IL-W-5-NR from the Iowa resident; Iowa takes its own from the Illinois
 * resident) and a single symmetric row cannot carry two certificate keys.
 */
export function reciprocityAgreement(
  country: string,
  workRegion: string,
  residenceRegion: string,
): PayrollReciprocityAgreement | null {
  if (workRegion === residenceRegion) return null;
  return packReciprocity(country).agreements.find((agreement) =>
    agreement.workRegion === workRegion && agreement.residenceRegion === residenceRegion) ?? null;
}

/** Every region whose residents may claim relief from working in `workRegion`. */
export function reciprocityPartners(country: string, workRegion: string): string[] {
  return packReciprocity(country).agreements
    .filter((agreement) => agreement.workRegion === workRegion)
    .map((agreement) => agreement.residenceRegion);
}
