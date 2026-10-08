import { getAuthz } from '../../../lib/authz'
import { SETUP_ENTITY_BY_KEY } from '../../../lib/setup/registry'
import { SetupEntitySection } from '../admin/setup/[entity]/SetupEntitySection'
import { pickString } from '../../../lib/list-params'
import { ModuleView } from '../../../components/viewspec/module-view'
import { loadSchedulingPage, schedulingSpec, schedulingTitle } from './view'

export const dynamic = 'force-dynamic'

export async function generateMetadata() {
  return { title: await schedulingTitle() }
}

/**
 * Scheduling — every people and task board in one workspace. Renders when
 * Scheduling or Project Scheduling is on and the actor can read the board
 * family; otherwise the page 404s or explains the missing permission.
 */
export default async function SchedulingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const sp = await searchParams
  const data = await loadSchedulingPage(sp)
  const authz = data.canConfigure && pickString(sp.boardRow) ? await getAuthz() : null
  return <>
    <ModuleView spec={schedulingSpec(data)} data={data} searchParams={sp} trusted contained />
    {authz ? <SetupEntitySection entity={SETUP_ENTITY_BY_KEY.get('schedule-boards')!}
      orgId={authz.user.orgId} actorId={authz.user.id} allowedSubsidiaryIds={authz.allowedSubsidiaryIds}
      visibleRowIds={new Set(data.boards.map(board => board.id))} canManage={data.canConfigure}
      basePath="/scheduling" searchParams={sp} rowParam="boardRow" drawerOnly /> : null}
  </>
}
