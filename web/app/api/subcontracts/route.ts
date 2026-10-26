import { apiErrorResponse } from "@/lib/api/error-response";
import { isoDate, uuidId } from "@/lib/api/json";
import { NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  ScopeNotFoundError,
  lockProjectForScope,
  withScopeSnapshot,
} from "@openbooks/engine/organization/scope";
import {
  SubcontractConflictError,
  SubcontractError,
  addSubcontractSovLine,
  approveSubcontract,
  approveSubcontractChangeOrder,
  approveVendorPayApplication,
  createSubcontract,
  createSubcontractChangeOrder,
  createSubcontractPaymentControl,
  createVendorPayApplication,
  generateVendorPayApplicationBill,
  parseSubcontractTransitionAction,
  releaseSubcontractPaymentControl,
  releaseVendorRetainage,
  removeSubcontractSovLine,
  submitSubcontract,
  submitVendorPayApplication,
  transitionSubcontract,
  updateDraftSubcontract,
  updateVendorPayApplicationLines,
  voidSubcontractChangeOrder,
  voidVendorPayApplication,
  listSubcontractRegister,
} from "@openbooks/engine/projects/subcontracts";
import {
  readSubcontractActionProjectScope,
  readSubcontractDetail,
} from "@openbooks/engine/projects/subcontracts-read";
import { normalizeMoney } from "@openbooks/engine/money/money";
import { guardPermission, guardSubsidiaryScope, type Authz } from "@/lib/authz";
import { canonicalDecimal } from "@/lib/exact-decimal";
import { moneyRefusal } from "@/lib/payroll-decimal-refusal";
import { isFeatureEnabled } from "@/lib/features";
import { isUuid } from "@/lib/list-params";
import { notFound } from "@/lib/api/responses";
import { defineRoute } from "@/lib/api/route";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Exact numeric(19,4) money string, or null when the request value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) return null;
  // canonicalDecimal bounds scale, not magnitude: a pasted 20-digit figure
  // would otherwise sail through every action below and die in Postgres as a
  // raw numeric overflow (HTTP 500). All subcontract money columns are
  // numeric(19,4), which holds 15 whole digits.
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) return null;
  try {
    return normalizeMoney(exact);
  } catch {
    return null;
  }
}

function invalidDecimal(label: string, raw: unknown, noun = "an amount") {
  return NextResponse.json({ error: moneyRefusal(label, raw, noun) }, { status: 422 });
}

async function listSubcontracts(request: Request, authz: Authz) {
  const orgId = authz.user.orgId;
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!id) {
    const statusValue = url.searchParams.get("status") ?? "all";
    const status =
      statusValue === "all"
        ? undefined
        : [
              "draft",
              "pending_approval",
              "active",
              "substantially_complete",
              "closed",
              "void",
            ].includes(statusValue)
          ? (statusValue as
              | "draft"
              | "pending_approval"
              | "active"
              | "substantially_complete"
              | "closed"
              | "void")
          : null;
    const page = Number(url.searchParams.get("page") ?? "1");
    const perPage = Number(url.searchParams.get("perPage") ?? "25");
    const q = url.searchParams.get("q") ?? undefined;
    if (
      status === null ||
      !Number.isInteger(page) ||
      page < 1 ||
      page > 100_000 ||
      !Number.isInteger(perPage) ||
      perPage < 10 ||
      perPage > 100 ||
      (q !== undefined && q.length > 200)
    ) {
      return NextResponse.json(
        { error: "Choose a valid subcontract search, status and page." },
        { status: 422 },
      );
    }
    try {
      const result = await withScopeSnapshot(orgId, () =>
        listSubcontractRegister(db, {
          orgId,
          actorId: authz.user.id,
          requestedScope: authz.allowedSubsidiaryIds,
          q,
          status,
          page,
          perPage,
        }),
      );
      return NextResponse.json({ subcontracts: result.rows, ...result });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) return notFound("record");
      if (error instanceof SubcontractError)
        return NextResponse.json({ error: error.message }, { status: 422 });
      throw error;
    }
  }

  if (!isUuid(id)) return notFound("record");
  try {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        return await withScopeSnapshot(orgId, async () => {
          const detail = await readSubcontractDetail(db, {
            orgId,
            id,
            allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          });
          return detail ? NextResponse.json(detail) : notFound("record");
        });
      } catch (error) {
        // A REPEATABLE READ reader can observe the old project header, then
        // lose the lock race to a committed rehome. PostgreSQL marks that
        // snapshot stale (40001); retry once so the caller sees the new scope.
        const failure = error as { code?: string; cause?: { code?: string } };
        const code = failure.code ?? failure.cause?.code;
        if (code !== "40001" || attempt > 0) throw error;
      }
    }
    throw new Error("Subcontract detail snapshot could not be refreshed");
  } catch (error) {
    if (error instanceof ScopeNotFoundError) return notFound("record");
    throw error;
  }
}

