import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import {
  ConstructionBillingError,
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
  revisedScheduleValue,
  submitPayApplication,
  voidPayApplication,
} from "@openbooks/engine/src/construction-billing.ts";
import { guardPermission, requirePermission } from "../../../lib/authz";
import { projectCostSummary } from "../../../lib/project-costing";
import { cmp, normalizeMoney, sum } from "@openbooks/engine/src/money.ts";
import { guardProjectsFeature } from "../../../lib/projects-gate";
import { supportsApplicationsForPayment } from "../../../lib/project-billing-procedure";

export const runtime = "nodejs";

/**
 * Construction progress billing API for one project. GET ?projectId returns the
 * schedule of values, change orders, applications for payment, contract sum,
 * GL-backed retainage held, and committed cost. POST is action-dispatched.
 */
export async function GET(req: Request) {
  const authz = await requirePermission("ar.read");
  const feature = await guardProjectsFeature(authz.user.orgId);
  if (feature) return feature;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const orgId = authz.user.orgId;
  if (!(await supportsApplicationsForPayment(orgId, projectId))) {
    return NextResponse.json({ error: "This project's billing profile does not use applications for payment" }, { status: 422 });
  }

  const retAcct = (await db.execute<{ acct: string | null }>(sql`
    select settings->'controlAccounts'->>'retainageReceivable' as acct from orgs where id = ${orgId}
  `));
  const retainageAccountId = retAcct.rows[0]?.acct ?? null;

  const [sov, cos, apps, held, committed] = await Promise.all([
    db.execute<any>(sql`
      select id, item_no as "itemNo", description, scheduled_value as "scheduledValue",
             retainage_percent as "retainagePercent", income_account_id as "incomeAccountId",
             sort_order as "sortOrder", change_order_id as "changeOrderId"
        from sov_lines where org_id = ${orgId} and project_id = ${projectId} order by sort_order
    `),
    db.execute<any>(sql`
      select co.id, co.number, co.description, co.status, co.amount, co.approved_on as "approvedOn",
             co.target_sov_line_id as "targetSovLineId", sl.description as "targetSovLineDescription",
             co.created_by <> ${authz.user.id} as "independentApprovalAllowed"
        from change_orders co
        left join sov_lines sl on sl.id = co.target_sov_line_id and sl.org_id = co.org_id
       where co.org_id = ${orgId} and co.project_id = ${projectId} order by co.number
    `),
    db.execute<any>(sql`
      select pa.id, pa.application_number as "applicationNumber", pa.period_end as "periodEnd", pa.kind,
             pa.status, pa.retainage_percent as "retainagePercent", pa.invoice_document_id as "invoiceDocumentId",
             d.document_number as "invoiceNumber", d.total as "invoiceTotal", d.status as "invoiceStatus",
             coalesce(pa.submitted_by, pa.created_by) <> ${authz.user.id} as "independentApprovalAllowed"
        from pay_applications pa
        left join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
       where pa.org_id = ${orgId} and pa.project_id = ${projectId} order by pa.application_number
    `),
    retainageAccountId
      ? (db.execute<{ held: string }>(sql`
          select coalesce(sum(jl.amount), 0) as held
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where jl.org_id = ${orgId} and jl.account_id = ${retainageAccountId} and jl.project_id = ${projectId}
             and je.status in ('posted', 'reversed')
        `))
      : Promise.resolve({ rows: [{ held: "0" }] }),
    projectCostSummary(orgId, projectId).catch(() => null),
  ]);

  const contractSum = sum(sov.rows.map((line: any) => String(line.scheduledValue ?? "0")));
  return NextResponse.json({
    sovLines: sov.rows,
    changeOrders: cos.rows,
    payApplications: apps.rows,
    contractSum,
    retainageHeld: String(held.rows[0]?.held ?? "0"),
    committedCost: committed?.committed?.cost ?? "0.0000",
    retainageConfigured: Boolean(retainageAccountId),
  });
}

async function ownsProject(orgId: string, projectId: string): Promise<boolean> {
  const r = (await db.execute(
    sql`select 1 from projects where id = ${projectId} and org_id = ${orgId}`,
  ));
  return r.rows.length > 0;
}

