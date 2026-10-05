import 'server-only'

import { registeredListTable } from '../../../lib/list/prepared-spec'
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
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../lib/authz'
import { requireFeatureEnabled } from '../../../lib/feature-gates'
import { loadOrRefuse } from '../../../lib/load-or-refuse'
import { SelfServiceError } from '@openbooks/engine/src/hrm/self-service/actor.ts'
import type { MePaySection } from '../../../lib/hrm/ai-rails'
import { loadMeOverview, type MeOverviewData } from '../../../lib/hrm/self-service'

/**
 * Me overview — the person's workspace landing. Employment summary,
 * open steps, pending requests, balances, and the extension rail (filled
 * from the self-service extension registry — reviews and benefits land
 * there, never as placeholders). Loader-resolved rows through the shared
 * registered list under house headings; the primary action is the shared
 * 'link-button' FIRST in the header, then the inline 'module-home-tabs'
 * view switch. Renders only when the hrm feature gate is on and the actor
 * holds hrm.self.read — the view 404s otherwise.
 */

const f = ref<MeOverviewData>()

export function meSpec(data: MeOverviewData): PageSpec {
  return page({
    route: '/me',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget('hrm-install-app', {}),
          widget('link-button', { href: f('profileHref'), label: f('editProfile') }),
          widget('link-button', {
            href: f('checklistsHref'),
            label: f('viewChecklists'),
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
          // Employment, steps, requests, balances, qualifications and
          // payslips render as direct lists under house headings — no
          // panel repeats the section name.
          heading(2, f('employmentsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_overview_employments', {
            variant: 'app',
            rows: f('employments'),
            rowKey: item('employmentId'),
            columns: [
              column(f('employmentsColumns.employer'), text(item('employer'))),
              column(f('employmentsColumns.title'), text(item('title'))),
              column(f('employmentsColumns.department'), text(item('department'))),
              column(
                f('employmentsColumns.status'),
                badge(item('statusLabel'), { variant: item('statusVariant') }),
              ),
              column(f('employmentsColumns.manager'), text(item('manager'))),
              column(
                f('employmentsColumns.serviceStart'),
                text(item('serviceStart'), { className: 'tabular-nums' }),
              ),
            ],
            empty: { title: f('employmentsEmpty'), description: f('employmentsEmptyDescription') },
          }),
          heading(2, f('stepsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_overview_steps', {
            variant: 'app',
            rows: f('steps'),
            rowKey: item('id'),
            columns: [
              column(f('stepsColumns.title'), text(item('title'))),
              column(f('stepsColumns.process'), text(item('processKind'))),
              column(
                f('stepsColumns.due'),
                text(item('dueOn'), { className: 'tabular-nums' }),
              ),
              column(
                f('stepsColumns.status'),
                badge(item('statusLabel'), { variant: item('statusVariant') }),
              ),
            ],
            empty: { title: f('stepsEmpty'), description: f('stepsEmptyDescription') },
          }),
          heading(2, f('requestsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          registeredListTable('me_overview_requests', {
            variant: 'app',
            rows: f('requests'),
            rowKey: item('id'),
            columns: [
              column(f('requestsColumns.kind'), text(item('kindLabel'))),
              column(
                f('requestsColumns.status'),
                badge(item('statusLabel'), { variant: item('statusVariant') }),
              ),
              column(
                f('requestsColumns.submitted'),
                text(item('submittedLabel'), { className: 'tabular-nums' }),
              ),
            ],
            empty: { title: f('requestsEmpty'), description: f('requestsEmptyDescription') },
          }),
          heading(2, f('balancesTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
          widgetBlock('hrm-leave-balances', {
            balances: data.balances,
            timeKindLabel: data.timeKindLabel,
            valueKindLabel: data.valueKindLabel,
            unlimitedLabel: data.unlimitedLabel,
            empty: data.balancesEmpty,
          }),
// HR-14 begin: the viewer's own certifications needing action —
          // same shared registered list as every other overview section.
          ...(data.qualificationsState === "disabled"
            ? []
            : [
                heading(2, f('qualificationsTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
                registeredListTable('me_overview_qualifications', {
                  variant: 'app',
                  rows: f('qualifications'),
                  rowKey: item('id'),
                  columns: [
                    column(f('qualificationsColumns.type'), text(item('typeName'))),
                    column(
                      f('qualificationsColumns.expires'),
                      text(item('expiresOn'), { className: 'tabular-nums' }),
                    ),
                    column(
                      f('qualificationsColumns.status'),
                      badge(item('statusLabel'), { variant: item('statusVariant') }),
                    ),
                  ],
                  empty: { title: f('qualificationsEmpty'), description: f('qualificationsEmptyDescription') },
                }),
              ]),

          // HR-21 begin: own payslips with the Explain drawer. The trace
          // table and diff chips render from the deterministic service —
          // no LLM is needed for the drawer; assistant phrasing is optional.
          // Shown while payroll is on; the empty state covers stub-less staff.
          {
            ...heading(2, f('payTitle'), 'text-sm font-semibold text-slate-900 dark:text-slate-100'),
            when: f('hasPay'),
          },
          {
            ...registeredListTable('me_overview_pay', {
              variant: 'app',
              rows: f('payStubs'),
              rowKey: item('id'),
              columns: [
                column(
                  f('payColumns.payDate'),
                  text(item('payDate'), { className: 'tabular-nums' }),
                ),
                column(f('payColumns.gross'), text(item('gross')), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
                column(f('payColumns.netPay'), text(item('netPay')), {
                  align: 'right',
                  className: 'tabular-nums',
                }),
                column('', link(item('explainLabel'), item('explainHref'))),
              ],
              empty: { title: f('payEmpty') },
            }),
            when: f('hasPay'),
          },
          {
            ...widgetBlock(
              'hrm-explain-drawer',
              {
                explain: data.payExplain,
              },
              f('payExplain'),
            ),
            when: f('hasPay'),
          },
          // HR-21 end
          widgetBlock(
            'directory-section',
            {
              title: data.extensionsTitle,
              items: data.extensions,
            },
            f('hasExtensions'),
          ),
        ]),
        when: f('hasContent'),
      },
    ],
  })
}

/**
 * Empty pay section for the refusal path: the payslip panel hides on
 * hasPay while the refusal block carries the message.
 */
const EMPTY_PAY_SECTION: MePaySection = {
  hasPay: false,
  payTitle: '',
  payStubs: [],
  payColumns: { payDate: '', gross: '', netPay: '' },
  payEmpty: '',
  payExplain: null,
}

export async function loadMePage(sp?: Record<string, string | undefined>): Promise<MeOverviewData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.self.read')
  await requireFeatureEnabled(authz.user.orgId, 'hrm')
  const overview = await loadMeOverview(authz)
  // HR-21: own payslips with the Explain drawer (?explain=<stubId>). The
  // stubs resolve through the same person link, so an unlinked login
  // refuses here too — convert only NO_LINK to the refusal state through
  // the shared mechanism (same as the clock); everything else still
  // throws. A refusal the overview already carries wins: it names the
  // same condition from the same link.
  const t = await getTranslations('hrm')
  const { loadMePaySection } = await import('../../../lib/hrm/ai-rails')
  const pay = await loadOrRefuse(() => loadMePaySection(authz, sp?.explain), {
    refusals: [{ error: SelfServiceError, code: 'NO_LINK' }],
    title: t('me.refusedTitle'),
  })
  if (pay.ok) return { ...overview, ...pay.data }
  return { ...overview, ...EMPTY_PAY_SECTION, refusal: overview.refusal ?? pay.refusal }
}

export async function meTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.overview.title')
}
