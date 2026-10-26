import { NextResponse } from "next/server";
import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import {
  OperatingProfileError,
  saveOperatingProfileScope,
} from "@openbooks/engine/organization/operating-profiles";
import { ScopeBody } from "../contract";
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  scope: "unrestricted",
  feature: { none: "The command fences the selected native work-family and capture features." },
  params: z.object({ id: uuidString() }).strict(),
  body: ScopeBody,
  handler: async ({ authz, body, params }) => {
    if (body.expectedRevision === undefined)
      throw new OperatingProfileError("Reload the workflow scope before saving.", 409);
    return withOrgTransaction(authz.user.orgId, async () =>
      NextResponse.json(
        await saveOperatingProfileScope(db, authz.user.orgId, authz.user.id, {
          ...body,
          id: params.id,
          expectedRevision: body.expectedRevision!,
        }),
      ),
    );
  },
});
