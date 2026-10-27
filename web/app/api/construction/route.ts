import { submitCustomerChangeOrder } from "@openbooks/engine/projects/construction-billing";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db, type SqlExecutor } from "@openbooks/engine/platform/db";
import {
  ConstructionBillingError,
  assertProjectIncomeAccountUsable,
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  projectRetainageHeldSql,
  projectDefaultIncomeAccount,
  releaseRetainage,
  requireIsoDate,
  submitPayApplication,
  voidPayApplication,
} from "@openbooks/engine/projects/construction-billing";
import { projectBillingHasBegun } from "@openbooks/engine/projects/header-controls";
import {
  ScopeNotFoundError,
  lockProjectForScope,
  withScopeSnapshot,
} from "@openbooks/engine/organization/scope";
import { can, guardSubsidiaryScope } from "../../../lib/authz";
import { isUuid } from "../../../lib/list-params";
import { projectCostSummary } from "../../../lib/project-costing";
import { cmp, normalizeMoney, sum, wholeDigits } from "@openbooks/engine/money";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { moneyRefusal, suppliedValue } from "../../../lib/payroll-decimal-refusal";
import { guardProjectsFeature } from "../../../lib/projects-gate";
import { acquireFeatureGateLock } from "../../../lib/features";
import { lockAndCheckOrgFeature } from "@openbooks/engine/organization/org-feature-lock";
import { supportsApplicationsForPayment } from "../../../lib/project-billing-procedure";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isoDate } from "../../../lib/api/json";
import { notFound } from "@/lib/api/responses";

const projectId = uuidString("projectId must be a valid UUID");
// Child row ids resolve through actionProjectScope, where a malformed id and
// an unknown one answer the same not-found record.
const rowId = z.string();
const payApplicationId = uuidString("payApplicationId must be a valid UUID");
const optionalAccountId = z
  .union([uuidString("Income account must be a valid identifier"), z.null()])
  .optional();

function moneyField(field: string) {
  return z
    .string({ error: `${field} must be sent as decimal text` })
    .superRefine((value, context) => {
      const parsed = canonicalDecimal(value, 4);
      if (parsed === null || wholeDigits(parsed) > 15) {
        context.addIssue({
          code: "custom",
          message: moneyRefusal(field, value),
        });
      }
    })
    .transform((value) => normalizeMoney(canonicalDecimal(value, 4)!));
}

const optionalRetainage = z
  .union([z.literal(""), moneyField("Retainage percent")])
  .nullable()
  .optional();
const nonEmptyDescription = z.string().trim().min(1, "description is required");
const itemNo = z.string().trim().max(80).nullable().optional();
const sortOrder = z
  .union([
    z.number().refine(Number.isInteger, "sortOrder must be a whole number"),
    z
      .string()
      .regex(/^-?\d+$/, "sortOrder must be a whole number")
      .transform(Number),
  ])
  .refine(
    (value) => value >= -2147483648 && value <= 2147483647,
    "sortOrder must fit a 32-bit integer",
  )
  .optional();
const payApplicationLine = z.strictObject({
  sovLineId: uuidString("sovLineId must be a valid UUID"),
  thisPeriodCompleted: z
    .union([z.literal(""), moneyField("Completed this period")])
    .nullable()
    .optional(),
  materialsStored: z
    .union([z.literal(""), moneyField("Materials stored")])
    .nullable()
    .optional(),
});

// A schedule-line update is either an income-account-only change (the
// recovery path for a line billing has locked) or a full line edit. One
// action member covers both so a refused field is named, rather than
// reported as a generic mismatch of two alternative shapes.
const sovContractFields = ["description", "scheduledValue", "retainagePercent", "itemNo"] as const;
const updateSovBody = z
  .strictObject({
    action: z.literal("updateSov"),
    id: rowId,
    description: nonEmptyDescription.optional(),
    scheduledValue: moneyField("Scheduled value").optional(),
    retainagePercent: optionalRetainage,
    itemNo,
    incomeAccountId: optionalAccountId,
  })
  .superRefine((value, context) => {
    const lineEdit = sovContractFields.some((field) => value[field] !== undefined);
    if (!lineEdit && value.incomeAccountId !== undefined) return;
    if (value.description === undefined) {
      context.addIssue({
        code: "custom",
        path: ["description"],
        message: "description is required",
      });
    }
    if (value.scheduledValue === undefined) {
      context.addIssue({
        code: "custom",
        path: ["scheduledValue"],
        message: "Scheduled value must be sent as decimal text",
      });
    }
  });

