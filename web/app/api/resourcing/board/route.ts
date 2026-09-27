import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { loadResourcingBoard } from "@/lib/resourcing/queries";

const Query = z.object({
  firstSunday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  lastSunday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  projectId: z.string().uuid().optional(),
  departmentId: z.string().uuid().optional(),
  jobTitle: z.string().trim().min(1).optional(),
}).strict();

export const GET = defineRoute({
  permission: "resourcing.read",
  feature: "resourcing",
  handler: async ({ request, authz }) => {
    const parsed = Query.safeParse(Object.fromEntries(new URL(request.url).searchParams));
    if (!parsed.success) {
      return Response.json({ error: "Invalid board filters" }, { status: 400 });
    }
    return Response.json(await loadResourcingBoard(authz.user.orgId, authz.allowedSubsidiaryIds, parsed.data));
  },
});
