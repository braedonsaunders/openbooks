import 'server-only'

import { registeredListTable } from '../../../../lib/list/prepared-spec'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
  heading,
  link,
  page,
  pageHeader,
  ref,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
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
          // Roster, steps, leave, changes and owed reviews render as
          // direct lists under house headings — no panel repeats the
          // section name. Approve/decline still rides native Approvals:
          // rows deep-link there and build no second decision path.
          heading(2, f('rosterTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_team_roster', {
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
              // HR-17: the 1:1 column and the per-report praise action.
              // Rows without the switches resolve null hrefs/props, so
              // the cells stay empty instead of promising a 404.
              column(f('rosterColumns.oneOnOne'), link(item('oneOnOneLabel'), item('oneOnOneHref'))),
              column(
                f('rosterColumns.feedback'),
                widgetCell('hrm-feedback-dialog', {
                  subjectEmploymentId: item('feedback.subjectEmploymentId'),
                  requestedFromPartyId: item('feedback.requestedFromPartyId'),
                  subjectLabel: item('feedback.subjectLabel'),
                  requestId: null,
                  kinds: item('feedback.kinds'),
                  kindLabel: item('feedback.kindLabel'),
                  visibilities: item('feedback.visibilities'),
                  visibilityLabel: item('feedback.visibilityLabel'),
                  bodyLabel: item('feedback.bodyLabel'),
                  bodyPlaceholder: item('feedback.bodyPlaceholder'),
                  submitLabel: item('feedback.submitLabel'),
                  cancelLabel: item('feedback.cancelLabel'),
                  closeHref: item('feedback.closeHref'),
                  failed: item('feedback.failed'),
                  openLabel: item('feedback.openLabel'),
                }),
              ),
            ],
            empty: { title: f('rosterEmpty') },
          }),
          heading(2, f('stepsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_team_steps', {
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
          heading(2, f('leaveTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_team_leave', {
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
          heading(2, f('changesTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_team_changes', {
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
          heading(2, f('owedTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_team_owed', {
            variant: 'app',
            rows: f('owedReviews'),
            rowKey: item('reviewId'),
            columns: [
              column(f('owedColumns.employee'), text(item('workerName'))),
              column(f('owedColumns.cycle'), text(item('cycleName'))),
              column(
                f('owedColumns.status'),
                badge(item('statusLabel'), { variant: item('statusVariant') }),
              ),
              column(
                f('owedColumns.due'),
                text(item('dueOn'), { className: 'tabular-nums' }),
              ),
              column('', link(item('openLabel'), item('openHref'))),
            ],
            empty: { title: f('owedEmpty'),
              description: f("owedDescription"),
            },
          }),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

export async function loadMeTeamPage(): Promise<MeTeamData> {
  const authz = await requirePermission('hrm.self.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  return loadMeTeam(authz)
}

export async function meTeamTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.team.title')
}
