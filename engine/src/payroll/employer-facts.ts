import { normalizeDecimal } from "../money/money.ts";
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts";

export type PayrollEmployerFactKind = "choice" | "integer" | "decimal" | "boolean";

/** A fact the pack requires of the legal employer and accepts through Setup. */
export interface PayrollEmployerFact {
  key: string;
  kind: PayrollEmployerFactKind;
  label: string;
  refusalReason: string;
  legalBasis: string;
  required: boolean;
  /** Whether the fact changes on any date or only at calendar-year boundaries. */
  effectivePeriod?: "date" | "calendar_year";
  /** Decimal precision for decimal facts; required only for that kind. */
  scale?: number;
  min?: string;
  max?: string;
  choices?: readonly { value: string; label: string }[];
}

const FACTS = new Map<string, readonly PayrollEmployerFact[]>();

export function registerEmployerFacts(country: string, facts: readonly PayrollEmployerFact[]): void {
  FACTS.set(country, facts);
}

export function employerFactsFor(country: string): readonly PayrollEmployerFact[] {
  return FACTS.get(country) ?? [];
}

export function isValidEmployerFactEffectiveDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12) return false;
  const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const daysInMonth = [31, leapYear ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]!;
  return day >= 1 && day <= daysInMonth;
}

export function employerFact(country: string, key: string): PayrollEmployerFact {
  if (!FACTS.has(country)) {
    throw new PayrollJurisdictionError(
      `no employerFacts registered for ${country || "(unset)"} — import the pack's employer-facts declaration`,
    );
  }
  const fact = FACTS.get(country)!.find((candidate) => candidate.key === key);
  if (!fact) {
    throw new PayrollPackError(
      `the ${country} payroll pack reads employer fact "${key}" without declaring it in employerFacts`,
    );
  }
  return fact;
}

function compareDecimals(a: string, b: string): number {
  const left = BigInt(a.replace(".", ""));
  const right = BigInt(b.replace(".", ""));
  return left < right ? -1 : left > right ? 1 : 0;
}

/** Resolve a stored value against the exact type and bounds declared by its pack. */
export function resolveEmployerFact(
  country: string,
  key: string,
  raw: string | null | undefined,
): string | null {
  const fact = employerFact(country, key);
  if (raw == null || raw.trim() === "") {
    if (!fact.required) return null;
    throw new PayrollPackError(
      `${country} payroll cannot calculate without ${fact.label} (${fact.key}): `
      + `${fact.refusalReason} Supply this value in Payroll Setup → Employer facts.`,
    );
  }
  const value = raw.trim();
  let canonical = value;
  let invalid: string | null = null;
  if (fact.kind === "boolean") {
    if (value !== "true" && value !== "false") invalid = 'must be "true" or "false"';
  } else if (fact.kind === "choice") {
    const choices = fact.choices?.map((choice) => choice.value) ?? [];
    if (!choices.includes(value)) invalid = `must be one of ${choices.join(", ") || "the declared choices"}`;
  } else if (fact.kind === "integer") {
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
      invalid = "must be a whole safe integer";
    } else if (fact.min !== undefined && BigInt(value) < BigInt(fact.min)
      || fact.max !== undefined && BigInt(value) > BigInt(fact.max)) {
      invalid = `must be between ${fact.min ?? "−∞"} and ${fact.max ?? "∞"}`;
    } else {
      canonical = BigInt(value).toString();
    }
  } else {
    const scale = fact.scale;
    if (!Number.isInteger(scale) || scale! < 0 || scale! > 10) {
      throw new PayrollPackError(`${country} employer fact ${fact.key} declares an invalid decimal scale`);
    }
    try {
      canonical = normalizeDecimal(value, scale);
      if (fact.min !== undefined && compareDecimals(canonical, normalizeDecimal(fact.min, scale)) < 0
        || fact.max !== undefined && compareDecimals(canonical, normalizeDecimal(fact.max, scale)) > 0) {
        invalid = `must be between ${fact.min ?? "−∞"} and ${fact.max ?? "∞"}`;
      }
    } catch {
      invalid = `must be an exact decimal with at most ${scale} fractional digits`;
    }
  }
  if (invalid) {
    throw new PayrollPackError(
      `${country} payroll cannot use ${fact.label} (${fact.key}) value "${value}": ${invalid}. `
      + `${fact.refusalReason} Correct it in Payroll Setup → Employer facts.`,
    );
  }
  return canonical;
}
