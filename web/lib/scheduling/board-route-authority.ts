import { NextResponse } from 'next/server'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'
import { boardAuthority, getBoard } from '@openbooks/engine/src/schedule-boards/boards.ts'
import { scheduleDatabaseRefusal } from '@openbooks/engine/src/schedule-boards/errors.ts'
import { getAuthz } from '@/lib/authz'
import { notFound } from '@/lib/api/responses'

/** The addressed board selects its native permission and feature family. */
export async function schedulingBoardRouteAuthority(params: unknown, mode: 'read' | 'manage' | 'publish') {
  const authz = await getAuthz()
  if (!authz) return NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const boardId = (params as { boardId?: unknown } | undefined)?.boardId
  if (!isUuid(boardId)) return notFound('record')
  const actor = { orgId: authz.user.orgId, actorId: authz.user.id }
  await withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, boardId)
    await boardAuthority(actor, board, mode)
  }).catch((error: unknown) => { throw scheduleDatabaseRefusal(error) })
  return authz
}
