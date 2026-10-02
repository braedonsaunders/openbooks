import {
  pageHeader,
  widget,
  widgetBlock,
  field,
} from '@braedonsaunders/appkit-viewspec'
import { listOneOnOneDirectory } from '@openbooks/engine/hrm/performance'
import { ModuleView } from '../../../../../components/viewspec/module-view'
import {
  loadMeOneOnOnesPage,
  meOneOnOnesSpec,
} from '../../../me/one-on-ones/view'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
import { can, getAuthz } from '../../../../../lib/authz'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
export const dynamic = 'force-dynamic'
/** The same governed conversation surface, reachable from the Talent workspace. */
export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | undefined>>
}) {
  const sp = await searchParams,
    authz = await getAuthz()
  if (!authz) notFound()
  const data = await loadMeOneOnOnesPage(sp),
    t = await getTranslations('hrm.talentWorkspace')
  function rehome<T>(value: T, key = ''): T {
    if (typeof value === 'string' && /href$/i.test(key))
      return value.replaceAll(
        '/me/one-on-ones',
        '/hrm/performance/conversations',
      ) as T
    if (Array.isArray(value)) return value.map((item) => rehome(item, key)) as T
    if (value && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rehome(item, key)]),
      ) as T
    return value
  }
  const directory = await listOneOnOneDirectory({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
  })
  const canSchedule =
    directory.employments.length > 1 &&
    (can(authz, 'hrm.performance.manage') ||
      directory.employments.some((e) => e.mine))
  const workspace = {
    ...rehome(data),
    title: t('conversations'),
    tabs: await hrmGroupTabs(authz, '/hrm/performance/conversations'),
  }
  const spec = meOneOnOnesSpec(workspace)
  return (
    <ModuleView
      spec={{
        ...spec,
        route: '/hrm/performance/conversations',
        header: [
          pageHeader({
            title: field('title'),
            description: field('description'),
            actions: [
              ...(canSchedule
                ? [
                    widget('link-button', {
                      href: '/hrm/performance/conversations?create=new',
                      label: t('newConversation'),
                      iconKey: 'plus',
                    }),
                  ]
                : []),
              widget('module-home-tabs', { tabs: workspace.tabs }),
            ],
          }),
        ],
        body: [
          ...spec.body,
          ...(canSchedule && sp.create === 'new'
            ? [
                widgetBlock('hrm-conversation-create', {
                  employees: directory.employments.map((e) => ({
                    value: e.id,
                    label: e.name,
                  })),
                  closeHref: '/hrm/performance/conversations',
                }),
              ]
            : []),
        ],
      }}
      data={workspace}
      searchParams={sp}
      trusted
    />
  )
}
