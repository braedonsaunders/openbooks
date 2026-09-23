import 'server-only'

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
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { loadAnomalyChecks, type AnomalyChecksData } from '../../../../lib/hrm/ai-rails'

/**
 * Payroll checks — the deterministic pre-run anomaly queue (HR-21).
 *
 * Stat tiles (blocking, warnings, acknowledged this period,
 * false-positive rate), severity/kind/status filter chips, the flags
 * table with explanations, and a flag drawer with the numbers and
 * acknowledge/resolve/false-positive actions. Blocking flags refuse the
 * pay-run finalize while open — the run wizard's review step links here
 * and finalizes through the same gate.
 */

const f = ref<AnomalyChecksData>()

export function anomalyChecksSpec(data: AnomalyChecksData): PageSpec {
  return page({
    route: '/payroll/anomalies',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget(
            'payroll-anomaly-scan',
            {
              currentParams: data.currentParams,
              scanLabel: data.scanLabel,
              scanBusyLabel: data.scanBusyLabel,
              scanFailedLabel: data.scanFailedLabel,
            },
            f('canScan'),
          ),
          widget('link-button', { href: f('finalizeHref'), label: f('runsLabel'), variant: 'outline' }),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      grid('grid grid-cols-2 gap-4 xl:grid-cols-4', [
        statTile({ iconKey: 'siren', accent: 'red', label: f('tiles.blocking'), value: f('stats.blocking'), tone: f('blockingTone') }),
        statTile({ iconKey: 'triangle-alert', accent: 'amber', label: f('tiles.warnings'), value: f('stats.warnings'), tone: f('warningsTone') }),
        statTile({ iconKey: 'clipboard-check', accent: 'teal', label: f('tiles.acknowledged'), value: f('stats.acknowledged') }),
        statTile({ iconKey: 'scale', accent: 'indigo', label: f('tiles.falsePositiveRate'), value: f('stats.falsePositiveRate') }),
      ]),
      widgetBlock('filter-chips', {
        basePath: '/payroll/anomalies',
        currentParams: data.currentParams,
        paramKey: 'severity',
        label: data.severityLabel,
        allLabel: data.allLabel,
        options: data.severityOptions,
      }),
      widgetBlock('filter-chips', {
        basePath: '/payroll/anomalies',
        currentParams: data.currentParams,
        paramKey: 'kind',
        label: data.kindLabel,
        allLabel: data.allLabel,
        options: data.kindOptions,
      }),
      widgetBlock('filter-chips', {
        basePath: '/payroll/anomalies',
        currentParams: data.currentParams,
        paramKey: 'status',
        label: data.statusLabel,
        allLabel: data.allLabel,
        options: data.statusOptions,
      }),
      panel({
        title: f('listTitle'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        blocks: [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns: [
              column(f('columns.severity'), badge(item('severityLabel'), { variant: item('severityVariant') })),
              column(f('columns.kind'), text(item('kindLabel'))),
              column(f('columns.period'), text(item('periodLabel'), { className: 'tabular-nums' })),
              column(f('columns.employment'), text(item('employmentLabel'))),
              column(f('columns.explanation'), text(item('explanation'))),
              column(f('columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              column('', link(item('openLabel'), item('flagHref'))),
            ],
            empty: { title: f('emptyTitle'), description: f('emptyDescription') },
          }),
          widgetBlock(
            'payroll-anomaly-drawer',
            {
              flag: data.dialogFlag,
              closeHref: data.dialogCloseHref,
            },
            f('dialogOpen'),
          ),
        ],
      }),
    ],
  })
}

export async function loadAnomalyChecksPage(
  sp: Record<string, string | undefined>,
): Promise<AnomalyChecksData> {
  // The page gate lives here — where the route-gate scanner reads — and the
  // loader enforces nothing twice: it takes the authorized session as input.
  const authz = await requirePermission('payroll.manage')
  // Either anomaly surface admits: the remedy names the payroll switch, the
  // page's own, while the time switch alone still opens the queue.
  if (
    !(await isFeatureEnabled(authz.user.orgId, 'hrmPayrollAnomalies')) &&
    !(await isFeatureEnabled(authz.user.orgId, 'hrmTimeAnomalies'))
  ) {
    await requireFeatureEnabled(authz.user.orgId, 'hrmPayrollAnomalies')
  }
  return loadAnomalyChecks(authz, sp)
}

export async function anomalyChecksTitle(): Promise<string> {
  const t = await getTranslations('payroll')
  return t('anomalies.title')
}
