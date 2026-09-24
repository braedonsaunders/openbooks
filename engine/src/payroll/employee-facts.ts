/**
 * Required employee facts: the `emp[...]` keys a pack's statutory engine
 * reads, DECLARED per pack instead of discovered at test-calculation time.
 *
 * Four of fourteen installable packs (PL, ES, JP, BR) cannot pay ANY
 * employee because their compute paths read facts no surface produces — no
 * profile column, no certificate field, no API input, no UI. All seven
 * blocking reads fail closed (correct, and unchanged here); the defect was
 * that nothing declared the gap, so readiness reported green and
 * `installable: true` promised what no employee could receive.
 *
 * Brazil is why this is a declaration with a test rather than a reminder
 * to be careful: its author stated the intent explicitly
 * (`br/certificates.ts` — "declaring an empty certificate list says 'no
 * form exists'") and still consumed profile facts nobody added. Prose
 * describing the intended producer is not a producer.
 *
 * The shape, per fact: key, kind, bounds, PRODUCER, and why it refuses.
 * A fact whose producer is "none yet" is the honest state — it is what
 * makes `payable` correctly false for those four packs. The seven
 * producers themselves are per-pack work with statutory questions
 * attached, and come after; this module only makes the gap enumerable.
 *
 * The producer set is built from TYPED DECLARATIONS — the certificate
 * registries and the profile-column mappings — never from occurrences.
 * The first census of this defect used `grep -rl <fact>` and reported
 * Brazil healthy off two COMMENT matches. Any check here that matched
 * text would certify those same comments and freeze the error as a
 * passing test.
 *
 * This module is a LEAF: it imports no pack registry, so a pack's
 * compute path can resolve through it without closing an import cycle
 * (compute → pack → compute). Each pack's facts live in its own
 * `<country>/employee-facts.ts`, which registers them here on import —
 * and the compute path imports that module directly, so registration is
 * guaranteed in every graph that can reach a read, never via a
 * transitive side effect.
 */
import { getTableColumns } from "drizzle-orm";
import { employeePayrollProfiles } from "@openbooks/schema";
import {
  packCertificates,
  profileColumnField,
} from "./certificates.ts";
import { PayrollJurisdictionError, PayrollPackError } from "./payroll-error.ts";
import type { PayrollCountryPack } from "./packs.ts";

/**
 * What shape the fact's value takes. Bounds beyond the kind live on the
 * fact (`min`/`max` for year/integer/count, `choices` for choice) and must
 * match what the pack's compute path enforces — never narrower, never
 * wider. A bound the engine does not check describes an imaginary product.
 */
export type PayrollEmployeeFactKind =
  /** An integer calendar year (birth years). */
  | "year"
  /** A bounded integer (the ES contribution group 1–11). */
  | "integer"
  /** A non-negative whole count (dependents). Never money. */
  | "count"
  /** Money, as a decimal string at the pack's canonical scale. */
  | "amount"
  /** One of a closed list of strings. */
  | "choice"
  /** A checkbox: the strings `"true"` / `"false"`. */
  | "flag"
  /** A short free string (a region code). */
  | "code";

/**
 * WHERE the fact's value comes from — the channel an operator acts on.
 * Every variant except `none` must resolve in a typed declaration (checked
 * by `employeeFactProducerProblem`); a claim that resolves nowhere is how
 * Brazil's comments became "two producers".
 */
export type PayrollEmployeeFactProducer =
  /** An `employee_payroll_profiles` column mapped by a certificate field. */
  | { kind: "profile_column"; column: string }
  /** A stored certificate answer: certificate key + field key. */
  | { kind: "certificate"; certificate: string; field: string }
  /** A `profileExemptionFlags` checkbox column the pack declares. */
  | { kind: "exemption_flag"; column: string }
  /**
   * A generic profile column — schema-owned, written by the profile API,
   * carrying no pack's vocabulary (`residence_region`). Validated against
   * the Drizzle table definition, not a hand list.
   */
  | { kind: "base_column"; column: string }
  /** Derived from a fact the pack already collects (PESEL → birth year). */
  | { kind: "derivation"; derivation: string; notes: string }
  /** No producer yet — the honest state. `notes` records what was decided. */
  | { kind: "none"; notes: string };

