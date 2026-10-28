import { defineRoute } from "@/lib/api/route";
import { NextResponse } from "next/server";
import {
  loadTrueCostSnapshot,
  replaceTrueCostConfig,
  trueCostBodySchema,
} from "@/lib/analytics/true-cost-config-write";

export const runtime = "nodejs";

export const GET = defineRoute({
  permission: "reports.read",
  feature: "projects",
  handler: async ({ authz: gate }) => {
    return NextResponse.json(await loadTrueCostSnapshot(gate.user.orgId));
  },
});

export const PUT = defineRoute({
  permission: "admin.setup.manage",
  feature: "projects",
  scope: "unrestricted",
  body: trueCostBodySchema,
  handler: async ({ authz: gate, body }) => {
    const result = await replaceTrueCostConfig({
      orgId: gate.user.orgId,
      actorId: gate.user.id,
      body,
    });
    if (result.kind === "invalid_body")
      return NextResponse.json({ error: result.message }, { status: 400 });
    if (result.kind === "revision_required") {
      return NextResponse.json(
        {
          error:
            "the True Cost configuration revision is required; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    if (result.kind === "invalid_amount") {
      return NextResponse.json(
        { error: "rates and amounts must be non-negative decimals" },
        { status: 400 },
      );
    }
    if (result.kind === "invalid_configuration") {
      return NextResponse.json(
        { error: "profiles and nested categories must be valid; correct every item before saving" },
        { status: 400 },
      );
    }
    if (result.kind === "conflict") {
      return NextResponse.json(
        {
          error:
            "this True Cost configuration changed after you opened it; reload and review the latest revision",
        },
        { status: 409 },
      );
    }
    return NextResponse.json({
      ok: true,
      revision: result.revision,
      activeProfileId: result.activeProfileId,
      profiles: result.profiles,
    });
  },
});
