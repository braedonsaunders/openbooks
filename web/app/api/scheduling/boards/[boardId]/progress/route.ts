import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { loadProjectProgress } from "@openbooks/engine/schedule-boards/progress";

/** Production progress for one project on a task board. */
export const GET = defineRoute({
  permission: "projects.read",
  feature: "projectScheduling",
  params: z.object({ boardId: uuidString() }),
  handler: async ({ request, authz, params }) => {
    const projectId = new URL(request.url).searchParams.get("projectId") ?? "";
    const progress = await loadProjectProgress({
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      boardId: params.boardId,
      projectId,
    });
    return NextResponse.json(progress);
  },
});
