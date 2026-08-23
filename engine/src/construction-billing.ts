import { sql } from "drizzle-orm";
import { canonicalDecimal } from "./exact-decimal.ts";
import { db, type SqlExecutor } from "./db.ts";
import { add, cmp, formatMoney, mulPercent, mulRatio, neg, normalizeMoney, sum, toUnits } from "./money.ts";

/**
 * Construction progress billing engine (AIA G702/G703). An Application for
 * Payment records, per Schedule-of-Values line, the work completed this period.
 * Billing the application generates a customer_invoice whose income lines carry
 * the gross work and whose one retainage line (a negative posting to the
 * Retainage Receivable account) withholds retainage — so the kernel books
 * DR AR (net due) + DR Retainage Receivable (held) / CR income (gross). The net
 * is the current payment due. Retainage release is the inverse: a positive
 * Retainage Receivable line moves the held amount into collectible AR.
 */

export class ConstructionBillingError extends Error {}

/** Persist retainage-release amount through exact decimal then ledger money. Fail closed. */
function persistRetainageReleaseAmount(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new ConstructionBillingError("retainage release amount must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new ConstructionBillingError("retainage release amount must be an exact decimal");
  }
}

/** Persist retainage percent through exact decimal then ledger money. Fail closed. */
function persistRetainagePercent(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new ConstructionBillingError("retainage percent must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new ConstructionBillingError("retainage percent must be an exact decimal");
  }
}

/** Persist a revised schedule-of-values input through exact decimal then ledger
 * money. Fail closed: these feed the persisted sov_lines.scheduled_value. */
function persistRevisedScheduleValueInput(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) throw new ConstructionBillingError("schedule value must be an exact decimal");
  try {
    return normalizeMoney(exact);
  } catch {
    throw new ConstructionBillingError("schedule value must be an exact decimal");
  }
}

async function assertProjectsEnabled(tx: SqlExecutor, orgId: string): Promise<void> {
  const result = (await tx.execute<{ enabled: boolean }>(sql`
    select coalesce((settings->'features'->>'projects')::boolean, true) as enabled
      from orgs where id = ${orgId}
  `));
  if (!result.rows[0]?.enabled) throw new ConstructionBillingError("Projects feature is disabled");
}

async function assertApplicationProcedure(tx: SqlExecutor, orgId: string, projectId: string): Promise<void> {
  const result = (await tx.execute<{ supported: boolean }>(sql`
    select pt.invoicing_profile->>'billingProcedure' = 'application_for_payment' as supported
      from projects p
      left join project_types pt on pt.id = p.project_type_id and pt.org_id = p.org_id
     where p.org_id = ${orgId} and p.id = ${projectId}
  `));
  if (!result.rows[0]?.supported) {
    throw new ConstructionBillingError("This project's billing profile does not use applications for payment");
  }
}

export interface AppLineInput {
  sovLineId: string;
  scheduledValue: string;
  previousCompleted: string;
  /** Cumulative stored-materials balance already billed by prior applications. */
  previousMaterialsStored: string;
  thisPeriodCompleted: string;
  materialsStored: string;
  /** Resolved retainage percent for this line (0–100). */
  retainagePercent: string;
}

export interface ComputedAppLine {
  sovLineId: string;
  grossThisPeriod: string;
  retainageThisPeriod: string;
  netThisPeriod: string;
  completedToDate: string;
  percentComplete: string;
}

export interface ComputedApplication {
  lines: ComputedAppLine[];
  grossThisPeriod: string;
  retainageThisPeriod: string;
  currentDue: string;
}

export interface PayApplicationLineUpdate {
  sovLineId: string;
  thisPeriodCompleted: string;
  materialsStored: string;
}

/** Exact contract-capacity calculation for an approved change order allocated
 * to an existing SOV line. A deduction can never erase already-billed work. */
export function revisedScheduleValue(
  currentScheduledValue: string,
  changeAmount: string,
  billedToDate: string,
): string {
  const current = persistRevisedScheduleValueInput(currentScheduledValue);
  const change = persistRevisedScheduleValueInput(changeAmount);
  const billed = persistRevisedScheduleValueInput(billedToDate);
  if (cmp(current, "0") < 0 || cmp(billed, "0") < 0) {
    throw new ConstructionBillingError("Schedule and billed values cannot be negative");
  }
  const revised = add(current, change);
  if (cmp(revised, "0") < 0 || cmp(revised, billed) < 0) {
    throw new ConstructionBillingError("The change order would reduce the schedule line below its already-billed value");
  }
  return revised;
}

