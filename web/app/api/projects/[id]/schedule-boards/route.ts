import { z } from "zod";
import { uuidString } from "@openbooks/engine/platform/identifiers";
import { NextResponse } from "next/server";
import { defineRoute } from "@/lib/api/route";
import { withOrgTransaction } from "@openbooks/engine/platform/db";
import { listBoards, boardAuthority } from "@openbooks/engine/schedule-boards/boards";
import { ScopeNotFoundError } from "@openbooks/engine/organization/scope";
import { readProjectSubsidiary } from "@/lib/record-scope-reads";
export const GET = defineRoute({
  permission: "projects.read",
  feature: "projectScheduling",
  params: z.object({ id: uuidString() }),
  handler: async ({ authz, params }) =>
    withOrgTransaction(authz.user.orgId, async () => {
      const project = await readProjectSubsidiary(authz.user.orgId, params.id);
      if (
        !project ||
        (authz.allowedSubsidiaryIds !== null &&
          (project.subsidiaryId === null || !authz.allowedSubsidiaryIds.has(project.subsidiaryId)))
      )
        throw new ScopeNotFoundError();
      const actor = { orgId: authz.user.orgId, actorId: authz.user.id },
        boards = await listBoards(actor, { projectId: params.id });
      const candidates = boards.filter((b) => b.rowKind !== "tasks");
      const visible = await Promise.all(
        candidates.map(async (board) => {
          try {
            await boardAuthority(actor, board, "read");
            return { id: board.id, code: board.code, name: board.name };
          } catch (error) {
            if (
              error instanceof ScopeNotFoundError ||
              (error &&
                typeof error === "object" &&
                "status" in error &&
                [403, 404].includes(Number(error.status)))
            )
              return null;
            throw error;
          }
        }),
      );
      return NextResponse.json({ boards: visible.filter((b) => b !== null) });
    }),
});
