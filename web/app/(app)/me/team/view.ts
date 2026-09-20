import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  link,
  page,
  pageHeader,
  panel,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadMeTeam, type MeTeamData } from '../../../../lib/hrm/self-service'

/**
 * Me team — the manager's direct reports as of today: roster, open steps
 * assigned to the manager, pending leave, and pending change requests.
 * Approve/decline rides native Approvals: rows deep-link there and build
 * no second decision path. Renders only when the hrm feature gate is on
 * and the actor holds hrm.self.read; a report-less caller reads the
 * refusal, never an empty team.
 */

const f = ref<MeTeamData>()

export function meTeamSpec(data: MeTeamData): PageSpec {
  return page({
    route: '/me/team',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('link-button', {
            href: f('approvalsHref'),
            label: f('decideInApprovals'),
            variant: 'outline',
          }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock(
        'empty-state',
        {
          title: data.refusal?.title ?? '',
          description: data.refusal?.message,
        },
        f('refusal'),
      ),
      {
        ...grid('flex h-full min-h-0 flex-col gap-4', [
          panel({
            title: f('rosterTitle'),
            iconKey: 'users',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('roster'),
                rowKey: item('employmentId'),
                columns: [
                  column(f('rosterColumns.name'), link(item('workerName'), item('workerHref'))),
                  column(f('rosterColumns.title'), text(item('title'))),
                  column(f('rosterColumns.department'), text(item('department'))),
                  column(
                    f('rosterColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column(
                    f('rosterColumns.serviceStart'),
                    text(item('serviceStart'), { className: 'tabular-nums' }),
                  ),
                ],
                empty: { title: f('rosterEmpty') },
              }),
            ],
          }),
          panel({
            title: f('stepsTitle'),
            iconKey: 'list-checks',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('teamSteps'),
                rowKey: item('id'),
                columns: [
                  column(f('stepsColumns.employee'), text(item('workerName'))),
                  column(f('stepsColumns.title'), text(item('title'))),
                  column(
                    f('stepsColumns.due'),
                    text(item('dueOn'), { className: 'tabular-nums' }),
                  ),
                ],
                empty: { title: f('stepsEmpty') },
              }),
            ],
          }),
          panel({
            title: f('leaveTitle'),
            iconKey: 'calendar-clock',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('pendingLeave'),
                rowKey: item('id'),
                columns: [
                  column(f('leaveColumns.employee'), text(item('workerName'))),
                  column(f('leaveColumns.type'), text(item('leaveTypeCode'))),
                  column(
                    f('leaveColumns.range'),
                    text(item('rangeLabel'), { className: 'tabular-nums' }),
                  ),
                  column(f('leaveColumns.hours'), text(item('hours')), {
                    align: 'right',
                    className: 'tabular-nums',
                  }),
                  column('', link(item('decideLabel'), item('decideHref'))),
                ],
                empty: { title: f('leaveEmpty') },
              }),
            ],
          }),
          panel({
            title: f('changesTitle'),
            iconKey: 'clipboard',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
                variant: 'app',
                rows: f('pendingChanges'),
                rowKey: item('id'),
                columns: [
                  column(f('changesColumns.employee'), text(item('workerName'))),
                  column(f('changesColumns.kind'), text(item('kindLabel'))),
                  column(
                    f('changesColumns.status'),
                    badge(item('statusLabel'), { variant: item('statusVariant') }),
                  ),
                  column('', link(item('decideLabel'), item('decideHref'))),
                ],
                empty: { title: f('changesEmpty') },
              }),
            ],
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeTeamPage(): Promise<MeTeamData> {
  const authz = await requirePermission('hrm.self.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadMeTeam(authz)
}

export async function meTeamTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.team.title')
}
