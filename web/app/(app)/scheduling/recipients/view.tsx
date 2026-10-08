import Link from 'next/link'
import { notFound, redirect } from 'next/navigation'
import { Button, PageHeader } from '@openbooks/ui'
import { ListPageLayout } from '@/components/page-layout'
import { requirePermission } from '@/lib/authz'
import { pickString } from '@/lib/list-params'
import { SETUP_ENTITY_BY_KEY } from '@/lib/setup/registry'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import {
  getBoard,
  boardAuthority,
} from '@openbooks/engine/src/schedule-boards/boards.ts'
import { withOrgTransaction } from '@openbooks/engine/src/platform/db.ts'
export async function ResourceRecipients({
  searchParams,
  projectId,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  projectId?: string
}) {
  const sp = await searchParams,
    authz = await requirePermission('admin.setup.manage'),
    actor = { orgId: authz.user.orgId, actorId: authz.user.id }
  const code = pickString(sp.board)
  if (!code) notFound()
  const board = await withOrgTransaction(actor.orgId, async () => {
    const board = await getBoard(actor, code)
    await boardAuthority(actor, board, 'manage')
    if (board.rowKind !== 'resources') notFound()
    return board
  })
  if (projectId && board.projectId !== projectId) notFound()
  if (!projectId && board.projectId)
    redirect(
      `/projects/${board.projectId}/schedule/recipients?board=${encodeURIComponent(board.code)}`,
    )
  const host = projectId ? `/projects/${projectId}/schedule` : '/scheduling'
  const boardPath = projectId ? `${host}/board` : host
  return (
    <ListPageLayout
      contained
      header={
        <PageHeader
          title="Board resource recipients"
          description={board.name}
          actions={
            <Button asChild variant="outline">
              <Link
                href={`${boardPath}?board=${encodeURIComponent(board.code)}`}
              >
                Return to board
              </Link>
            </Button>
          }
        />
      }
    >
      <SetupEntitySection
        entity={SETUP_ENTITY_BY_KEY.get('schedule-resource-recipients')!}
        orgId={actor.orgId}
        actorId={actor.actorId}
        allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
        canManage
        basePath={`${host}/recipients`}
        searchParams={sp}
        parent={{ recordKey: 'schedule-boards', value: board.id }}
        contained
      />
    </ListPageLayout>
  )
}
