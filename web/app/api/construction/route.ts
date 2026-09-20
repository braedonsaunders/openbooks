import { jsonObject, parseJsonBody } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/src/platform/db.ts";
import {
  ConstructionBillingError,
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  projectRetainageHeldSql,
  releaseRetainage,
  requireIsoDate,
  revisedScheduleValue,
  submitPayApplication,
  voidPayApplication,
} from "@openbooks/engine/src/projects/construction-billing.ts";
import { guardPermission, guardSubsidiaryScope } from "../../../lib/authz";
import { isUuid } from "../../../lib/list-params";
import { projectCostSummary } from "../../../lib/project-costing";
import { add, cmp, normalizeMoney, sum } from "@openbooks/engine/src/money/money.ts";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { guardProjectsFeature } from "../../../lib/projects-gate";
import { supportsApplicationsForPayment } from "../../../lib/project-billing-procedure";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";

export const runtime = "nodejs";

/**
 * Construction progress billing API for one project. GET ?projectId returns the
 * schedule of values, change orders, applications for payment, contract sum,
 * GL-backed retainage held, and committed cost. POST is action-dispatched.
 */
export async function GET(req: Request) {
  const authz = await guardPermission("ar.read");
  if (authz instanceof NextResponse) return authz;
  const feature = await guardProjectsFeature(authz.user.orgId);
  if (feature) return feature;
  const url = new URL(req.url);
  const projectId = url.searchParams.get("projectId");
  if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
  const orgId = authz.user.orgId;
  // A project outside the caller's subsidiary scope is a missing project.
  const scope = await projectScope(orgId, projectId);
  if (!scope) return NextResponse.json({ error: "not found" }, { status: 404 });
  const denied = guardSubsidiaryScope(authz, scope.subsidiaryId);
  if (denied) return denied;
  if (!(await supportsApplicationsForPayment(orgId, projectId))) {
    return NextResponse.json({ error: "This project's billing profile does not use applications for payment" }, { status: 422 });
  }

  const retAcct = (await db.execute<{ acct: string | null }>(sql`
    select a.id as acct
      from orgs o
      join accounts a on a.id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
                     and a.org_id = o.id
     where o.id = ${orgId}
  `));
  const retainageAccountId = retAcct.rows[0]?.acct ?? null;

  // The org project-revenue default backing the CO income picker (F-t03-002
  // residual); resolved alongside the page reads, not inside a write tx.
  const defaultIncomeAccount = projectDefaultIncomeAccount(db, orgId);
  const [sov, cos, apps, held, committed] = await Promise.all([
    db.execute(sql`
      select l.id, l.item_no as "itemNo", l.description, l.scheduled_value as "scheduledValue",
             l.retainage_percent as "retainagePercent", l.income_account_id as "incomeAccountId",
             l.sort_order as "sortOrder", l.change_order_id as "changeOrderId",
             exists(select 1 from pay_application_lines pal where pal.org_id = ${orgId} and pal.sov_line_id = l.id) as "usedByApplication"
        from sov_lines l where l.org_id = ${orgId} and l.project_id = ${projectId} order by l.sort_order
    `),
    db.execute(sql`
      select co.id, co.number, co.description, co.status, co.amount, co.approved_on as "approvedOn",
             co.target_sov_line_id as "targetSovLineId", sl.description as "targetSovLineDescription",
             co.income_account_id as "incomeAccountId",
             co.created_by <> ${authz.user.id} as "independentApprovalAllowed"
        from change_orders co
        left join sov_lines sl on sl.id = co.target_sov_line_id and sl.org_id = co.org_id
       where co.org_id = ${orgId} and co.project_id = ${projectId} order by co.number
    `),
    db.execute(sql`
      select pa.id, pa.application_number as "applicationNumber", pa.period_end as "periodEnd", pa.kind,
             pa.status, pa.retainage_percent as "retainagePercent", pa.invoice_document_id as "invoiceDocumentId",
             d.document_number as "invoiceNumber", d.total as "invoiceTotal", d.status as "invoiceStatus",
             coalesce(pa.submitted_by, pa.created_by) <> ${authz.user.id} as "independentApprovalAllowed"
        from pay_applications pa
        left join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
       where pa.org_id = ${orgId} and pa.project_id = ${projectId} order by pa.application_number
    `),
    retainageAccountId
      ? db.execute<{ held: string }>(projectRetainageHeldSql(orgId, projectId, retainageAccountId))
      : Promise.resolve({ rows: [{ held: "0" }] }),
    projectCostSummary(orgId, projectId, authz.allowedSubsidiaryIds).catch(() => null),
  ]);

  const contractSum = sum(sov.rows.map((line) => String(line.scheduledValue ?? "0")));
  return NextResponse.json({
    sovLines: sov.rows,
    changeOrders: cos.rows,
    defaultIncomeAccountId: await defaultIncomeAccount,
    payApplications: apps.rows,
    contractSum,
    retainageHeld: String(held.rows[0]?.held ?? "0"),
    committedCost: committed?.committed?.cost ?? "0.0000",
    retainageConfigured: Boolean(retainageAccountId),
  });
}

