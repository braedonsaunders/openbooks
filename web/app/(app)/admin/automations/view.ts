import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  page,
  pageHeader,
  ref,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { requireFeatureEnabled } from '../../../../lib/feature-gates'
import { pickString } from '../../../../lib/list-params'
import { dateTime } from '../../../../lib/format'
import { listAutomations } from '@openbooks/engine/src/automations/services.ts'
import { loadApprovalSettings } from '@openbooks/engine/src/automations/approvals.ts'

/**
 * The automations list, split into a loader and a spec.
 *
 * Mirrors the flows list archetype: a `table` block (variant 'app') over
 * loader-resolved rows, status segments through the shared `filter-chips`
 * widget, and the primary action as a header widget opening the
 * new-automation dialog. Rows carry status chips, the last run, and the
 * error the run log shows.
 */

const BASE = '/admin/automations'

const STATUS_VARIANT: Record<string, 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'> = {
  enabled: 'success',
  draft: 'secondary',
  disabled: 'outline',
  error: 'destructive',
}

export interface AutomationListRow {
  id: string
  name: string
  href: string
  status: string
  statusLabel: string
  statusVariant: 'success' | 'warning' | 'destructive' | 'secondary' | 'outline'
  triggerLabel: string
  lastRunAt: string | null
  neverRanLabel: string
  error: string | null
}

export interface AutomationsData {
  title: string
  description: string
  backHref: string
  backLabel: string
  statusLabel: string
  statusOptions: { value: string; label: string; count: number }[]
  currentParams: Record<string, string | string[] | undefined>
  isEmpty: boolean
  emptyTitle: string
  emptyDescription: string
  newLabel: string
  columnAutomation: string
  columnStatus: string
  columnTrigger: string
  columnLastRun: string
  columnError: string
  columnActions: string
  rows: AutomationListRow[]
  runLabel: string
  enableLabel: string
  disableLabel: string
  actionFailed: string
  approvalTitle: string
  approvalHelp: string
  approvalException: string
  approvalThresholds: string
  approvalAuto: string
  approvalDelegate: string
  approvalExclude: string
  approvalYes: string
  approvalNo: string
  approvalSave: string
  approvalSaved: string
  approvalFailed: string
  approvalSettings: {
    subjectKind: string
    exceptionOnly: boolean
    thresholds: Record<string, unknown>
    autoApproveWhenNoRule: boolean
    delegateAfterDays: number | null
    excludeInitiator: boolean
  }[]
}