const postBodySchema0 = z.discriminatedUnion("action", [
  z.strictObject({
    action: z.literal("addSov"),
    projectId,
    description: nonEmptyDescription,
    scheduledValue: moneyField("Scheduled value"),
    retainagePercent: optionalRetainage,
    itemNo,
    sortOrder,
    incomeAccountId: optionalAccountId,
  }),
  z.strictObject({ action: z.literal("deleteSov"), id: rowId }),
  z.strictObject({
    action: z.literal("addChangeOrder"),
    projectId,
    number: z.string().trim().min(1, "number is required").max(80),
    description: z.string().trim().max(2000).nullable().optional(),
    amount: moneyField("Change-order amount"),
    targetSovLineId: uuidString("The target schedule line must be a valid identifier")
      .nullable()
      .optional(),
    incomeAccountId: optionalAccountId,
  }),
  z.strictObject({
    action: z.literal("approveChangeOrder"),
    id: rowId,
    approvedOn: z
      .union([isoDate("approvedOn must be a valid calendar date"), z.literal(""), z.null()])
      .optional(),
  }),
  z.strictObject({ action: z.literal("voidChangeOrder"), id: rowId }),
  z.strictObject({
    action: z.literal("createPayApp"),
    projectId,
    periodEnd: isoDate("periodEnd must be a valid calendar date"),
    retainagePercent: moneyField("Retainage percent").optional(),
  }),
  z.strictObject({
    action: z.literal("submitPayApp"),
    payApplicationId,
    lines: z.array(payApplicationLine).max(1000).optional(),
  }),
  z.strictObject({ action: z.literal("approvePayApp"), payApplicationId }),
  z.strictObject({ action: z.literal("voidPayApp"), payApplicationId }),
  z.strictObject({ action: z.literal("billPayApp"), payApplicationId }),
  z.strictObject({
    action: z.literal("releaseRetainage"),
    projectId,
    periodEnd: isoDate("periodEnd must be a valid calendar date"),
    amount: moneyField("Release amount"),
  }),
  updateSovBody,
]);

export const runtime = "nodejs";

/**
 * Construction progress billing API for one project. GET ?projectId returns the
 * schedule of values, change orders, applications for payment, contract sum,
 * GL-backed retainage held, and committed cost. POST is action-dispatched.
 */
