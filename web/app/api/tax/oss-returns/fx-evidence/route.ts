import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import { listOssReturnFxEvidence } from "@openbooks/engine/tax-returns/oss-fx-evidence";

export const runtime = "nodejs";

const QuerySchema = z.object({
  scheme: z.enum(["union", "non_union", "ioss"]),
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

/**
 * Stored ECB translation evidence for a prepared return period: one row per
 * source currency with the rate, its date and the reproducibility digest.
 * Empty before the first export of the period — evidence is stored at export.
 */
export const GET = defineRoute({
  permission: "reports.read",
  feature: "crossBorderTax",
  scope: "unrestricted",
  handler: async ({ authz: routeAuthz, request }) => {
    const params = new URL(request.url).searchParams;
    const parsed = QuerySchema.safeParse({
      scheme: params.get("scheme") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: "scheme (union|non_union|ioss), from and to (YYYY-MM-DD) are required" },
        { status: 400 },
      );
    }
    try {
      const rows = await listOssReturnFxEvidence(routeAuthz.user.orgId, parsed.data);
      return NextResponse.json({ rows });
    } catch (e: unknown) {
      return apiErrorResponse(e, { safeStatus: 422 });
    }
  },
});