/**
 * Pure G702/G703 math for one application. Materials stored is a cumulative
 * balance, not a fresh charge: the draw bills only its increase over the
 * balance prior applications already billed (mirroring the vendor-application
 * model), and a decrease is refused — billed materials left the site, which is
 * a credit/adjustment, not a negative draw. Gross this period = work completed
 * + the stored increment; retainage is withheld on that gross; the net is the
 * current payment due. Exact money throughout — unit-tested.
 */
export function computeApplication(lines: AppLineInput[]): ComputedApplication {
  const computed: ComputedAppLine[] = lines.map((l) => {
    const scheduled = normalizeMoney(l.scheduledValue || "0");
    const previous = normalizeMoney(l.previousCompleted || "0");
    const previousStored = normalizeMoney(l.previousMaterialsStored || "0");
    const thisPeriod = normalizeMoney(l.thisPeriodCompleted || "0");
    const stored = normalizeMoney(l.materialsStored || "0");
    const retainagePercent = normalizeMoney(l.retainagePercent || "0");
    if ([scheduled, previous, previousStored, thisPeriod, stored].some((value) => cmp(value, "0") < 0)) {
      throw new ConstructionBillingError("Schedule values and application amounts cannot be negative");
    }
    if (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0) {
      throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
    }
    if (cmp(stored, previousStored) < 0) {
      throw new ConstructionBillingError(
        "Materials stored cannot fall below the balance prior applications billed — stored materials have left the site; handle the reduction through a credit or adjusting entry",
      );
    }
    const gross = add(thisPeriod, add(stored, neg(previousStored)));
    const retainage = cmp(l.retainagePercent, "0") > 0 ? mulPercent(gross, l.retainagePercent) : "0.0000";
    const net = add(gross, neg(retainage));
    const completedToDate = add(previous, gross);
    if (cmp(completedToDate, scheduled) > 0) {
      throw new ConstructionBillingError("Application amount exceeds the scheduled value");
    }
    const percent = cmp(scheduled, "0") > 0 && cmp(completedToDate, "0") >= 0
      ? formatMoney(mulRatio("100", toUnits(completedToDate), toUnits(scheduled)), 2)
      : "0.00";
    return {
      sovLineId: l.sovLineId,
      grossThisPeriod: gross,
      retainageThisPeriod: retainage,
      netThisPeriod: net,
      completedToDate,
      percentComplete: percent,
    };
  });
  const grossThisPeriod = computed.length ? sum(computed.map((c) => c.grossThisPeriod)) : "0";
  const retainageThisPeriod = computed.length ? sum(computed.map((c) => c.retainageThisPeriod)) : "0";
  return {
    lines: computed,
    grossThisPeriod,
    retainageThisPeriod,
    currentDue: add(grossThisPeriod, neg(retainageThisPeriod)),
  };
}

