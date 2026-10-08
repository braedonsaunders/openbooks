import Link from 'next/link'
import { notFound } from 'next/navigation'
import { Button, PageHeader } from '@openbooks/ui'
import { getTranslations } from 'next-intl/server'
import { ListPageLayout } from '../../../../components/page-layout'
import { SetupEntitySection } from '../../admin/setup/[entity]/SetupEntitySection'
import { requirePermission, can } from '../../../../lib/authz'
import { SETUP_ENTITY_BY_KEY } from '../../../../lib/setup/registry'
import { boardAuthority, enabledBoardKinds, listBoards } from '@openbooks/engine/src/schedule-boards/boards.ts'

export const dynamic = 'force-dynamic'

/** Board configuration lives beside the schedule and shares native lists/drawers. */
export default async function SchedulingBoardsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const authz = await requirePermission('admin.setup.manage')
  const actor = { orgId: authz.user.orgId, actorId: authz.user.id }
  const kinds = await enabledBoardKinds(actor.orgId)
  if (!kinds.people && !kinds.tasks && !kinds.resources) notFound()
  const boards = await listBoards(actor, { includeArchived: true })
  const readable = await Promise.all(boards.map(async board => board.rowKind === 'resources'
    ? boardAuthority(actor, board, 'read').then(() => true, () => false)
    : can(authz, board.rowKind === 'people' ? 'hrm.shifts.read' : 'projects.read')))
  const t = await getTranslations('scheduling')
  return <ListPageLayout contained className="flex h-full min-h-0 flex-col" header={<PageHeader
    title={t('toolbar.manageBoards')} description={t('boards.description')}
    actions={<Button asChild variant="outline"><Link href="/scheduling">{t('boards.return')}</Link></Button>} />}>
    <SetupEntitySection entity={SETUP_ENTITY_BY_KEY.get('schedule-boards')!}
      orgId={authz.user.orgId} actorId={authz.user.id} allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      visibleRowIds={new Set(boards.filter((_, index) => readable[index]).map(board => board.id))}
      searchParams={await searchParams} basePath="/scheduling/boards" canManage contained />
  </ListPageLayout>
}