/**
 * One `emp[...]` fact a pack's statutory engine reads.
 */
export interface PayrollEmployeeFact {
  /** The engine key (`pl_rok_urodzenia`). Never shown to an operator raw. */
  key: string;
  kind: PayrollEmployeeFactKind;
  /**
   * The operator-facing name, in the operator's language where the pack
   * has one — the statutory artefact they can go and find (the JPS
   * notice's 標準報酬月額, not `emp jp_hyojun_hoshu`). Refusals name
   * engine keys today; this label is what fixes them.
   */
  label: string;
  /** The statutory reason an absent or invalid value refuses, in words. */
  refusalReason: string;
  /**
   * True when an absent value BLOCKS every employee (the seven). False
   * when absent is accepted — a default applies (BR pensão), absence is a
   * valid answer (ES contrato temporal), or only a present-but-foreign
   * value refuses (BR regime).
   */
  required: boolean;
  /** Inclusive numeric bounds for `year`, `integer` and `count`. */
  min?: number;
  /** Inclusive numeric bounds for `year`, `integer` and `count`. */
  max?: number;
  /** The closed answer set for `choice`. */
  choices?: readonly string[];
  /** Where the value comes from — or the honest `none`. */
  producer: PayrollEmployeeFactProducer;
}

// ---------------------------------------------------------------------------
// Registration. Populated by each pack's own `<country>/employee-facts.ts`
// on import — which the pack's compute path imports directly, so a read
// can never run unregistered. A pack that reads no fact registers
// nothing and reads as empty.
// ---------------------------------------------------------------------------

const FACTS = new Map<string, readonly PayrollEmployeeFact[]>();

export function registerEmployeeFacts(
  country: string,
  facts: readonly PayrollEmployeeFact[],
): void {
  FACTS.set(country, facts);
}

/** True once the pack's own facts module has been imported. */
export function isEmployeeFactsRegistered(country: string): boolean {
  return FACTS.has(country);
}

/**
 * The declared facts for one pack. Unregistered reads as empty — but
 * `empFact` refuses an unregistered country outright, so silence can
 * never smuggle a read past the declaration.
 */
export function employeeFactsFor(country: string): readonly PayrollEmployeeFact[] {
  return FACTS.get(country) ?? [];
}

/**
 * Read one employee fact the way the pack's compute path does — through
 * the declaration. Returns the raw value untouched (presence, bounds and
 * refusal messages stay exactly where they are: the compute path); what
 * this adds is the authoring-time refusal — an unregistered country, or
 * a key the pack never declared, throws here instead of silently reading
 * `undefined` forever.
 */
export function empFact(
  country: string,
  emp: Record<string, string | null>,
  key: string,
): string | null | undefined {
  if (!FACTS.has(country)) {
    throw new PayrollJurisdictionError(
      `no employeeFacts registered for ${country || "(unset)"} — the pack's compute path `
      + "must import its own <country>/employee-facts.ts so its reads resolve through the declaration",
    );
  }
  const declared = (FACTS.get(country) ?? []).some((fact) => fact.key === key);
  if (!declared) {
    throw new PayrollPackError(
      `the ${country} payroll pack reads employee fact "${key}" without declaring it — `
      + `declare it in the pack's employeeFacts (key, kind, bounds, producer, refusal reason) first`,
    );
  }
  return emp[key];
}

/** Resolve and validate one declared employee fact at the calculation
 * boundary. The caller reads the value from the declared producer (profile
 * or certificate); this common gate guarantees every pack gets the same
 * missing-value and primitive/bounds semantics instead of a silent default. */
