import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { returnDocumentToDraft, ReturnToDraftError } from "@openbooks/engine/flows/module";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { defineRoute } from "@/lib/api/route";
import { notFound } from "@/lib/api/responses";
import { guardSubsidiaryScope } from "../../../../../lib/authz";
import { readDocumentScope } from "@/lib/record-scope-reads";

export const runtime = "nodejs";

const params = z.object({ id: uuidString() });

const returnBody = z
  .object({
    reason: z
      .string()
      .trim()
      .min(5, "a return reason between 5 and 500 characters is required")
      .max(500),
    expectedUpdatedAt: z.string().min(1).optional(),
  })
  .strict();

/**
 * POST return-to-draft: an approved, never-received/never-billed purchase
 * order corrects through edit and re-approval instead of a void on an order
 * that never moved stock. Runs the native document-lifecycle
 * returnDocumentToDraft service (same status, scope, revision and audit
 * contract as the document drawer) — the service itself refuses received or
 * billed lines by name, so a partially applied order meets the amendment
 * path instead.
 */
export const POST = defineRoute({
  permission: "purchase_orders.create",
  feature: "orders",
  params,
  body: returnBody,
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
        const result = await returnDocumentToDraft({
          documentId: id,
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          reason: body.reason,
          expectedUpdatedAt: body.expectedUpdatedAt,
          allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        });
        return { kind: "returned" as const, result };
      });
      if (outcome.kind === "not_found" || outcome.kind === "scope_revoked") {
        return notFound("record");
      }
      return NextResponse.json({ ok: true, supersededRunIds: outcome.result.supersededRunIds });
    } catch (e) {
      if (e instanceof ScopeNotFoundError) return notFound("record");
      if (e instanceof ReturnToDraftError) {
        return NextResponse.json({ error: e.message, code: e.code }, { status: e.status });
      }
      throw e;
    }
  },
});