async function actionProjectId(orgId: string, action: string, body: Record<string, any>): Promise<string | null> {
  if (["addSov", "addChangeOrder", "createPayApp", "releaseRetainage"].includes(action)) {
    return typeof body.projectId === "string" && await ownsProject(orgId, body.projectId) ? body.projectId : null;
  }
  let query: SQL;
  if (["updateSov", "deleteSov"].includes(action)) {
    query = sql`select project_id from sov_lines where id = ${body.id} and org_id = ${orgId}`;
  } else if (["approveChangeOrder", "voidChangeOrder"].includes(action)) {
    query = sql`select project_id from change_orders where id = ${body.id} and org_id = ${orgId}`;
  } else if (["submitPayApp", "approvePayApp", "voidPayApp", "billPayApp"].includes(action)) {
    query = sql`select project_id from pay_applications where id = ${body.payApplicationId} and org_id = ${orgId}`;
  } else {
    return null;
  }
  const result = (await db.execute<{ project_id: string }>(query));
  return result.rows[0]?.project_id ?? null;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as Record<string, any>;
  const action = body.action as string;
  const permission = action === "approveChangeOrder" || action === "approvePayApp" || action === "voidPayApp"
    ? "ar.approve"
    : action === "billPayApp" || action === "releaseRetainage"
      ? "ar.post"
      : "ar.create";
  const authz = await guardPermission(permission);
  if (authz instanceof NextResponse) return authz;
  const orgId = authz.user.orgId;
  const feature = await guardProjectsFeature(orgId);
  if (feature) return feature;
  const userId = authz.user.id;
  const projectActions = new Set(["addSov", "updateSov", "deleteSov", "addChangeOrder", "approveChangeOrder", "voidChangeOrder", "createPayApp", "submitPayApp", "approvePayApp", "voidPayApp", "billPayApp", "releaseRetainage"]);
  if (projectActions.has(action)) {
    const projectId = await actionProjectId(orgId, action, body);
    if (!projectId) return NextResponse.json({ error: "not found" }, { status: 404 });
    if (!(await supportsApplicationsForPayment(orgId, projectId))) {
      return NextResponse.json({ error: "This project's billing profile does not use applications for payment" }, { status: 422 });
    }
  }

  try {
    switch (action) {
      case "addSov": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const description = String(body.description ?? "").trim();
        const scheduledValue = normalizeMoney(String(body.scheduledValue ?? "0"));
        const retainagePercent = body.retainagePercent == null || body.retainagePercent === "" ? null : normalizeMoney(String(body.retainagePercent));
        if (!description || cmp(scheduledValue, "0") <= 0) throw new ConstructionBillingError("Description and a positive scheduled value are required");
        if (retainagePercent !== null && (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)) throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
        const id = await db.transaction(async (tx) => {
          const prior = (await tx.execute(sql`select 1 from pay_applications where org_id = ${orgId} and project_id = ${body.projectId} limit 1`));
          if (prior.rows.length) throw new ConstructionBillingError("After billing begins, contract value must change through an approved change order");
          const created = (await tx.execute<{ id: string }>(sql`
            insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, retainage_percent,
                                   income_account_id, sort_order, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${body.itemNo ?? null}, ${description}, ${scheduledValue},
                    ${retainagePercent}, ${body.incomeAccountId ?? null}, ${Number(body.sortOrder ?? 0)}, ${userId}, ${userId})
            returning id
          `));
          const createdId = created.rows[0]!.id;
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, itemNo: body.itemNo ?? null, description, scheduledValue, retainagePercent, incomeAccountId: body.incomeAccountId ?? null } })}::jsonb, ${userId})`);
          return createdId;
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case "updateSov": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute<any>(sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`));
          if (!before.rows[0]) throw new ConstructionBillingError("Schedule line not found");
          const used = (await tx.execute(sql`select 1 from pay_application_lines where org_id = ${orgId} and sov_line_id = ${body.id} limit 1`));
          if (used.rows.length) throw new ConstructionBillingError("A schedule line used by an application is immutable; use a change order");
          const description = String(body.description ?? "").trim();
          const scheduledValue = normalizeMoney(String(body.scheduledValue ?? "0"));
          const retainagePercent = body.retainagePercent == null || body.retainagePercent === "" ? null : normalizeMoney(String(body.retainagePercent));
          if (!description || cmp(scheduledValue, "0") <= 0) throw new ConstructionBillingError("Description and a positive scheduled value are required");
          if (retainagePercent !== null && (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)) throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
          const after = (await tx.execute<any>(sql`
            update sov_lines set item_no = ${body.itemNo ?? null}, description = ${description}, scheduled_value = ${scheduledValue},
                   retainage_percent = ${retainagePercent}, income_account_id = ${body.incomeAccountId ?? null}, updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId} returning *
          `));
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${body.id}, 'update', ${JSON.stringify({ before: before.rows[0], after: after.rows[0] })}::jsonb, ${userId})`);
        });
        return NextResponse.json({ ok: true });
      }
      case "deleteSov": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute<any>(sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`));
          if (!before.rows[0]) throw new ConstructionBillingError("Schedule line not found");
          const used = (await tx.execute(sql`select 1 from pay_application_lines where org_id = ${orgId} and sov_line_id = ${body.id} limit 1`));
          if (used.rows.length || before.rows[0].change_order_id) throw new ConstructionBillingError("A controlled schedule line cannot be deleted; use a reversing change order");
          await tx.execute(sql`delete from sov_lines where id = ${body.id} and org_id = ${orgId}`);
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${body.id}, 'delete', ${JSON.stringify({ before: before.rows[0] })}::jsonb, ${userId})`);
        });
        return NextResponse.json({ ok: true });
      }
      case "addChangeOrder": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const number = String(body.number ?? "").trim();
        const amount = normalizeMoney(String(body.amount ?? "0"));
        const targetSovLineId = typeof body.targetSovLineId === "string" && body.targetSovLineId ? body.targetSovLineId : null;
        if (!number || cmp(amount, "0") === 0) throw new ConstructionBillingError("Change-order number and a non-zero amount are required");
        if (cmp(amount, "0") < 0 && !targetSovLineId) throw new ConstructionBillingError("A deductive change order must identify the schedule line it reduces");
        const id = await db.transaction(async (tx) => {
          if (targetSovLineId) {
            const target = (await tx.execute(sql`
              select 1 from sov_lines
               where id = ${targetSovLineId} and org_id = ${orgId} and project_id = ${body.projectId}
            `));
            if (!target.rows.length) throw new ConstructionBillingError("The target schedule line does not belong to this project");
          }
          const created = (await tx.execute<{ id: string }>(sql`
            insert into change_orders (org_id, project_id, number, description, amount, target_sov_line_id, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${number}, ${body.description ?? null}, ${amount}, ${targetSovLineId}, ${userId}, ${userId}) returning id
          `));
          const createdId = created.rows[0]!.id;
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, number, description: body.description ?? null, amount, targetSovLineId, status: "draft" } })}::jsonb, ${userId})`);
          return createdId;
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case "approveChangeOrder": {
        // Approving a change order also lands its value as a new SOV line so the
        // contract sum and future draws reflect it.
        await db.transaction(async (tx) => {
          const co = (await tx.execute<any>(sql`
            select project_id, number, description, amount, target_sov_line_id, created_by from change_orders
             where id = ${body.id} and org_id = ${orgId} and status = 'draft' for update
          `));
          const row = co.rows[0];
          if (!row) throw new ConstructionBillingError("Change order not found or no longer draft");
          if (row.created_by === userId) throw new ConstructionBillingError("The preparer cannot approve the same change order");
          await tx.execute(sql`select id from projects where id = ${row.project_id} and org_id = ${orgId} for update`);
          const activeApplication = (await tx.execute(sql`
            select 1 from pay_applications where org_id = ${orgId} and project_id = ${row.project_id}
             and status in ('draft', 'submitted', 'approved') limit 1
          `));
          if (activeApplication.rows.length) throw new ConstructionBillingError("Complete or void the current application before approving a change order");
          await tx.execute(sql`
            update change_orders set status = 'approved', approved_on = ${body.approvedOn ?? new Date().toISOString().slice(0, 10)},
                   approved_by = ${userId},
                   updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId}
          `);
          let sovLineId: string;
          if (row.target_sov_line_id) {
            const target = (await tx.execute<{ id: string; scheduled_value: string }>(sql`
              select id, scheduled_value
                from sov_lines
               where id = ${row.target_sov_line_id} and org_id = ${orgId} and project_id = ${row.project_id}
               for update
            `));
            if (!target.rows[0]) throw new ConstructionBillingError("The target schedule line no longer exists");
            const billed = (await tx.execute<{ amount: string }>(sql`
              select coalesce(sum(pal.this_period_completed + pal.materials_stored), 0) as amount
                from pay_application_lines pal
                join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
               where pal.org_id = ${orgId} and pal.sov_line_id = ${row.target_sov_line_id}
                 and pa.status in ('invoiced', 'posted')
            `));
            const revisedValue = revisedScheduleValue(
              String(target.rows[0].scheduled_value),
              String(row.amount),
              String(billed.rows[0]?.amount ?? "0"),
            );
            await tx.execute(sql`
              update sov_lines set scheduled_value = ${revisedValue}, updated_at = now(), updated_by = ${userId}
               where id = ${row.target_sov_line_id} and org_id = ${orgId}
            `);
            sovLineId = row.target_sov_line_id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${sovLineId}, 'change_order_adjustment',
                      ${JSON.stringify({ changeOrderId: body.id, before: { scheduledValue: target.rows[0].scheduled_value }, after: { scheduledValue: revisedValue } })}::jsonb,
                      ${userId})`);
          } else {
            if (cmp(String(row.amount), "0") <= 0) throw new ConstructionBillingError("An unallocated change order must be additive");
            const sov = (await tx.execute<{ id: string }>(sql`
              insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, change_order_id,
                                     sort_order, created_by, updated_by)
              values (${orgId}, ${row.project_id}, ${"CO-" + row.number}, ${row.description ?? "Change order " + row.number},
                      ${String(row.amount)}, ${body.id},
                      (select coalesce(max(sort_order), 0) + 1 from sov_lines where org_id = ${orgId} and project_id = ${row.project_id}),
                      ${userId}, ${userId})
              returning id
            `));
            sovLineId = sov.rows[0]!.id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${sovLineId}, 'insert',
                      jsonb_build_object('source', 'approved_change_order', 'changeOrderId', ${body.id},
                        'after', jsonb_build_object('projectId', ${row.project_id}, 'scheduledValue', ${String(row.amount)})),
                      ${userId})`);
          }
          const approvedOn = body.approvedOn ?? new Date().toISOString().slice(0, 10);
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${body.id}, 'approve',
                    jsonb_build_object('before', jsonb_build_object('status', 'draft'), 'after',
                      jsonb_build_object('status', 'approved', 'approvedOn', ${approvedOn}, 'sovLineId', ${sovLineId})),
                    ${userId})`);
        });
        return NextResponse.json({ ok: true });
      }
      case "voidChangeOrder": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute<any>(sql`
            select * from change_orders where id = ${body.id} and org_id = ${orgId} for update
          `));
          if (!before.rows[0] || before.rows[0].status !== "draft") {
            throw new ConstructionBillingError("Only a draft change order can be voided");
          }
          await tx.execute(sql`
            update change_orders set status = 'void', updated_at = now(), updated_by = ${userId}
             where id = ${body.id} and org_id = ${orgId}
          `);
          await tx.execute(sql`
            insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${body.id}, 'void',
                    ${JSON.stringify({ before: { status: "draft" }, after: { status: "void" } })}::jsonb, ${userId})
          `);
        });
        return NextResponse.json({ ok: true });
      }
      case "createPayApp": {
        if (!(await ownsProject(orgId, body.projectId))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const r = await createPayApplication(orgId, userId, body.projectId, body.periodEnd, String(body.retainagePercent ?? "10"));
        return NextResponse.json(r, { status: 201 });
      }
      case "submitPayApp": {
        const lines = Array.isArray(body.lines) ? body.lines.map((line: any) => ({
          sovLineId: String(line.sovLineId ?? ""),
          thisPeriodCompleted: String(line.thisPeriodCompleted ?? "0"),
          materialsStored: String(line.materialsStored ?? "0"),
        })) : [];
        const result = await submitPayApplication(orgId, userId, body.payApplicationId, lines);
        return NextResponse.json(result);
      }
      case "approvePayApp": {
        await approvePayApplication(orgId, userId, body.payApplicationId);
        return NextResponse.json({ ok: true });
      }
      case "voidPayApp": {
        await voidPayApplication(orgId, userId, body.payApplicationId);
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
