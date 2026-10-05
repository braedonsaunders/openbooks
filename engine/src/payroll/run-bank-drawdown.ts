import { sql } from "drizzle-orm";
import { add, cmp, neg } from "../money/money.ts";
import type { db } from "../platform/db.ts";
import { planBalanceExcludingRun } from "./entitlements-db.ts";
import type { EntitlementMovement } from "./entitlements-movement-kernel.ts";
import type { EntitlementPlan } from "./entitlements-types.ts";
import { PayrollError } from "./error.ts";
import type { Line } from "./run-stub-records.ts";

type Executor = Pick<typeof db, "execute">;

/**
 * Bank drawdown on ordinary runs: a plan's payout component, appearing on any
 * non-termination run, settles against the employee's bank as a ledger
 * movement tied to the stub — money plans withdraw the paid amount, hours
 * plans the paid hours. A negative-hours line on the plan's deposit component
 * (worked time banked instead of paid) deposits those hours; a positive line
 * pays them out. Settlements net per plan because the ledger is unique on
 * (run, plan, employee, kind): the stub keeps every cash line itemized while
 * the bank carries the net effect.
 *
 * Termination runs skip this phase: the termination settlement already pays
 * every bank in full, and settling again would withdraw twice. Simulations
 * never reach persistence, so no simulate gate is needed here.
 */
export async function applyBankDrawdown(
  tx: Executor,
  args: {
    orgId: string;
    /** Run being calculated; its own movements stay out of the opening read. */
    documentId: string;
    payDate: string;
    employeePartyId: string;
    employeeName: string;
    terminationRun: boolean;
    plans: readonly EntitlementPlan[];
    lines: Line[];
    entitlementMovements: EntitlementMovement[];
  },
): Promise<void> {
  const { orgId, documentId, payDate, employeePartyId, employeeName, terminationRun, plans, lines, entitlementMovements } = args;
  if (terminationRun) return;
  const settling = new Map<string, { plan: EntitlementPlan; role: "payout" | "deposit" }>();
  const settlePlans = new Map<string, string[]>();
  for (const plan of plans) {
    if (plan.payoutComponentId === plan.depositComponentId && plan.payoutComponentId !== null) {
      throw new PayrollError(`Entitlement plan ${plan.code} names one component as both its payout and deposit component — choose distinct components so withdrawals and deposits stay attributable`);
    }
    for (const componentId of [plan.payoutComponentId, plan.depositComponentId]) {
      if (componentId === null) continue;
      settlePlans.set(componentId, [...(settlePlans.get(componentId) ?? []), plan.code]);
    }
    if (plan.payoutComponentId !== null) settling.set(plan.payoutComponentId, { plan, role: "payout" });
    if (plan.depositComponentId !== null && !settling.has(plan.depositComponentId)) {
      settling.set(plan.depositComponentId, { plan, role: "deposit" });
    }
  }
  for (const [componentId, codes] of settlePlans) {
    if (codes.length > 1) {
      const component = (await tx.execute<{ code: string }>(sql`select code from pay_components where id = ${componentId}`)).rows[0];
      throw new PayrollError(`Payroll component ${component?.code ?? componentId} settles two entitlement plans (${codes.join(", ")}) — dedicate one payout component per plan so withdrawals stay attributable`);
    }
  }
  if (settling.size === 0) return;
  // Net settlement per plan in the plan's unit; the last contributing stub
  // line carries the movement's evidence link.
  const nets = new Map<string, { plan: EntitlementPlan; net: string; line: Line }>();
  for (const line of lines) {
    if (line.kind !== "earning" || line.componentId === null) continue;
    const entry = settling.get(line.componentId);
    if (!entry) continue;
    const value = entry.plan.unit === "hours" ? line.hours ?? null : line.amount;
    if (value === null || cmp(value, "0") === 0) {
      if (entry.plan.unit === "hours" && line.hours == null && cmp(line.amount, "0") !== 0) {
        throw new PayrollError(`${employeeName}'s ${entry.plan.name} payout on the ${payDate} run carries pay but no hours — enter the taken hours on the payout line so the hours bank settles exactly`);
      }
      continue;
    }
    const current = nets.get(entry.plan.id);
    nets.set(entry.plan.id, {
      plan: entry.plan,
      net: current ? add(current.net, value) : value,
      line,
    });
  }
  for (const { plan, net } of nets.values()) {
    if (cmp(net, "0") === 0) continue;
    const inRun = entitlementMovements
      .filter((movement) => movement.planId === plan.id)
      .reduce((total, movement) => add(total, movement.amount), "0");
    const opening = await planBalanceExcludingRun(tx, orgId, plan.id, employeePartyId, payDate, documentId);
    const available = add(opening, inRun);
    if (cmp(net, "0") > 0) {
      if (cmp(net, available) > 0 && !plan.allowNegativeBalance) {
        throw new PayrollError(`${employeeName}'s ${plan.name} payout of ${net} exceeds the available ${available} — pay no more than the bank holds, or allow negative balances on the plan`);
      }
      const existing = entitlementMovements.find((movement) => movement.planId === plan.id && movement.kind === "payout");
      // A cap auto-payout already queued a payout movement for this plan this
      // run: fold the voluntary withdrawal into it, since the ledger admits
      // one payout per (run, plan, employee).
      if (existing) {
        existing.amount = add(existing.amount, neg(net));
        existing.hours = plan.unit === "hours" ? add(existing.hours ?? "0", net) : existing.hours;
      } else {
        entitlementMovements.push({
          planId: plan.id,
          employeePartyId,
          movementDate: payDate,
          amount: neg(net),
          hours: plan.unit === "hours" ? net : null,
          kind: "payout",
          componentId: plan.payoutComponentId,
          note: `${plan.name} payout on the ${payDate} run`,
        });
      }
      nets.get(plan.id)!.line.entitlementMovementKey = `${plan.id}:payout`;
    } else {
      entitlementMovements.push({
        planId: plan.id,
        employeePartyId,
        movementDate: payDate,
        amount: neg(net),
        hours: plan.unit === "hours" ? neg(net) : null,
        kind: "bank_in",
        componentId: plan.depositComponentId ?? plan.payoutComponentId,
        note: `${plan.name} deposit on the ${payDate} run`,
      });
      nets.get(plan.id)!.line.entitlementMovementKey = `${plan.id}:bank_in`;
    }
  }
}
