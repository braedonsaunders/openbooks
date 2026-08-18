import { add, formatMoney, neg } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";
import type {
  PayrollFilingCorrectionRow,
  PayrollFilingFieldChange,
  PayrollFilingSlipData,
  PayrollSlipBox,
} from "./payroll-filing-registry.ts";

/**
 * The US pack's CORRECTION forms — Form W-2c and Form 941-X.
 *
 * The IRS does not correct a return by re-filing it. Where the CRA re-sends a
 * T4 stamped with a report-type code, the IRS uses a WHOLLY SEPARATE form that
 * carries BOTH the previously reported amount and the corrected one, side by
 * side, so the agency can see the movement without holding the earlier filing:
 *
 *   - Form W-2c, "Corrected Wage and Tax Statement" (with Form W-3c as its
 *     transmittal), prints two stacked rows per corrected box — "Previously
 *     reported" and "Correct information" — plus boxes (f)/(g) for the
 *     employee's previously reported SSN and name. The IRS instruction is to
 *     complete ONLY the boxes being corrected, which is exactly the delta the
 *     generic lifecycle computes.
 *   - Form 941-X, "Adjusted Employer's QUARTERLY Federal Tax Return or Claim
 *     for Refund", prints three columns: column 1 the total corrected amount,
 *     column 2 the amount originally reported (or as previously corrected),
 *     and column 3 the difference. Column 3 is column 1 minus column 2, in
 *     money.ts arithmetic — never a float.
 *
 * These are FORM DATA builders, like every other slip in the payroll filing
 * registry: they feed the shared form-faithful facsimile pathway, and the
 * packs' declarations carry a named refusal for the ELECTRONIC correction
 * files (SSA EFW2C, 941-X e-file) exactly as they already do for EFW2 and the
 * 941 itself. A correction form the employer prints, signs and mails is a real
 * deliverable; a reconstructed transmission format would not be.
 */

/** Whether a reported value is an amount the correction can subtract. */
const MONEY = /^-?\d+(\.\d+)?$/;

/** Column 3 of a 941-X: corrected minus originally reported, exactly. */
function difference(current: string | null, previous: string | null): string | null {
  if (current == null || previous == null) return null;
  if (!MONEY.test(current) || !MONEY.test(previous)) return null;
  // Dollars and cents, like the columns either side of it — money.ts's
  // canonical four-decimal form beside two-decimal box amounts would read as
  // two different quantities on one line of a printed form.
  return formatMoney(add(current, neg(previous)), 2);
}

/**
 * Form W-2c from one row's correction.
 *
 * Only corrected boxes are printed, per the IRS instruction ("complete only
 * the money boxes that are being corrected"), and each one appears twice —
 * previously reported, then correct information. A cancellation prints the
 * form with zeros in the "correct information" column, which is how a W-2
 * filed in error is withdrawn: the SSA has no "delete" transaction, so the
 * amounts are corrected to nil.
 */
