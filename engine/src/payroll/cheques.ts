import { sealJson, unsealJson } from "../platform/secrets.ts";
import {
  lockChequeBank,
  chequeMicrFields,
  type CanadianChequeBank,
} from "../payments-core/cheque-bank.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { sum, toUnits } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { PayrollError } from "./error.ts";
import { PaymentError } from "../payments-core/payment-errors.ts";
import { lockAndCheckPayrollRunPopulation } from "./scope.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";

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
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  bankProfileId?: string | null;
  printMicr?: boolean;
}): Promise<PayRunChequeBatch> {
  const { orgId, documentId, actorId, allowedSubsidiaryIds } = input;
  return await withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
        throw new PayrollError("Payroll is switched off in Company Settings → Features");
      const runRows = await tx.execute<{
        run_status: string;
        subsidiary_id: string | null;
        paid_entry_id: string | null;
      }>(
        sql`
      select r.run_status, d.subsidiary_id, r.paid_entry_id
       from pay_runs r
       join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
       for update of r
    `,
        "objects",
      );
      const run = runRows[0];
      if (!run) throw new PayrollError("pay run not found");
      const actorScope = await lockActorCommandAuthority(
        tx,
        orgId,
        actorId,
        run.subsidiary_id,
        "payroll.run",
      );
      if (run.run_status !== "committed") {
        throw new PayrollError("commit the pay run before printing its cheques");
      }
      // Cheque numbers cannot be recalled once printed: a scoped caller must
      // own the complete population, exactly as the bank file and every other
      // run action require. Fail closed before the first number is allocated.
      await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, allowedSubsidiaryIds);
      await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, actorScope);

      const stubs = await tx.execute<{
        id: string;
        employee_party_id: string;
        name: string;
        net_pay: string;
        cheque_number: string | null;
        currency_code: string;
        pay_date: string;
      }>(
        sql`
      select s.id, s.employee_party_id, p.display_name as name, s.net_pay::text as net_pay,
             s.cheque_number, s.currency_code, s.pay_date::text
        from pay_stubs s
        join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         and s.payment_method = 'cheque'
       order by p.display_name, s.id
       for update of s
    `,
        "objects",
      );

      // A per-subsidiary sequence is used only when the employer has configured
      // one; otherwise the org-wide row. Same probe as engine/src/payments/payments.ts.
      const scoped = run.subsidiary_id
        ? (
            await tx.execute(
              sql`
          select 1 from number_sequences
           where org_id = ${orgId} and document_kind = ${PAYROLL_CHEQUE_SEQUENCE_KIND}
             and subsidiary_id = ${run.subsidiary_id} limit 1
        `,
              "objects",
            )
          ).length > 0
        : false;
      const sequenceSubsidiaryId = scoped ? run.subsidiary_id : null;

      let issued = 0;
      const cheques: PayRunCheque[] = [];
      for (const stub of stubs) {
        if (toUnits(stub.net_pay) <= 0n || toUnits(stub.net_pay) % 100n !== 0n)
          throw new PayrollError(
            "Cheques require positive whole-cent net pay; correct the payroll calculation before committing the run",
          );
        let number = stub.cheque_number;
        let bankBasis: IssuedChequeBank | null = null;
        if (number) {
          bankBasis = await readIssuedChequeBank(tx, orgId, stub.id);
          if (input.bankProfileId && bankBasis?.profileId !== input.bankProfileId)
            throw new PayrollError(
              "Reprint with the original cheque bank profile; issued bank details cannot be changed",
            );
          if (input.printMicr && !bankBasis)
            throw new PayrollError(
              "This cheque was issued for preprinted bank stock; its original stock is required",
            );
        } else {
          let profileId = input.bankProfileId;
          if (!profileId) {
            const profiles = await tx.execute<{ id: string }>(
              sql`select p.id from payment_bank_profiles p
            join payment_formats f on f.org_id=p.org_id and f.id=p.payment_format_id and f.is_active and f.rail='cheque'
            join accounts a on a.org_id=p.org_id and a.id=p.bank_account_id and a.is_active and not a.is_summary and a.type='asset_bank'
            where p.org_id=${orgId} and p.is_active and p.currency=${stub.currency_code}
              and (p.subsidiary_id is null or p.subsidiary_id is not distinct from ${run.subsidiary_id}::uuid)
              and (a.subsidiary_id is null or a.subsidiary_id is not distinct from ${run.subsidiary_id}::uuid)
            order by p.id for share of p,f,a`,
              "objects",
            );
            if (profiles.length !== 1)
              throw new PayrollError(
                "Configure a cheque bank profile in Payment Operations Setup and select it in the cheque designer when more than one profile applies",
              );
            profileId = profiles[0]!.id;
          }
          bankBasis = {
            ...(await lockChequeBank(
              tx,
              orgId,
              profileId,
              run.subsidiary_id,
              stub.currency_code,
              stub.pay_date,
            )),
            payeeName: stub.name,
          };
        }
        if (input.printMicr && !bankBasis?.bank)
          throw new PayrollError(
            "Configure the Canadian MICR bank fields on the cheque bank profile before printing blank stock",
          );
        if (bankBasis && run.paid_entry_id) {
          const funding = await tx.execute<{ account_id: string }>(
            sql`select distinct l.account_id from journal_lines l join accounts a on a.org_id=l.org_id and a.id=l.account_id and a.type='asset_bank' where l.org_id=${orgId} and l.entry_id=${run.paid_entry_id} and l.amount<0`,
            "objects",
          );
          if (funding.length !== 1 || funding[0]!.account_id !== bankBasis.bankAccountId)
            throw new PayrollError(
              "Use cheque stock for the bank account recorded on this payroll payment",
            );
        }
        if (!number) {
          const seq = await tx.execute<{ prefix: string; next_number: number; padding: number }>(
            sql`
          insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
          values (${orgId}, ${PAYROLL_CHEQUE_SEQUENCE_KIND}, ${sequenceSubsidiaryId},
                  ${PAYROLL_CHEQUE_PREFIX})
          on conflict on constraint sequences_org_kind_sub
          do update set next_number = number_sequences.next_number + 1
          where number_sequences.org_id = ${orgId}
          returning prefix, next_number, padding
        `,
            "objects",
          );
          const s = seq[0];
          if (!s) throw new PayrollError("Cheque number allocation was not recorded");
          number = `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
          if (input.printMicr && bankBasis?.bank) chequeMicrFields(number, bankBasis.bank);
          const stamped = await tx.execute<{ id: string }>(
            sql`
          update pay_stubs set cheque_number = ${number}, updated_at = now(), updated_by = ${actorId}
           where org_id = ${orgId} and id = ${stub.id} and cheque_number is null returning id
        `,
            "objects",
          );
          if (stamped.length !== 1)
            throw new PayrollError("Cheque number was not recorded on the pay stub");
          const audit = await tx.execute<{ id: string }>(
            sql`
          insert into audit_log (org_id,table_name,row_id,action,changes,actor_id)
          values (${orgId},'pay_stubs',${stub.id},'update',${JSON.stringify({ event: "cheque_issued", before: { chequeNumber: null }, after: { chequeNumber: number }, documentId, amount: stub.net_pay, bankBasis: bankBasis ? sealJson(bankBasis, { orgId, purpose: `payroll.cheque.bank.${stub.id}` }) : null })}::jsonb,${actorId}) returning id
        `,
            "objects",
          );
          if (audit.length !== 1) throw new PayrollError("Cheque issuance audit was not recorded");
          issued += 1;
        }
        if (input.printMicr && bankBasis?.bank) chequeMicrFields(number, bankBasis.bank);
        cheques.push({
          stubId: stub.id,
          employeePartyId: stub.employee_party_id,
          employeeName: bankBasis?.payeeName ?? stub.name,
          chequeNumber: number,
          amount: stub.net_pay,
        });
      }
      return { cheques, total: sum(cheques.map((c) => c.amount)), issued };
    }),
  ).catch((error: unknown) => {
    if (error instanceof PaymentError) throw new PayrollError(error.message, { cause: error });
    throw error;
  });
}

export interface IssuedChequeBank {
  profileId: string;
  bankAccountId: string;
  bank: CanadianChequeBank | null;
  payeeName?: string;
}

/** The issued instrument retains encrypted bank identity independently of mutable setup. */
async function readIssuedChequeBank(
  tx: import("../platform/db.ts").SqlExecutor,
  orgId: string,
  stubId: string,
): Promise<IssuedChequeBank | null> {
  const rows = await tx.execute<{ sealed: string | null }>(
    sql`
    select a.changes->>'bankBasis' sealed from audit_log a
    join pay_stubs s on s.org_id=a.org_id and s.id=a.row_id
    where a.org_id=${orgId} and a.table_name='pay_stubs' and a.row_id=${stubId}
      and a.changes->>'event'='cheque_issued' and a.changes#>>'{after,chequeNumber}'=s.cheque_number
  `,
    "objects",
  );
  if (rows.length > 1)
    throw new PayrollError(
      "Cheque issuance evidence is ambiguous; review its audit history before printing",
    );
  return rows[0]?.sealed
    ? unsealJson<IssuedChequeBank>(rows[0].sealed, {
        orgId,
        purpose: `payroll.cheque.bank.${stubId}`,
      })
    : null;
}

export async function assertIssuedChequeFunding(
  tx: import("../platform/db.ts").SqlExecutor,
  orgId: string,
  documentId: string,
  bankAccountId: string,
) {
  const stubs = await tx.execute<{ id: string }>(
    sql`select id from pay_stubs where org_id=${orgId} and pay_run_document_id=${documentId} and cheque_number is not null order by id for share`,
    "objects",
  );
  for (const stub of stubs) {
    const basis = await readIssuedChequeBank(tx, orgId, stub.id);
    if (basis && basis.bankAccountId !== bankAccountId)
      throw new PayrollError(
        "Select the bank account bound to this run’s issued cheques; bank details cannot be changed after issuance",
      );
  }
}

/** Authorize an existing instrument without allocating any number on a read path. */
export async function lockIssuedChequePrint(
  tx: import("../platform/db.ts").SqlExecutor,
  input: {
    orgId: string;
    stubId: string;
    actorId: string;
    allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  },
) {
  if (!(await lockAndCheckOrgFeature(tx, input.orgId, "payroll")))
    throw new PayrollError("Payroll is switched off in Company Settings → Features");
  const row = (
    await tx.execute<{ document_id: string; subsidiary_id: string | null; cheque_number: string }>(
      sql`
    select r.document_id,d.subsidiary_id,s.cheque_number from pay_stubs s
    join pay_runs r on r.org_id=s.org_id and r.document_id=s.pay_run_document_id and r.run_status='committed'
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where s.org_id=${input.orgId} and s.id=${input.stubId} and s.payment_method='cheque' and s.cheque_number is not null
      ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)} for share of r,s,d
  `,
      "objects",
    )
  )[0];
  if (!row) throw new PayrollError("Issued cheque not found in committed payroll");
  const scope = await lockActorCommandAuthority(
    tx,
    input.orgId,
    input.actorId,
    row.subsidiary_id,
    "payroll.run",
  );
  await lockAndCheckPayrollRunPopulation(tx, input.orgId, row.document_id, scope);
  await lockAndCheckPayrollRunPopulation(
    tx,
    input.orgId,
    row.document_id,
    input.allowedSubsidiaryIds,
  );
  return { documentId: row.document_id, chequeNumber: row.cheque_number };
}

export async function issuedChequeBank(
  orgId: string,
  stubId: string,
): Promise<IssuedChequeBank | null> {
  return readIssuedChequeBank(db, orgId, stubId);
}

/** The batch as it stands, without allocating anything (list/preview). */
export async function payRunCheques(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunChequeBatch> {
  const rows = await db.execute<{
    id: string;
    employee_party_id: string;
    name: string;
    net_pay: string;
    cheque_number: string | null;
  }>(
    sql`
    select s.id, s.employee_party_id, p.display_name as name, s.net_pay::text as net_pay,
           s.cheque_number
     from pay_stubs s
       join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       join documents d on d.id = s.pay_run_document_id and d.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       and s.payment_method = 'cheque'
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
     order by p.display_name, s.id
  `,
    "objects",
  );
  const cheques: PayRunCheque[] = [];
  for (const row of rows) {
    const basis = row.cheque_number ? await readIssuedChequeBank(db, orgId, row.id) : null;
    cheques.push({
      stubId: row.id,
      employeePartyId: row.employee_party_id,
      employeeName: basis?.payeeName ?? row.name,
      chequeNumber: row.cheque_number ?? "",
      amount: row.net_pay,
    });
  }
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
  "zero",
  "one",
  "two",
  "three",
  "four",
  "five",
  "six",
  "seven",
  "eight",
  "nine",
  "ten",
  "eleven",
  "twelve",
  "thirteen",
  "fourteen",
  "fifteen",
  "sixteen",
  "seventeen",
  "eighteen",
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
  let dollars = BigInt((whole || "0").replace(/,/g, ""));
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