async function nextNumber(
  tx: SqlExecutor,
  orgId: string,
  kind: string,
  subsidiaryId: string | null,
  prefix: string,
): Promise<string> {
  const configured = subsidiaryId
    ? ((await tx.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`))).rows.length > 0
    : false;
  const seqSub = configured ? subsidiaryId : null;
  const r = (await tx.execute<{ prefix: string; next_number: number; padding: number }>(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${seqSub}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    where number_sequences.org_id = ${orgId}
    returning prefix, next_number, padding
  `));
  const s = r.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

async function retainageReceivableAccount(tx: SqlExecutor, orgId: string): Promise<string | null> {
  const r = (await tx.execute<{ acct: string | null }>(sql`
    select a.id as acct
      from orgs o
      join accounts a on a.id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
                     and a.org_id = o.id
     where o.id = ${orgId}
  `));
  return r.rows[0]?.acct ?? null;
}

async function defaultIncomeAccount(tx: SqlExecutor, orgId: string): Promise<string | null> {
  const r = (await tx.execute<{ id: string }>(sql`
    select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
     order by number nulls last limit 1
  `));
  return r.rows[0]?.id ?? null;
}

/**
 * Create the next Application for Payment for a project, pre-filling each SOV
 * line's previous-completed (the exact gross billed to date, with each prior
 * application's stored balance netted out) and prior stored-materials basis
 * from prior POSTED applications so the draw math is cumulative.
 */
export async function createPayApplication(
  orgId: string,
  userId: string,
  projectId: string,
  periodEnd: string,
  retainagePercent = "10",
): Promise<{ id: string; applicationNumber: number }> {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(periodEnd)) throw new ConstructionBillingError("A valid period-ending date is required");
  const exactRetainage = persistRetainagePercent(retainagePercent);
  if (cmp(exactRetainage, "0") < 0 || cmp(exactRetainage, "100") > 0) {
    throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
  }
  return db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    await assertApplicationProcedure(tx, orgId, projectId);
    // Serialize application numbering and cumulative snapshots per project.
    const owned = (await tx.execute(sql`
      select 1 from projects where org_id = ${orgId} and id = ${projectId} for update
    `));
    if (!owned.rows.length) throw new ConstructionBillingError("Project not found");
    const lifecycle = (await tx.execute<{ has_open: boolean; last_period: string | null }>(sql`
      select
        exists(select 1 from pay_applications where org_id = ${orgId} and project_id = ${projectId}
               and status in ('draft', 'submitted', 'approved')) as has_open,
        max(period_end) filter (where status in ('invoiced', 'posted')) as last_period
        from pay_applications where org_id = ${orgId} and project_id = ${projectId}
    `));
    if (lifecycle.rows[0]?.has_open) throw new ConstructionBillingError("Complete or void the current application before starting another");
    if (lifecycle.rows[0]?.last_period && periodEnd <= lifecycle.rows[0].last_period) {
      throw new ConstructionBillingError("The period ending must be after the previous invoiced application");
    }
    const sov = (await tx.execute<{ id: string; scheduled_value: string }>(sql`
      select id, scheduled_value from sov_lines where org_id = ${orgId} and project_id = ${projectId}
       order by sort_order
    `));
    if (!sov.rows.length) throw new ConstructionBillingError("This project has no Schedule of Values yet");

    const numRes = (await tx.execute<{ n: number }>(sql`
      select coalesce(max(application_number), 0) + 1 as n
        from pay_applications where org_id = ${orgId} and project_id = ${projectId}
    `));
    const applicationNumber = Number(numRes.rows[0]!.n);

    const app = (await tx.execute<{ id: string }>(sql`
      insert into pay_applications (org_id, project_id, application_number, period_end, retainage_percent,
                                    created_by, updated_by)
      values (${orgId}, ${projectId}, ${applicationNumber}, ${periodEnd}, ${exactRetainage}, ${userId}, ${userId})
      returning id
    `));
    const appId = app.rows[0]!.id;

    for (const line of sov.rows) {
      // Previous completed sums each prior application's gross (its stored
      // increment already netted via that line's own previous_materials_stored);
      // the stored basis itself is the last posted application's balance, the
      // customer-side mirror of the vendor-application prefill.
      const prior = (await tx.execute<{ prev: string; prev_stored: string }>(sql`
        select
          coalesce((select sum(pal.this_period_completed + pal.materials_stored - pal.previous_materials_stored)
              from pay_application_lines pal
              join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
             where pal.org_id = ${orgId} and pal.sov_line_id = ${line.id} and pa.status in ('invoiced', 'posted')), 0) as prev,
          coalesce((select pal.materials_stored
              from pay_application_lines pal
              join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
             where pal.org_id = ${orgId} and pal.sov_line_id = ${line.id} and pa.status in ('invoiced', 'posted')
             order by pa.application_number desc limit 1), 0) as prev_stored
      `));
      await tx.execute(sql`
        insert into pay_application_lines (org_id, pay_application_id, sov_line_id, previous_completed,
                                           previous_materials_stored, created_by, updated_by)
        values (${orgId}, ${appId}, ${line.id}, ${prior.rows[0]?.prev ?? "0"}, ${prior.rows[0]?.prev_stored ?? "0"}, ${userId}, ${userId})
      `);
    }
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${appId}, 'insert',
              ${JSON.stringify({ after: { projectId, applicationNumber, periodEnd, retainagePercent: exactRetainage, status: "draft" } })}::jsonb,
              ${userId})
    `);
    return { id: appId, applicationNumber };
  });
}

/** Atomically persist all entered draw values and submit the application for
 * independent approval. No partial line-save can escape this transaction. */
export async function submitPayApplication(
  orgId: string,
  userId: string,
  payAppId: string,
  updates: PayApplicationLineUpdate[],
): Promise<ComputedApplication> {
  return db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    const appRes = (await tx.execute<{ id: string; project_id: string; status: string; retainage_percent: string }>(sql`
      select id, project_id, status, retainage_percent
        from pay_applications where id = ${payAppId} and org_id = ${orgId} for update
    `));
    const app = appRes.rows[0];
    if (!app) throw new ConstructionBillingError("Application not found");
    if (app.status !== "draft") throw new ConstructionBillingError("Only a draft application can be submitted");
    await assertApplicationProcedure(tx, orgId, app.project_id);

    const seen = new Set<string>();
    for (const update of updates) {
      if (seen.has(update.sovLineId)) throw new ConstructionBillingError("A draw line was supplied more than once");
      seen.add(update.sovLineId);
      const thisPeriod = normalizeMoney(update.thisPeriodCompleted || "0");
      const stored = normalizeMoney(update.materialsStored || "0");
      if (cmp(thisPeriod, "0") < 0 || cmp(stored, "0") < 0) {
        throw new ConstructionBillingError("Draw amounts cannot be negative");
      }
      const updated = (await tx.execute<{ id: string }>(sql`
        update pay_application_lines
           set this_period_completed = ${thisPeriod}, materials_stored = ${stored},
               updated_at = now(), updated_by = ${userId}
         where pay_application_id = ${payAppId} and sov_line_id = ${update.sovLineId} and org_id = ${orgId}
         returning id
      `));
      if (!updated.rows.length) throw new ConstructionBillingError("A draw line does not belong to this application");
    }

    const linesRes = (await tx.execute<any>(sql`
      select pal.sov_line_id, pal.previous_completed, pal.previous_materials_stored,
             pal.this_period_completed, pal.materials_stored,
             sl.scheduled_value, sl.retainage_percent
        from pay_application_lines pal
        join sov_lines sl on sl.id = pal.sov_line_id and sl.org_id = pal.org_id
       where pal.pay_application_id = ${payAppId} and pal.org_id = ${orgId}
       order by sl.sort_order
    `));
    const computed = computeApplication(linesRes.rows.map((line) => ({
      sovLineId: line.sov_line_id,
      scheduledValue: String(line.scheduled_value ?? "0"),
      previousCompleted: String(line.previous_completed ?? "0"),
      previousMaterialsStored: String(line.previous_materials_stored ?? "0"),
      thisPeriodCompleted: String(line.this_period_completed ?? "0"),
      materialsStored: String(line.materials_stored ?? "0"),
      retainagePercent: line.retainage_percent != null ? String(line.retainage_percent) : app.retainage_percent,
    })));
    if (cmp(computed.grossThisPeriod, "0") <= 0) throw new ConstructionBillingError("Enter work completed before submitting");
    await tx.execute(sql`
      update pay_applications
         set status = 'submitted', submitted_at = now(), submitted_by = ${userId},
             updated_at = now(), updated_by = ${userId}
       where id = ${payAppId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${payAppId}, 'submit',
              ${JSON.stringify({ before: { status: "draft" }, after: { status: "submitted" }, lines: updates })}::jsonb,
              ${userId})
    `);
    return computed;
  });
}

/** Approve a submitted application under segregation of duties. */
export async function approvePayApplication(orgId: string, userId: string, payAppId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    const appRes = (await tx.execute<{ project_id: string; status: string; submitted_by: string | null; created_by: string | null }>(sql`
      select project_id, status, submitted_by, created_by
        from pay_applications where id = ${payAppId} and org_id = ${orgId} for update
    `));
    const app = appRes.rows[0];
    if (!app) throw new ConstructionBillingError("Application not found");
    if (app.status !== "submitted") throw new ConstructionBillingError("Only a submitted application can be approved");
    if ((app.submitted_by ?? app.created_by) === userId) {
      throw new ConstructionBillingError("The submitter cannot approve the same application");
    }
    await assertApplicationProcedure(tx, orgId, app.project_id);
    await tx.execute(sql`
      update pay_applications
         set status = 'approved', approved_at = now(), approved_by = ${userId},
             updated_at = now(), updated_by = ${userId}
       where id = ${payAppId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${payAppId}, 'approve',
              ${JSON.stringify({ before: { status: "submitted" }, after: { status: "approved" } })}::jsonb,
              ${userId})
    `);
  });
}

/** Void an application before invoicing. The row and draw evidence are kept;
 * voiding never deletes or rewrites financial history. */
export async function voidPayApplication(orgId: string, userId: string, payAppId: string): Promise<void> {
  await db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    const result = (await tx.execute<{ project_id: string; status: string; invoice_document_id: string | null }>(sql`
      select project_id, status, invoice_document_id
        from pay_applications where id = ${payAppId} and org_id = ${orgId} for update
    `));
    const app = result.rows[0];
    if (!app) throw new ConstructionBillingError("Application not found");
    if (!["draft", "submitted", "approved"].includes(app.status) || app.invoice_document_id) {
      throw new ConstructionBillingError("Only an application that has not been invoiced can be voided");
    }
    await assertApplicationProcedure(tx, orgId, app.project_id);
    await tx.execute(sql`
      update pay_applications
         set status = 'void', updated_at = now(), updated_by = ${userId}
       where id = ${payAppId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${payAppId}, 'void',
              ${JSON.stringify({ before: { status: app.status }, after: { status: "void" } })}::jsonb,
              ${userId})
    `);
  });
}

/**
 * Bill an application: build the customer_invoice (income lines gross + one
 * negative Retainage Receivable line) and mark the application posted. The
 * invoice is left as a draft to run through the normal approve/post lifecycle;
 * posting it applies the retainage split via the customer_invoice kernel rule.
 */
export async function generatePayApplicationInvoice(
  orgId: string,
  userId: string,
  payAppId: string,
): Promise<{ invoiceId: string; documentNumber: string; currentDue: string; retainage: string }> {
  return db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    const appRes = (await tx.execute<any>(sql`
      select * from pay_applications where id = ${payAppId} and org_id = ${orgId} for update
    `));
    const app = appRes.rows[0];
    if (!app) throw new ConstructionBillingError("Application not found");
    if (app.status !== "approved") throw new ConstructionBillingError("Only an approved application can create an invoice");
    await assertApplicationProcedure(tx, orgId, app.project_id);

    const projRes = (await tx.execute<any>(sql`
      select p.id, p.customer_id, p.subsidiary_id, coalesce(s.base_currency, o.base_currency) as currency
        from projects p join orgs o on o.id = p.org_id left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
       where p.id = ${app.project_id} and p.org_id = ${orgId}
    `));
    const project = projRes.rows[0];
    if (!project) throw new ConstructionBillingError("Project not found");
    if (!project.customer_id) throw new ConstructionBillingError("The project has no customer to invoice");

    const linesRes = (await tx.execute<any>(sql`
      select pal.sov_line_id, pal.previous_completed, pal.previous_materials_stored,
             pal.this_period_completed, pal.materials_stored,
             sl.description, sl.scheduled_value, sl.income_account_id, sl.retainage_percent
        from pay_application_lines pal
        join sov_lines sl on sl.id = pal.sov_line_id and sl.org_id = pal.org_id
       where pal.pay_application_id = ${payAppId} and pal.org_id = ${orgId}
       order by sl.sort_order
    `));

    const computed = computeApplication(
      linesRes.rows.map((l) => ({
        sovLineId: l.sov_line_id,
        scheduledValue: String(l.scheduled_value ?? "0"),
        previousCompleted: String(l.previous_completed ?? "0"),
        previousMaterialsStored: String(l.previous_materials_stored ?? "0"),
        thisPeriodCompleted: String(l.this_period_completed ?? "0"),
        materialsStored: String(l.materials_stored ?? "0"),
        retainagePercent: l.retainage_percent != null ? String(l.retainage_percent) : String(app.retainage_percent),
      })),
    );

    if (cmp(computed.grossThisPeriod, "0") === 0) {
      throw new ConstructionBillingError("Nothing to bill — enter work completed on at least one line");
    }

    const defIncome = await defaultIncomeAccount(tx, orgId);
    const retAcct = await retainageReceivableAccount(tx, orgId);
    if (cmp(computed.retainageThisPeriod, "0") > 0 && !retAcct) {
      throw new ConstructionBillingError(
        "Configure a Retainage Receivable control account (Company control accounts) before withholding retainage",
      );
    }

    const documentNumber = await nextNumber(tx, orgId, "customer_invoice", project.subsidiary_id ?? null, "INV-");
    const invoice = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                             project_id, subsidiary_id, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, 'customer_invoice', ${documentNumber}, ${project.customer_id},
              ${app.period_end}, ${project.currency}, 'draft', ${app.project_id}, ${project.subsidiary_id},
              ${`Application for Payment #${app.application_number}`}, '0', '0', '0', ${userId})
      returning id
    `));
    const invoiceId = invoice.rows[0]!.id;

    let lineNo = 1;
    const byLine = new Map(computed.lines.map((c) => [c.sovLineId, c]));
    for (const src of linesRes.rows) {
      const c = byLine.get(src.sov_line_id)!;
      if (cmp(c.grossThisPeriod, "0") === 0) continue;
      let acct = defIncome;
      if (src.income_account_id) {
        const owned = (await tx.execute<{ id: string }>(sql`
          select id from accounts
           where org_id = ${orgId} and id = ${src.income_account_id} and is_active and not is_summary
        `));
        if (!owned.rows[0]) {
          throw new ConstructionBillingError("No income account configured for a schedule-of-values line");
        }
        acct = owned.rows[0].id;
      }
      if (!acct) throw new ConstructionBillingError("No income account configured for a schedule-of-values line");
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description, quantity,
              unit_price, amount, is_billable, project_id, created_by)
        values (${orgId}, ${invoiceId}, ${lineNo}, ${acct}, ${src.description}, '1',
              ${c.grossThisPeriod}, ${c.grossThisPeriod}, true, ${app.project_id}, ${userId})
      `);
      lineNo++;
    }

    // The single retainage line: a NEGATIVE posting to Retainage Receivable.
    // The kernel credits the line account by its amount, so a negative amount
    // debits Retainage Receivable and reduces the AR (the collectible total).
    if (cmp(computed.retainageThisPeriod, "0") > 0) {
      const negRetainage = neg(computed.retainageThisPeriod);
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description, quantity,
              unit_price, amount, is_billable, project_id, created_by)
        values (${orgId}, ${invoiceId}, ${lineNo}, ${retAcct}, ${"Less retainage held"}, '1',
              ${negRetainage}, ${negRetainage}, false, ${app.project_id}, ${userId})
      `);
    }

    await tx.execute(sql`
      update documents set subtotal = ${computed.currentDue}, total = ${computed.currentDue}, updated_by = ${userId}
       where id = ${invoiceId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      update pay_applications set status = 'invoiced', invoice_document_id = ${invoiceId}, updated_by = ${userId}
       where id = ${payAppId} and org_id = ${orgId}
    `);
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${payAppId}, 'invoice',
              ${JSON.stringify({ before: { status: "approved" }, after: { status: "invoiced", invoiceId, documentNumber }, totals: computed })}::jsonb,
              ${userId})
    `);

    return {
      invoiceId,
      documentNumber,
      currentDue: computed.currentDue,
      retainage: computed.retainageThisPeriod,
    };
  });
}

