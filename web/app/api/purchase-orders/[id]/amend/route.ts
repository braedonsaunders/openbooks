import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { guardSubsidiaryScope } from "../../../../../lib/authz";
import { unexpectedServerError } from "../../../../../lib/api/unexpected";
import {
  amendPurchaseOrder,
  PurchaseOrderAmendError,
} from "../../../../../lib/purchase-order-amend";
import { readDocumentScope } from "@/lib/record-scope-reads";

export const runtime = "nodejs";

const params = z.object({ id: uuidString() });

const amendLineBody = z
  .object({
    lineId: uuidString(),
    quantity: z.string().min(1).max(50).optional(),
    unitPrice: z.string().min(1).max(50).optional(),
  })
  .strict();

const amendBody = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, "an amendment reason between 5 and 500 characters is required")
      .max(500),
    expectedUpdatedAt: z.string().min(1).optional(),
    lines: z.array(amendLineBody).min(1),
  })
  .strict();

/**
 * POST amend: change quantity and/or unit price on an approved purchase
 * order's lines when receipts or bills already guard a redraft. Quantities
 * never fall below received or billed evidence; the amendment is audited
 * before/after with its reason, bumps the revision, and re-approves through
 * the native Flow release (ungated it stays approved, gated it goes
 * pending_approval into a new run).
 */
export const POST = defineRoute({
  permission: "purchase_orders.create",
  feature: "orders",
  params,
  body: amendBody,
  handler: async ({ authz, params: { id }, body }) => {
    try {
      const outcome = await withOrgTransaction(authz.user.orgId, async () => {
        const locked = await readDocumentScope(authz.user.orgId, id, {
          kind: "purchase_order",
          lock: true,
        });
        if (!locked) return { kind: "not_found" as const };
        if (guardSubsidiaryScope(authz, locked.subsidiaryId)) {
          return { kind: "scope_revoked" as const };
        }
        const result = await amendPurchaseOrder({
          orderId: id,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          reason: body.reason,
          expectedUpdatedAt: body.expectedUpdatedAt,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
          lines: body.lines,
        });
        return { kind: "amended" as const, result };
      });
      if (outcome.kind === "not_found" || outcome.kind === "scope_revoked") {
        return notFound("record");
      }
      return NextResponse.json({
        ok: true,
        status: outcome.result.status,
        gated: outcome.result.gated,
        runId: outcome.result.runId,
      });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound("record");
      if (e instanceof PurchaseOrderAmendError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      }
      return unexpectedServerError("purchase-orders/amend", e);
    }
  },
});