export function resolveEmployeeFact(
  country: string,
  key: string,
  raw: string | null | undefined,
): string | null {
  if (!FACTS.has(country)) {
    throw new PayrollJurisdictionError(
      `no employeeFacts registered for ${country || "(unset)"} — the pack's compute path `
      + "must import its own <country>/employee-facts.ts so its reads resolve through the declaration",
    );
  }
  const fact = (FACTS.get(country) ?? []).find((candidate) => candidate.key === key);
  if (!fact) {
    throw new PayrollPackError(
      `the ${country} payroll pack reads employee fact "${key}" without declaring it — `
      + `declare it in employeeFacts (kind, bounds, producer, refusal reason) first`,
    );
  }
  if (raw == null || raw.trim() === "") {
    if (!fact.required) return null;
    throw new PayrollPackError(
      `${country} payroll cannot calculate without ${fact.label} (${fact.key}): `
      + `${fact.refusalReason} Supply this fact through the pack's declared producer.`,
    );
  }
  const value = raw.trim();
  let invalid: string | null = null;
  if (fact.kind === "flag" && value !== "true" && value !== "false") {
    invalid = `must be "true" or "false"`;
  } else if (fact.kind === "choice" && !fact.choices?.includes(value)) {
    invalid = `must be one of ${fact.choices?.join(", ") ?? "the declared choices"}`;
  } else if (fact.kind === "year" || fact.kind === "integer" || fact.kind === "count") {
    const n = Number(value);
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(n)) {
      invalid = "must be a whole number";
    } else if (fact.min !== undefined && n < fact.min || fact.max !== undefined && n > fact.max) {
      invalid = `must be between ${fact.min ?? "−∞"} and ${fact.max ?? "∞"}`;
    } else if (fact.kind === "count" && n < 0) {
      invalid = "must be a non-negative whole number";
    }
  }
  if (invalid) {
    throw new PayrollPackError(
      `${country} payroll cannot use ${fact.label} (${fact.key}) value "${value}": ${invalid}. `
      + `${fact.refusalReason} Correct the value in the pack's declared producer.`,
    );
  }
  return value;
}

/**
 * The required facts absent (or blank) for one employee — the per-person
 * gap readiness enumerates BEFORE calculation. Optional facts are never
 * missing: absent is an accepted answer for them.
 */
export function missingEmployeeFacts(
  country: string,
  emp: Record<string, string | null>,
): readonly PayrollEmployeeFact[] {
  return employeeFactsFor(country).filter(
    (fact) => fact.required && (emp[fact.key] === undefined || emp[fact.key] === null || emp[fact.key] === ""),
  );
}

/**
 * Whether a claimed producer resolves in the typed declarations — the
 * certificate registries and the profile-column mappings — never in
 * comments or prose. Returns the problem, or null when the claim holds.
 * `none` is always honest; `derivation` carries its own notes until a
 * derivation registry exists to check it against.
 */
export function employeeFactProducerProblem(
  country: string,
  fact: PayrollEmployeeFact,
  exemptionColumns: readonly string[] = [],
): string | null {
  const producer = fact.producer;
  try {
    switch (producer.kind) {
      case "none":
      case "derivation":
        return null;
      case "profile_column": {
        const field = profileColumnField(country, producer.column);
        if (!field) {
          return (
            `${country} employee fact "${fact.key}" claims profile column "${producer.column}", `
            + "which no certificate field of this pack maps — the column is not a producer"
          );
        }
        return null;
      }
      case "certificate": {
        const declared = packCertificates(country);
        const certificate = declared.certificates.find((entry) => entry.key === producer.certificate);
        if (!certificate) {
          return (
            `${country} employee fact "${fact.key}" claims certificate "${producer.certificate}", `
            + "which this pack does not declare"
          );
        }
        const field = certificate.fields.find((entry) => entry.key === producer.field);
        if (!field) {
          return (
            `${country} employee fact "${fact.key}" claims field "${producer.field}" `
            + `on certificate "${producer.certificate}", which declares no such field`
          );
        }
        return null;
      }
      case "exemption_flag": {
        if (!exemptionColumns.includes(producer.column)) {
          return (
            `${country} employee fact "${fact.key}" claims exemption flag column "${producer.column}", `
            + "which this pack does not declare in profileExemptionFlags"
          );
        }
        return null;
      }
      case "base_column": {
        const columns = Object.values(getTableColumns(employeePayrollProfiles));
        if (!columns.some((column) => column.name === producer.column)) {
          return (
            `${country} employee fact "${fact.key}" claims base profile column "${producer.column}", `
            + "which employee_payroll_profiles does not carry"
          );
        }
        return null;
      }
    }
  } catch (error) {
    return `${country} employee fact "${fact.key}" producer does not resolve: ${String(error)}`;
  }
}