export function buildW2c(row: PayrollFilingCorrectionRow, taxYear: number): PayrollFilingSlipData {
  const cancelling = row.revision === "cancelled";
  const header = new Map(
    row.current.headerFields.map((field) => [field.label, field.value] as const),
  );
  const previousHeader = new Map(
    row.previously.fields.filter((f) => f.code == null).map((f) => [f.label, f.value] as const),
  );

  // Identity that MOVED is the W-2c's boxes (f) and (g) — what was previously
  // reported — and it is printed beside the correct value, never instead of it.
  const identity: { label: string; value: string }[] = [];
  for (const change of row.changes) {
    if (change.code != null) continue;
    if (change.redacted) {
      // Boxes (f)/(h): the SSN moved. The number itself is sealed and is not
      // reproduced here — the form is completed from the employee's record.
      identity.push({
        label: `Previously reported — ${change.label}`,
        value: "changed (enter from the employee's record)",
      });
      continue;
    }
    identity.push({
      label: `Previously reported — ${change.label}`,
      value: change.previous ?? "—",
    });
  }

  const boxes: PayrollSlipBox[] = [];
  const corrected = cancelling
    ? row.previously.fields
      .filter((field) => field.code != null)
      .map((field): PayrollFilingFieldChange => ({
        code: field.code,
        label: field.label,
        previous: field.value,
        current: MONEY.test(field.value) ? "0.00" : field.value,
        redacted: false,
      }))
    : row.changes.filter((change) => change.code != null);

  for (const change of corrected) {
    boxes.push({
      code: change.code!,
      label: `${change.label} — previously reported`,
      value: change.previous ?? "—",
    });
    boxes.push({
      code: change.code!,
      label: `${change.label} — correct information`,
      value: change.current ?? "—",
      emphasis: true,
    });
  }
  if (boxes.length === 0 && identity.length === 0) {
    throw new PayrollError(
      "nothing on this W-2 changed — a Form W-2c with no corrected box would tell the SSA "
      + "nothing and must not be filed",
    );
  }

  return {
    formCode: "US_W2C",
    formName: "Form W-2c — Corrected Wage and Tax Statement",
    formNumber: "Form W-2c",
    headerFields: [
      {
        label: "Employer identification number (EIN) (b)",
        value: header.get("Employer identification number (EIN)") ?? "Unassigned",
      },
      { label: "Tax year of the form being corrected (c)", value: String(taxYear) },
      { label: "Form being corrected (c)", value: "W-2" },
      {
        label: "Employee's name (h)",
        value: header.get("Employee's name") ?? row.label,
      },
      ...(previousHeader.get("Employee's name") !== undefined
        && previousHeader.get("Employee's name") !== header.get("Employee's name")
        ? [{
          label: "Employee's previously reported name (g)",
          value: previousHeader.get("Employee's name")!,
        }]
        : []),
      ...identity,
    ],
    boxes,
    notes: [
      "Only the boxes being corrected are completed, per the Form W-2c instructions; every "
      + "other box on the original W-2 stands.",
      "File Form W-3c, Transmittal of Corrected Wage and Tax Statements, with the W-2c set, "
      + "and give the employee their copies.",
      ...(cancelling
        ? [
          "This W-2 is being CANCELLED: the Social Security Administration has no delete "
          + "transaction for a filed W-2, so the correct amounts are nil. Confirm with the SSA "
          + "before filing if the employee should never have been reported under this EIN.",
        ]
        : []),
      "The SSA EFW2C electronic correction file is not generated — the same gap the original "
      + "W-2 declares for EFW2. Transmit corrections through SSA Business Services Online, or "
      + "mail the printed W-2c/W-3c.",
    ],
  };
}

/**
 * Form 941-X from one quarter's correction — the three-column adjustment.
 *
 * Line numbers on Form 941-X are its OWN and do not match Form 941's; this
 * worksheet keeps the 941 line codes it was computed from and prints the
 * 941-X's three columns against them, so the amounts are transcribed onto the
 * paper form without being re-derived. That transcription step is named in the
 * notes rather than glossed over.
 */
export function build941X(row: PayrollFilingCorrectionRow, taxYear: number): PayrollFilingSlipData {
  if (row.revision === "cancelled") {
    throw new PayrollError(
      "a Form 941 quarter cannot be cancelled — the IRS has no mechanism to withdraw a filed "
      + "quarterly return. Correct it on Form 941-X, which reports the difference",
    );
  }
  const header = new Map(
    row.current.headerFields.map((field) => [field.label, field.value] as const),
  );
  const boxes: PayrollSlipBox[] = [];
  for (const change of row.changes) {
    if (change.code == null) continue;
    const delta = difference(change.current, change.previous);
    boxes.push({
      code: change.code,
      label: `${change.label} — column 1, total corrected amount`,
      value: change.current ?? "—",
    });
    boxes.push({
      code: change.code,
      label: `${change.label} — column 2, amount originally reported`,
      value: change.previous ?? "—",
    });
    boxes.push({
      code: change.code,
      label: `${change.label} — column 3, difference`,
      value: delta ?? "—",
      emphasis: true,
    });
  }
  if (boxes.length === 0) {
    throw new PayrollError(
      "nothing on this Form 941 quarter changed — a Form 941-X with no difference reports "
      + "nothing and must not be filed",
    );
  }
  return {
    formCode: "US_941X",
    formName: "Form 941-X — Adjusted Employer's QUARTERLY Federal Tax Return or Claim for Refund",
    formNumber: "Form 941-X",
    headerFields: [
      {
        label: "Employer identification number (EIN)",
        value: header.get("Employer identification number (EIN)") ?? "Unassigned",
      },
      {
        label: "Return you are correcting",
        value: header.get("Report for this quarter") ?? `${taxYear}`,
      },
      { label: "Form being corrected", value: "941" },
    ],
    boxes,
    notes: [
      "Column 3 is column 1 minus column 2, computed in exact decimal arithmetic from the "
      + "committed pay stubs — it is never keyed.",
      "Form 941-X uses its own line numbering, which differs from Form 941's; the codes shown "
      + "here are the Form 941 lines these amounts were computed from and must be transcribed "
      + "onto the 941-X's corresponding lines.",
      "Form 941-X also requires the correction date, the certification in Part 2 and an "
      + "explanation in Part 4 — employer declarations no payroll data can supply.",
      "No electronic 941-X is generated, the same gap the original Form 941 declares: file the "
      + "adjusted return with the IRS directly.",
    ],
  };
}