export async function loadAutomations(
  searchParams: Record<string, string | string[] | undefined>,
): Promise<AutomationsData> {
  const authz = await requirePermission('automations.read')
  await requireFeatureEnabled(authz.user.orgId, 'automations')
  const t = await getTranslations('admin.automations')
  const status = pickString(searchParams.status)

  const automations = await listAutomations(authz.user.orgId, authz.user.id)
  // Exception-only approval tuning per subject kind (a setting over Flows
  // gates, rehomed off setup onto this page): defaults when never saved.
  const subjectKinds = ['timesheet_week', 'leave_request', 'expense_report']
  const approvalSettings = await Promise.all(
    subjectKinds.map(async (subjectKind) => {
      const saved = await loadApprovalSettings(authz.user.orgId, subjectKind)
      return {
        subjectKind,
        exceptionOnly: saved?.exceptionOnly ?? false,
        thresholds: (saved?.thresholds ?? {}) as Record<string, unknown>,
        autoApproveWhenNoRule: saved?.autoApproveWhenNoRule ?? false,
        delegateAfterDays: saved?.delegateAfterDays ?? null,
        excludeInitiator: saved?.excludeInitiator ?? true,
      }
    }),
  )
  const counts = new Map<string, number>()
  for (const a of automations) counts.set(a.status, (counts.get(a.status) ?? 0) + 1)
  const statuses = ['enabled', 'draft', 'disabled', 'error']
  const rows: AutomationListRow[] = automations
    .filter((a) => !status || a.status === status)
    .map((a) => {
      const trigger = (a.trigger ?? {}) as Record<string, unknown>
      return {
        id: a.id,
        name: a.name,
        href: `${BASE}/${a.id}`,
        status: a.status,
        statusLabel: t(`status.${a.status}`),
        statusVariant: STATUS_VARIANT[a.status] ?? 'outline',
        triggerLabel: t(`triggerKinds.${String(trigger.kind ?? 'manual')}`),
        lastRunAt: a.lastRunAt ? dateTime(a.lastRunAt) : null,
        neverRanLabel: t('list.neverRan'),
        error: a.errorMessage,
      }
    })

  return {
    title: t('title'),
    description: t('description'),
    backHref: '/admin/flows',
    backLabel: t('backToFlows'),
    statusLabel: t('list.statusLabel'),
    statusOptions: statuses.map((value) => ({
      value,
      label: t(`status.${value}`),
      count: counts.get(value) ?? 0,
    })),
    currentParams: searchParams,
    isEmpty: automations.length === 0,
    emptyTitle: t('list.emptyTitle'),
    emptyDescription: t('list.emptyDescription'),
    newLabel: t('list.newButton'),
    columnAutomation: t('list.columnAutomation'),
    columnStatus: t('list.columnStatus'),
    columnTrigger: t('list.columnTrigger'),
    columnLastRun: t('list.columnLastRun'),
    columnError: t('list.columnError'),
    columnActions: t('list.columnActions'),
    rows,
    runLabel: t('list.runNow'),
    enableLabel: t('list.enable'),
    disableLabel: t('list.disable'),
    actionFailed: t('list.actionFailed'),
    approvalTitle: t('builder.approvalTitle'),
    approvalHelp: t('builder.approvalHelp'),
    approvalException: t('builder.approvalException'),
    approvalThresholds: t('builder.approvalThresholds'),
    approvalAuto: t('builder.approvalAuto'),
    approvalDelegate: t('builder.approvalDelegate'),
    approvalExclude: t('builder.approvalExclude'),
    approvalYes: t('builder.approvalYes'),
    approvalNo: t('builder.approvalNo'),
    approvalSave: t('builder.approvalSave'),
    approvalSaved: t('builder.saved'),
    approvalFailed: t('builder.saveFailed'),
    approvalSettings,
  }
}

export function automationsSpec(data: AutomationsData): PageSpec {
  const f = ref<AutomationsData>()
  return page({
    route: '/admin/automations',
    layout: 'list',
    header: [
      pageHeader({
        back: { href: f('backHref'), label: f('backLabel') },
        title: f('title'),
        description: f('description'),
        actions: [widget('new-automation', { label: f('newLabel') })],
      }),
      widgetBlock('filter-chips', {
        basePath: BASE,
        currentParams: data.currentParams,
        paramKey: 'status',
        label: data.statusLabel,
        options: data.statusOptions,
      }),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          icon: 'workflow',
          title: data.emptyTitle,
          description: data.emptyDescription,
          action: 'new-automation',
        }),
        when: f('isEmpty'),
      },
      table({
        variant: 'app',
        rows: f('rows'),
        rowKey: item('id'),
        columns: [
          column(
            f('columnAutomation'),
            widgetCell('automation-name-cell', { name: item('name'), href: item('href') }),
          ),
          column(f('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
          column(f('columnTrigger'), text(item('triggerLabel'))),
          column(
            f('columnLastRun'),
            widgetCell('automation-last-run-cell', { at: item('lastRunAt'), fallback: item('neverRanLabel') }),
          ),
          column(f('columnError'), text(item('error'))),
          column(
            f('columnActions'),
            widgetCell('automation-row-actions', {
              id: item('id'),
              status: item('status'),
              runLabel: f('runLabel'),
              enableLabel: f('enableLabel'),
              disableLabel: f('disableLabel'),
              actionFailed: f('actionFailed'),
            }),
          ),
        ],
        empty: { title: f('emptyTitle'), description: f('emptyDescription') },
      }),
      widgetBlock('automation-approval-settings', {
        settings: f('approvalSettings'),
        saveFailed: f('approvalFailed'),
        savedLabel: f('approvalSaved'),
        saveLabel: f('approvalSave'),
        titleLabel: f('approvalTitle'),
        helpLabel: f('approvalHelp'),
        exceptionLabel: f('approvalException'),
        thresholdsLabel: f('approvalThresholds'),
        autoApproveLabel: f('approvalAuto'),
        delegateLabel: f('approvalDelegate'),
        excludeLabel: f('approvalExclude'),
        yesLabel: f('approvalYes'),
        noLabel: f('approvalNo'),
      }),
    ],
  })
}