/** Whole-digit width of a canonical decimal, for column-range guards. */
function wholeDigits(canonical: string): number {
  return canonical.replace(/^[+-]/, '').split('.')[0]!.replace(/^0+/, '').length
}

async function pinIncomeAccount(exec: SqlExecutor, orgId: string, accountId: unknown): Promise<string | null> {
  if (accountId == null || accountId === "") return null;
  const id = String(accountId);
  // A malformed id names no account: same answer as an unknown one, never
  // a PostgreSQL uuid cast error escaping as a 500.
  if (!isUuid(id)) throw new ConstructionBillingError("Income account not found");
  const owned = (await exec.execute(sql`
    select 1 from accounts
     where org_id = ${orgId} and id = ${id} and is_active and not is_summary
  `));
  if (!owned.rows.length) throw new ConstructionBillingError("Income account not found");
  return id;
}

/**
 * The org's project-revenue control account (F-t03-002 residual): the
 * project/type default income account for owner-change-order schedule
 * lines — the same default project billing falls back to
 * (web/lib/billing.ts `defaultIncomeId`). Validated like a pinned account;
 * null when unconfigured or retired, in which case the approval leaves the
 * line without an account exactly like a hand-added SOV line.
 */
async function projectDefaultIncomeAccount(exec: SqlExecutor, orgId: string): Promise<string | null> {
  const row = (await exec.execute(sql`
    select a.id
      from orgs o
      join accounts a
        on a.id = nullif(o.settings->'controlAccounts'->>'projectRevenue', '')::uuid
       and a.org_id = o.id
     where o.id = ${orgId} and a.is_active and not a.is_summary`)).rows[0] as { id: string } | undefined;
  return row?.id ?? null;
}

/**
 * The income account an approval carries onto its created SOV line: the
 * CO's pinned account, or the org default when the CO predates the column
 * or was saved without one. A stored account retired since creation cannot
 * be credited, and stranding the approval is worse than substituting the
 * current default — so a pin failure falls through to the default (which
 * itself validates, else null). Anything unexpected still throws.
 */
async function resolveCarriedIncomeAccount(tx: SqlExecutor, orgId: string, stored: string | null): Promise<string | null> {
  if (stored) {
    try {
      return await pinIncomeAccount(tx, orgId, stored);
    } catch (error) {
      if (!(error instanceof ConstructionBillingError)) throw error;
    }
  }
  return pinIncomeAccount(tx, orgId, await projectDefaultIncomeAccount(tx, orgId));
}

/** The project a request targets, with the subsidiary that scopes it. */
interface ProjectScope {
  projectId: string;
  subsidiaryId: string | null;
}

async function projectScope(orgId: string, projectId: unknown): Promise<ProjectScope | null> {
  if (typeof projectId !== "string" || !isUuid(projectId)) return null;
  const r = (await db.execute<{ id: string; subsidiary_id: string | null }>(
    sql`select id, subsidiary_id from projects where id = ${projectId} and org_id = ${orgId}`,
  ));
  const row = r.rows[0];
  return row ? { projectId: row.id, subsidiaryId: row.subsidiary_id } : null;
}

async function ownsProject(orgId: string, projectId: string): Promise<boolean> {
  return (await projectScope(orgId, projectId)) !== null;
}

/** Residual simultaneous-insert race against change_orders_project_number.
 * Drizzle wraps PostgreSQL errors, so inspect the full cause chain and only
 * claim the violation this route owns. */
