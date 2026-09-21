import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  grid,
  link,
  panel,
  page,
  pageHeader,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import {
  getOneOnOne,
  listOneOnOneDirectory,
  listOneOnOnes,
} from '@openbooks/engine/src/hrm/performance/one-on-ones.ts'
import { listOpenRequestsForParty } from '@openbooks/engine/src/hrm/performance/feedback.ts'
import { getAuthz } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { meTabs } from '../../../../lib/hrm/self-service'

/**
 * Me 1:1s — upcoming and past conversations with the agenda drawer
 * (talking points, action items with done toggles, the private notes
 * area, and the "carry forward" chip), plus open feedback requests with
 * the fulfil form. Renders only when hrm, hrmPerformance and hrmOneOnOnes
 * are on; rows stay loader-resolved through the governed services, and
 * private items arrive already filtered to their author.
 */

const f = ref<MeOneOnOnesData>()

export interface AgendaRow {
  id: string
  kind: string
  kindLabel: string
  authorMine: boolean
  body: string
  visibility: string
  visibilityLabel: string
  status: string
  carriedLabel: string | null
  doneLabel: string
  reopenLabel: string
}

export interface MeOneOnOnesData {
  title: string
  description: string
  tabs: { href: string; label: string; active?: boolean }[]
  upcomingTitle: string
  pastTitle: string
  requestsTitle: string
  cols: { when: string; with: string; status: string }
  upcoming: { id: string; when: string; other: string; status: string; statusLabel: string; href: string }[]
  past: { id: string; when: string; other: string; status: string; statusLabel: string; href: string }[]
  upcomingEmpty: string
  pastEmpty: string
  requests: { id: string; body: string; subject: string; href: string }[]
  requestsEmpty: string
  detail: {
    id: string
    title: string
    when: string
    with: string
    status: string
    canWrite: boolean
    items: AgendaRow[]
    newKinds: { value: string; label: string }[]
    newKindLabel: string
    bodyLabel: string
    bodyPlaceholder: string
    privateLabel: string
    sharedLabel: string
    addLabel: string
    holdLabel: string
    skipLabel: string
    skipReasonLabel: string
    cancelLabel: string
    carryNote: string | null
    failed: string
    closeHref: string
  } | null
  requestDetail: {
    requestId: string
    subjectLabel: string
    kinds: { value: string; label: string }[]
    kindLabel: string
    visibilities: { value: string; label: string }[]
    visibilityLabel: string
    bodyLabel: string
    bodyPlaceholder: string
    submitLabel: string
    cancelLabel: string
    closeHref: string
    failed: string
    openLabel: string
    subjectEmploymentId: string
  } | null
  drawerOpen: boolean
}

export function meOneOnOnesSpec(data: MeOneOnOnesData): PageSpec {
  return page({
    route: '/me/one-on-ones',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [widget('module-home-tabs', { tabs: data.tabs })],
      }),
    ],
    body: [
      grid('flex h-full min-h-0 flex-col gap-4', [
        panel({
          title: f('upcomingTitle'),
          iconKey: 'calendar',
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('upcoming'),
              rowKey: item('id'),
              empty: { title: f('upcomingEmpty') },
              columns: [
                column(data.cols.when, link(item('when'), item('href'))),
                column(data.cols.with, text(item('other'))),
                column(data.cols.status, badge(item('statusLabel'), { variant: 'secondary' })),
              ],
            }),
          ],
        }),
        panel({
          title: f('pastTitle'),
          iconKey: 'history',
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('past'),
              rowKey: item('id'),
              empty: { title: f('pastEmpty') },
              columns: [
                column(data.cols.when, link(item('when'), item('href'))),
                column(data.cols.with, text(item('other'))),
                column(data.cols.status, badge(item('statusLabel'), { variant: 'secondary' })),
              ],
            }),
          ],
        }),
        panel({
          title: f('requestsTitle'),
          iconKey: 'message-square',
          bodyClassName: 'min-h-0 overflow-y-auto p-0',
          blocks: [
            table({
              variant: 'app',
              rows: f('requests'),
              rowKey: item('id'),
              empty: { title: f('requestsEmpty') },
              columns: [
                column(data.requestsTitle, link(item('body'), item('href'))),
                column(data.cols.with, text(item('subject'))),
              ],
            }),
          ],
        }),
      ]),
      {
        ...widgetBlock('hrm-one-on-one-drawer', { detail: data.detail }),
        when: f('drawerOpen'),
      },
      widgetBlock('hrm-feedback-dialog', {
        subjectEmploymentId: data.requestDetail?.subjectEmploymentId ?? '',
        subjectLabel: data.requestDetail?.subjectLabel ?? '',
        requestId: data.requestDetail?.requestId ?? null,
        kinds: data.requestDetail?.kinds ?? [],
        kindLabel: data.requestDetail?.kindLabel ?? '',
        visibilities: data.requestDetail?.visibilities ?? [],
        visibilityLabel: data.requestDetail?.visibilityLabel ?? '',
        bodyLabel: data.requestDetail?.bodyLabel ?? '',
        bodyPlaceholder: data.requestDetail?.bodyPlaceholder ?? '',
        submitLabel: data.requestDetail?.submitLabel ?? '',
        cancelLabel: data.requestDetail?.cancelLabel ?? '',
        closeHref: data.requestDetail?.closeHref ?? '/me/one-on-ones',
        failed: data.requestDetail?.failed ?? '',
        openLabel: data.requestDetail?.openLabel ?? '',
      }),
    ],
  })
}

