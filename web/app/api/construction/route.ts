import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  ConstructionBillingError,
  createPayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
} from "@openbooks/engine/src/construction-billing.ts";
import { requirePermission } from "../../../lib/authz";
import { projectCostSummary } from "../../../lib/project-costing";

export const runtime = "nodejs";

/**
 * Construction progress billing API for one project. GET ?projectId returns the
 * schedule of values, change orders, applications for payment, contract sum,
 * GL-backed retainage held, and committed cost. POST is action-dispatched.
 */
export async function GET(req: Request) {
  const authz = await requirePermission("ar.read");
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const orgId = authz.user.orgId;

  const retAcct = (await db.execute(sql`
    select settings->'controlAccounts'->>'retainageReceivable' as acct from orgs where id = ${orgId}
  `)) as unknown as { rows: { acct: string | null }[] };
  const retainageAccountId = retAcct.rows[0]?.acct ?? null;

  const [sov, cos, apps, held, committed] = await Promise.all([
    db.execute(sql`
      select id, item_no as "itemNo", description, scheduled_value as "scheduledValue",
             retainage_percent as "retainagePercent", income_account_id as "incomeAccountId",
             sort_order as "sortOrder", change_order_id as "changeOrderId"
        from sov_lines where org_id = ${orgId} and project_id = ${projectId} order by sort_order
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select id, number, description, status, amount, approved_on as "approvedOn"
        from change_orders where org_id = ${orgId} and project_id = ${projectId} order by number
    `) as unknown as Promise<{ rows: any[] }>,
    db.execute(sql`
      select pa.id, pa.application_number as "applicationNumber", pa.period_end as "periodEnd", pa.kind,
             pa.status, pa.retainage_percent as "retainagePercent", pa.invoice_document_id as "invoiceDocumentId",
             d.document_number as "invoiceNumber", d.total as "invoiceTotal", d.status as "invoiceStatus"
        from pay_applications pa
        left join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
       where pa.org_id = ${orgId} and pa.project_id = ${projectId} order by pa.application_number
    `) as unknown as Promise<{ rows: any[] }>,
    retainageAccountId
      ? (db.execute(sql`
          select coalesce(sum(jl.amount), 0) as held
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where jl.org_id = ${orgId} and jl.account_id = ${retainageAccountId} and jl.project_id = ${projectId}
        `) as unknown as Promise<{ rows: { held: string }[] }>)
      : Promise.resolve({ rows: [{ held: "0" }] }),
    projectCostSummary(orgId, projectId).catch(() => null),
  ]);

  const contractSum = sov.rows.reduce((a: number, l: any) => a + Number(l.scheduledValue ?? 0), 0);
  return NextResponse.json({
    sovLines: sov.rows,
    changeOrders: cos.rows,
    payApplications: apps.rows,
    contractSum: contractSum.toFixed(4),
    retainageHeld: String(held.rows[0]?.held ?? "0"),
    committedCost: committed?.committed?.cost ?? 0,
    retainageConfigured: Boolean(retainageAccountId),
  });
}

async function ownsProject(orgId: string, projectId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from projects where id = ${projectId} and org_id = ${orgId}`,
  )) as unknown as { rows: unknown[] };
  return r.rows.length > 0;
}

export async function POST(req: Request) {
  const authz = await requirePermission("ar.create");
  const orgId = authz.user.orgId;
  const userId = authz.user.id;
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const action = body.action as string;

  try {
    switch (action) {
      case "addSov": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const created = (await db.execute(sql`
          insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, retainage_percent,
                                 income_account_id, sort_order, created_by, updated_by)
          values (${orgId}, ${body.projectId}, ${body.itemNo ?? null}, ${body.description},
                  ${String(body.scheduledValue ?? "0")}, ${body.retainagePercent != null ? String(body.retainagePercent) : null},
                  ${body.incomeAccountId ?? null}, ${Number(body.sortOrder ?? 0)}, ${userId}, ${userId})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        return NextResponse.json({ id: created.rows[0]!.id }, { status: 201 });
      }
      case "updateSov": {
        await db.execute(sql`
          update sov_lines set item_no = ${body.itemNo ?? null}, description = ${body.description},
                 scheduled_value = ${String(body.scheduledValue ?? "0")},
                 retainage_percent = ${body.retainagePercent != null ? String(body.retainagePercent) : null},
                 income_account_id = ${body.incomeAccountId ?? null}, updated_at = now(), updated_by = ${userId}
           where id = ${body.id} and org_id = ${orgId}
        `);
        return NextResponse.json({ ok: true });
      }
      case "deleteSov": {
        await db.execute(sql`delete from sov_lines where id = ${body.id} and org_id = ${orgId}`);
        return NextResponse.json({ ok: true });
      }
      case "addChangeOrder": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const created = (await db.execute(sql`
          insert into change_orders (org_id, project_id, number, description, amount, created_by, updated_by)
          values (${orgId}, ${body.projectId}, ${body.number}, ${body.description ?? null},
                  ${String(body.amount ?? "0")}, ${userId}, ${userId})
          returning id
        `)) as unknown as { rows: { id: string }[] };
        return NextResponse.json({ id: created.rows[0]!.id }, { status: 201 });
      }
      case "approveChangeOrder": {
        // Approving a change order also lands its value as a new SOV line so the
        // contract sum and future draws reflect it.
        const co = (await db.execute(sql`
          select project_id, number, description, amount from change_orders
           where id = ${body.id} and org_id = ${orgId} and status = 'draft'
        `)) as unknown as { rows: any[] };
        const row = co.rows[0];
        if (!row) return NextResponse.json({ error: "change order not found or not draft" }, { status: 404 });
        await db.transaction(async (tx) => {
          await tx.execute(sql`
            update change_orders set status = 'approved', approved_on = ${body.approvedOn ?? new Date().toISOString().slice(0, 10)},
                   updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId}
          `);
          await tx.execute(sql`
            insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, change_order_id,
                                   sort_order, created_by, updated_by)
            values (${orgId}, ${row.project_id}, ${"CO-" + row.number}, ${row.description ?? "Change order " + row.number},
                    ${String(row.amount ?? "0")}, ${body.id},
                    (select coalesce(max(sort_order), 0) + 1 from sov_lines where org_id = ${orgId} and project_id = ${row.project_id}),
                    ${userId}, ${userId})
          `);
        });
        return NextResponse.json({ ok: true });
      }
      case "createPayApp": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const r = await createPayApplication(orgId, userId, body.projectId, body.periodEnd, String(body.retainagePercent ?? "10"));
        return NextResponse.json(r, { status: 201 });
      }
      case "updatePayAppLine": {
        await db.execute(sql`
          update pay_application_lines set this_period_completed = ${String(body.thisPeriodCompleted ?? "0")},
                 materials_stored = ${String(body.materialsStored ?? "0")}, updated_at = now(), updated_by = ${userId}
           where pay_application_id = ${body.payApplicationId} and sov_line_id = ${body.sovLineId} and org_id = ${orgId}
        `);
        return NextResponse.json({ ok: true });
      }
      case "billPayApp": {
        const r = await generatePayApplicationInvoice(orgId, userId, body.payApplicationId);
        return NextResponse.json(r);
      }
      case "releaseRetainage": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const r = await releaseRetainage(orgId, userId, body.projectId, body.periodEnd, String(body.amount ?? "0"));
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ConstructionBillingError) return NextResponse.json({ error: e.message }, { status: 422 });
    throw e;
  }
}
