import { z } from 'zod'
import { sql } from 'drizzle-orm'
import { NextResponse } from 'next/server'
import { defineRoute } from '@/lib/api/route'
import { db, withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import {
  listBoards,
  boardAuthority,
} from '@openbooks/engine/src/schedule-boards/boards.ts'
import { ScopeNotFoundError } from '@openbooks/engine/src/organization/subsidiary-scope.ts'
export const GET = defineRoute({
  permission: 'projects.read',
  feature: 'projectScheduling',
  params: z.object({ id: z.string().uuid() }),
  handler: async ({ authz, params }) =>
    withOrgTransaction(authz.user.orgId, async () => {
      const project = (
        await db.execute<{ subsidiaryId: string | null }>(
          sql`select subsidiary_id as "subsidiaryId" from projects where org_id=${authz.user.orgId} and id=${params.id}`,
        )
      ).rows[0]
      if (
        !project ||
        (authz.allowedSubsidiaryIds !== null &&
          (project.subsidiaryId === null ||
            !authz.allowedSubsidiaryIds.has(project.subsidiaryId)))
      )
        throw new ScopeNotFoundError()
      const actor = { orgId: authz.user.orgId, actorId: authz.user.id },
        boards = await listBoards(actor, { projectId: params.id })
      const candidates = boards.filter((b) => b.rowKind !== 'tasks')
      const visible = await Promise.all(
        candidates.map(async (board) => {
          try {
            await boardAuthority(actor, board, 'read')
            return { id: board.id, code: board.code, name: board.name }
          } catch (error) {
            if (
              error instanceof ScopeNotFoundError ||
              (error &&
                typeof error === 'object' &&
                'status' in error &&
                [403, 404].includes(Number(error.status)))
            )
              return null
            throw error
          }
        }),
      )
      return NextResponse.json({ boards: visible.filter((b) => b !== null) })
    }),
})
