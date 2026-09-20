import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  grid,
  field as item,
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
import { requirePermission } from '../../../lib/authz'
import { isFeatureEnabled } from '../../../lib/features'
import { loadMeOverview, type MeOverviewData } from '../../../lib/hrm/self-service'

/**
 * Me overview — the person's workspace landing. Employment summary,
 * open steps, pending requests, balances, and the extension rail (filled
 * from the self-service extension registry — reviews and benefits land
 * there, never as placeholders). Loader-resolved rows through the shared
 * `table` block and `filter-chips`-free panels exactly like the HR
 * overview; the primary action is the shared 'link-button' FIRST in the
 * header, then 'module-home-tabs'. Renders only when the hrm feature gate
 * is on and the actor holds hrm.self.read — the view 404s otherwise.
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
          panel({
            title: f('employmentsTitle'),
            iconKey: 'users',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
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
            ],
          }),
          panel({
            title: f('stepsTitle'),
            iconKey: 'list-checks',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
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
            ],
          }),
          panel({
            title: f('requestsTitle'),
            iconKey: 'clipboard',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              table({
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
            ],
          }),
          panel({
            title: f('balancesTitle'),
            iconKey: 'gauge',
            bodyClassName: 'min-h-0 overflow-y-auto p-0',
            blocks: [
              widgetBlock('hrm-leave-balances', {
                balances: data.balances,
                timeKindLabel: data.timeKindLabel,
                valueKindLabel: data.valueKindLabel,
                unlimitedLabel: data.unlimitedLabel,
                empty: data.balancesEmpty,
              }),
            ],
          }),
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

export async function loadMePage(): Promise<MeOverviewData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('hrm.self.read')
  if (!(await isFeatureEnabled(authz.user.orgId, 'hrm'))) notFound()
  return loadMeOverview(authz)
}

export async function meTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('me.overview.title')
}
