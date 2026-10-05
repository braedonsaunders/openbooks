import 'server-only'
import { getLocale, getTranslations } from 'next-intl/server'
import {
  page,
  pageHeader,
  ref,
  field,
  column,
  link,
  text,
  badge,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { TrainingError, listOwnTraining } from '@openbooks/engine/hrm/training'
import { requirePermission } from '@/lib/authz'
import { requireFeatureEnabled } from '@/lib/feature-gates'
import { meTabs } from '@/lib/hrm/self-service'
import { buildListDrawerHref } from '@/lib/list-params'
import { registeredListTable } from '@/lib/list/prepared-spec'

/** Only the employee's authorized invitations enter the registered list and record drawer. */
export async function loadMeTraining(sp: Record<string, string | undefined> = {}) {
  const authz = await requirePermission('hrm.self.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  await requireFeatureEnabled(authz.user.orgId, 'hrmCertifications')
  const [t, policy, locale, tabs] = await Promise.all([
    getTranslations('hrm.me.training'),
    getTranslations('admin.setup.training'),
    getLocale(),
    meTabs(authz, '/me/training'),
  ])
  const labels = {
    title: t('title'),
    description: t('description'),
    emptyTitle: t('emptyTitle'),
    emptyDescription: t('emptyDescription'),
    session: policy('session'),
    start: policy('startsAt'),
    location: policy('location'),
    status: policy('status'),
  }
  try {
    const records = await listOwnTraining({ orgId: authz.user.orgId, actorId: authz.user.id })
    const rows = records.map((row) => ({
      id: row.id,
      name: row.sessionName,
      href: buildListDrawerHref('/me/training', sp, 'training', row.id),
      start:
        new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: row.timeZone }).format(
          new Date(row.startsAt),
        ) + ` · ${row.timeZone}`,
      location: row.location,
      status: policy(`statuses.${row.status}`),
      variant:
        row.status === 'completed'
          ? ('success' as const)
          : row.status === 'failed'
            ? ('destructive' as const)
            : ('outline' as const),
    }))
    return { authz, data: { labels, tabs, rows, refusal: null as string | null, hasContent: true } }
  } catch (error) {
    if (!(error instanceof TrainingError)) throw error
    return { authz, data: { labels, tabs, rows: [], refusal: error.message, hasContent: false } }
  }
}
type Data = Awaited<ReturnType<typeof loadMeTraining>>['data']
const f = ref<Data>(),
  item = field
export function meTrainingSpec(data: Data): PageSpec {
  return page({
    route: '/me/training',
    layout: 'list',
    header: [
      pageHeader({
        title: f('labels.title'),
        description: f('labels.description'),
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      widgetBlock('empty-state', { title: data.labels.title, description: f('refusal') }, f('refusal')),
      {
        ...registeredListTable('me_training', {
          variant: 'app',
          rows: f('rows'),
          rowKey: item('id'),
          columns: [
            column(f('labels.session'), link(item('name'), item('href'))),
            column(f('labels.start'), text(item('start'))),
            column(f('labels.location'), text(item('location'))),
            column(f('labels.status'), badge(item('status'), { variant: item('variant') })),
          ],
          empty: { title: f('labels.emptyTitle'), description: f('labels.emptyDescription') },
        }),
        when: f('hasContent'),
      },
    ],
  })
}
