import { SchedulingWorkspace } from '@/components/scheduling/SchedulingWorkspace'
import { SetupEntitySection } from '../../../../admin/setup/[entity]/SetupEntitySection'
import { loadSchedulingPage } from '../../../../scheduling/view'
import { SETUP_ENTITY_BY_KEY } from '@/lib/setup/registry'
import { getAuthz } from '@/lib/authz'
import { pickString } from '@/lib/list-params'
import { isUuid } from '@openbooks/engine/src/platform/uuid.ts'
import { notFound } from 'next/navigation'
export const dynamic = 'force-dynamic'
/** A project-owned schedule body never appears in the general board picker. */
export default async function ProjectBoard({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const { id } = await params
  if (!isUuid(id)) notFound()
  const sp = await searchParams,
    data = await loadSchedulingPage(sp, id),
    authz = await getAuthz()
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-2">
      <div className="min-h-0 flex-1">
        <SchedulingWorkspace {...data} />
      </div>
      {authz && data.canConfigure && pickString(sp.boardRow) ? (
        <SetupEntitySection
          entity={SETUP_ENTITY_BY_KEY.get('schedule-boards')!}
          orgId={authz.user.orgId}
          actorId={authz.user.id}
          allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
          visibleRowIds={new Set(data.boards.map((b) => b.id))}
          canManage
          basePath={data.hostPath}
          searchParams={sp}
          rowParam="boardRow"
          drawerOnly
        />
      ) : null}
    </div>
  )
}
