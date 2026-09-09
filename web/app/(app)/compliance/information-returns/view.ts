import 'server-only'

import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  page,
  pageHeader,
  ref,
  rootRef,
  table,
  text,
  textBlock,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@openbooks/viewspec'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { FORM_TYPES } from '@openbooks/engine/src/information-returns.ts'
import { can, requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import {
  loadFilings,
  loadInformationReturnReadiness,
  requireComplianceFeature,
} from '../../../../lib/compliance'
import { getMoneyFormatter } from '@/lib/money-server'
import { complianceTabs } from '../tabs'

/**
 * Information-return filings by year. One row per (year, form, filing entity),
 * with the readiness queue underneath — the list of vendors that will make a
 * filing wrong if nobody chases them before January.
 *
 * The readiness queue is a real <section> with its own heading and prose, so
 * the vocabulary gained a `heading` block and an `as: 'section'` grid. An <h2>
 * is not a <p>, and the element name is part of the document rather than
 * decoration, so approximating either would be a real difference.
 */

const STATUS_TONE: Record<string, 'success' | 'warning' | 'secondary' | 'outline' | 'destructive'> = {
  draft: 'outline',
  computed: 'warning',
  finalized: 'success',
  filed: 'success',
  void: 'secondary',
}

export interface FilingRow {
  id: string
  taxYear: string
  href: string
  formType: string
  entity: string
  includedCount: string
  excludedNote: string
  filedTotal: string
  statusLabel: string
  statusVariant: 'success' | 'warning' | 'secondary' | 'outline' | 'destructive'
  missingTin: boolean
  missingTinLabel: string
}

export interface ReadinessRow {
  partyId: string
  vendorName: string
  href: string
  issueLabel: string
  issueVariant: 'destructive' | 'warning'
  classification: string
  paidThisYear: string
}

export interface InformationReturnsData {
  title: string
  description: string
  tabs: Awaited<ReturnType<typeof complianceTabs>>
  canManage: boolean
  formTypes: string[]
  defaultYear: number
  emptyTitle: string
  emptyDescription: string
  noFilings: boolean
  hasFilings: boolean
  columnYear: string
  columnForm: string
  columnEntity: string
  columnRecipients: string
  columnTotal: string
  columnStatus: string
  columnAttention: string
  rows: FilingRow[]
  readinessTitle: string
  readinessDescription: string
  readinessClear: string
  readinessIsClear: boolean
  readinessHasRows: boolean
  columnVendor: string
  columnIssue: string
  columnClassification: string
  columnPaid: string
  readiness: ReadinessRow[]
}

export async function loadInformationReturns(): Promise<InformationReturnsData> {
  const authz = await requirePermission('compliance.read')
  const orgId = authz.user.orgId
  await requireComplianceFeature(orgId)
  const t = await getTranslations('compliance')
  const { money } = await getMoneyFormatter()
  const lastYear = Number((await businessToday(orgId)).slice(0, 4)) - 1

  const [filings, readiness, projectsEnabled] = await Promise.all([
    loadFilings(orgId, authz.allowedSubsidiaryIds),
    loadInformationReturnReadiness(orgId, lastYear, authz.allowedSubsidiaryIds),
    isFeatureEnabled(orgId, 'projects'),
  ])
  const tabs = await complianceTabs('/compliance/information-returns', { projectsEnabled })

  return {
    title: t('informationReturns.title'),
    description: t('informationReturns.description'),
    tabs,
    canManage: can(authz, 'compliance.manage'),
    formTypes: [...FORM_TYPES],
    defaultYear: lastYear,
    emptyTitle: t('informationReturns.empty.title'),
    emptyDescription: t('informationReturns.empty.description'),
    noFilings: filings.length === 0,
    hasFilings: filings.length > 0,
    columnYear: t('informationReturns.columns.year'),
    columnForm: t('informationReturns.columns.form'),
    columnEntity: t('informationReturns.columns.entity'),
    columnRecipients: t('informationReturns.columns.recipients'),
    columnTotal: t('informationReturns.columns.total'),
    columnStatus: t('informationReturns.columns.status'),
    columnAttention: t('informationReturns.columns.attention'),
    rows: filings.map((filing) => ({
      id: filing.id,
      taxYear: String(filing.taxYear),
      href: `/compliance/information-returns/${filing.id}`,
      formType: filing.formType,
      entity: filing.subsidiaryName ?? t('informationReturns.orgRoot'),
      includedCount: String(filing.includedCount),
      excludedNote:
        filing.excludedCount > 0
          ? t('informationReturns.excluded', { count: filing.excludedCount })
          : '',
      filedTotal: money(filing.filedTotal, { currency: filing.currency }),
      statusLabel: t(`filingStatus.${filing.status}`),
      statusVariant: STATUS_TONE[filing.status] ?? 'secondary',
      missingTin: filing.missingTinCount > 0,
      missingTinLabel:
        filing.missingTinCount > 0
          ? t('informationReturns.missingTin', { count: filing.missingTinCount })
          : '',
    })),
    readinessTitle: t('informationReturns.readinessTitle', { year: lastYear }),
    readinessDescription: t('informationReturns.readinessDescription'),
    readinessClear: t('informationReturns.readinessClear'),
    readinessIsClear: readiness.length === 0,
    readinessHasRows: readiness.length > 0,
    columnVendor: t('informationReturns.columns.vendor'),
    columnIssue: t('informationReturns.columns.issue'),
    columnClassification: t('informationReturns.columns.classification'),
    columnPaid: t('informationReturns.columns.paid'),
    readiness: readiness.map((row) => ({
      partyId: row.partyId,
      vendorName: row.vendorName,
      href: `/compliance/vendors?vendor=${row.partyId}`,
      issueLabel: !row.reportable
        ? t('readiness.unflagged')
        : !row.hasTin
          ? t('readiness.missingTin')
          : t('readiness.noForm'),
      issueVariant: row.reportable ? 'destructive' : 'warning',
      classification: row.taxClassification ? t(`taxClassification.${row.taxClassification}`) : '—',
      paidThisYear: money(row.paidThisYear),
    })),
  }
}

const f = ref<InformationReturnsData>()
const item = field
const rootF = rootRef<InformationReturnsData>()

const MUTED = 'text-slate-500 dark:text-slate-400'
const PANEL = 'overflow-x-auto rounded-xl border border-slate-200 bg-white dark:border-slate-800 dark:bg-slate-900'

export function informationReturnsSpec(data: InformationReturnsData): PageSpec {
  return page({
    layout: 'list',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actions: [
          widget(
            'new-filing',
            { formTypes: data.formTypes, defaultYear: data.defaultYear },
            f('canManage'),
          ),
        ],
      }),
      widgetBlock('module-home-tabs', { tabs: data.tabs }),
    ],
    body: [
      {
        ...widgetBlock('empty-state', {
          title: data.emptyTitle,
          description: data.emptyDescription,
        }),
        when: f('noFilings'),
      },
      {
        ...grid(PANEL, [
          table({
            variant: 'app',
            rows: f('rows'),
            rowKey: item('id'),
            columns: [
              column(rootF('columnYear'), link(item('taxYear'), item('href'), 'hover:underline'), {
                className: 'font-medium tabular-nums',
              }),
              column(rootF('columnForm'), text(item('formType'))),
              column(rootF('columnEntity'), text(item('entity')), { className: MUTED }),
              column(
                rootF('columnRecipients'),
                text(item('includedCount'), {
                  suffix: { field: item('excludedNote'), className: 'ml-1 text-xs text-slate-400' },
                }),
                { align: 'right', className: 'tabular-nums' },
              ),
              column(rootF('columnTotal'), text(item('filedTotal')), {
                align: 'right',
                className: 'tabular-nums',
              }),
              column(rootF('columnStatus'), badge(item('statusLabel'), { variant: item('statusVariant') })),
              column(
                rootF('columnAttention'),
                widgetCell('badge-or-dash', {
                  shown: item('missingTin'),
                  label: item('missingTinLabel'),
                  variant: 'destructive',
                }),
              ),
            ],
          }),
        ]),
        when: f('hasFilings'),
      },
      grid(
        'mt-6',
        [
          heading(2, f('readinessTitle'), 'mb-1 text-sm font-semibold text-slate-800 dark:text-slate-100'),
          textBlock(f('readinessDescription'), { size: 'sm', className: 'mb-3', tone: 'muted' }),
          {
            ...textBlock(f('readinessClear'), {
              size: 'sm',
              className:
                'rounded-lg border border-emerald-200 bg-emerald-50/60 px-3 py-2 text-emerald-800 dark:border-emerald-900/60 dark:bg-emerald-950/20 dark:text-emerald-300',
            }),
            when: f('readinessIsClear'),
          },
          {
            ...grid(PANEL, [
              table({
                variant: 'app',
                rows: f('readiness'),
                rowKey: item('partyId'),
                columns: [
                  column(rootF('columnVendor'), link(item('vendorName'), item('href'), 'hover:underline'), {
                    className: 'font-medium',
                  }),
                  column(rootF('columnIssue'), badge(item('issueLabel'), { variant: item('issueVariant') })),
                  column(rootF('columnClassification'), text(item('classification')), { className: MUTED }),
                  column(rootF('columnPaid'), text(item('paidThisYear')), {
                    align: 'right',
                    className: 'tabular-nums',
                  }),
                ],
              }),
            ]),
            when: f('readinessHasRows'),
          },
        ],
        { as: 'section' },
      ),
    ],
  })
}
