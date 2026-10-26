import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { saveResourceRecipient } from "@openbooks/engine/schedule-boards/resource-recipients";
import { resourceRecipientBody } from "../contract";
export const PATCH = defineRoute({
  permission: "admin.setup.manage",
  feature: "projectScheduling",
  params: z.object({ id: uuidString() }),
  body: resourceRecipientBody.extend({
    expectedRevision: z.number().int().positive(),
  }),
  handler: async ({ authz, params, body }) =>
    NextResponse.json(
      await saveResourceRecipient(
        { orgId: authz.user.orgId, actorId: authz.user.id },
        { id: params.id, ...body },
      ),
    ),
});
