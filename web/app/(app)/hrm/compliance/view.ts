import 'server-only'

import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import {
  badge,
  column,
  field as item,
  grid,
  page,
  pageHeader,
  panel,
  ref,
  statTile,
  table,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from '@braedonsaunders/appkit-viewspec'
import { requirePermission } from '../../../../lib/authz'
import { isFeatureEnabled } from '../../../../lib/features'
import { loadCompliancePage, type ComplianceData } from '../../../../lib/hrm/compliance'

/**
 * The Compliance tab (HR-13), split into a loader and a spec — the
 * banking/purchasing archetype: a four-tile vitals strip, section chips
 * across findings/rates/certified/classes/per-diem, and a ViewSpec table
 * block (variant 'app') per section over loader-resolved rows. The page's
 * primary action is the shared 'link-button' widget ("Generate report")
 * FIRST in the page header, then the module-home-tabs strip. Row actions
 * and the generate dialog open through small client islands;
 * configuration lives in rehomed Setup sections on this same page. Every
 * string arrives loader-resolved through the catalog.
 */

const f = ref<ComplianceData>()

export function complianceSpec(data: ComplianceData, basePath: string = '/hrm/compliance'): PageSpec {
  return page({
    route: '/hrm/compliance',
    layout: 'list',
    bodyClassName: 'flex h-full min-h-0 flex-col',
    header: [
      pageHeader({
        title: f('title'),
        description: f('description'),
        actionsClassName: 'flex flex-wrap items-center gap-3',
        actions: [
          widget(
            'link-button',
            { href: data.generateHref, label: data.generateLabel, iconKey: 'plus' },
            f('canManage'),
          ),
          widget('module-home-tabs', { tabs: data.tabs }),
        ],
      }),
    ],
    body: [
      widgetBlock('empty-state', { title: data.refusal?.title ?? '', description: data.refusal?.message }, f('refusal')),
      grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4', [0, 1, 2, 3].map((index) => statTile({
        iconKey: 'siren',
        accent: 'amber',
        label: f(`stats.${index}.label`),
        value: f(`stats.${index}.value`),
        sub: f(`stats.${index}.sub`),
      }))),
      widgetBlock('filter-chips', {
        basePath,
        currentParams: data.currentParams,
        paramKey: 'section',
        label: '',
        allLabel: '',
        options: data.sections,
      }),
      ...(data.section === 'findings'
        ? [
            widgetBlock('filter-chips', {
              basePath,
              currentParams: data.currentParams,
              paramKey: 'kind',
              label: '',
              allLabel: 'All',
              options: data.kinds,
            }),
            panel({
              title: f('labels.findingsTitle'),
              iconKey: 'siren',
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('findings'),
                  rowKey: item('id'),
                  columns: [
                    column(f('labels.columns.kind'), text(item('kindLabel'))),
                    column(f('labels.columns.project'), text(item('projectLabel'))),
                    column(f('labels.columns.day'), text(item('workedOn'))),
                    column(f('labels.columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                    column(f('labels.columns.recorded'), text(item('recordedLabel'))),
                    column(
                      f('labels.columns.actions'),
                      widgetCell('hrm-compliance-actions', {
                        actionKind: 'finding',
                        rowId: item('id'),
                        rowStatus: item('status'),
                        acknowledgeLabel: f('actions.acknowledge'),
                        resolveLabel: f('actions.resolve'),
                        approveLabel: '',
                        voidLabel: '',
                        submitLabel: '',
                        canManage: f('canManage'),
                      }),
                    ),
                  ],
                  empty: { title: f('labels.empty'), description: f('labels.emptyAction') },
                }),
              ],
            }),
          ]
        : []),
      ...(data.section === 'rates'
        ? [
            panel({
              title: f('labels.ratesTitle'),
              iconKey: 'table-properties',
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('schedules'),
                  rowKey: item('id'),
                  columns: [
                    column(f('labels.columns.schedule'), text(item('name'))),
                    column(f('labels.columns.kind'), text(item('kindLabel'))),
                    column(f('labels.columns.scope'), text(item('scopeLabel'))),
                    column(f('labels.columns.reciprocity'), text(item('reciprocityLabel'))),
                    column(f('labels.columns.window'), text(item('windowLabel'))),
                    column(f('labels.columns.status'), text(item('statusLabel'))),
                  ],
                  empty: { title: f('labels.empty'), description: f('labels.emptyAction') },
                }),
              ],
            }),
            widgetBlock('setup-section', { entityKey: 'construction-classifications', sp: {}, basePath }),
            widgetBlock('setup-section', { entityKey: 'construction-rate-schedules', sp: {}, basePath }),
          ]
        : []),
      ...(data.section === 'certified'
        ? [
            panel({
              title: f('labels.certifiedTitle'),
              iconKey: 'file-check',
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('runs'),
                  rowKey: item('id'),
                  columns: [
                    column(f('labels.columns.project'), text(item('projectLabel'))),
                    column(f('labels.columns.week'), text(item('weekLabel'))),
                    column(f('labels.columns.format'), text(item('formatKey'))),
                    column(f('labels.columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                    column(
                      f('labels.columns.actions'),
                      widgetCell('hrm-compliance-actions', {
                        actionKind: 'run',
                        rowId: item('id'),
                        rowStatus: item('status'),
                        acknowledgeLabel: '',
                        resolveLabel: '',
                        approveLabel: '',
                        voidLabel: '',
                        submitLabel: f('actions.submit'),
                        canManage: f('canManage'),
                      }),
                    ),
                  ],
                  empty: { title: f('labels.empty'), description: f('labels.emptyAction') },
                }),
              ],
            }),
          ]
        : []),
      ...(data.section === 'classes'
        ? [
            panel({
              title: f('labels.classesTitle'),
              iconKey: 'shield-plus',
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('classes'),
                  rowKey: item('id'),
                  columns: [
                    column(f('labels.columns.code'), text(item('code'))),
                    column(f('labels.columns.name'), text(item('name'))),
                    column(f('labels.columns.rate'), text(item('rateLabel')), {
                      align: 'right',
                      className: 'tabular-nums',
                    }),
                    column(f('labels.columns.rules'), text(item('rulesLabel')), {
                      align: 'right',
                      className: 'tabular-nums',
                    }),
                  ],
                  empty: { title: f('labels.empty'), description: f('labels.emptyAction') },
                }),
              ],
            }),
            widgetBlock('setup-section', { entityKey: 'construction-comp-classes', sp: {}, basePath }),
            widgetBlock('setup-section', { entityKey: 'construction-ratio-rules', sp: {}, basePath }),
          ]
        : []),
      ...(data.section === 'perdiem'
        ? [
            panel({
              title: f('labels.perdiemTitle'),
              iconKey: 'wallet',
              bodyClassName: 'min-h-0 overflow-y-auto p-0',
              className: 'min-h-0 flex-1',
              blocks: [
                table({
                  variant: 'app',
                  rows: f('entries'),
                  rowKey: item('id'),
                  columns: [
                    column(f('labels.columns.day'), text(item('dayLabel'))),
                    column(f('labels.columns.amount'), text(item('amountLabel')), {
                      align: 'right',
                      className: 'tabular-nums',
                    }),
                    column(f('labels.columns.status'), badge(item('statusLabel'), { variant: item('statusVariant') })),
                    column(
                      f('labels.columns.actions'),
                      widgetCell('hrm-compliance-actions', {
                        actionKind: 'entry',
                        rowId: item('id'),
                        rowStatus: item('status'),
                        entryKind: 'per_diem',
                        acknowledgeLabel: '',
                        resolveLabel: '',
                        approveLabel: f('actions.approve'),
                        voidLabel: f('actions.void'),
                        submitLabel: '',
                        canManage: f('canManage'),
                      }),
                    ),
                  ],
                  empty: { title: f('labels.empty'), description: f('labels.emptyAction') },
                }),
              ],
            }),
            widgetBlock('setup-section', { entityKey: 'construction-per-diem-policies', sp: {}, basePath }),
          ]
        : []),
      widgetBlock('hrm-compliance-generate', {
        projects: f('generateDialog.projects'),
        formats: f('generateDialog.formats'),
        title: f('generateDialog.title'),
        projectLabel: f('generateDialog.projectLabel'),
        weekLabel: f('generateDialog.weekLabel'),
        formatLabel: f('generateDialog.formatLabel'),
        generateLabel: f('generateDialog.generateLabel'),
        cancelLabel: f('generateDialog.cancelLabel'),
        closeHref: basePath,
      }),
    ],
  })
}

export async function loadCompliancePageData(sp: Record<string, string | undefined>) {
  const authz = await requirePermission('hrm.construction.read')
  const orgId = authz.user.orgId
  if (!(await isFeatureEnabled(orgId, 'hrmConstructionCompliance'))) notFound()
  if (!(await isFeatureEnabled(orgId, 'hrm'))) notFound()
  const { loadCompliancePage } = await import('../../../../lib/hrm/compliance')
  return loadCompliancePage(authz, sp)
}

export async function complianceTitle(): Promise<string> {
  const t = await getTranslations('hrm')
  return t('compliance.title')
}

export type { ComplianceData }
