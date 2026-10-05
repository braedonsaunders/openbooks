import 'server-only'
import { getTranslations } from 'next-intl/server'
import { notFound } from 'next/navigation'
import {
  page,
  pageHeader,
  pagination,
  column,
  link,
  badge,
  text,
  field,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { HrmPerformanceError, listConversationPage } from '@openbooks/engine/hrm/performance'
import { getAuthz } from '../../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../../lib/feature-gates'
import { hrmGroupTabs } from '../../../../../components/module-home/group-tabs'
import { isUuid, parseListParams } from '../../../../../lib/list-params'
import { registeredListTable } from '../../../../../lib/list/prepared-spec'
import {
  businessTimeZone,
  formatInZone,
  formatTimeInZone,
} from '@openbooks/engine/platform/business-date'
import { loadMeOneOnOnesPage } from '../../../me/one-on-ones/view'

const route = '/hrm/performance/conversations'
export async function loadConversations(sp: Record<string, string | undefined>) {
  const authz = await getAuthz()
  if (!authz) notFound()
  await requireFeatureEnabled(authz.user.orgId, 'hrmPerformance')
  const t = await getTranslations('hrm.talentWorkspace'),
    h = await getTranslations('hrm')
  const params = parseListParams(sp, {
    sort: 'when',
    dir: 'asc',
    allowedSorts: ['when', 'employee', 'manager'] as const,
  })
  const status = ['scheduled', 'held', 'skipped', 'cancelled'].includes(sp.status ?? '')
    ? (sp.status as 'scheduled' | 'held' | 'skipped' | 'cancelled')
    : sp.status === 'all'
      ? undefined
      : 'scheduled'
  const list = await listConversationPage({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    ...params,
    status,
    mine: sp.scope === 'mine',
  })
  const zone = await businessTimeZone(authz.user.orgId)
  const preserved = { ...sp, status: status ?? 'all', one: undefined, create: undefined }
  const href = (extra: Record<string, string> = {}) => {
    const query = new URLSearchParams(
      Object.entries({ ...preserved, ...extra }).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )
    return route + (query.size ? '?' + query : '')
  }
  if (sp.one && !isUuid(sp.one)) notFound()
  let selected: Awaited<ReturnType<typeof loadMeOneOnOnesPage>> | null = null
  if (sp.one) {
    try {
      selected = await loadMeOneOnOnesPage({ one: sp.one }, { detailOnly: true })
    } catch (error) {
      if (error instanceof HrmPerformanceError && ['NOT_FOUND', 'FORBIDDEN'].includes(error.code)) notFound()
      throw error
    }
  }
  return {
    ...list,
    tabs: await hrmGroupTabs(authz, route),
    title: t('conversations'),
    description: t('conversationWorkspaceDescription'),
    addLabel: t('newConversation'),
    addHref: href({ create: 'new' }),
    currentParams: preserved,
    sort: params.sort,
    dir: params.dir,
    rows: list.rows.map((row) => ({
      id: row.id,
      manager: row.manager,
      employee: row.employee,
      when:
        formatInZone(new Date(row.scheduledAt), zone) +
        ' ' +
        formatTimeInZone(new Date(row.scheduledAt), zone).replace(/^(\d{2})(\d{2}).*$/, '$1:$2'),
      status: h('me.oneOnOnes.' + row.status),
      href: href({ one: row.id }),
    })),
    columns: {
      when: t('conversationDate'),
      manager: t('manager'),
      employee: t('employee'),
      status: t('status'),
    },
    empty: t('noConversations'),
    searchLabel: t('searchConversations'),
    statusLabel: t('status'),
    scopeLabel: t('view'),
    filters: [
      {
        paramKey: 'status',
        label: t('status'),
        allLabel: t('allStatuses'),
        defaultValue: 'scheduled',
        options: ['scheduled', 'held', 'skipped', 'cancelled'].map((value) => ({
          value,
          label: h('me.oneOnOnes.' + value),
        })),
      },
      {
        paramKey: 'scope',
        label: t('view'),
        allLabel: t('allVisible'),
        options: [{ value: 'mine', label: t('myConversations') }],
      },
    ],
    detail: selected?.detail ? { ...selected.detail, closeHref: href() } : null,
    create: sp.create === 'new' && list.canSchedule ? { employees: [], closeHref: href() } : null,
  }
}
type Data = Awaited<ReturnType<typeof loadConversations>>
export function conversationsSpec(data: Data): PageSpec {
  return page({
    route: '/hrm/performance/conversations',
    layout: 'list',
    header: [
      pageHeader({
        title: field('title'),
        description: field('description'),
        actions: [
          ...(data.canSchedule
            ? [widget('link-button', { href: data.addHref, label: data.addLabel, iconKey: 'plus' })]
            : []),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('list-toolbar', {
        basePath: route,
        currentParams: data.currentParams,
        search: { placeholder: data.searchLabel },
        filters: data.filters,
      }),
      registeredListTable('hrm_conversation_worklist', {
        rows: field('rows'),
        rowKey: field('id'),
        empty: { title: data.empty },
        sorting: { basePath: route, sort: field('sort'), dir: field('dir') },
        columns: [
          column(data.columns.when, link(field('when'), field('href')), { sort: 'when' }),
          column(data.columns.employee, text(field('employee')), { sort: 'employee' }),
          column(data.columns.manager, text(field('manager')), { sort: 'manager' }),
          column(data.columns.status, badge(field('status'))),
        ],
      }),
      pagination({
        basePath: route,
        total: field('total'),
        page: field('currentPage'),
        perPage: field('perPage'),
      }),
      ...(data.detail ? [widgetBlock('hrm-one-on-one-drawer', { detail: data.detail })] : []),
      ...(data.create ? [widgetBlock('hrm-conversation-create', data.create)] : []),
    ],
  })
}
