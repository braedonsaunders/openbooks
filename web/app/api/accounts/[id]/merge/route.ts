import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { can } from "@/lib/authz";
import {
  AccountMergeError,
  previewAccountMerge,
  requestAccountMerge,
} from "@openbooks/engine/chart/account-merge";

export const runtime = "nodejs";

const params = z.object({ id: uuidString() });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "use YYYY-MM-DD");

const mergeBody = z.strictObject({
  targetAccountId: uuidString(),
  effectiveDate: isoDate,
  reason: z.string().trim().min(8, "record a reason of at least 8 characters").max(1000),
  expectedDigest: z.string().regex(/^[0-9a-f]{64}$/, "preview the merge before confirming it"),
  idempotencyKey: uuidString(),
});

/** Preview merging this account into a surviving account: refusals and consequences. */
export const GET = defineRoute({
  permission: "gl.manage",
  feature: "accountMerges",
  scope: "unrestricted",
  params,
  handler: async ({ request, authz, params: { id } }) => {
    const url = new URL(request.url);
    const target = url.searchParams.get("target") ?? "";
    const effectiveDate = url.searchParams.get("date") ?? "";
    if (!uuidString().safeParse(target).success || !isoDate.safeParse(effectiveDate).success) {
      return NextResponse.json(
        { error: "Choose the surviving account and the effective date." },
        { status: 422 },
      );
    }
    try {
      return NextResponse.json(
        await previewAccountMerge(
          authz.user.orgId,
          { sourceAccountId: id, targetAccountId: target, effectiveDate },
          authz.allowedSubsidiaryIds,
        ),
      );
    } catch (error) {
      if (error instanceof AccountMergeError) return apiErrorResponse(error);
      throw error;
    }
  },
});

/**
 * Merge this account into the surviving account exactly as previewed, or
 * submit the merge for approval when an Accounting event Flow governs it.
 * The merge posts reclass journals, so it also needs posting authority.
 */
export const POST = defineRoute({
  permission: "gl.manage",
  feature: "accountMerges",
  scope: "unrestricted",
  params,
  body: mergeBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params: { id }, body }) => {
    if (!can(authz, "gl.post")) {
      return NextResponse.json(
        {
          error: "Merging accounts posts reclass journal entries.",
          code: "forbidden",
          remedy: "Ask a user who can post journal entries to merge the accounts.",
        },
        { status: 403 },
      );
    }
    try {
      const outcome = await requestAccountMerge(authz.user.orgId, {
        sourceAccountId: id,
        targetAccountId: body.targetAccountId,
        effectiveDate: body.effectiveDate,
        reason: body.reason,
        expectedDigest: body.expectedDigest,
        idempotencyKey: body.idempotencyKey,
        actorId: authz.user.id,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      });
      return NextResponse.json(outcome, {
        status: outcome.status === "completed" && !outcome.replayed ? 201 : 200,
      });
    } catch (error) {
      return apiErrorResponse(error);
    }
  },
});
