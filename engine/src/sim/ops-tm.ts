import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { postDocument } from "../posting.ts";
import { postProjectLaborCost } from "../project-recognition.ts";
import { mul, sum as sumMoney } from "../money.ts";
import { addDays } from "./manifest.ts";
import { postingDeps } from "./activities/documents.ts";
import type { SimOrg } from "./world.ts";

/**
 * Construction Time-&-Materials. Crew time is logged against a job at a cost rate
 * and a bill rate; the LABOR COST flows through the ledger (DR job-cost field
 * labor / CR labor clearing, via the real project-labor poster); then a T&M
 * invoice is built whose lines ARE the time transactions, billed at the labor
 * rate. Gross profit = billed (bill rate) − labor cost — a real T&M margin.
 */

/** Create a field-ticket document (a non-posting crew record) for a job/day. */
export async function createFieldTicket(world: SimOrg, projectId: string, date: string): Promise<{ fieldTicketId: string; number: string }> {
  const id = randomUUID();
  const number = `FT-${date.replace(/-/g, "")}-${id.slice(0, 4)}`;
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, document_date, currency, subtotal, tax_total, total, created_by, custom)
    values (${id}, ${world.orgId}, 'field_ticket', 'approved', ${number}, ${date}, ${world.currency},
            '0.00', '0.00', '0.00', ${world.actors.controller}, ${JSON.stringify({ sim: { fieldTicket: true, projectId } })}::jsonb)`);
  return { fieldTicketId: id, number };
}

/** Log one approved, billable crew time entry against a project (optionally on a field ticket). */
export async function logTime(
  world: SimOrg,
  input: { projectId: string; employeeId: string; hours: string; workedOn: string; fieldTicketId?: string | null },
): Promise<{ timeEntryId: string }> {
  const emp = world.employees.find((e) => e.id === input.employeeId);
  if (!emp) throw new Error(`unknown employee ${input.employeeId}`);
  if (!world.timeTypeId || !world.laborItemId) throw new Error("this company has no labor billing setup");
  const id = randomUUID();
  await db.execute(sql`
    insert into time_entries
      (id, org_id, employee_party_id, worked_on, hours, time_type_id, item_id, project_id,
       is_billable, cost_rate, bill_rate, status, field_ticket_id)
    values (${id}, ${world.orgId}, ${input.employeeId}, ${input.workedOn}, ${input.hours},
            ${world.timeTypeId}, ${world.laborItemId}, ${input.projectId},
            true, ${emp.costRate}, ${emp.billRate}, 'approved', ${input.fieldTicketId ?? null})`);
  return { timeEntryId: id };
}

/**
 * Log a full crew-day on a job via a FIELD TICKET (how a contractor actually
 * captures crew hours): one field ticket for the day, `hours` for each crew
 * member (all crew by default) recorded against it.
 */
export async function logCrewDay(
  world: SimOrg,
  input: { projectId: string; workedOn: string; hours: string; employeeIds?: string[] },
): Promise<{ timeEntryIds: string[]; fieldTicket: string }> {
  const ids = input.employeeIds ?? world.employees.map((e) => e.id);
  const { fieldTicketId, number } = await createFieldTicket(world, input.projectId, input.workedOn);
  const out: string[] = [];
  for (const employeeId of ids) {
    const r = await logTime(world, { projectId: input.projectId, employeeId, hours: input.hours, workedOn: input.workedOn, fieldTicketId });
    out.push(r.timeEntryId);
  }
  return { timeEntryIds: out, fieldTicket: number };
}

/** Post the labor cost for approved time entries (DR field labor / CR labor clearing). */
export async function postLaborCost(world: SimOrg, timeEntryIds: string[]): Promise<{ entryIds: string[] }> {
  const entryIds = await postProjectLaborCost(world.orgId, world.actors.controller, timeEntryIds);
  return { entryIds };
}

/** Post labor cost for all not-yet-costed approved time on a project. */
export async function postLaborForProject(world: SimOrg, projectId: string): Promise<{ entryIds: string[]; costed: number }> {
  const rows = (await db.execute(sql`
    select id from time_entries
     where org_id = ${world.orgId} and project_id = ${projectId}
       and status = 'approved' and cost_journal_entry_id is null`)) as unknown as { rows: { id: string }[] };
  const ids = rows.rows.map((r) => r.id);
  if (ids.length === 0) return { entryIds: [], costed: 0 };
  const { entryIds } = await postLaborCost(world, ids);
  return { entryIds, costed: ids.length };
}

interface UnbilledTime {
  id: string;
  hours: string;
  bill_rate: string;
  cost_rate: string;
  employee_party_id: string;
  time_type_id: string;
}

/**
 * Build and post a T&M invoice from all unbilled, approved, billable time on a
 * project — one invoice line per time entry at its bill rate. Stamps each time
 * entry as invoiced (idempotency). Returns the billed total, the labor cost
 * behind it, and the gross margin.
 */
export interface ExtraBillLine {
  accountId: string;
  description: string;
  amount: string;
  quantity?: string;
  unitPrice?: string;
}

export async function billTimeAndMaterials(
  world: SimOrg,
  projectId: string,
  invoiceDate: string,
  opts: { extraLines?: ExtraBillLine[]; memo?: string; costPlusFee?: number } = {},
): Promise<{ invoiceId: string; documentNumber: string; billed: string; laborCost: string; lines: number } | null> {
  const proj = (await db.execute(sql`
    select customer_id, name, code from projects where id = ${projectId} and org_id = ${world.orgId}`)) as unknown as {
    rows: { customer_id: string | null; name: string; code: string }[];
  };
  const customerId = proj.rows[0]?.customer_id;
  if (!customerId) throw new Error(`project ${projectId} has no customer to bill`);

  const time = (await db.execute(sql`
    select id, hours::text, bill_rate::text, cost_rate::text, employee_party_id, time_type_id
      from time_entries
     where org_id = ${world.orgId} and project_id = ${projectId}
       and status = 'approved' and is_billable and invoiced_by_line_id is null`)) as unknown as { rows: UnbilledTime[] };
  const extraLines = opts.extraLines ?? [];
  if (time.rows.length === 0 && extraLines.length === 0) return null;

  // Cost-plus jobs bill labor at cost × (1 + fee); standard T&M bills at bill rate.
  const fee = opts.costPlusFee;
  const rateOf = (t: UnbilledTime) => (fee === undefined ? t.bill_rate : mul(t.cost_rate, (1 + fee).toFixed(4)));
  const empName = new Map(world.employees.map((e) => [e.id, e.name]));
  const effRates = time.rows.map(rateOf);
  const lineAmounts = time.rows.map((t, i) => mul(t.hours, effRates[i]!));
  const laborBilled = sumMoney(lineAmounts);
  const total = sumMoney([laborBilled, ...extraLines.map((l) => l.amount)]);
  const laborCost = sumMoney(time.rows.map((t) => mul(t.hours, t.cost_rate)));

  const docId = randomUUID();
  const documentNumber = `${fee === undefined ? "TM" : "CP"}-${proj.rows[0]!.code}-${invoiceDate.replace(/-/g, "")}`;
  // Net-30 terms with a modest collection lag, so the environment's collection
  // step remits against this invoice (otherwise billed T&M never gets paid).
  const dueDate = addDays(invoiceDate, 30);
  const expectedPayDate = addDays(invoiceDate, 38);
  await db.execute(sql`
    insert into documents
      (id, org_id, kind, status, document_number, party_id, document_date, due_date, expected_pay_date,
       currency, subtotal, tax_total, total, created_by, memo, custom)
    values (${docId}, ${world.orgId}, 'customer_invoice', 'draft', ${documentNumber}, ${customerId}, ${invoiceDate},
            ${dueDate}, ${expectedPayDate}, ${world.currency}, ${total}, '0.00', ${total}, ${world.actors.arClerk},
            ${opts.memo ?? `T&M billing — ${proj.rows[0]!.name}`},
            ${JSON.stringify({ sim: { tm: true, projectId, payFraction: "1" } })}::jsonb)`);

  const lineIds: { lineId: string; timeEntryId: string }[] = [];
  let lineNo = 0;
  for (let i = 0; i < time.rows.length; i++) {
    const t = time.rows[i]!;
    const rate = effRates[i]!;
    const lineId = randomUUID();
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount,
         project_id, time_entry_id, time_type_id, employee_id, bill_rate, is_billable)
      values (${lineId}, ${world.orgId}, ${docId}, ${++lineNo}, ${world.accounts.revenueService},
              ${`Labor — ${empName.get(t.employee_party_id) ?? "crew"}: ${t.hours}h @ ${rate}/hr`},
              ${t.hours}, ${rate}, ${lineAmounts[i]}, '0.00',
              ${projectId}, ${t.id}, ${t.time_type_id}, ${t.employee_party_id}, ${rate}, true)`);
    lineIds.push({ lineId, timeEntryId: t.id });
  }
  // Non-time revenue lines: equipment at day rate, materials at markup, etc.
  for (const ex of extraLines) {
    await db.execute(sql`
      insert into document_lines
        (id, org_id, document_id, line_number, account_id, description, quantity, unit_price, amount, tax_amount,
         project_id, is_billable)
      values (${randomUUID()}, ${world.orgId}, ${docId}, ${++lineNo}, ${ex.accountId}, ${ex.description},
              ${ex.quantity ?? "1"}, ${ex.unitPrice ?? ex.amount}, ${ex.amount}, '0.00', ${projectId}, true)`);
  }

  await postDocument(docId, postingDeps(world));

  // Mark each time entry billed (idempotency for the next billing run).
  for (const { lineId, timeEntryId } of lineIds) {
    await db.execute(sql`
      update time_entries set invoiced_by_line_id = ${lineId}
       where id = ${timeEntryId} and org_id = ${world.orgId}`);
  }

  return { invoiceId: docId, documentNumber, billed: total, laborCost, lines: lineNo };
}
