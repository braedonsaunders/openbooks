import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { add, mulPercent, neg, sum } from "./money.ts";

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

export interface AppLineInput {
  sovLineId: string;
  scheduledValue: string;
  previousCompleted: string;
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

/**
 * Pure G702/G703 math for one application. Gross this period = work completed +
 * materials stored this application; retainage is withheld on that gross; the
 * net is the current payment due. Exact money throughout — unit-tested.
 */
export function computeApplication(lines: AppLineInput[]): ComputedApplication {
  const computed: ComputedAppLine[] = lines.map((l) => {
    const gross = add(l.thisPeriodCompleted || "0", l.materialsStored || "0");
    const retainage = Number(l.retainagePercent) > 0 ? mulPercent(gross, l.retainagePercent) : "0";
    const net = add(gross, neg(retainage));
    const completedToDate = add(l.previousCompleted || "0", gross);
    const scheduled = Number(l.scheduledValue || "0");
    const percent = scheduled > 0 ? ((Number(completedToDate) / scheduled) * 100).toFixed(2) : "0.00";
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
  tx: any,
  orgId: string,
  kind: string,
  subsidiaryId: string | null,
  prefix: string,
): Promise<string> {
  const configured = subsidiaryId
    ? ((await tx.execute(sql`
        select 1 from number_sequences where org_id = ${orgId} and document_kind = ${kind}
          and subsidiary_id = ${subsidiaryId} limit 1`)) as unknown as { rows: unknown[] }).rows.length > 0
    : false;
  const seqSub = configured ? subsidiaryId : null;
  const r = (await tx.execute(sql`
    insert into number_sequences (org_id, document_kind, subsidiary_id, prefix)
    values (${orgId}, ${kind}, ${seqSub}, ${prefix})
    on conflict on constraint sequences_org_kind_sub
    do update set next_number = number_sequences.next_number + 1
    returning prefix, next_number, padding
  `)) as unknown as { rows: { prefix: string; next_number: number; padding: number }[] };
  const s = r.rows[0]!;
  return `${s.prefix}${String(s.next_number).padStart(s.padding, "0")}`;
}

async function retainageReceivableAccount(tx: any, orgId: string): Promise<string | null> {
  const r = (await tx.execute(sql`
    select settings->'controlAccounts'->>'retainageReceivable' as acct from orgs where id = ${orgId}
  `)) as unknown as { rows: { acct: string | null }[] };
  return r.rows[0]?.acct ?? null;
}

async function defaultIncomeAccount(tx: any, orgId: string): Promise<string | null> {
  const r = (await tx.execute(sql`
    select id from accounts where org_id = ${orgId} and type in ('income', 'income_other') and is_active
     order by number nulls last limit 1
  `)) as unknown as { rows: { id: string }[] };
  return r.rows[0]?.id ?? null;
}

/**
 * Create the next Application for Payment for a project, pre-filling each SOV
 * line's previous-completed from prior POSTED applications so the draw math is
 * cumulative.
 */
export async function createPayApplication(
  orgId: string,
  userId: string,
  projectId: string,
  periodEnd: string,
  retainagePercent = "10",
): Promise<{ id: string; applicationNumber: number }> {
  return db.transaction(async (tx) => {
    const sov = (await tx.execute(sql`
      select id, scheduled_value from sov_lines where org_id = ${orgId} and project_id = ${projectId}
       order by sort_order
    `)) as unknown as { rows: { id: string; scheduled_value: string }[] };
    if (!sov.rows.length) throw new ConstructionBillingError("This project has no Schedule of Values yet");

    const numRes = (await tx.execute(sql`
      select coalesce(max(application_number), 0) + 1 as n
        from pay_applications where org_id = ${orgId} and project_id = ${projectId}
    `)) as unknown as { rows: { n: number }[] };
    const applicationNumber = Number(numRes.rows[0]!.n);

    const app = (await tx.execute(sql`
      insert into pay_applications (org_id, project_id, application_number, period_end, retainage_percent,
                                    created_by, updated_by)
      values (${orgId}, ${projectId}, ${applicationNumber}, ${periodEnd}, ${retainagePercent}, ${userId}, ${userId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const appId = app.rows[0]!.id;

    for (const line of sov.rows) {
      const prior = (await tx.execute(sql`
        select coalesce(sum(pal.this_period_completed + pal.materials_stored), 0) as prev
          from pay_application_lines pal
          join pay_applications pa on pa.id = pal.pay_application_id
         where pal.org_id = ${orgId} and pal.sov_line_id = ${line.id} and pa.status = 'posted'
      `)) as unknown as { rows: { prev: string }[] };
      await tx.execute(sql`
        insert into pay_application_lines (org_id, pay_application_id, sov_line_id, previous_completed, created_by, updated_by)
        values (${orgId}, ${appId}, ${line.id}, ${prior.rows[0]?.prev ?? "0"}, ${userId}, ${userId})
      `);
    }
    return { id: appId, applicationNumber };
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
    const appRes = (await tx.execute(sql`
      select * from pay_applications where id = ${payAppId} and org_id = ${orgId} for update
    `)) as unknown as { rows: any[] };
    const app = appRes.rows[0];
    if (!app) throw new ConstructionBillingError("Application not found");
    if (app.status === "posted") throw new ConstructionBillingError("This application has already been billed");

    const projRes = (await tx.execute(sql`
      select p.id, p.customer_id, p.subsidiary_id, coalesce(s.base_currency, o.base_currency) as currency
        from projects p join orgs o on o.id = p.org_id left join subsidiaries s on s.id = p.subsidiary_id
       where p.id = ${app.project_id} and p.org_id = ${orgId}
    `)) as unknown as { rows: any[] };
    const project = projRes.rows[0];
    if (!project) throw new ConstructionBillingError("Project not found");
    if (!project.customer_id) throw new ConstructionBillingError("The project has no customer to invoice");

    const linesRes = (await tx.execute(sql`
      select pal.sov_line_id, pal.previous_completed, pal.this_period_completed, pal.materials_stored,
             sl.description, sl.scheduled_value, sl.income_account_id, sl.retainage_percent
        from pay_application_lines pal
        join sov_lines sl on sl.id = pal.sov_line_id
       where pal.pay_application_id = ${payAppId} and pal.org_id = ${orgId}
       order by sl.sort_order
    `)) as unknown as { rows: any[] };

    const computed = computeApplication(
      linesRes.rows.map((l) => ({
        sovLineId: l.sov_line_id,
        scheduledValue: String(l.scheduled_value ?? "0"),
        previousCompleted: String(l.previous_completed ?? "0"),
        thisPeriodCompleted: String(l.this_period_completed ?? "0"),
        materialsStored: String(l.materials_stored ?? "0"),
        retainagePercent: l.retainage_percent != null ? String(l.retainage_percent) : String(app.retainage_percent),
      })),
    );

    if (Number(computed.grossThisPeriod) === 0) {
      throw new ConstructionBillingError("Nothing to bill — enter work completed on at least one line");
    }

    const defIncome = await defaultIncomeAccount(tx, orgId);
    const retAcct = await retainageReceivableAccount(tx, orgId);
    if (Number(computed.retainageThisPeriod) > 0 && !retAcct) {
      throw new ConstructionBillingError(
        "Configure a Retainage Receivable control account (Company control accounts) before withholding retainage",
      );
    }

    const documentNumber = await nextNumber(tx, orgId, "customer_invoice", project.subsidiary_id ?? null, "INV-");
    const invoice = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                             project_id, subsidiary_id, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, 'customer_invoice', ${documentNumber}, ${project.customer_id},
              ${app.period_end}, ${project.currency}, 'draft', ${app.project_id}, ${project.subsidiary_id},
              ${`Application for Payment #${app.application_number}`}, '0', '0', '0', ${userId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const invoiceId = invoice.rows[0]!.id;

    let lineNo = 1;
    const byLine = new Map(computed.lines.map((c) => [c.sovLineId, c]));
    for (const src of linesRes.rows) {
      const c = byLine.get(src.sov_line_id)!;
      if (Number(c.grossThisPeriod) === 0) continue;
      const acct = src.income_account_id ?? defIncome;
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
    if (Number(computed.retainageThisPeriod) > 0) {
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
      update pay_applications set status = 'posted', invoice_document_id = ${invoiceId}, updated_by = ${userId}
       where id = ${payAppId} and org_id = ${orgId}
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
    if (Number(amount) <= 0) throw new ConstructionBillingError("Release amount must be positive");
    const projRes = (await tx.execute(sql`
      select p.id, p.customer_id, p.subsidiary_id, coalesce(s.base_currency, o.base_currency) as currency
        from projects p join orgs o on o.id = p.org_id left join subsidiaries s on s.id = p.subsidiary_id
       where p.id = ${projectId} and p.org_id = ${orgId}
    `)) as unknown as { rows: any[] };
    const project = projRes.rows[0];
    if (!project?.customer_id) throw new ConstructionBillingError("Project has no customer to invoice");

    const retAcct = await retainageReceivableAccount(tx, orgId);
    if (!retAcct) throw new ConstructionBillingError("No Retainage Receivable control account is configured");

    const documentNumber = await nextNumber(tx, orgId, "customer_invoice", project.subsidiary_id ?? null, "INV-");
    const invoice = (await tx.execute(sql`
      insert into documents (org_id, kind, document_number, party_id, document_date, currency, status,
                             project_id, subsidiary_id, memo, subtotal, tax_total, total, created_by)
      values (${orgId}, 'customer_invoice', ${documentNumber}, ${project.customer_id}, ${periodEnd},
              ${project.currency}, 'draft', ${projectId}, ${project.subsidiary_id}, 'Retainage release',
              ${amount}, '0', ${amount}, ${userId})
      returning id
    `)) as unknown as { rows: { id: string }[] };
    const invoiceId = invoice.rows[0]!.id;
    // Positive Retainage Receivable line → CR Retainage Receivable, DR AR.
    await tx.execute(sql`
      insert into document_lines (org_id, document_id, line_number, account_id, description, quantity,
            unit_price, amount, is_billable, project_id, created_by)
      values (${orgId}, ${invoiceId}, 1, ${retAcct}, 'Retainage release', '1', ${amount}, ${amount}, false,
            ${projectId}, ${userId})
    `);
    return { invoiceId, documentNumber, amount };
  });
}