export const GET = defineRoute({
  permission: "ar.read",
  feature: "projects",
  handler: async ({ request: req, authz }) => {
    const url = new URL(req.url);
    const projectId = url.searchParams.get("projectId");
    if (!projectId) return NextResponse.json({ error: "projectId required" }, { status: 400 });
    const orgId = authz.user.orgId;
    // A project outside the caller's subsidiary scope is a missing project.
    const scope = await projectScope(orgId, projectId);
    if (!scope) return notFound("record");
    const denied = guardSubsidiaryScope(authz, scope.subsidiaryId);
    if (denied) return denied;
    if (!(await supportsApplicationsForPayment(orgId, projectId))) {
      return NextResponse.json(
        {
          error: "This project's billing profile does not use applications for payment",
        },
        { status: 422 },
      );
    }

    // Committed cost opens its own repeatable-read snapshot on the pool (its
    // fan-out issues concurrent queries, which a single snapshot connection
    // cannot serve), so resolve it before pinning the page snapshot below. It
    // is already scope-filtered, and the locked recheck gates the response: a
    // rehome landing anywhere around this read still ends in a uniform 404.
    // A failed cost summary must fail the request, never render as a fake
    // zero committed cost beside real contract figures.
    const committed = await projectCostSummary(orgId, projectId, authz.allowedSubsidiaryIds);

    // The page reads run in ONE repeatable-read snapshot with the project
    // locked for share and the scope rechecked under that lock, so a
    // concurrent A→B rehome cannot move the project between two reads of one
    // response and disclose B's financials. Reads run sequentially: the
    // snapshot holds a single connection, which cannot serve concurrent
    // queries. A rehomed-out project answers like a missing one.
    try {
      return await withScopeSnapshot(orgId, async () => {
        await lockProjectForScope(db, orgId, projectId, authz.allowedSubsidiaryIds, "share");
        const retAcct = await db.execute<{ acct: string | null }>(
          sql`
        select a.id as acct
          from orgs o
          join accounts a on a.id = nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')::uuid
                         and a.org_id = o.id
         where o.id = ${orgId}
      `,
          "objects",
        );
        const retainageAccountId = retAcct[0]?.acct ?? null;

        // The org project-revenue default backing the CO income picker,
        // resolved alongside the page reads, not inside a write tx.
        const defaultIncomeAccount = await projectDefaultIncomeAccount(db, orgId);
        const sov = await db.execute(
          sql`
        select l.id, l.item_no as "itemNo", l.description, l.scheduled_value as "scheduledValue",
               l.retainage_percent as "retainagePercent", l.income_account_id as "incomeAccountId",
               l.sort_order as "sortOrder", l.change_order_id as "changeOrderId",
               exists(select 1 from pay_application_lines pal
                 join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
                where pal.org_id = ${orgId} and pal.sov_line_id = l.id and pa.status <> 'void') as "usedByApplication"
          from sov_lines l where l.org_id = ${orgId} and l.project_id = ${projectId} order by l.sort_order
      `,
          "objects",
        );
        const cos = await db.execute(
          sql`
        select co.id, co.number, co.description, co.status, co.amount, co.approved_on as "approvedOn",
               co.target_sov_line_id as "targetSovLineId", sl.description as "targetSovLineDescription",
               co.income_account_id as "incomeAccountId"
          from change_orders co
          left join sov_lines sl on sl.id = co.target_sov_line_id and sl.org_id = co.org_id
         where co.org_id = ${orgId} and co.project_id = ${projectId} order by co.number
      `,
          "objects",
        );
        const apps = await db.execute(
          sql`
        select pa.id, pa.application_number as "applicationNumber", pa.period_end as "periodEnd", pa.kind,
               pa.status, pa.retainage_percent as "retainagePercent", pa.invoice_document_id as "invoiceDocumentId",
               d.document_number as "invoiceNumber", d.total as "invoiceTotal", d.status as "invoiceStatus"
          from pay_applications pa
          left join documents d on d.id = pa.invoice_document_id and d.org_id = pa.org_id
         where pa.org_id = ${orgId} and pa.project_id = ${projectId} order by pa.application_number
      `,
          "objects",
        );
        const held = retainageAccountId
          ? await db.execute<{ held: string }>(
              projectRetainageHeldSql(orgId, projectId, retainageAccountId),
              "objects",
            )
          : [{ held: "0" }];

        const contractSum = sum(sov.map((line) => String(line.scheduledValue ?? "0")));
        return NextResponse.json({
          sovLines: sov,
          changeOrders: cos,
          defaultIncomeAccountId: defaultIncomeAccount,
          payApplications: apps,
          contractSum,
          retainageHeld: String(held[0]?.held ?? "0"),
          committedCost: committed.committed.cost,
          retainageConfigured: Boolean(retainageAccountId),
        });
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      throw error;
    }
  },
});

async function pinIncomeAccount(
  exec: SqlExecutor,
  orgId: string,
  accountId: unknown,
  projectSubsidiaryId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<string | null> {
  if (accountId == null || accountId === "") return null;
  const id = String(accountId);
  // A malformed id names no account: same answer as an unknown one, never
  // a PostgreSQL uuid cast error escaping as a 500.
  if (!isUuid(id)) throw new ConstructionBillingError("Income account not found");
  return (
    await assertProjectIncomeAccountUsable(
      exec,
      orgId,
      id,
      projectSubsidiaryId,
      allowedSubsidiaryIds,
    )
  ).id;
}

/** The project a request targets, with the subsidiary that scopes it. */
interface ProjectScope {
  projectId: string;
  subsidiaryId: string | null;
}

async function projectScope(orgId: string, projectId: unknown): Promise<ProjectScope | null> {
  if (typeof projectId !== "string" || !isUuid(projectId)) return null;
  const r = await db.execute<{ id: string; subsidiary_id: string | null }>(
    sql`select id, subsidiary_id from projects where id = ${projectId} and org_id = ${orgId}`,
    "objects",
  );
  const row = r[0];
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
    const candidate = current as {
      constraint?: unknown;
      message?: unknown;
      cause?: unknown;
    };
    if (candidate.constraint === "change_orders_project_number") return true;
    if (
      typeof candidate.message === "string" &&
      candidate.message.includes("change_orders_project_number")
    )
      return true;
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
async function actionProjectScope(
  orgId: string,
  action: string,
  body: Record<string, unknown>,
): Promise<ProjectScope | null> {
  if (["addSov", "addChangeOrder", "createPayApp", "releaseRetainage"].includes(action)) {
    return projectScope(orgId, body.projectId);
  }
  let query: SQL;
  const childId = ["submitPayApp", "approvePayApp", "voidPayApp", "billPayApp"].includes(action)
    ? body.payApplicationId
    : body.id;
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
  const row = (await db.execute<{ id: string; subsidiary_id: string | null }>(query, "objects"))[0];
  return row ? { projectId: row.id, subsidiaryId: row.subsidiary_id } : null;
}

export const POST = defineRoute({
  public: "session",
  body: postBodySchema0,
  invalidBodyStatus: 422,
  handler: async ({ authz, body: routeBody }) => {
    // Project/pay-app ids below are pre-validated by actionProjectScope (garbage
    // 404s there), so the `as string` pins at the call sites only restate that.
    const body = routeBody as {
      action?: string;
      projectId?: string;
      payApplicationId?: string;
      periodEnd?: string;
      id?: string;
      description?: string;
      scheduledValue?: unknown;
      number?: unknown;
      notes?: unknown;
      amount?: unknown;
      retainagePercent?: unknown;
      lines?: unknown;
      itemNo?: unknown;
      sortOrder?: unknown;
      targetSovLineId?: unknown;
      incomeAccountId?: unknown;
      approvedOn?: unknown;
    };
    const action = body.action as string;
    const permission =
      action === "voidPayApp"
        ? "ar.approve"
        : action === "billPayApp" || action === "releaseRetainage"
          ? "ar.post"
          : "ar.create";
    if (!can(authz, permission)) {
      return NextResponse.json({ error: `missing permission: ${permission}` }, { status: 403 });
    }

    const orgId = authz.user.orgId;
    const feature = await guardProjectsFeature(orgId);
    if (feature) return feature;
    const userId = authz.user.id;
    const projectActions = new Set([
      "addSov",
      "updateSov",
      "deleteSov",
      "addChangeOrder",
      "approveChangeOrder",
      "voidChangeOrder",
      "createPayApp",
      "submitPayApp",
      "approvePayApp",
      "voidPayApp",
      "billPayApp",
      "releaseRetainage",
    ]);
    // The entry scope resolution, rechecked under the project lock inside every
    // write transaction below (the child→project link never moves, so this id
    // stays the right row to lock even if the entry read races a rehome).
    let scope: ProjectScope | null = null;
    if (projectActions.has(action)) {
      const resolved = await actionProjectScope(orgId, action, body);
      if (!resolved) return notFound("record");
      // Out of the caller's subsidiary scope ⇒ indistinguishable from missing.
      const denied = guardSubsidiaryScope(authz, resolved.subsidiaryId);
      if (denied) return denied;
      if (!(await supportsApplicationsForPayment(orgId, resolved.projectId))) {
        return NextResponse.json(
          {
            error: "This project's billing profile does not use applications for payment",
          },
          { status: 422 },
        );
      }
      scope = resolved;
    }
    // Recheck the entry scope under the project row lock inside a write
    // transaction. The child→project link never moves, so the entry project's
    // id stays the right row to lock; a null here (non-project actions) fails
    // closed like a missing project.
    const lockEntryProject = (
      tx: SqlExecutor,
    ): Promise<{ id: string; subsidiaryId: string | null }> => {
      if (!scope) throw new ScopeNotFoundError();
      return lockProjectForScope(tx, orgId, scope.projectId, authz.allowedSubsidiaryIds);
    };

    try {
      switch (action) {
        case "addSov": {
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const description = String(body.description ?? "").trim();
          const scheduledRaw = canonicalDecimal(body.scheduledValue ?? "0", 4);
          if (scheduledRaw === null)
            throw new ConstructionBillingError(
              moneyRefusal("Scheduled value", body.scheduledValue ?? "0"),
            );
          const scheduledValue = normalizeMoney(scheduledRaw);
          // scheduled_value is numeric(19,4): fifteen whole digits. The shape
          // check admits any magnitude, so a pasted 20-digit figure died in
          // the insert with a storage error.
          if (wholeDigits(scheduledValue) > 15)
            throw new ConstructionBillingError(
              "Scheduled value is out of range — at most 15 whole digits fit the ledger",
            );
          const retainageRaw =
            body.retainagePercent == null || body.retainagePercent === ""
              ? null
              : canonicalDecimal(body.retainagePercent, 4);
          if (
            body.retainagePercent != null &&
            body.retainagePercent !== "" &&
            retainageRaw === null
          ) {
            throw new ConstructionBillingError(
              moneyRefusal("Retainage percent", body.retainagePercent, "a percent"),
            );
          }
          const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
          if (!description || cmp(scheduledValue, "0") <= 0)
            throw new ConstructionBillingError(
              "Description and a positive scheduled value are required",
            );
          if (
            retainagePercent !== null &&
            (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)
          )
            throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
          // sort_order is integer and unknown errors escape as a raw 500, so a
          // figure the column cannot hold fails closed here with a named 422.
          const sortOrder =
            body.sortOrder === undefined || body.sortOrder === null || body.sortOrder === ""
              ? 0
              : Number(body.sortOrder);
          if (!Number.isInteger(sortOrder) || sortOrder > 2147483647 || sortOrder < -2147483648)
            throw new ConstructionBillingError(
              "Sort order must be a whole number the schedule can store",
            );
          const id = await db.transaction(async (tx) => {
            // Fenced recheck inside the write transaction: the entry guard
            // above may be stale by the time this write lands, and a Projects
            // disable racing this insert must refuse one side or the other.
            await acquireFeatureGateLock(orgId, tx);
            if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) {
              throw new ConstructionBillingError("Projects feature is disabled");
            }
            // The entry scope check is unlocked: recheck under the project
            // lock, so a rehome racing this insert refuses instead of
            // billing B's project. Missing and out-of-scope share one 404.
            const lockedProject = await lockEntryProject(tx);
            const incomeAccountId = await pinIncomeAccount(
              tx,
              orgId,
              body.incomeAccountId,
              lockedProject.subsidiaryId,
              authz.allowedSubsidiaryIds,
            );
            // The same billing-has-begun predicate the project header edit
            // enforces for contract value: one rule, one owner.
            if (await projectBillingHasBegun(tx, orgId, body.projectId as string))
              throw new ConstructionBillingError(
                "After billing begins, contract value must change through an approved change order",
              );
            const created = await tx.execute<{ id: string }>(
              sql`
            insert into sov_lines (org_id, project_id, item_no, description, scheduled_value, retainage_percent,
                                   income_account_id, sort_order, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${body.itemNo ?? null}, ${description}, ${scheduledValue},
                    ${retainagePercent}, ${incomeAccountId}, ${sortOrder}, ${userId}, ${userId})
            returning id
          `,
              "objects",
            );
            const createdId = created[0]!.id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, itemNo: body.itemNo ?? null, description, scheduledValue, retainagePercent, incomeAccountId } })}::jsonb, ${userId})`);
            return createdId;
          });
          return NextResponse.json({ id }, { status: 201 });
        }
        case "updateSov": {
          await db.transaction(async (tx) => {
            // Lock the project before its lines: the entry check is unlocked,
            // and a rehome racing this update must refuse before any line
            // moves. The child→project link never moves, so the entry
            // project's id stays the right row to lock.
            const lockedProject = await lockEntryProject(tx);
            const before = await tx.execute(
              sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`,
              "objects",
            );
            if (!before[0]) throw new ConstructionBillingError("Schedule line not found");
            const stored = before[0];
            const used = await tx.execute(
              sql`select 1 from pay_application_lines pal
                    join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
                   where pal.org_id = ${orgId} and pal.sov_line_id = ${body.id} and pa.status <> 'void' limit 1`,
              "objects",
            );
            const locked = used.length > 0 || stored.change_order_id != null;
            const incomeAccountId = await pinIncomeAccount(
              tx,
              orgId,
              body.incomeAccountId,
              lockedProject.subsidiaryId,
              authz.allowedSubsidiaryIds,
            );
            if (locked) {
              // Contract value stays controlled once billing begins, but the
              // income account is posting metadata, not a contract term, so a
              // locked line still accepts an income-account-only change (the
              // recovery path an approved application needs to reach invoicing).
              // Anything beyond the income account still goes through a change
              // order.
              const reqItemNo =
                body.itemNo == null || body.itemNo === "" ? null : String(body.itemNo);
              const storedItemNo =
                stored.item_no == null || stored.item_no === "" ? null : String(stored.item_no);
              const scheduledRaw = canonicalDecimal(body.scheduledValue ?? "0", 4);
              const retainageRaw =
                body.retainagePercent == null || body.retainagePercent === ""
                  ? null
                  : canonicalDecimal(body.retainagePercent, 4);
              const storedRetainage =
                stored.retainage_percent == null ? null : String(stored.retainage_percent);
              const onlyIncome =
                reqItemNo === storedItemNo &&
                String(body.description ?? "").trim() === String(stored.description ?? "") &&
                scheduledRaw !== null &&
                cmp(normalizeMoney(scheduledRaw), String(stored.scheduled_value ?? "0")) === 0 &&
                (retainageRaw === null
                  ? storedRetainage === null
                  : storedRetainage !== null &&
                    cmp(normalizeMoney(retainageRaw), storedRetainage) === 0) &&
                !(
                  body.retainagePercent != null &&
                  body.retainagePercent !== "" &&
                  retainageRaw === null
                );
              if (!onlyIncome) {
                throw new ConstructionBillingError(
                  used.length > 0
                    ? "A schedule line used by an application is immutable; use a change order"
                    : "A controlled schedule line is immutable; use a change order",
                );
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
              if (scheduledRaw === null)
                throw new ConstructionBillingError(
                  moneyRefusal("Scheduled value", body.scheduledValue ?? "0"),
                );
              const scheduledValue = normalizeMoney(scheduledRaw);
              if (wholeDigits(scheduledValue) > 15)
                throw new ConstructionBillingError(
                  "Scheduled value is out of range — at most 15 whole digits fit the ledger",
                );
              const retainageRaw =
                body.retainagePercent == null || body.retainagePercent === ""
                  ? null
                  : canonicalDecimal(body.retainagePercent, 4);
              if (
                body.retainagePercent != null &&
                body.retainagePercent !== "" &&
                retainageRaw === null
              ) {
                throw new ConstructionBillingError(
                  moneyRefusal("Retainage percent", body.retainagePercent, "a percent"),
                );
              }
              const retainagePercent = retainageRaw === null ? null : normalizeMoney(retainageRaw);
              if (!description || cmp(scheduledValue, "0") <= 0)
                throw new ConstructionBillingError(
                  "Description and a positive scheduled value are required",
                );
              if (
                retainagePercent !== null &&
                (cmp(retainagePercent, "0") < 0 || cmp(retainagePercent, "100") > 0)
              )
                throw new ConstructionBillingError("Retainage percent must be between 0 and 100");
              const after = await tx.execute(
                sql`
              update sov_lines set item_no = ${body.itemNo ?? null}, description = ${description}, scheduled_value = ${scheduledValue},
                     retainage_percent = ${retainagePercent}, income_account_id = ${incomeAccountId}, updated_at = now(), updated_by = ${userId}
               where id = ${body.id} and org_id = ${orgId} returning *
            `,
                "objects",
              );
              await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
              values (${orgId}, 'sov_lines', ${body.id}, 'update', ${JSON.stringify({ before: before[0], after: after[0] })}::jsonb, ${userId})`);
            }
          });
          return NextResponse.json({ ok: true });
        }
        case "deleteSov": {
          await db.transaction(async (tx) => {
            // Same rehome race as updateSov: lock the project first, then the
            // line, so a concurrent A→B move refuses before anything deletes.
            await lockEntryProject(tx);
            const before = await tx.execute(
              sql`select * from sov_lines where id = ${body.id} and org_id = ${orgId} for update`,
              "objects",
            );
            if (!before[0]) throw new ConstructionBillingError("Schedule line not found");
            const used = await tx.execute(
              sql`select 1 from pay_application_lines pal
                    join pay_applications pa on pa.id = pal.pay_application_id and pa.org_id = pal.org_id
                   where pal.org_id = ${orgId} and pal.sov_line_id = ${body.id} and pa.status <> 'void' limit 1`,
              "objects",
            );
            if (used.length || before[0].change_order_id)
              throw new ConstructionBillingError(
                "A controlled schedule line cannot be deleted; use a reversing change order",
              );
            await tx.execute(
              sql`delete from sov_lines where id = ${body.id} and org_id = ${orgId}`,
            );
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'sov_lines', ${body.id}, 'delete', ${JSON.stringify({ before: before[0] })}::jsonb, ${userId})`);
          });
          return NextResponse.json({ ok: true });
        }
        case "addChangeOrder": {
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const number = String(body.number ?? "").trim();
          const amountRaw = canonicalDecimal(body.amount ?? "0", 4);
          if (amountRaw === null)
            return NextResponse.json(
              {
                error: moneyRefusal("Change-order amount", body.amount ?? "0"),
              },
              { status: 422 },
            );
          const amount = normalizeMoney(amountRaw);
          // change_orders.amount is numeric(19,4): same bound, same refusal.
          if (wholeDigits(amount) > 15)
            return NextResponse.json(
              {
                error: `Change-order amount is out of range — at most 15 whole digits fit the ledger; got "${suppliedValue(body.amount)}"`,
              },
              { status: 422 },
            );
          const targetSovLineId =
            typeof body.targetSovLineId === "string" && body.targetSovLineId
              ? body.targetSovLineId
              : null;
          if (targetSovLineId && !isUuid(targetSovLineId)) {
            throw new ConstructionBillingError("The target schedule line id must be a valid UUID");
          }
          // The income account the approval lands on the created SOV line.
          // Targeted orders reprice the line's own
          // account, so the writer only reads this for untargeted ones;
          // pinned like a hand-added SOV line either way.
          if (!number || cmp(amount, "0") === 0)
            throw new ConstructionBillingError(
              "Change-order number and a non-zero amount are required",
            );
          if (cmp(amount, "0") < 0 && !targetSovLineId)
            throw new ConstructionBillingError(
              "A deductive change order must identify the schedule line it reduces",
            );
          const id = await db.transaction(async (tx) => {
            // Fenced recheck inside the write transaction: the entry guard
            // above may be stale by the time this write lands, and a Projects
            // disable racing this insert must refuse one side or the other.
            await acquireFeatureGateLock(orgId, tx);
            if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) {
              throw new ConstructionBillingError("Projects feature is disabled");
            }
            // Recheck scope under the project lock: a rehome racing this
            // insert must refuse before the change order lands on B's project.
            const lockedProject = await lockEntryProject(tx);
            // Numbers are unique per project in storage: fail closed with the
            // domain error here so a double submit or retry never escapes as
            // a unique violation (the route maps the residual race below).
            const duplicate = await tx.execute(
              sql`
            select 1 from change_orders
             where org_id = ${orgId} and project_id = ${body.projectId} and number = ${number}
             limit 1
          `,
              "objects",
            );
            if (duplicate.length)
              throw new ConstructionBillingError(
                "A change order with this number already exists for this project",
              );
            if (targetSovLineId) {
              const target = await tx.execute(
                sql`
              select 1 from sov_lines
               where id = ${targetSovLineId} and org_id = ${orgId} and project_id = ${body.projectId}
            `,
                "objects",
              );
              if (!target.length)
                throw new ConstructionBillingError(
                  "The target schedule line does not belong to this project",
                );
            }
            const incomeAccountId = await pinIncomeAccount(
              tx,
              orgId,
              body.incomeAccountId,
              lockedProject.subsidiaryId,
              authz.allowedSubsidiaryIds,
            );
            const created = await tx.execute<{ id: string }>(
              sql`
            insert into change_orders (org_id, project_id, number, description, amount, target_sov_line_id, income_account_id, created_by, updated_by)
            values (${orgId}, ${body.projectId}, ${number}, ${body.description ?? null}, ${amount}, ${targetSovLineId}, ${incomeAccountId}, ${userId}, ${userId}) returning id
          `,
              "objects",
            );
            const createdId = created[0]!.id;
            await tx.execute(sql`insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
            values (${orgId}, 'change_orders', ${createdId}, 'insert', ${JSON.stringify({ after: { projectId: body.projectId, number, description: body.description ?? null, amount, targetSovLineId, incomeAccountId, status: "draft" } })}::jsonb, ${userId})`);
            return createdId;
          });
          return NextResponse.json({ id }, { status: 201 });
        }
        case "approveChangeOrder": {
          const approvedOn =
            body.approvedOn == null || body.approvedOn === ""
              ? await businessToday(orgId)
              : requireIsoDate(body.approvedOn, "Approval date");
          return NextResponse.json(
            await submitCustomerChangeOrder({
              orgId,
              actorId: userId,
              id: String(body.id),
              approvedOn,
            }),
          );
        }
        case "voidChangeOrder": {
          await db.transaction(async (tx) => {
            // Fenced recheck inside the write transaction, like every other
            // change-order writer: the entry guard may be stale, and a void
            // must not land on a project whose Projects feature was turned
            // off in between.
            await acquireFeatureGateLock(orgId, tx);
            if (!(await lockAndCheckOrgFeature(tx, orgId, "projects"))) {
              throw new ConstructionBillingError("Projects feature is disabled");
            }
            // Lock the project before its change order, like the approval
            // above: a rehome racing this void must refuse first.
            await lockEntryProject(tx);
            const before = await tx.execute(
              sql`
            select * from change_orders where id = ${body.id} and org_id = ${orgId} for update
          `,
              "objects",
            );
            if (!before[0] || before[0].status !== "draft") {
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
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const retainageRaw = canonicalDecimal(body.retainagePercent ?? "10", 4);
          if (retainageRaw === null)
            throw new ConstructionBillingError(
              moneyRefusal("Retainage percent", body.retainagePercent ?? "10", "a percent"),
            );
          const r = await createPayApplication(
            orgId,
            userId,
            body.projectId as string,
            body.periodEnd as string,
            normalizeMoney(retainageRaw),
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(r, { status: 201 });
        }
        case "submitPayApp": {
          const lines = [];
          if (Array.isArray(body.lines)) {
            for (const line of body.lines as Array<Record<string, unknown>>) {
              // Draw-entry inputs arrive as strings; an untouched cell submits
              // "" (and untouched rows are omitted), so a blank draw reads as
              // zero instead of failing the decimal parse.
              const blankToZero = (v: unknown) =>
                typeof v === "string" && v.trim() === "" ? "0" : (v ?? "0");
              const thisPeriod = canonicalDecimal(blankToZero(line.thisPeriodCompleted), 4);
              const stored = canonicalDecimal(blankToZero(line.materialsStored), 4);
              if (thisPeriod === null) {
                throw new ConstructionBillingError(
                  moneyRefusal("Completed this period", line.thisPeriodCompleted),
                );
              }
              if (stored === null) {
                throw new ConstructionBillingError(
                  moneyRefusal("Materials stored", line.materialsStored),
                );
              }
              lines.push({
                sovLineId: String(line.sovLineId ?? ""),
                thisPeriodCompleted: normalizeMoney(thisPeriod),
                materialsStored: normalizeMoney(stored),
              });
            }
          }
          const result = await submitPayApplication(
            orgId,
            userId,
            body.payApplicationId as string,
            lines,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(result);
        }
        case "approvePayApp": {
          await approvePayApplication(
            orgId,
            userId,
            body.payApplicationId as string,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json({ ok: true });
        }
        case "voidPayApp": {
          await voidPayApplication(
            orgId,
            userId,
            body.payApplicationId as string,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json({ ok: true });
        }
        case "billPayApp": {
          const r = await generatePayApplicationInvoice(
            orgId,
            userId,
            body.payApplicationId as string,
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(r);
        }
        case "releaseRetainage": {
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const amountRaw = canonicalDecimal(body.amount ?? "0", 4);
          if (amountRaw === null)
            return NextResponse.json(
              { error: moneyRefusal("Release amount", body.amount ?? "0") },
              { status: 422 },
            );
          const r = await releaseRetainage(
            orgId,
            userId,
            body.projectId as string,
            body.periodEnd as string,
            normalizeMoney(amountRaw),
            authz.allowedSubsidiaryIds,
          );
          return NextResponse.json(r);
        }
        default:
          return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
    } catch (e) {
      // A locked scope recheck that fails (missing, cross-org, or moved out of
      // the caller's subsidiaries) is indistinguishable from a missing record.
      if (e instanceof ScopeNotFoundError) return notFound("record");
      if (e instanceof ConstructionBillingError) return apiErrorResponse(e, { safeStatus: 422 });
      // Residual simultaneous-insert race against change_orders_project_number:
      // the pre-check above already answered, so report its verdict.
      if (isDuplicateChangeOrderNumber(e)) {
        return NextResponse.json(
          {
            error: "A change order with this number already exists for this project",
          },
          { status: 409 },
        );
      }
      throw e;
    }
  },
});
