import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import {
  createPayApplication,
  submitPayApplication,
  approvePayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
  type PayApplicationLineUpdate,
} from "../construction-billing.ts";
import { mulDecimal } from "../money.ts";
import { postDraftDocument } from "./activities/documents.ts";
import type { SimOrg } from "./world.ts";

/**
 * Phase 6 flagship — AIA G702/G703 progress billing with retainage. Sets up a
 * project + schedule of values, then each period drives the full pay-application
 * lifecycle through the real construction-billing engine: create → submit →
 * approve → generate invoice → post. Retainage is withheld into the Retainage
 * Receivable subledger by the engine and released at the end.
 *
 * NOTE: project + SOV rows are created by direct insert (no engine helper
 * exists); the pay-application lifecycle uses typed engine functions. Column
 * layout follows schema/src/construction.ts. Pending live validation.
 */

export interface SovLineSpec {
  description: string;
  scheduledValue: string;
}

export interface SimProject {
  projectId: string;
  sovLines: { id: string; scheduledValue: string }[];
}

/** Create a project with a schedule of values (G703 line items). */
export async function setupProject(
  world: SimOrg,
  opts: { name: string; code: string; customerId: string; startsOn: string; endsOn: string; lines: SovLineSpec[] },
): Promise<SimProject> {
  const projectId = randomUUID();
  const contractValue = opts.lines.reduce((acc, l) => acc + Number(l.scheduledValue), 0).toFixed(2);
  await db.execute(sql`
    insert into projects (id, org_id, name, code, status, billing_method, customer_id, contract_value, starts_on, ends_on)
    values (${projectId}, ${world.orgId}, ${opts.name}, ${opts.code}, 'active', 'schedule_of_values',
            ${opts.customerId}, ${contractValue}, ${opts.startsOn}, ${opts.endsOn})`);

  const sovLines: { id: string; scheduledValue: string }[] = [];
  let sort = 0;
  for (const line of opts.lines) {
    const id = randomUUID();
    await db.execute(sql`
      insert into sov_lines (id, org_id, project_id, description, scheduled_value, income_account_id, sort_order)
      values (${id}, ${world.orgId}, ${projectId}, ${line.description}, ${line.scheduledValue},
              ${world.accounts.revenueService}, ${sort++})`);
    sovLines.push({ id, scheduledValue: line.scheduledValue });
  }
  return { projectId, sovLines };
}

/**
 * Run one progress-billing period: bill `fraction` of each SOV line's scheduled
 * value this period, then post the resulting invoice (net of retainage).
 */
export async function runProgressBilling(
  world: SimOrg,
  projectId: string,
  periodEnd: string,
  fraction: string,
  submitterId: string,
  approverId: string,
): Promise<{ invoiceId: string; documentNumber: string; currentDue: string; retainage: string }> {
  const sov = (await db.execute(sql`
    select id, scheduled_value from sov_lines where org_id = ${world.orgId} and project_id = ${projectId}`)) as unknown as {
    rows: { id: string; scheduled_value: string }[];
  };
  const app = await createPayApplication(world.orgId, submitterId, projectId, periodEnd);
  const updates: PayApplicationLineUpdate[] = sov.rows.map((l) => ({
    sovLineId: l.id,
    thisPeriodCompleted: mulDecimal(l.scheduled_value, fraction),
    materialsStored: "0",
  }));
  await submitPayApplication(world.orgId, submitterId, app.id, updates);
  await approvePayApplication(world.orgId, approverId, app.id);
  const inv = await generatePayApplicationInvoice(world.orgId, approverId, app.id);
  await postDraftDocument(world, inv.invoiceId);
  return inv;
}

/** Release withheld retainage for a project as a final billing. */
export async function releaseProjectRetainage(
  world: SimOrg,
  projectId: string,
  periodEnd: string,
  amount: string,
  actorId: string,
): Promise<{ invoiceId: string; documentNumber: string; amount: string }> {
  const res = await releaseRetainage(world.orgId, actorId, projectId, periodEnd, amount);
  await postDraftDocument(world, res.invoiceId);
  return res;
}
