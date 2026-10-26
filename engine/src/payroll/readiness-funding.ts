import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { PayrollError } from "./error.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import {
  PAYROLL_PAYMENT_METHODS,
  stubPaymentMethods,
  type PayrollPaymentMethod,
} from "./payment-method.ts";
import { payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { runContext } from "./readiness-context.ts";

/** Pay-run funding: what payday costs, by payment rail. */

/** Net pay owed on one rail, and how many people are on it. */
export interface FundingRail {
  method: PayrollPaymentMethod;
  netPay: string;
  employees: number;
}

export interface PayRunFunding {
  /** Net pay owed to employees — the money that must leave the bank. */
  netPay: string;
  /**
   * The same net pay split by how it leaves: a controller funds a direct-
   * deposit file and a cheque run differently — the file is drawn on the
   * payday, the cheques clear whenever they are presented — so a single
   * "cash required" number is not the question actually being asked.
   */
  rails: FundingRail[];
  /** Statutory + benefit liabilities the run records (remitted later). */
  liabilities: string;
  /** Total employer cost of the payday. */
  totalCost: string;
  payDate: string;
  /** Business days from today to the pay date (negative = already past). */
  businessDaysToPayDate: number;
  /** Bank accounts with book balance, for the funding picker. */
  accounts: { id: string; label: string; balance: string; sufficient: boolean }[];
}

function businessDaysBetween(fromIso: string, toIso: string): number {
  const from = new Date(`${fromIso}T00:00:00Z`);
  const to = new Date(`${toIso}T00:00:00Z`);
  const forward = to >= from;
  const cursor = new Date(forward ? from : to);
  const end = forward ? to : from;
  let days = 0;
  while (cursor < end) {
    cursor.setUTCDate(cursor.getUTCDate() + 1);
    const day = cursor.getUTCDay();
    if (day !== 0 && day !== 6) days++;
  }
  return forward ? days : -days;
}

/** What this payday costs, and whether the chosen bank can carry it. */
export async function payRunFunding(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<PayRunFunding> {
  const run = await runContext(orgId, documentId, allowedSubsidiaryIds);
  // A missing run is a named not-found regardless of scope: without a run
  // every account reads sufficient against a zero net pay.
  if (!run) throw new PayrollError("pay run not found");
  const today = await businessToday(orgId);
  const payDate = run.pay_date;

  const totals = await db.execute<{ net: string; gross: string; employer: string }>(
    sql`
    select coalesce(sum(s.net_pay), 0)::text as net,
           coalesce(sum(s.gross), 0)::text as gross,
           coalesce(sum(s.employer_cost), 0)::text as employer
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `,
    "objects",
  );
  const t = totals[0] ?? { net: "0", gross: "0", employer: "0" };
  // Liabilities = what the run owes but does not pay today: employee
  // withholdings (gross − net) plus the employer-side accruals.
  const liabilities = add(add(t.gross, neg(t.net)), t.employer);

  // Both rails are always reported, including at zero: the operator has to be
  // able to see that nobody is on cheques, not infer it from an absent row.
  const stubs = await stubPaymentMethods(orgId, documentId);
  const visibleStubIds = await db.execute<{ id: string }>(
    sql`
    select s.id
      from pay_stubs s
      join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
     where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
  `,
    "objects",
  );
  const visibleStubIdSet = new Set(visibleStubIds.map((row) => row.id));
  const scopedStubs = stubs.filter((stub) => visibleStubIdSet.has(stub.stubId));
  const rails: FundingRail[] = PAYROLL_PAYMENT_METHODS.map((method) => {
    const mine = scopedStubs.filter((s) => s.method === method);
    return { method, netPay: sum(mine.map((s) => s.netPay)), employees: mine.length };
  });

  // Account balances read the LEDGER reader — posted + reversed lines in the
  // primary posting book, exactly the banking roster's balance leg
  // (web/lib/module-home/banking.ts) and the GL summary. Reading posted-only
  // counted live reversal legs while ignoring the voided originals they
  // negate, so a voided transfer haunted funding (1010 at -$5,000
  // beside the roster's $0.00, 1000 $2,500 apart) with no journal entry to
  // explain the gap — because the explaining entries were the reversed ones
  // this query excluded. A secondary book's adjustments must not inflate
  // funding either, like bank reconciliation itself.
  const accounts = await db.execute<{ id: string; label: string; balance: string }>(
    sql`
    select a.id, coalesce(a.number || ' · ', '') || a.name as label,
           coalesce(bal.amount, 0)::text as balance
      from accounts a
      left join lateral (
        select sum(jl.amount) as amount
          from journal_lines jl
          join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           and je.status in ('posted', 'reversed')
           and je.book_id = (select b.id from accounting_books b
                              where b.org_id = ${orgId} and b.is_primary
                              order by b.created_at limit 1)
         where jl.org_id = a.org_id and jl.account_id = a.id) bal on true
     where a.org_id = ${orgId} and a.is_active and not a.is_summary and a.type = 'asset_bank'
       ${
         allowedSubsidiaryIds == null
           ? sql``
           : allowedSubsidiaryIds.size > 0
             ? sql`and (a.subsidiary_id is null or a.subsidiary_id in (${sql.join(
                 [...allowedSubsidiaryIds].map((id) => sql`${id}`),
                 sql`, `,
               )}))`
             : sql`and false`
       }
     order by a.number nulls last, a.name
  `,
    "objects",
  );

  return {
    netPay: t.net,
    rails,
    liabilities,
    totalCost: add(t.net, liabilities),
    payDate,
    businessDaysToPayDate: businessDaysBetween(today, payDate),
    accounts: accounts.map((a) => ({ ...a, sufficient: cmp(a.balance, t.net) >= 0 })),
  };
}
