import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { sum } from "./money.ts";
import { PayrollError } from "./payroll-error.ts";

/**
 * Printed pay cheques.
 *
 * Cheque numbers ride the org's existing `number_sequences` machinery — the
 * same table, prefix, padding and subsidiary scoping every other document
 * number in the product uses — under the kind `payroll_cheque`, so the
 * employer configures the stock's starting number in Setup → Number sequences
 * rather than in a payroll-only setting. The number lands on the stub
 * (`pay_stubs.cheque_number`, unique per org) because the stub IS the
 * per-employee record of the pay; there is no parallel cheque register.
 *
 * Numbers are allocated ONCE per stub: re-printing a batch reprints the same
 * numbers rather than burning stock, which is what makes the print button safe
 * to press twice.
 */

export const PAYROLL_CHEQUE_SEQUENCE_KIND = "payroll_cheque";
const PAYROLL_CHEQUE_PREFIX = "CHQ-";

export interface PayRunCheque {
  stubId: string;
  employeePartyId: string;
  employeeName: string;
  chequeNumber: string;
  amount: string;
}

export interface PayRunChequeBatch {
  cheques: PayRunCheque[];
  /** Control total of the batch. */
  total: string;
  /** How many numbers this call allocated (0 on a re-print). */
  issued: number;
}

/**
 * Allocate a cheque number to every cheque-rail stub on the run that has not
 * got one, and return the batch in the order it prints.
 *
 * A run whose figures are not final has nothing to print: cheque stock is
 * physical and a number that has left the printer cannot be recalled, so this
 * refuses until the run is committed.
 */
export async function issuePayRunCheques(input: {
  orgId: string;
  documentId: string;
  actorId: string;
}): Promise<PayRunChequeBatch> {
  const { orgId, documentId, actorId } = input;
  return await db.transaction(async (tx) => {
    const runRows = (await tx.execute(sql`
      select r.run_status, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r
    `)) as unknown as { rows: { run_status: string; subsidiary_id: string | null }[] };
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (run.run_status !== "committed") {
      throw new PayrollError("commit the pay run before printing its cheques");
    }

    const stubs = (await tx.execute(sql`
      select s.id, s.employee_party_id, p.display_name as name, s.net_pay::text as net_pay,
             s.cheque_number
        from pay_stubs s
        join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         and s.payment_method = 'cheque'
       order by p.display_name, s.id
       for update of s
    `)) as unknown as {
      rows: {
        id: string; employee_party_id: string; name: string; net_pay: string;
        cheque_number: string | null;
      }[];
    };

    // A per-subsidiary sequence is used only when the employer has configured
    // one; otherwise the org-wide row. Same probe as engine/src/payments.ts.
    const scoped = run.subsidiary_id
      ? ((await tx.execute(sql`
          select 1 from number_sequences
           where org_id = ${orgId} and document_kind = ${PAYROLL_CHEQUE_SEQUENCE_KIND}
             and subsidiary_id = ${run.subsidiary_id} limit 1
        `)) as unknown as { rows: unknown[] }).rows.length > 0
      : false;
    const sequenceSubsidiaryId = scoped ? run.subsidiary_id : null;

    let issued = 0;
    const cheques: PayRunCheque[] = [];
    for (const stub of stubs.rows) {
      let number = stub.cheque_number;
      if (!number) {
        const seq = (await tx.execute(sql`
          insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
          values (${orgId}, ${PAYROLL_CHEQUE_SEQUENCE_KIND}, ${sequenceSubsidiaryId},
                  ${PAYROLL_CHEQUE_PREFIX})
          on conflict on constraint sequences_org_kind_sub
          do update set next_number = number_sequences.next_number + 1
          returning prefix, next_number, padding
        `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
        const s = seq.rows[0]!;
        number = `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
        await tx.execute(sql`
          update pay_stubs set cheque_number = ${number}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${stub.id}
        `);
        issued += 1;
      }
      cheques.push({
        stubId: stub.id,
        employeePartyId: stub.employee_party_id,
        employeeName: stub.name,
        chequeNumber: number,
        amount: stub.net_pay,
      });
    }
    return { cheques, total: sum(cheques.map((c) => c.amount)), issued };
  });
}

/** The batch as it stands, without allocating anything (list/preview). */
export async function payRunCheques(orgId: string, documentId: string): Promise<PayRunChequeBatch> {
  const rows = (await db.execute(sql`
    select s.id, s.employee_party_id, p.display_name as name, s.net_pay::text as net_pay,
           s.cheque_number
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       and s.payment_method = 'cheque'
     order by p.display_name, s.id
  `)) as unknown as {
    rows: {
      id: string; employee_party_id: string; name: string; net_pay: string;
      cheque_number: string | null;
    }[];
  };
  const cheques = rows.rows.map((row) => ({
    stubId: row.id,
    employeePartyId: row.employee_party_id,
    employeeName: row.name,
    chequeNumber: row.cheque_number ?? "",
    amount: row.net_pay,
  }));
  return { cheques, total: sum(cheques.map((c) => c.amount)), issued: 0 };
}

/**
 * `1,234.56` → `One thousand two hundred thirty-four and 56/100`.
 *
 * The legal amount on a cheque. Written out here rather than by a locale
 * formatter because the courtesy amount and the legal amount must agree to the
 * cent and an Intl rounding surprise on a negotiable instrument is not
 * recoverable.
 */
const ONES = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten",
  "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen", "seventeen", "eighteen",
  "nineteen",
];
const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
const SCALES = ["", " thousand", " million", " billion", " trillion"];

function underThousand(n: number): string {
  if (n < 20) return ONES[n]!;
  if (n < 100) {
    const rest = n % 10;
    return TENS[Math.floor(n / 10)]! + (rest ? `-${ONES[rest]}` : "");
  }
  const rest = n % 100;
  return `${ONES[Math.floor(n / 100)]} hundred${rest ? ` ${underThousand(rest)}` : ""}`;
}

export function amountInWords(amount: string): string {
  const negative = amount.trim().startsWith("-");
  const [whole = "0", fraction = ""] = amount.trim().replace(/^[-+]/, "").split(".");
  const cents = `${fraction}00`.slice(0, 2);
  let dollars = BigInt(whole || "0");
  if (dollars === 0n) return capitalize(`${negative ? "minus " : ""}zero and ${cents}/100`);
  const groups: string[] = [];
  let scale = 0;
  while (dollars > 0n) {
    const group = Number(dollars % 1000n);
    if (group > 0) groups.unshift(underThousand(group) + SCALES[scale]!);
    dollars /= 1000n;
    scale += 1;
    if (scale >= SCALES.length && dollars > 0n) {
      throw new PayrollError(`cheque amount ${amount} is too large to write in words`);
    }
  }
  return capitalize(`${negative ? "minus " : ""}${groups.join(" ")} and ${cents}/100`);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}
