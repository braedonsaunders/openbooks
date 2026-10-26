import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { db, withOrgTransaction } from "@openbooks/engine/platform/db";
import { saveWorkListPresentation } from "@openbooks/engine/organization/list-presentation";
const body = z
  .object({
    context: z.enum(["project", "manufacturing_work_order"]),
    presentation: z.enum(["list", "board"]).nullable(),
  })
  .strict();
export const PUT = defineRoute({
  public: "session",
  body,
  handler: ({ authz, body }) => {
    if (!authz) return Response.json({ error: "Unauthorized" }, { status: 401 });
    return withOrgTransaction(authz.user.orgId, async () =>
      Response.json(
        await saveWorkListPresentation(
          db,
          authz.user.orgId,
          authz.user.id,
          body.context,
          body.presentation,
        ),
      ),
    );
  },
});