export async function meOneOnOnesTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.oneOnOnes.title')
}

export async function loadMeOneOnOnesPage(
  sp: Record<string, string | undefined>,
): Promise<MeOneOnOnesData> {
  const authz = await getAuthz()
  if (!authz) notFound()
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmPerformance'))) notFound()
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrmOneOnOnes'))) notFound()
  const t = await getTranslations('hrm')
  const tabs = await meTabs(authz, '/me/one-on-ones')

  const reportFilter = typeof sp.report === 'string' && sp.report.length > 0 ? sp.report : null
  const ones = await listOneOnOnes({
    orgId: authz.user.orgId,
    actorId: authz.user.id,
    ...(reportFilter ? { employmentId: reportFilter } : {}),
  })
  const directory = await listOneOnOneDirectory({ orgId: authz.user.orgId, actorId: authz.user.id }).catch(() => null)
  const names = new Map((directory?.employments ?? []).map((e) => [e.id, e.name]))
  const otherName = (one: { managerEmploymentId: string; reportEmploymentId: string; managerName: string; reportName: string }): string => {
    const mineFirst = directory?.employments.find((e) => e.mine)
    if (mineFirst) {
      return one.managerEmploymentId === mineFirst.id ? one.reportName : one.managerName
    }
    return names.get(one.reportEmploymentId) ?? one.reportName
  }
  const statusLabel = (status: string): string =>
    status === 'held' ? t('me.oneOnOnes.held')
    : status === 'skipped' ? t('me.oneOnOnes.skipped')
    : status === 'cancelled' ? t('me.oneOnOnes.cancelled')
    : t('me.oneOnOnes.scheduled')
  const toRow = (one: (typeof ones)[number]) => ({
    id: one.id,
    when: one.scheduledAt.slice(0, 16).replace('T', ' '),
    other: otherName(one),
    status: one.status,
    statusLabel: statusLabel(one.status),
    href: `/me/one-on-ones?one=${one.id}`,
  })
  const upcoming = ones.filter((o) => o.status === 'scheduled').map(toRow)
  const past = ones.filter((o) => o.status !== 'scheduled').map(toRow)

  let requests: MeOneOnOnesData['requests'] = []
  try {
    const open = await listOpenRequestsForParty({ orgId: authz.user.orgId, actorId: authz.user.id })
    requests = open.map((r) => ({
      id: r.id,
      body: r.body.length > 80 ? `${r.body.slice(0, 80)}…` : r.body,
      subject: r.subjectName,
      href: `/me/one-on-ones?request=${r.id}`,
    }))
  } catch {
    requests = []
  }

  const oneId = typeof sp.one === 'string' && sp.one.length > 0 ? sp.one : null
  let detail: MeOneOnOnesData['detail'] = null
  if (oneId) {
    try {
      const one = await getOneOnOne({ orgId: authz.user.orgId, actorId: authz.user.id, id: oneId })
      detail = {
        id: one.id,
        title: `${otherName(one)} · ${one.scheduledAt.slice(0, 16).replace('T', ' ')}`,
        when: one.scheduledAt,
        with: otherName(one),
        status: one.status,
        canWrite: one.status === 'scheduled',
        items: one.items.map((i) => ({
          id: i.id,
          kind: i.kind,
          kindLabel:
            i.kind === 'action_item' ? t('me.oneOnOnes.actionItem')
            : i.kind === 'note' ? t('me.oneOnOnes.note')
            : t('me.oneOnOnes.talkingPoint'),
          authorMine: false,
          body: i.body,
          visibility: i.visibility,
          visibilityLabel: i.visibility === 'private' ? t('me.oneOnOnes.private') : t('me.oneOnOnes.shared'),
          status: i.status,
          carriedLabel: i.status === 'carried' ? t('me.oneOnOnes.carriedForward') : null,
          doneLabel: t('me.oneOnOnes.done'),
          reopenLabel: t('me.oneOnOnes.reopen'),
        })),
        newKinds: [
          { value: 'talking_point', label: t('me.oneOnOnes.talkingPoint') },
          { value: 'action_item', label: t('me.oneOnOnes.actionItem') },
          { value: 'note', label: t('me.oneOnOnes.note') },
        ],
        newKindLabel: t('me.oneOnOnes.kindLabel'),
        bodyLabel: t('me.oneOnOnes.bodyLabel'),
        bodyPlaceholder: t('me.oneOnOnes.bodyPlaceholder'),
        privateLabel: t('me.oneOnOnes.privateNote'),
        sharedLabel: t('me.oneOnOnes.shared'),
        addLabel: t('me.oneOnOnes.addItem'),
        holdLabel: t('me.oneOnOnes.hold'),
        skipLabel: t('me.oneOnOnes.skip'),
        skipReasonLabel: t('me.oneOnOnes.skipReason'),
        cancelLabel: t('me.oneOnOnes.cancelMeeting'),
        carryNote: t('me.oneOnOnes.carryNote'),
        failed: t('me.oneOnOnes.actionFailed'),
        closeHref: '/me/one-on-ones',
      }
    } catch {
      detail = null
    }
  }

  const requestId = typeof sp.request === 'string' && sp.request.length > 0 ? sp.request : null
  let requestDetail: MeOneOnOnesData['requestDetail'] = null
  if (requestId) {
    try {
      const open = await listOpenRequestsForParty({ orgId: authz.user.orgId, actorId: authz.user.id })
      const req = open.find((r) => r.id === requestId)
      if (req) {
        requestDetail = {
          requestId: req.id,
          subjectLabel: req.subjectName,
          kinds: [],
          kindLabel: '',
          visibilities: [
            { value: 'manager_and_subject', label: t('performance.continuous.feedback.managerAndSubject') },
            { value: 'manager_only', label: t('performance.continuous.feedback.managerOnly') },
            { value: 'subject_only', label: t('performance.continuous.feedback.subjectOnly') },
          ],
          visibilityLabel: t('performance.continuous.feedback.visibilityLabel'),
          bodyLabel: t('performance.continuous.feedback.bodyLabel'),
          bodyPlaceholder: t('performance.continuous.feedback.bodyPlaceholder'),
          submitLabel: t('performance.continuous.feedback.submitLabel'),
          cancelLabel: t('performance.cancel'),
          closeHref: '/me/one-on-ones',
          failed: t('me.oneOnOnes.actionFailed'),
          openLabel: t('performance.continuous.feedback.respondLabel'),
          subjectEmploymentId: req.subjectEmploymentId,
        }
      }
    } catch {
      requestDetail = null
    }
  }

  return {
    title: t('me.oneOnOnes.title'),
    description: t('me.oneOnOnes.description'),
    tabs,
    upcomingTitle: t('me.oneOnOnes.upcoming'),
    pastTitle: t('me.oneOnOnes.past'),
    requestsTitle: t('me.oneOnOnes.requests'),
    cols: {
      when: t('me.oneOnOnes.colWhen'),
      with: t('me.oneOnOnes.colWith'),
      status: t('me.oneOnOnes.colStatus'),
    },
    upcoming,
    past,
    upcomingEmpty: t('me.oneOnOnes.upcomingEmpty'),
    pastEmpty: t('me.oneOnOnes.pastEmpty'),
    requests,
    requestsEmpty: t('me.oneOnOnes.requestsEmpty'),
    detail,
    requestDetail,
    drawerOpen: detail !== null,
  }
}
