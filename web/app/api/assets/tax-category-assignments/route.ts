import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import { assignAssetTaxCategory } from "@openbooks/engine/assets/asset-tax-category-assignments";
import { guardUnrestrictedScope } from "@/lib/authz";
import { isUuid } from "@/lib/list-params";
const patchBodySchema0 = z.strictObject({
  categoryId: uuidString("categoryId must be a valid id"),
  regime: z.string().trim().min(1, "regime is required"),
  classCode: z.string().trim().min(1).nullable().optional(),
});

export const runtime = "nodejs";

export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: "fixedAssets",
  body: patchBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    // Category tax attributes decide how every entity's assets are reported on
    // every filing: org-wide policy, unrestricted scope only.
    const unrestricted = guardUnrestrictedScope(gate);
    if (unrestricted) return unrestricted;

    const body = routeBody as {
      categoryId?: string;
      regime?: string;
      classCode?: string | null;
    };
    if (!body.categoryId || !isUuid(body.categoryId) || !body.regime)
      return NextResponse.json({ error: "invalid assignment" }, { status: 422 });
    const categoryId = body.categoryId;
    const result = await assignAssetTaxCategory({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      categoryId,
      regime: body.regime,
      classCode: body.classCode ?? null,
    });
    if (result.kind === "regime_not_found")
      return NextResponse.json({ error: "regime is not installed" }, { status: 422 });
    if (result.kind === "invalid_class")
      return NextResponse.json({ error: "invalid class" }, { status: 422 });
    if (result.kind === "category_not_found")
      return NextResponse.json({ error: "category not found" }, { status: 404 });
    if (result.kind === "open_pool") {
      return NextResponse.json(
        {
          error: `cannot remove tax class "${result.classCode}" while its pool has a nonzero balance; keep or restore this class assignment until the pool is closed`,
        },
        { status: 422 },
      );
    }
    return NextResponse.json({ ok: true });
  },
});