const postingActions = new Set(["createVendorBill", "releaseRetainage"]);
const paymentActions = new Set(["addPaymentControl", "releasePaymentControl"]);

const subcontractRequestBody = z.discriminatedUnion("action", [
  z
    .object({
      action: z.literal("createSubcontract"),
      projectId: uuidId,
      vendorId: uuidId,
      number: z.string().trim().min(1),
      title: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      currency: z.string().optional(),
      originalCommitment: z.string(),
      defaultRetainagePercent: z.string().nullable().optional(),
      purchaseOrderId: uuidId.nullable().optional(),
      startsOn: z.string().nullable().optional(),
      endsOn: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("updateSubcontract"),
      id: uuidId,
      title: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      originalCommitment: z.string(),
      defaultRetainagePercent: z.string(),
      startsOn: z.string().nullable().optional(),
      endsOn: z.string().nullable().optional(),
      expectedUpdatedAt: z.string(),
    })
    .strict(),
  z
    .object({
      action: z.literal("addSovLine"),
      subcontractId: uuidId,
      itemNo: z.string().nullable().optional(),
      description: z.string().trim().min(1),
      scheduledValue: z.string(),
      retainagePercent: z.string().nullable().optional(),
      expenseAccountId: uuidId.nullable().optional(),
      sortOrder: z.number().int().optional(),
    })
    .strict(),
  z.object({ action: z.literal("removeSovLine"), id: uuidId }).strict(),
  z.object({ action: z.literal("submitSubcontract"), id: uuidId }).strict(),
  z.object({ action: z.literal("approveSubcontract"), id: uuidId }).strict(),
  z
    .object({
      action: z.literal("transitionSubcontract"),
      id: uuidId,
      transition: z.enum(["substantially_complete", "close", "void"]),
    })
    .strict(),
  z
    .object({
      action: z.literal("addChangeOrder"),
      subcontractId: uuidId,
      number: z.string().trim().min(1),
      description: z.string().nullable().optional(),
      amount: z.string(),
      targetSovLineId: uuidId.nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("approveChangeOrder"),
      id: uuidId,
      approvedOn: isoDate("approvedOn must be a valid calendar date (YYYY-MM-DD)"),
    })
    .strict(),
  z.object({ action: z.literal("voidChangeOrder"), id: uuidId }).strict(),
  z
    .object({
      action: z.literal("createPayApplication"),
      subcontractId: uuidId,
      periodEnd: z.string(),
      vendorInvoiceNumber: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("updatePayApplication"),
      payApplicationId: uuidId,
      expectedRevision: z.number().int().positive(),
      lines: z.array(
        z
          .object({
            sovLineId: z.string(),
            workCompletedThisPeriod: z.string().optional(),
            materialsStoredCurrent: z.string().optional(),
          })
          .strict(),
      ),
    })
    .strict(),
  z.object({ action: z.literal("submitPayApplication"), id: uuidId }).strict(),
  z.object({ action: z.literal("approvePayApplication"), id: uuidId }).strict(),
  z.object({ action: z.literal("voidPayApplication"), id: uuidId }).strict(),
  z.object({ action: z.literal("createVendorBill"), id: uuidId }).strict(),
  z
    .object({
      action: z.literal("releaseRetainage"),
      subcontractId: uuidId,
      periodEnd: z.string(),
      amount: z.string(),
      memo: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("addPaymentControl"),
      subcontractId: uuidId,
      payApplicationId: uuidId.nullable().optional(),
      vendorBillDocumentId: uuidId.nullable().optional(),
      controlType: z.enum(["joint_check", "payment_hold"]),
      jointPayeePartyId: uuidId.nullable().optional(),
      amountLimit: z.string().nullable().optional(),
      reason: z.string().trim().min(1),
      effectiveOn: z.string(),
      expiresOn: z.string().nullable().optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal("releasePaymentControl"),
      id: uuidId,
      releaseReason: z.string().trim().min(1),
    })
    .strict(),
]);

