/**
 * JP required employee facts: the `emp` keys the pack's statutory engine
 * reads, DECLARED with kind, bounds, producer and refusal reason.
 *
 * One source, two readers: `./pack.ts` states it as the pack's
 * `employeeFacts` declaration, and `./compute-statutory.ts` imports this
 * module so every read registers before it can run. See
 * `../employee-facts.ts` for the shape and the derivation of `payable`.
 */
import { registerEmployeeFacts } from "../employee-facts.ts";
import type { PayrollEmployeeFact } from "../employee-facts.ts";

// Required employee facts. The compute path reads two `emp[...]` keys
  // and NO surface produces either — no profile column, no 扶養控除等申告書
  // field (it carries dependent counts and flags, not the 標準報酬 grade or
  // the kaigo status), no API input, no UI. Both block every employee.
  // Declared here with no producers yet, so readiness names the gap before
  // calculation and `payable` derives false until the next shard builds
  // the channels.
  export const JP_EMPLOYEE_FACTS: readonly PayrollEmployeeFact[] = [
    {
      key: "jp_hyojun_hoshu",
      kind: "amount",
      label: "標準報酬月額 (grade value, off the JPS notice)",
      refusalReason:
        "Pension and health price off the 標準報酬 grade, never off raw pay; an undeclared grade "
        + "must not fall through to pricing on the month's wages.",
      required: true,
      producer: {
        kind: "none",
        notes:
          "No channel exists. OPEN QUESTION: which artefact fixes the grade for the operator — the "
          + "JPS 標準報酬決定通知書 after 定時決定/随時改定, or a grade table the operator reads the "
          + "monthly remuneration through? JPS/NTA citation required before building; the refusal "
          + "already names the statutory artefact (標準報酬月額), which is the best of the four packs "
          + "and the pattern the other three should follow.",
      },
    },
    {
      key: "jp_kaigo_dainigou",
      kind: "flag",
      label: "介護保険第2号被保険者 status",
      refusalReason:
        "A 介護保険第2号被保険者 (40–64) owes the 介護 premium this engine does not price, and an "
        + "undeclared status must not default into health-without-介護 — the cheaper premium.",
      required: true,
      producer: {
        kind: "none",
        notes:
          "No channel exists. The refusal deliberately fails closed toward the employee's side (no "
          + "cheaper default) — keep that direction when the input is built. OPEN QUESTION: the status "
          + "follows age 40–64 almost mechanically; whether the input is a checkbox or an age-derived "
          + "display with an override needs the same birth-year citation PL and ES are waiting on.",
      },
    },
];

registerEmployeeFacts("JP", JP_EMPLOYEE_FACTS);