/**
 * Release accumulated retainage: bill the held Retainage Receivable balance for
 * a project by generating an invoice whose one positive Retainage Receivable
 * line moves it into collectible AR (DR AR / CR Retainage Receivable).
 */
export async function releaseRetainage(
  orgId: string,
  userId: string,
  projectId: string,
  periodEnd: string,
  amount: string,
): Promise<{ invoiceId: string; documentNumber: string; amount: string }> {
  return db.transaction(async (tx) => {
    await assertProjectsEnabled(tx, orgId);
    await assertApplicationProcedure(tx, orgId, projectId);
    const exactAmount = persistRetainageReleaseAmount(amount);
    if (cmp(exactAmount, "0") <= 0) throw new ConstructionBillingError("Release amount must be positive");
    const projRes = (await tx.execute<any>(sql`
      select p.id, p.customer_id, p.subsidiary_id, coalesce(s.base_currency, o.base_currency) as currency
        from projects p join orgs o on o.id = p.org_id left join subsidiaries s on s.id = p.subsidiary_id and s.org_id = p.org_id
       where p.id = ${projectId} and p.org_id = ${orgId}
    `));
    const project = projRes.rows[0];
    if (!project?.customer_id) throw new ConstructionBillingError("Project has no customer to invoice");

    const retAcct = await retainageReceivableAccount(tx, orgId);
    if (!retAcct) throw new ConstructionBillingError("No Retainage Receivable control account is configured");

    // Reserve against both posted GL retainage and draft release invoices so
    // two concurrent releases cannot overdraw the subledger before posting.
    const projectLock = (await tx.execute<{ id: string }>(sql`
      select id from projects where id = ${projectId} and org_id = ${orgId} for update
    `));
    if (!projectLock.rows.length) throw new ConstructionBillingError("Project not found");
    const balance = (await tx.execute<{ held: string; reserved: string }>(sql`
      select
        coalesce((select sum(jl.amount)
          from journal_lines jl join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
         where jl.org_id = ${orgId} and jl.project_id = ${projectId} and jl.account_id = ${retAcct} and je.status in ('posted', 'reversed')), 0) as held,
        coalesce((select sum(d.total)
          from pay_applications pa join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
         where pa.org_id = ${orgId} and pa.project_id = ${projectId} and pa.kind = 'retainage_release'
           and pa.status in ('invoiced', 'posted') and d.status <> 'posted'), 0) as reserved
    `));
    const available = add(String(balance.rows[0]?.held ?? "0"), neg(String(balance.rows[0]?.reserved ?? "0")));
    if (cmp(exactAmount, available) > 0) throw new ConstructionBillingError("Release amount exceeds available retained funds");

    const documentNumber = await nextNumber(tx, orgId, "customer_invoice", project.subsidiary_id ?? null, "INV-");
    const invoice = (await tx.execute<{ id: string }>(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                             project_id, subsidiary_id, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, 'customer_invoice', ${documentNumber}, ${project.customer_id}, ${periodEnd},
              ${project.currency}, 'draft', ${projectId}, ${project.subsidiary_id}, 'Retainage release',
              ${exactAmount}, '0', ${exactAmount}, ${userId})
      returning id
    `));
    const invoiceId = invoice.rows[0]!.id;
    // Positive Retainage Receivable line → CR Retainage Receivable, DR AR.
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description, quantity,
            unit_price, amount, is_billable, project_id, created_by)
      values (${orgId}, ${invoiceId}, 1, ${retAcct}, 'Retainage release', '1', ${exactAmount}, ${exactAmount}, false,
            ${projectId}, ${userId})
    `);
    const numberRes = (await tx.execute<{ n: number }>(sql`
      select coalesce(max(application_number), 0) + 1 as n
        from pay_applications where org_id = ${orgId} and project_id = ${projectId}
    `));
    const applicationNumber = Number(numberRes.rows[0]?.n ?? 1);
    const release = (await tx.execute<{ id: string }>(sql`
      insert into pay_applications (org_id, project_id, application_number, period_end, kind, status,
                                    retainage_percent, invoice_document_id, memo, created_by, updated_by)
      values (${orgId}, ${projectId}, ${applicationNumber}, ${periodEnd}, 'retainage_release', 'invoiced',
              '0', ${invoiceId}, 'Retainage release', ${userId}, ${userId})
      returning id
    `));
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_applications', ${release.rows[0]!.id}, 'retainage_release',
              ${JSON.stringify({ after: { projectId, applicationNumber, periodEnd, amount: exactAmount, availableBefore: available, invoiceId, documentNumber } })}::jsonb,
              ${userId})
    `);
    return { invoiceId, documentNumber, amount: exactAmount };
  });
}