/**
 * The declaration itself, checked structurally: unique keys, kinds with
 * the bounds they need, and every claimed producer resolving. The
 * conformance test requires this to be null for every registered pack.
 * The pack is passed explicitly — this module never imports the registry,
 * so it cannot close an import cycle with it.
 */
export function employeeFactsProblem(
  country: string,
  facts: readonly PayrollEmployeeFact[] | undefined,
  exemptionColumns: readonly string[] = [],
): string | null {
  if (!facts || !Array.isArray(facts)) {
    return `the ${country} payroll pack states no employeeFacts declaration — declare it (possibly empty)`;
  }
  const seen = new Set<string>();
  for (const fact of facts) {
    if (seen.has(fact.key)) {
      return `the ${country} payroll pack declares employee fact "${fact.key}" twice`;
    }
    seen.add(fact.key);
    if (fact.kind === "choice" && (!fact.choices || fact.choices.length === 0)) {
      return `the ${country} payroll pack declares choice fact "${fact.key}" with no choices`;
    }
    if (
      (fact.kind === "year" || fact.kind === "integer" || fact.kind === "count")
      && fact.min !== undefined && fact.max !== undefined && fact.min > fact.max
    ) {
      return `the ${country} payroll pack declares fact "${fact.key}" with min ${fact.min} above max ${fact.max}`;
    }
    const producerProblem = employeeFactProducerProblem(country, fact, exemptionColumns);
    if (producerProblem) return producerProblem;
  }
  return null;
}

/**
 * Why this pack cannot pay anyone yet — or null when it can. DERIVED,
 * never asserted: a pack is payable exactly when it is installable and
 * every REQUIRED fact has a producer. Optional facts without producers
 * do not block (absent is an accepted answer for them); required facts
 * without producers mean every employee refuses, so the pack is not
 * payable even though it is installable.
 */
export function packPayableProblem(pack: PayrollCountryPack): string | null {
  if (!pack.installable) return null;
  const blocked = (pack.employeeFacts ?? []).filter(
    (fact) => fact.required && fact.producer.kind === "none",
  );
  if (blocked.length === 0) return null;
  const names = blocked.map((fact) => `${fact.label} (${fact.key})`).join("; ");
  return (
    `the ${pack.country} payroll pack is installable but cannot pay any employee: `
    + `${blocked.length} required employee fact${blocked.length === 1 ? " has" : "s have"} no producer — ${names}`
  );
}

/** Derived from the declaration — never a second flag a pack can assert. */
export function isPayrollPackPayable(pack: PayrollCountryPack): boolean {
  return pack.installable && packPayableProblem(pack) === null;
}

/** Payable packs as country codes, in registry order. */
export function payablePayrollCountries(packs: readonly PayrollCountryPack[]): string[] {
  return packs.filter(isPayrollPackPayable).map((pack) => String(pack.country));
}

/** Payable packs as (country, name) pairs, for surfaces that list packs. */
export function payablePayrollPacks(
  packs: readonly PayrollCountryPack[],
): { country: string; name: string }[] {
  return packs
    .filter(isPayrollPackPayable)
    .map((pack) => ({ country: String(pack.country), name: pack.name }));
}
