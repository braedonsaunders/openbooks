import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { apiErrorResponse } from "@/lib/api/error-response";
import { NextResponse } from "next/server";
import {
  installTaxDepreciationPack,
  taxDepreciationPacks,
} from "@openbooks/engine/src/tax-returns/depreciation-packs.ts";
import { guardUnrestrictedScope } from "../../../../lib/authz";
const postBodySchema0 = z.strictObject({
  code: z.string().trim().min(1, "code is required").max(100),
});

export { runtime } from "@/lib/api/route";

export const GET = defineRoute({
  permission: "assets.read",
  feature: "fixedAssets",
  handler: async ({ authz: _gate }) => {
    return NextResponse.json({ packs: taxDepreciationPacks() });
  },
});

export const POST = defineRoute({
  permission: "admin.setup.manage",
  feature: "fixedAssets",
  body: postBodySchema0,
  handler: async ({ request: _req, authz: gate, body: routeBody }) => {
    // Tax depreciation packs install the org-wide regime every entity's
    // assets depreciate under.
    const unrestricted = guardUnrestrictedScope(gate);
    if (unrestricted) return unrestricted;

    const body = routeBody as { code?: string };
    try {
      return NextResponse.json(
        await installTaxDepreciationPack(
          gate.user.orgId,
          body.code,
          gate.user.id,
        ),
      );
    } catch (error) {
      return apiErrorResponse(error, { safeStatus: 422 });
    }
  },
});
