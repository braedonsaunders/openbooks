/**
 * PL required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads the employee's birth year
// off `emp["pl_rok_urodzenia"]` and NO surface produces it — no profile
// column, no certificate field (PIT-2 carries pomniejszenie and kup only),
// no API input, no UI — so every PL pay run refuses every employee and the
// only remedy is editing the database. The fact is declared here, with no
// producer yet, so readiness names the gap before calculation and `payable`
// derives false until the next shard builds the channel.
// ---------------------------------------------------------------------------

export const PL_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
  {
    key: "pl_rok_urodzenia",
    kind: "year",
    label: "Birth year (rok urodzenia)",
    refusalReason:
      "The FP/FS age bar (art. 261) and the under-26 refusal cannot be decided without it, "
      + "and an unknown age must not fall through to standard pricing.",
    required: true,
    producer: {
      kind: "none",
      notes:
        "No channel exists. OPEN QUESTION: does the FP age bar key on BIRTH YEAR or on AGE AT THE "
        + "PAY DATE? Those differ for anyone whose birthday falls inside the period. gov.pl citation "
        + "required before building. DECIDED: a declared birth-year field, with the PESEL deriving and "
        + "PREFILLING it (first six digits YYMMDD, century carried in the month digits: 01–12 → 1900s, "
        + "21–32 → 2000s, 81–92 → 1800s); a saved value CONTRADICTING the PESEL refuses naming both. "
        + "Not derive-only — a purely derived value gives readiness nothing to point at and the operator "
        + "no field to fill. Employees without a PESEL (foreign workers on NIP/passport) need the "
        + "declared fallback input.",
    },
  },
];

registerEmployeeFacts("PL", PL_EMPLOYEE_FACTS);