async function dispatchSubcontractAction(
  requestBody: z.infer<typeof subcontractRequestBody>,
  authz: Authz,
) {
  const body = requestBody as unknown as Record<string, unknown>;
  const action = String(body.action);
  const orgId = authz.user.orgId;
  const userId = authz.user.id;
  // Lifecycle transitions are validated before any lookup so malformed input
  // never reaches the database.
  if (action === "transitionSubcontract") {
    try {
      parseSubcontractTransitionAction(body.transition);
    } catch (error) {
      if (error instanceof SubcontractError) {
        return apiErrorResponse(error, { safeStatus: 400 });
      }
      throw error;
    }
  }
  // Every action is scoped by the project it reaches: a record on a project
  // outside the caller's subsidiary scope is indistinguishable from a missing one.
  const scope = await readSubcontractActionProjectScope(db, orgId, action, body);
  if (scope) {
    if (!scope.found) return notFound("record");
    const denied = guardSubsidiaryScope(authz, scope.subsidiaryId);
    if (denied) return denied;
  }
  try {
    return await db.transaction(async (tx) => {
      if (scope) {
        // The outer transaction keeps this parent-row lock alive until the
        // service's own transaction has committed, so a project rehome cannot
        // slip between this locked scope check and the dispatched mutation.
        // SHARE blocks subsidiary rehomes but remains compatible with the
        // key-share locks PostgreSQL takes for child foreign-key inserts.
        await lockProjectForScope(
          tx,
          orgId,
          String(scope.projectId),
          authz.allowedSubsidiaryIds,
          "share",
        );
      }
      let result: unknown = { ok: true };
      switch (action) {
        case "createSubcontract": {
          // Transaction currency is Multi-currency configuration. Turning that
          // switch off must refuse a new write; omitting currency keeps the
          // vendor / subsidiary / org fallback so stored contracts stay valid.
          if (body.currency !== undefined && !(await isFeatureEnabled(orgId, "multiCurrency"))) {
            return apiErrorResponse(
              new SubcontractError(
                "Multi-currency is disabled; enable it in Company Settings → Features before choosing a subcontract transaction currency",
              ),
              { safeStatus: 422 },
            );
          }
          const originalCommitment = exactMoney(body.originalCommitment);
          if (originalCommitment === null)
            return invalidDecimal("Original commitment", body.originalCommitment);
          const retainageInput = body.defaultRetainagePercent;
          const defaultRetainagePercent =
            retainageInput == null || retainageInput === ""
              ? undefined
              : exactMoney(retainageInput);
          if (defaultRetainagePercent === null)
            return invalidDecimal("Retainage percent", retainageInput, "a percent");
          result = await createSubcontract({
            ...body,
            orgId,
            userId,
            originalCommitment,
            defaultRetainagePercent,
          } as unknown as {
            orgId: string;
            userId: string;
            projectId: string;
            vendorId: string;
            number: string;
            title: string;
            description?: string | null;
            currency?: string | null;
            originalCommitment: string;
            defaultRetainagePercent?: string;
            purchaseOrderId?: string | null;
            startsOn?: string | null;
            endsOn?: string | null;
          });
          break;
        }
        case "updateSubcontract": {
          const originalCommitment = exactMoney(body.originalCommitment);
          if (originalCommitment === null)
            return invalidDecimal("Original commitment", body.originalCommitment);
          const defaultRetainagePercent = exactMoney(body.defaultRetainagePercent);
          if (defaultRetainagePercent === null)
            return invalidDecimal("Retainage percent", body.defaultRetainagePercent, "a percent");
          // Concurrent editors are fenced by the stamp the loader read: a
          // missing token is 422, a stale one 409s in the engine — mirroring
          // the pay-application revision token.
          if (
            typeof body.expectedUpdatedAt !== "string" ||
            !Number.isFinite(Date.parse(body.expectedUpdatedAt))
          ) {
            return NextResponse.json(
              { error: "expectedUpdatedAt must be the updated-at token the loader read" },
              { status: 422 },
            );
          }
          await updateDraftSubcontract({
            ...body,
            orgId,
            userId,
            originalCommitment,
            defaultRetainagePercent,
          } as unknown as {
            orgId: string;
            userId: string;
            id: string;
            title: string;
            description?: string | null;
            originalCommitment: string;
            defaultRetainagePercent: string;
            startsOn?: string | null;
            endsOn?: string | null;
            expectedUpdatedAt: string;
          });
          break;
        }
        case "addSovLine": {
          const scheduledValue = exactMoney(body.scheduledValue);
          if (scheduledValue === null)
            return invalidDecimal("Scheduled value", body.scheduledValue);
          let retainagePercent: string | null = null;
          if (body.retainagePercent != null && body.retainagePercent !== "") {
            retainagePercent = exactMoney(body.retainagePercent);
            if (retainagePercent === null)
              return invalidDecimal("Retainage percent", body.retainagePercent, "a percent");
          }
          result = await addSubcontractSovLine({
            ...body,
            orgId,
            userId,
            scheduledValue,
            retainagePercent,
          } as unknown as {
            orgId: string;
            userId: string;
            subcontractId: string;
            itemNo?: string | null;
            description: string;
            scheduledValue: string;
            retainagePercent?: string | null;
            expenseAccountId?: string | null;
            sortOrder?: number;
          });
          break;
        }
        case "removeSovLine":
          await removeSubcontractSovLine(orgId, userId, String(body.id));
          break;
        case "submitSubcontract":
          await submitSubcontract(orgId, userId, String(body.id));
          break;
        case "approveSubcontract":
          await approveSubcontract(orgId, userId, String(body.id));
          break;
        case "transitionSubcontract": {
          let transition: ReturnType<typeof parseSubcontractTransitionAction>;
          try {
            transition = parseSubcontractTransitionAction(body.transition);
          } catch (error) {
            if (error instanceof SubcontractError) {
              return apiErrorResponse(error, { safeStatus: 400 });
            }
            throw error;
          }
          await transitionSubcontract({ orgId, userId, id: String(body.id), action: transition });
          break;
        }
        case "addChangeOrder": {
          const amount = exactMoney(body.amount);
          if (amount === null) return invalidDecimal("Amount", body.amount);
          result = await createSubcontractChangeOrder({
            ...body,
            orgId,
            userId,
            amount,
          } as unknown as {
            orgId: string;
            userId: string;
            subcontractId: string;
            number: string;
            description?: string | null;
            amount: string;
            targetSovLineId?: string | null;
          });
          break;
        }
        case "approveChangeOrder":
          await approveSubcontractChangeOrder(
            orgId,
            userId,
            String(body.id),
            String(body.approvedOn),
          );
          break;
        case "voidChangeOrder":
          await voidSubcontractChangeOrder(orgId, userId, String(body.id));
          break;
        case "createPayApplication":
          result = await createVendorPayApplication({ ...body, orgId, userId } as unknown as {
            orgId: string;
            userId: string;
            subcontractId: string;
            periodEnd: string;
            vendorInvoiceNumber?: string | null;
          });
          break;
        case "updatePayApplication": {
          // Malformed lines never reach the engine: a non-array (or an entry
          // without a line identity or with an unparseable amount) is 422
          // naming the line, not a 500 from deep inside the update.
          // Concurrent editors are fenced by the revision token the loader
          // read: a missing token is 422, a stale one 409s in the engine.
          if (!Array.isArray(body.lines)) {
            return NextResponse.json(
              { error: "lines must be an array of pay-application lines" },
              { status: 422 },
            );
          }
          if (!Number.isInteger(body.expectedRevision) || (body.expectedRevision as number) < 1) {
            return NextResponse.json(
              {
                error:
                  "expectedRevision must be the positive integer revision token the loader read",
              },
              { status: 422 },
            );
          }
          const lines = [];
          for (const [index, entry] of (body.lines as Array<unknown>).entries()) {
            const label = `line ${index + 1}`;
            if (typeof entry !== "object" || entry === null) {
              return NextResponse.json(
                { error: `${label}: a pay-application line object is required` },
                { status: 422 },
              );
            }
            const line = entry as Record<string, unknown>;
            const sovLineId = String(line.sovLineId ?? "");
            if (!isUuid(sovLineId)) {
              return NextResponse.json(
                { error: `${label}: sovLineId must be a valid uuid` },
                { status: 422 },
              );
            }
            const workCompletedThisPeriod = exactMoney(line.workCompletedThisPeriod ?? "0");
            if (workCompletedThisPeriod === null) {
              return NextResponse.json(
                {
                  error: moneyRefusal(
                    `${label} (${sovLineId}): work completed`,
                    line.workCompletedThisPeriod ?? "0",
                  ),
                },
                { status: 422 },
              );
            }
            const materialsStoredCurrent = exactMoney(line.materialsStoredCurrent ?? "0");
            if (materialsStoredCurrent === null) {
              return NextResponse.json(
                {
                  error: moneyRefusal(
                    `${label} (${sovLineId}): materials stored`,
                    line.materialsStoredCurrent ?? "0",
                  ),
                },
                { status: 422 },
              );
            }
            lines.push({
              sovLineId,
              workCompletedThisPeriod,
              materialsStoredCurrent,
            });
          }
          result = await updateVendorPayApplicationLines({
            ...body,
            orgId,
            userId,
            lines,
          } as unknown as {
            orgId: string;
            userId: string;
            payApplicationId: string;
            expectedRevision: number;
            lines: Array<{
              sovLineId: string;
              workCompletedThisPeriod: string;
              materialsStoredCurrent: string;
            }>;
          });
          break;
        }
        case "submitPayApplication":
          result = await submitVendorPayApplication(orgId, userId, String(body.id));
          break;
        case "approvePayApplication":
          await approveVendorPayApplication(orgId, userId, String(body.id));
          break;
        case "voidPayApplication":
          await voidVendorPayApplication(orgId, userId, String(body.id));
          break;
        case "createVendorBill":
          result = await generateVendorPayApplicationBill(orgId, userId, String(body.id));
          break;
        case "releaseRetainage": {
          const amount = exactMoney(body.amount);
          if (amount === null) return invalidDecimal("Amount", body.amount);
          result = await releaseVendorRetainage({ ...body, orgId, userId, amount } as unknown as {
            orgId: string;
            userId: string;
            subcontractId: string;
            periodEnd: string;
            amount: string;
            memo?: string | null;
          });
          break;
        }
        case "addPaymentControl": {
          let amountLimit: string | null = null;
          if (body.amountLimit != null && body.amountLimit !== "") {
            amountLimit = exactMoney(body.amountLimit);
            if (amountLimit === null) return invalidDecimal("Amount limit", body.amountLimit);
          }
          result = await createSubcontractPaymentControl({
            ...body,
            orgId,
            userId,
            amountLimit,
          } as unknown as {
            orgId: string;
            userId: string;
            subcontractId: string;
            payApplicationId?: string | null;
            vendorBillDocumentId?: string | null;
            controlType: "joint_check" | "payment_hold";
            jointPayeePartyId?: string | null;
            amountLimit?: string | null;
            reason: string;
            effectiveOn: string;
            expiresOn?: string | null;
          });
          break;
        }
        case "releasePaymentControl":
          await releaseSubcontractPaymentControl(
            orgId,
            userId,
            String(body.id),
            String(body.releaseReason ?? ""),
          );
          break;
        default:
          return NextResponse.json({ error: "unknown action" }, { status: 400 });
      }
      return NextResponse.json(result, {
        status: action.startsWith("create") || action.startsWith("add") ? 201 : 200,
      });
    });
  } catch (error) {
    // A stale revision token is a conflict (409), not a validation refusal:
    // the record moved under the editor, so the message names the remedy
    // (reload, then re-enter) and the client can tell it apart from a 422.
    if (error instanceof SubcontractConflictError)
      return apiErrorResponse(error, { safeStatus: 409 });
    if (error instanceof SubcontractError) return apiErrorResponse(error, { safeStatus: 422 });
    if (error instanceof ScopeNotFoundError) return notFound("record");
    const code = (error as { code?: string }).code;
    if (code === "23505")
      return NextResponse.json({ error: "That number is already in use" }, { status: 409 });
    console.error("[subcontracts] action failed", error);
    return NextResponse.json({ error: "Subcontract action failed" }, { status: 500 });
  }
}

export const GET = defineRoute({
  authorize: () => guardPermission("ap.read"),
  feature: "subcontracts",
  handler: async ({ request, authz }) => listSubcontracts(request, authz),
});
export const POST = defineRoute({
  authorize: async ({ request }) => {
    let action: string | undefined;
    try {
      const payload: unknown = await request.clone().json();
      if (
        typeof payload === "object" &&
        payload !== null &&
        "action" in payload &&
        typeof payload.action === "string"
      )
        action = payload.action;
    } catch {
      // The route body schema returns the malformed-body refusal after authorization.
    }
    const permission =
      action === undefined
        ? "ap.create"
        : postingActions.has(action)
          ? "ap.post"
          : paymentActions.has(action)
            ? "ap.pay"
            : "ap.create";
    return guardPermission(permission);
  },
  feature: "subcontracts",
  body: subcontractRequestBody,
  invalidBodyStatus: 422,
  handler: async ({ body, authz }) => dispatchSubcontractAction(body, authz),
});