function isDuplicateChangeOrderNumber(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { constraint?: unknown; message?: unknown; cause?: unknown };
    if (candidate.constraint === "change_orders_project_number") return true;
    if (typeof candidate.message === "string" && candidate.message.includes("change_orders_project_number")) return true;
    current = candidate.cause;
  }
  return false;
}

/**
 * Resolve the project an action touches — directly, or through the parent of
 * the child row it names — together with that project's subsidiary, so the
 * caller's scope is enforced before any engine work. Unknown ids, malformed
 * ids and cross-org rows all resolve to null (a missing record).
 */
async function actionProjectScope(orgId: string, action: string, body: Record<string, unknown>): Promise<ProjectScope | null> {
  if (["addSov", "addChangeOrder", "createPayApp", "releaseRetainage"].includes(action)) {
    return projectScope(orgId, body.projectId);
  }
  let query: SQL;
  const childId = ["submitPayApp", "approvePayApp", "voidPayApp", "billPayApp"].includes(action) ? body.payApplicationId : body.id;
  if (typeof childId !== "string" || !isUuid(childId)) return null;
  if (["updateSov", "deleteSov"].includes(action)) {
    query = sql`select p.id, p.subsidiary_id from sov_lines l join projects p on p.id = l.project_id and p.org_id = l.org_id
                 where l.id = ${childId} and l.org_id = ${orgId}`;
  } else if (["approveChangeOrder", "voidChangeOrder"].includes(action)) {
    query = sql`select p.id, p.subsidiary_id from change_orders co join projects p on p.id = co.project_id and p.org_id = co.org_id
                 where co.id = ${childId} and co.org_id = ${orgId}`;
  } else if (["submitPayApp", "approvePayApp", "voidPayApp", "billPayApp"].includes(action)) {
    query = sql`select p.id, p.subsidiary_id from pay_applications pa join projects p on p.id = pa.project_id and p.org_id = pa.org_id
                 where pa.id = ${childId} and pa.org_id = ${orgId}`;
  } else {
    return null;
  }
  const row = (await db.execute<{ id: string; subsidiary_id: string | null }>(query)).rows[0];
  return row ? { projectId: row.id, subsidiaryId: row.subsidiary_id } : null;
}

