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
import { add, cmp, mulDecimal, sum } from "../money.ts";
import { postDraftDocument, createAndPostDocument } from "./activities/documents.ts";
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
export type BillingMethod =
  | "time_and_materials"
  | "schedule_of_values"
  | "fixed_price"
  | "not_to_exceed"
  | "cost_plus";

export async function setupProject(
  world: SimOrg,
  opts: {
    name: string;
    code: string;
    customerId: string;
    startsOn: string;
    endsOn: string;
    lines?: SovLineSpec[];
    billingMethod?: BillingMethod;
    /** Contract/NTE ceiling (fixed_price / not_to_exceed); defaults to Σ SOV. */
    contractValue?: string;
  },
): Promise<SimProject> {
  const projectId = randomUUID();
  const lines = opts.lines ?? [];
  const method = opts.billingMethod ?? "schedule_of_values";
  const contractValue = opts.contractValue ?? sum(lines.map((line) => line.scheduledValue));

  // Classify the project by the GOVERNED project_types FK (which carries the
  // profitability/invoicing/backup profiles), not free text. billing_method is
  // only the coarse back-compat classifier (time_and_materials|fixed_price|
  // cost_plus) and is derived from the resolved type.
  const typeRow = (await db.execute(sql`
    select id, billing_method from project_types
     where org_id = ${world.orgId} and key = ${method} and is_active limit 1`)) as unknown as {
    rows: { id: string; billing_method: string }[];
  };
  const type = typeRow.rows[0];
  if (!type) throw new Error(`no project_type "${method}" — run seedProjectTypes`);

  await db.execute(sql`
    insert into projects (id, org_id, name, code, status, project_type_id, billing_method, customer_id, contract_value, starts_on, ends_on)
    values (${projectId}, ${world.orgId}, ${opts.name}, ${opts.code}, 'active', ${type.id}, ${type.billing_method},
            ${opts.customerId}, ${contractValue}, ${opts.startsOn}, ${opts.endsOn})`);

  const sovLines: { id: string; scheduledValue: string }[] = [];
  let sort = 0;
  for (const line of lines) {
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

/**
 * Fixed-price / lump-sum milestone billing: invoice a stated amount against the
 * contract (e.g. a completed milestone or a percent of the fixed price). DR AR /
 * CR contract revenue. Guards against billing past the contract value.
 */
export async function billFixedPrice(
  world: SimOrg,
  projectId: string,
  amount: string,
  invoiceDate: string,
  description = "Milestone billing",
): Promise<{ invoiceId: string; documentNumber: string; amount: string; billedToDate: string; contractValue: string }> {
  const proj = (await db.execute(sql`
    select p.customer_id, p.name, p.code, pt.key as type_key, p.contract_value::text as contract
      from projects p left join project_types pt on pt.id = p.project_type_id
     where p.id = ${projectId} and p.org_id = ${world.orgId}`)) as unknown as {
    rows: { customer_id: string | null; name: string; code: string; type_key: string | null; contract: string }[];
  };
  const p = proj.rows[0];
  if (!p?.customer_id) throw new Error(`project ${projectId} has no customer to bill`);
  if (p.type_key !== "fixed_price" && p.type_key !== "not_to_exceed") {
    throw new Error(`project ${projectId} is a ${p.type_key ?? "?"} job, not fixed-price/NTE`);
  }
  if (cmp(amount, "0") <= 0) throw new Error("fixed-price billing amount must be greater than zero");
  const priorRow = (await db.execute(sql`
    select coalesce(sum(total), 0)::text as billed from documents
     where org_id = ${world.orgId} and kind = 'customer_invoice' and status = 'posted'
       and custom->'sim'->>'projectId' = ${projectId}`)) as unknown as { rows: { billed: string }[] };
  const priorBilled = priorRow.rows[0]?.billed ?? "0";
  const billedToDate = add(priorBilled, amount);
  if (cmp(billedToDate, p.contract) > 0) {
    throw new Error(`fixed-price billing would exceed contract value ${p.contract}`);
  }

  const documentNumber = `FP-${p.code}-${invoiceDate.replace(/-/g, "")}`;
  const res = await createAndPostDocument(world, {
    kind: "customer_invoice",
    documentNumber,
    partyId: p.customer_id,
    documentDate: invoiceDate,
    createdBy: world.actors.arClerk,
    currency: world.currency,
    memo: `${description} — ${p.name}`,
    custom: { sim: { fixedPrice: true, projectId } },
    lines: [{ accountId: world.accounts.revenueService!, description, amount, projectId }],
  });
  return { invoiceId: res.documentId, documentNumber, amount, billedToDate, contractValue: p.contract };
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
