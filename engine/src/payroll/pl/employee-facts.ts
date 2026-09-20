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
// off `emp["pl_rok_urodzenia"]`, served since 0191 by the profile column the
// `pl_wiek` certificate field maps: the PESEL derives and prefills it (see
// `./pesel.ts` for the cited century rule), employees without a PESEL are
// entered directly, and a saved value contradicting the PESEL refuses at the
// profile API naming both. Not derive-only — a purely derived value would
// give readiness nothing to point at and the operator no field to fill.
//
// OPEN, still: does the FP age bar key on BIRTH YEAR or on AGE AT THE PAY
// DATE? Those differ for anyone whose birthday falls inside the period, and
// this channel only supplies the year — it does not decide what the engine
// does with it. A statutory citation is owed before that question closes.
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
    producer: { kind: "profile_column", column: "pl_rok_urodzenia" },
  },
];

registerEmployeeFacts("PL", PL_EMPLOYEE_FACTS);
