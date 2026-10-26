import { sql, type SQL } from "drizzle-orm";

/** Native party identities. Employee is a natural person with a named employee role. */
export const PARTY_KINDS = ["company", "person", "customer", "vendor", "employee"] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];
const NATURAL_PERSON_KINDS = ["person", "employee"] as const;

/** Roles cannot establish personhood for a company, customer, or vendor identity. */
export function isNaturalPersonPartyKind(kind: unknown): kind is "person" | "employee" {
  return NATURAL_PERSON_KINDS.some((candidate) => candidate === kind);
}

export function naturalPersonPartyKindFilter(column: SQL): SQL {
  return sql`${column} in (${sql.join(
    NATURAL_PERSON_KINDS.map((kind) => sql`${kind}`),
    sql`, `,
  )})`;
}

export const EMPLOYEE_PERSON_REFUSAL =
  'The employee role requires kind "person" or "employee". Select a natural person identity before assigning the employee role.';

export class EmployeePartyKindError extends Error {
  readonly status = 422;
  readonly code = "employee-person-required";
  readonly field = "kind";
  readonly remedy = EMPLOYEE_PERSON_REFUSAL;

  constructor() {
    super(EMPLOYEE_PERSON_REFUSAL);
    this.name = "EmployeePartyKindError";
  }
}
