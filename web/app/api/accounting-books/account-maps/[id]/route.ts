import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { closeBookAccountMap } from "@openbooks/engine/multibook";

export const runtime = "nodejs";

const patchBody = z
  .object({
    effectiveTo: z.string().nullable(),
    reason: z.string(),
  })
  .strict();

/**
 * End (or reopen) a mapping's window, with a reason. Its accounts, scope and
 * start date are fixed: a different mapping is a new version. The window
 * never ends before entries the book already holds under it.
 */
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: "multiBookAccounting",
  scope: "unrestricted",
  params: z.object({ id: uuidString() }),
  body: patchBody,
  invalidBodyStatus: 422,
  handler: async ({ authz, params, body }) => {
    const updated = await closeBookAccountMap({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      id: params.id,
      effectiveTo: body.effectiveTo,
      reason: body.reason,
    });
    return NextResponse.json(updated);
  },
});
