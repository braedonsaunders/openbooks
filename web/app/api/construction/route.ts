import { submitCustomerChangeOrder } from "@openbooks/engine/projects/construction-billing";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  ConstructionBillingError,
  approvePayApplication,
  createPayApplication,
  generatePayApplicationInvoice,
  releaseRetainage,
  requireIsoDate,
  submitPayApplication,
  voidPayApplication,
} from "@openbooks/engine/projects/construction-billing";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { can, guardSubsidiaryScope } from "../../../lib/authz";
import { isUuid } from "../../../lib/list-params";
import { normalizeMoney, wholeDigits } from "@openbooks/engine/money";
import { canonicalDecimal } from "../../../lib/exact-decimal";
import { moneyRefusal } from "../../../lib/payroll-decimal-refusal";
import { guardProjectsFeature } from "../../../lib/projects-gate";
import { supportsApplicationsForPayment } from "../../../lib/project-billing-procedure";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import { isoDate } from "../../../lib/api/json";
import { notFound } from "@/lib/api/responses";
import {
  createConstructionChangeOrder,
  createConstructionSovLine,
  deleteConstructionSovLine,
  loadProjectConstructionBilling,
  updateConstructionSovLine,
  voidConstructionChangeOrder,
} from "../../../lib/project-construction";

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

    try {
      return NextResponse.json(
        await loadProjectConstructionBilling(
          { orgId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
          projectId,
        ),
      );
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      throw error;
    }
  },
});

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
    try {
      switch (action) {
        case "addSov": {
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const id = await createConstructionSovLine(
            { orgId, actorId: userId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
            {
              projectId: body.projectId as string,
              description: String(body.description ?? ""),
              scheduledValue: String(body.scheduledValue ?? "0"),
              retainagePercent:
                body.retainagePercent == null ? null : String(body.retainagePercent),
              itemNo: body.itemNo == null ? null : String(body.itemNo),
              sortOrder: body.sortOrder == null ? 0 : Number(body.sortOrder),
              incomeAccountId: body.incomeAccountId == null ? null : String(body.incomeAccountId),
            },
          );
          return NextResponse.json({ id }, { status: 201 });
        }
        case "updateSov": {
          await updateConstructionSovLine(
            { orgId, actorId: userId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
            {
              projectId: scope!.projectId,
              id: String(body.id),
              description: String(body.description ?? ""),
              scheduledValue: String(body.scheduledValue ?? "0"),
              retainagePercent:
                body.retainagePercent == null ? null : String(body.retainagePercent),
              itemNo: body.itemNo == null ? null : String(body.itemNo),
              incomeAccountId: body.incomeAccountId == null ? null : String(body.incomeAccountId),
            },
          );
          return NextResponse.json({ ok: true });
        }
        case "deleteSov": {
          await deleteConstructionSovLine(
            { orgId, actorId: userId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
            scope!.projectId,
            String(body.id),
          );
          return NextResponse.json({ ok: true });
        }
        case "addChangeOrder": {
          if (!(await ownsProject(orgId, body.projectId as string))) return notFound("record");
          const id = await createConstructionChangeOrder(
            { orgId, actorId: userId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
            {
              projectId: body.projectId as string,
              number: String(body.number ?? ""),
              description: body.description == null ? null : String(body.description),
              amount: String(body.amount ?? "0"),
              targetSovLineId: body.targetSovLineId == null ? null : String(body.targetSovLineId),
              incomeAccountId: body.incomeAccountId == null ? null : String(body.incomeAccountId),
            },
          );
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
          await voidConstructionChangeOrder(
            { orgId, actorId: userId, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
            scope!.projectId,
            String(body.id),
          );
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