export async function POST(req: Request) {
  const parsedBody = await parseJsonBody(req, jsonObject);
  if (!parsedBody.ok) return parsedBody.response;
  // Project/pay-app ids below are pre-validated by actionProjectScope (garbage
  // 404s there), so the `as string` pins at the call sites only restate that.
  const body = parsedBody.data as {
    action?: string; projectId?: string; payApplicationId?: string;
    periodEnd?: string; id?: string; description?: string;
    scheduledValue?: unknown; number?: unknown; notes?: unknown;
    amount?: unknown; retainagePercent?: unknown; lines?: unknown;
    itemNo?: unknown; sortOrder?: unknown; targetSovLineId?: unknown;
    incomeAccountId?: unknown; approvedOn?: unknown;
  };
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
    const scope = await actionProjectScope(orgId, action, body);
    if (!scope) return NextResponse.json({ error: "not found" }, { status: 404 });
    // Out of the caller's subsidiary scope ⇒ indistinguishable from missing.
    const denied = guardSubsidiaryScope(authz, scope.subsidiaryId);
    if (denied) return denied;
    if (!(await supportsApplicationsForPayment(orgId, scope.projectId))) {
      return NextResponse.json({ error: "This project's billing profile does not use applications for payment" }, { status: 422 });
    }
  }

  try {
    switch (action) {
      case "addSov": {
        if (!(await ownsProject(orgId, body.projectId as string))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const description = String(body.description ?? "").trim();
        const scheduledRaw = canonicalDecimal(body.scheduledValue ?? "0", 4);
        if (scheduledRaw === null) throw new ConstructionBillingError("Scheduled value must be a number with no more than four decimal places");
        const scheduledValue = normalizeMoney(scheduledRaw);
        // scheduled_value is numeric(19,4): fifteen whole digits. The shape
        // check admits any magnitude, so a pasted 20-digit figure died in
        // the insert with a storage error.
        if (wholeDigits(scheduledValue) > 15) throw new ConstructionBillingError("Scheduled value is out of range — at most 15 whole digits fit the ledger");
        const retainageRaw = body.retainagePercent == null || body.retainagePercent === "" ? null : canonicalDecimal(body.retainagePercent, 4);
        if (body.retainagePercent != null && body.retainagePercent !== "" && retainageRaw === null) {
          throw new ConstructionBillingError("Retainage percent must be a number with no more than four decimal places");
        }
        const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
        if (!description || cmp(scheduledValue, "0") <= 0) throw new ConstructionBillingError("Description and a positive scheduled value are required");
        if (retainagePercent !== null && (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)) throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
        // sort_order is integer and unknown errors escape as a raw 500, so a
        // figure the column cannot hold fails closed here with a named 422.
        const sortOrder = body.sortOrder === undefined || body.sortOrder === null || body.sortOrder === '' ? 0 : Number(body.sortOrder)
        if (!Number.isInteger(sortOrder) || sortOrder > 2147483647 || sortOrder < -2147483648) throw new ConstructionBillingError("Sort order must be a whole number the schedule can store");
        const incomeAccountId = await pinIncomeAccount(db, orgId, body.incomeAccountId);
        const id = await db.transaction(async (tx) => {
          const prior = (await tx.execute(sql`select 1 from pay_applications where org_id = ${orgId} and project_id = ${body.projectId} limit 1`));
          if (prior.rows.length) throw new ConstructionBillingError("After billing begins, contract value must change through an approved change order");
          const created = (await tx.execute<{ id: string }>(sql`
            insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, retainage_percent,
                                   income_account_id, sort_order, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${body.itemNo ?? null}, ${description}, ${scheduledValue},
                    ${retainagePercent}, ${incomeAccountId}, ${sortOrder}, ${userId}, ${userId})
            returning id
          `));
          const createdId = created.rows[0]!.id;
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, itemNo: body.itemNo ?? null, description, scheduledValue, retainagePercent, incomeAccountId } })}::jsonb, ${userId})`);
          return createdId;
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case "updateSov": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute(sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`));
          if (!before.rows[0]) throw new ConstructionBillingError("Schedule line not found");
          const stored = before.rows[0];
          const used = (await tx.execute(sql`select 1 from pay_application_lines where org_id = ${orgId} and sov_line_id = ${body.id} limit 1`));
          const locked = used.rows.length > 0 || stored.change_order_id != null;
          const incomeAccountId = await pinIncomeAccount(tx, orgId, body.incomeAccountId);
          if (locked) {
            // Contract value stays controlled once billing begins, but the
            // income account is posting metadata, not a contract term, so a
            // locked line still accepts an income-account-only change (the
            // recovery path an approved application needs to reach invoicing).
            // Anything beyond the income account still goes through a change
            // order.
            const reqItemNo = body.itemNo == null || body.itemNo === "" ? null : String(body.itemNo);
            const storedItemNo = stored.item_no == null || stored.item_no === "" ? null : String(stored.item_no);
            const scheduledRaw = canonicalDecimal(body.scheduledValue ?? "0", 4);
            const retainageRaw = body.retainagePercent == null || body.retainagePercent === "" ? null : canonicalDecimal(body.retainagePercent, 4);
            const storedRetainage = stored.retainage_percent == null ? null : String(stored.retainage_percent);
            const onlyIncome =
              reqItemNo === storedItemNo &&
              String(body.description ?? "").trim() === String(stored.description ?? "") &&
              scheduledRaw !== null && cmp(normalizeMoney(scheduledRaw), String(stored.scheduled_value ?? "0")) === 0 &&
              (retainageRaw === null ? storedRetainage === null : storedRetainage !== null && cmp(normalizeMoney(retainageRaw), storedRetainage) === 0) &&
              !(body.retainagePercent != null && body.retainagePercent !== "" && retainageRaw === null);
            if (!onlyIncome) {
              throw new ConstructionBillingError(used.rows.length > 0
                ? "A schedule line used by an application is immutable; use a change order"
                : "A controlled schedule line is immutable; use a change order");
            }
            if ((incomeAccountId ?? null) !== (stored.income_account_id ?? null)) {
              await tx.execute(sql`
                update sov_lines set income_account_id = ${incomeAccountId}, updated_at = now(), updated_by = ${userId}
                 where id = ${body.id} and org_id = ${orgId}
              `);
              await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
                values (${orgId}, 'sov_lines', ${body.id}, 'income_account_update', ${JSON.stringify({ before: { incomeAccountId: stored.income_account_id }, after: { incomeAccountId: incomeAccountId } })}::jsonb, ${userId})`);
            }
          } else {
            const description = String(body.description ?? "").trim();
            const scheduledRaw = canonicalDecimal(body.scheduledValue ?? "0", 4);
            if (scheduledRaw === null) throw new ConstructionBillingError("Scheduled value must be a number with no more than four decimal places");
            const scheduledValue = normalizeMoney(scheduledRaw);
            if (wholeDigits(scheduledValue) > 15) throw new ConstructionBillingError("Scheduled value is out of range — at most 15 whole digits fit the ledger");
            const retainageRaw = body.retainagePercent == null || body.retainagePercent === "" ? null : canonicalDecimal(body.retainagePercent, 4);
            if (body.retainagePercent != null && body.retainagePercent !== "" && retainageRaw === null) {
              throw new ConstructionBillingError("Retainage percent must be a number with no more than four decimal places");
            }
            const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
            if (!description || cmp(scheduledValue, "0") <= 0) throw new ConstructionBillingError("Description and a positive scheduled value are required");
            if (retainagePercent !== null && (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)) throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
            const after = (await tx.execute(sql`
              update sov_lines set item_no = ${body.itemNo ?? null}, description = ${description}, scheduled_value = ${scheduledValue},
                     retainage_percent = ${retainagePercent}, income_account_id = ${incomeAccountId}, updated_at = now(), updated_by = ${userId}
               where id = ${body.id} and org_id = ${orgId} returning *
            `));
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${body.id}, 'update', ${JSON.stringify({ before: before.rows[0], after: after.rows[0] })}::jsonb, ${userId})`);
          }
        });
        return NextResponse.json({ ok: true });
      }
      case "deleteSov": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute(sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`));
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
        if (!(await ownsProject(orgId, body.projectId as string))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const number = String(body.number ?? "").trim();
        const amountRaw = canonicalDecimal(body.amount ?? "0", 4);
        if (amountRaw === null) return NextResponse.json({ error: "invalid amount" }, { status: 422 });
        const amount = normalizeMoney(amountRaw);
        // change_orders.amount is numeric(19,4): same bound, same refusal.
        if (wholeDigits(amount) > 15) return NextResponse.json({ error: "invalid amount" }, { status: 422 });
        const targetSovLineId = typeof body.targetSovLineId === "string" && body.targetSovLineId ? body.targetSovLineId : null;
        if (targetSovLineId && !isUuid(targetSovLineId)) {
          throw new ConstructionBillingError("The target schedule line id must be a valid UUID");
        }
        // The income account the approval lands on the created SOV line
        // (F-t03-002 residual). Targeted orders reprice the line's own
        // account, so the writer only reads this for untargeted ones;
        // pinned like a hand-added SOV line either way.
        const incomeAccountId = await pinIncomeAccount(db, orgId, body.incomeAccountId);
        if (!number || cmp(amount, "0") === 0) throw new ConstructionBillingError("Change-order number and a non-zero amount are required");
        if (cmp(amount, "0") < 0 && !targetSovLineId) throw new ConstructionBillingError("A deductive change order must identify the schedule line it reduces");
        const id = await db.transaction(async (tx) => {
          // Numbers are unique per project in storage: fail closed with the
          // domain error here so a double submit or retry never escapes as
          // a unique violation (the route maps the residual race below).
          const duplicate = (await tx.execute(sql`
            select 1 from change_orders
             where org_id = ${orgId} and project_id = ${body.projectId} and number = ${number}
             limit 1
          `));
          if (duplicate.rows.length) throw new ConstructionBillingError("A change order with this number already exists for this project");
          if (targetSovLineId) {
            const target = (await tx.execute(sql`
              select 1 from sov_lines
               where id = ${targetSovLineId} and org_id = ${orgId} and project_id = ${body.projectId}
            `));
            if (!target.rows.length) throw new ConstructionBillingError("The target schedule line does not belong to this project");
          }
          const created = (await tx.execute<{ id: string }>(sql`
            insert into change_orders (org_id, project_id, number, description, amount, target_sov_line_id, income_account_id, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${number}, ${body.description ?? null}, ${amount}, ${targetSovLineId}, ${incomeAccountId}, ${userId}, ${userId}) returning id
          `));
          const createdId = created.rows[0]!.id;
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, number, description: body.description ?? null, amount, targetSovLineId, incomeAccountId, status: "draft" } })}::jsonb, ${userId})`);
          return createdId;
        });
        return NextResponse.json({ id }, { status: 201 });
      }
      case "approveChangeOrder": {
        // Approving a change order also lands its value as a new SOV line so the
        // contract sum and future draws reflect it. An omitted approval date is
        // the business day; a supplied one must be a real calendar day.
        const approvedOn = body.approvedOn == null || body.approvedOn === ""
          ? await businessToday(orgId)
          : requireIsoDate(body.approvedOn, "Approval date");
        await db.transaction(async (tx) => {
          const co = (await tx.execute<{ project_id: string; number: string; description: string | null; amount: string; target_sov_line_id: string | null; income_account_id: string | null; created_by: string | null }>(sql`
            select project_id, number, description, amount, target_sov_line_id, income_account_id, created_by from change_orders
             where id = ${body.id} and org_id = ${orgId} and status = 'draft' for update
          `));
          const row = co.rows[0];
          if (!row) throw new ConstructionBillingError("Change order not found or no longer draft");
          if (row.created_by === userId) throw new ConstructionBillingError("The preparer cannot approve the same change order");
          // Contract value is the fixed-price ceiling behind Financials total
          // price, revenue recognition's total transaction price, and the
          // cockpit's earned view, so approval moves it by the change order's
          // signed amount in this same transaction.
          const project = (await tx.execute<{ contract_value: string | null }>(sql`
            select contract_value from projects where id = ${row.project_id} and org_id = ${orgId} for update
          `));
          const effectRaw = canonicalDecimal(String(row.amount), 4);
          if (effectRaw === null) {
            throw new ConstructionBillingError("Change-order amount must be a number with no more than four decimal places");
          }
          let effect: string;
          try {
            effect = normalizeMoney(effectRaw);
          } catch {
            throw new ConstructionBillingError("Change-order amount must be a number with no more than four decimal places");
          }
          const contractValueBefore = project.rows[0]?.contract_value ?? null;
          const contractValueAfter = add(contractValueBefore ?? "0", effect);
          if (cmp(contractValueAfter, "0") < 0) {
            throw new ConstructionBillingError("Approving this change order would drive the contract value below zero");
          }
          await tx.execute(sql`
            update projects set contract_value = ${contractValueAfter}, updated_at = now(), updated_by = ${userId}
             where id = ${row.project_id} and org_id = ${orgId}
          `);
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'projects', ${row.project_id}, 'contract_value_adjustment',
                    ${JSON.stringify({ changeOrderId: body.id, before: { contractValue: contractValueBefore }, after: { contractValue: contractValueAfter } })}::jsonb,
                    ${userId})`);
          const activeApplication = (await tx.execute(sql`
            select 1 from pay_applications where org_id = ${orgId} and project_id = ${row.project_id}
             and status in ('draft', 'submitted', 'approved') limit 1
          `));
          if (activeApplication.rows.length) throw new ConstructionBillingError("Complete or void the current application before approving a change order");
          await tx.execute(sql`
            update change_orders set status = 'approved', approved_on = ${approvedOn},
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
              select coalesce(sum(pal.this_period_completed + pal.materials_stored - pal.previous_materials_stored), 0) as amount
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
              update sov_lines set scheduled_value = ${revisedValue}, change_order_id = ${body.id}, updated_at = now(), updated_by = ${userId}
               where id = ${row.target_sov_line_id} and org_id = ${orgId}
            `);
            sovLineId = row.target_sov_line_id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${sovLineId}, 'change_order_adjustment',
                      ${JSON.stringify({ changeOrderId: body.id, before: { scheduledValue: target.rows[0].scheduled_value }, after: { scheduledValue: revisedValue } })}::jsonb,
                      ${userId})`);
          } else {
            if (cmp(effect, "0") <= 0) throw new ConstructionBillingError("An unallocated change order must be additive");
            // Carry the pinned account (or the org default for COs saved
            // without one) so the line bills without a manual edit.
            const carriedIncomeAccountId = await resolveCarriedIncomeAccount(tx, orgId, row.income_account_id ?? null);
            const sov = (await tx.execute<{ id: string }>(sql`
              insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, change_order_id, income_account_id,
                                     sort_order, created_by, updated_by)
              values (${orgId}, ${row.project_id}, ${"CO-" + row.number}, ${row.description ?? "Change order " + row.number},
                      ${effect}, ${body.id}, ${carriedIncomeAccountId},
                      (select coalesce(max(sort_order), 0) + 1 from sov_lines where org_id = ${orgId} and project_id = ${row.project_id}),
                      ${userId}, ${userId})
              returning id
            `));
            sovLineId = sov.rows[0]!.id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${sovLineId}, 'insert',
                      jsonb_build_object('source', 'approved_change_order', 'changeOrderId', ${body.id}::text,
                        'after', jsonb_build_object('projectId', ${row.project_id}::text, 'scheduledValue', ${String(row.amount)}::text,
                          'incomeAccountId', ${carriedIncomeAccountId}::text)),
                      ${userId})`);
          }
          await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${body.id}, 'approve',
                    jsonb_build_object('before', jsonb_build_object('status', 'draft'), 'after',
                      jsonb_build_object('status', 'approved', 'approvedOn', ${approvedOn}::text, 'sovLineId', ${sovLineId}::text)),
                    ${userId})`);
        });
        return NextResponse.json({ ok: true });
      }
      case "voidChangeOrder": {
        await db.transaction(async (tx) => {
          const before = (await tx.execute(sql`
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
        if (!(await ownsProject(orgId, body.projectId as string))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const retainageRaw = canonicalDecimal(body.retainagePercent ?? "10", 4);
        if (retainageRaw === null) throw new ConstructionBillingError("Retainage percent must be a number with no more than four decimal places");
        const r = await createPayApplication(orgId, userId, body.projectId as string, body.periodEnd as string, normalizeMoney(retainageRaw));
        return NextResponse.json(r, { status: 201 });
      }
      case "submitPayApp": {
        const lines = [];
        if (Array.isArray(body.lines)) {
          for (const line of body.lines as Array<Record<string, unknown>>) {
            // Draw-entry inputs arrive as strings; an untouched cell submits
            // "" (and untouched rows are omitted), so a blank draw reads as
            // zero instead of failing the decimal parse.
            const blankToZero = (v: unknown) => (typeof v === "string" && v.trim() === "" ? "0" : (v ?? "0"));
            const thisPeriod = canonicalDecimal(blankToZero(line.thisPeriodCompleted), 4);
            const stored = canonicalDecimal(blankToZero(line.materialsStored), 4);
            if (thisPeriod === null || stored === null) {
              throw new ConstructionBillingError("Draw amounts must be numbers with no more than four decimal places");
            }
            lines.push({
              sovLineId: String(line.sovLineId ?? ""),
              thisPeriodCompleted: normalizeMoney(thisPeriod),
              materialsStored: normalizeMoney(stored),
            });
          }
        }
        const result = await submitPayApplication(orgId, userId, body.payApplicationId as string, lines);
        return NextResponse.json(result);
      }
      case "approvePayApp": {
        await approvePayApplication(orgId, userId, body.payApplicationId as string);
        return NextResponse.json({ ok: true });
      }
      case "voidPayApp": {
        await voidPayApplication(orgId, userId, body.payApplicationId as string);
        return NextResponse.json({ ok: true });
      }
      case "billPayApp": {
        const r = await generatePayApplicationInvoice(orgId, userId, body.payApplicationId as string);
        return NextResponse.json(r);
      }
      case "releaseRetainage": {
        if (!(await ownsProject(orgId, body.projectId as string))) return NextResponse.json({ error: "not found" }, { status: 404 });
        const amountRaw = canonicalDecimal(body.amount ?? "0", 4);
        if (amountRaw === null) return NextResponse.json({ error: "invalid amount" }, { status: 422 });
        const r = await releaseRetainage(orgId, userId, body.projectId as string, body.periodEnd as string, normalizeMoney(amountRaw));
        return NextResponse.json(r);
      }
      default:
        return NextResponse.json({ error: "unknown action" }, { status: 400 });
    }
  } catch (e) {
    if (e instanceof ConstructionBillingError) return NextResponse.json({ error: e.message }, { status: 422 });
    // Residual simultaneous-insert race against change_orders_project_number:
    // the pre-check above already answered, so report its verdict.
    if (isDuplicateChangeOrderNumber(e)) {
      return NextResponse.json({ error: "A change order with this number already exists for this project" }, { status: 409 });
    }
    throw e;
  }
}
