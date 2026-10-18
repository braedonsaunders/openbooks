import { z } from "zod";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { switchActiveWorkspace } from "../../../../lib/active-workspace";

export const runtime = "nodejs";

const switchBody = z.object({ orgId: z.string() });

/**
 * The workspace this session currently acts in. Open tabs compare it with the
 * workspace they rendered so a switch made elsewhere cannot leave a tab showing
 * one organization while its requests act in another.
 */
export const GET = defineRoute({
  public: "session",
  handler: ({ authz }) =>
    NextResponse.json({ orgId: authz.user.orgId }, { headers: { "Cache-Control": "no-store" } }),
});

/**
 * Switch the session's active workspace. A stable endpoint rather than a
 * server action, so a tab rendered by an earlier deployment can still switch;
 * the caller reloads the document afterwards so no client state from the
 * previous workspace survives.
 */
export const POST = defineRoute({
  public: "session",
  body: switchBody,
  handler: async ({ authz, body }) => {
    const result = await switchActiveWorkspace(authz, body.orgId);
    if (result.ok) return NextResponse.json({ orgId: result.orgId });
    if (result.reason === "invalid") {
      return NextResponse.json({ error: "invalid_workspace" }, { status: 400 });
    }
    return NextResponse.json({ error: "workspace_unavailable" }, { status: 403 });
  },
});
