/**
 * Final-payout earning phases: termination bank settlement and cash-out
 * vacation pay.
 *
 * Extracted verbatim from engine/src/payroll/run-earning-lines.ts; bodies
 * preserve exact math, transaction/lock sequencing, and refusal identity.
 * The split keeps every run-* operation module under the 800-line bound
 * pinned by run-modular-boundary.test.ts.
 */
import { type db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { cmp, mulPercent, neg, roundMoney, sum } from "../money/money.ts";
import { type Money } from "../money/brands.ts";
import { entitlementBalances, entitlementMoneyValue, planMovementsForStub, type EntitlementPlan } from "./entitlements.ts";
import { type Line } from "./run-stub-records.ts";

export async function settleTerminationBankPayouts(
  tx: Pick<typeof db, "execute">,
  args: {
    orgId: string; documentId: string; payDate: string;
    employeePartyId: string;
    /** Employee display name, for the unvalued-hours refusal. */
    employeeName: string;
    terminationRun: boolean;
    plans: EntitlementPlan[];
    lines: Line[];
    entitlementMovements: Awaited<ReturnType<typeof planMovementsForStub>>["movements"];
  },
): Promise<void> {
  const {
    orgId, documentId, payDate, employeePartyId, employeeName,
    terminationRun, plans, lines, entitlementMovements,
  } = args;
  // A final pay must clear every accrued bank: the carried balance is paid out
  // with this period's accrual, never left on the books for someone who left.
  //
  // The balances are read INSIDE this transaction and NET OF THIS RUN'S OWN
  // movements. Both matter: without the exclusion the second Calculate saw the
  // first Calculate's `−balance` payout row, netted to zero, and silently
  // dropped the departing employee's entire accrued balance from their final
  // cheque — leaving the liability on the books with nobody to pay it to.
  if (terminationRun && plans.length > 0) {
    const balances = await entitlementBalances(orgId, employeePartyId, payDate, {
      executor: tx, excludeRunDocumentId: documentId, plans,
    });
    for (const balance of balances) {
      if (cmp(balance.balance, "0") <= 0) continue;
      if (!balance.plan.payoutComponentId) {
        throw new PayrollError(
          `entitlement plan ${balance.plan.code} has no payout component — set it in Payroll setup → Entitlement plans`,
        );
      }
      // The line pays MONEY, never the plan's unit: an hours bank values at
      // the current wage (40 hours at $30/h pays $1,200, not $40.00), and a
      // bank with no resolvable wage refuses by name instead of mispricing.
      // The ledger movement below stays in the plan's unit — the bank IS
      // hours; only its payout is money.
      const payoutMoney = entitlementMoneyValue({
        plan: balance.plan, amount: balance.balance, wage: balance.wage, employeeName,
      });
      lines.push({
        componentId: balance.plan.payoutComponentId, kind: "earning",
        description: `${balance.plan.name} payout (accrued balance)`,
        amount: payoutMoney, sequence: 44, vacationable: false,
      });
      entitlementMovements.push({
        planId: balance.plan.id, employeePartyId, movementDate: payDate,
        amount: neg(roundMoney(balance.balance, 2)), hours: null,
        kind: "payout", componentId: balance.plan.payoutComponentId,
        note: "Final pay — bank cleared",
      });
    }
  }
}

/**
 * Cash-out vacation: the money is paid rather than banked, bypassing the
 * plan engine entirely and producing no ledger movement.
 */
export function appendCashVacationPay(args: {
  vacationPercent: string | null;
  payVacationInCash: boolean;
  need: (systemKey: string, kind: string) => Record<string, unknown>;
  lines: Line[];
}): void {
  const { vacationPercent, payVacationInCash, need, lines } = args;
  // Cash-out vacation policies bypass the bank entirely: the money is paid,
  // not accrued, so no ledger movement is produced.
  if (payVacationInCash && vacationPercent && cmp(vacationPercent, "0") > 0) {
    const base = sum(lines
      .filter((l) => l.kind === "earning" && (l.vacationable ?? true) && !l.accrualOnly)
      .map((l) => l.amount));
    const vacation = mulPercent(base, vacationPercent, 2) as Money;
    if (cmp(vacation, "0") > 0) {
      const c = need("vacation_payout", "earning");
      lines.push({
        componentId: c.id as string, kind: "earning", description: "Vacation pay",
        amount: vacation, sequence: 45, vacationable: false,
      });
    }
  }
}
