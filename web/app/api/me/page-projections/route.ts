import { NextResponse } from "next/server";
import { z } from "zod";
import { defineRoute } from "@/lib/api/route";
import { getAuthz } from "@/lib/authz";
import { withAuthzContext } from "@/lib/authz-context";
import { isProjectedPageSlug, rebuildProjectedPage } from "@/lib/page-projection";

export const runtime = "nodejs";

const BODY = z
  .object({
    page: z.string().min(1).max(64),
    params: z.record(z.string().max(256), z.string().max(2048)).default({}),
  })
  .strict();

/**
 * Rebuild the signed-in person's projection of a module cockpit they were
 * shown from an older projection. The cockpit's own loader runs under their
 * authority and refuses exactly as the page would.
 */
export const POST = defineRoute({
  public: "session",
  body: BODY,
  handler: async ({ body }) => {
    const authz = await getAuthz();
    if (!authz) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
    if (!isProjectedPageSlug(body.page))
      return NextResponse.json({ error: "Name a module cockpit to refresh." }, { status: 400 });
    const page = body.page;
    return withAuthzContext(authz, async () => {
      await rebuildProjectedPage(page, body.params);
      return NextResponse.json(
        { rebuilt: true },
        { headers: { "Cache-Control": "private, no-store" } },
      );
    });
  },
});
