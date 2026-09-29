import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { deleteGrant } from "../../../../grant-handlers";

export const runtime = "nodejs";

export const DELETE = defineRoute({
  public: "session",
  params: z.object({ id: z.string(), grantId: z.string() }),
  handler: async ({ request: _req, authz: gate, params }) => {
    const { id, grantId } = await params;
    return deleteGrant(gate, "file", id, grantId);
  },
});
