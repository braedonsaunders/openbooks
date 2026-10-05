import { sql } from "drizzle-orm";
import type { db } from "../platform/db.ts";
import { PayrollError } from "./error.ts";

/**
 * Entitlement-plan settlement configuration: the payout component withdraws
 * on any run and the deposit component funds an hours bank from a run. Both
 * must be earning components the run can actually price — a deduction or
 * contribution row would silently match nothing — and they must be distinct,
 * or withdrawals and deposits lose attribution.
 */
export async function validateEntitlementPlanConfiguration(
  executor: Pick<typeof db, "execute">,
  orgId: string,
  body: Record<string, unknown>,
): Promise<void> {
  const payoutId = body.payoutComponentId == null || body.payoutComponentId === "" ? null : String(body.payoutComponentId);
  const depositId = body.depositComponentId == null || body.depositComponentId === "" ? null : String(body.depositComponentId);
  if (payoutId !== null && payoutId === depositId) {
    throw new PayrollError("The payout and deposit components are the same row — choose distinct components so withdrawals and deposits stay attributable");
  }
  for (const [label, id] of [["payout", payoutId], ["deposit", depositId]] as const) {
    if (id === null) continue;
    const component = (await executor.execute<{ code: string; kind: string; is_active: boolean }>(sql`
      select code, kind, is_active from pay_components where org_id = ${orgId} and id = ${id}`)).rows[0];
    if (!component) throw new PayrollError(`The plan's ${label} component is not visible in this organization — choose a payroll component from Payroll setup`);
    if (!component.is_active) throw new PayrollError(`Payroll component ${component.code} is inactive — re-enable it before binding it as the plan's ${label} component`);
    if (component.kind !== "earning") {
      throw new PayrollError(`Payroll component ${component.code} is not an earning component — only earning components carry bank settlements`);
    }
  }
}
