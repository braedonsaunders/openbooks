import { grid, panel, ref, statTile, widgetBlock } from '@braedonsaunders/appkit-viewspec'
import type { BenefitsData } from '../../../../lib/hrm/benefits'

type OverviewData = Pick<BenefitsData,
  'overview' | 'tiles' | 'programRows' | 'programTableText' | 'programsTitle' |
  'programsRefusal' | 'awardsRefusal' | 'reportsRefusal' | 'deliveredRows' |
  'awaitingRows' | 'deliveredTitle' | 'awaitingTitle'
>

const f = ref<BenefitsData>()

/** The Customers cockpit composition: vitals, a two-column hero, and an operational rail. */
export function benefitsOverviewBlocks(data: OverviewData) {
  const moneyPanels = data.awardsRefusal ? [] : [
    { title: data.deliveredTitle, rows: data.deliveredRows, iconKey: 'circle-check' },
    { title: data.awaitingTitle, rows: data.awaitingRows, iconKey: 'timer' },
  ].filter(({ rows }) => rows.length > 0).map(({ title, rows, iconKey }) => panel({
    title,
    iconKey,
    hint: f('overview.payrollHint'),
    bodyClassName: 'p-0',
    className: 'shrink-0',
    blocks: [widgetBlock('hrm-facts', {
      facts: rows.map((row) => ({ label: row.currency, value: row.display })),
    })],
  }))
  return [
    grid('grid shrink-0 grid-cols-2 gap-3 sm:grid-cols-4', [
      statTile({ iconKey: 'heart-pulse', accent: 'teal', label: f('overview.vitalsLabels.activePrograms'), value: f('tiles.activePrograms') }),
      statTile({ iconKey: 'calendar-clock', accent: 'sky', label: f('overview.vitalsLabels.openWindows'), value: f('tiles.openWindows') }),
      statTile({ iconKey: 'timer', accent: 'amber', label: f('overview.vitalsLabels.pendingApprovals'), value: f('tiles.pendingApprovals') }),
      statTile({ iconKey: 'wallet', accent: 'violet', label: f('overview.vitalsLabels.queuedPayouts'), value: f('tiles.queuedPayouts') }),
    ]),
    grid('grid min-h-0 flex-1 grid-cols-1 gap-5 lg:grid-cols-3', [
      panel({
        title: f('programsTitle'),
        iconKey: 'heart-pulse',
        hint: f('overview.heroHint'),
        bodyClassName: 'min-h-0 overflow-y-auto p-0',
        className: 'min-h-[24rem] lg:col-span-2',
        blocks: data.programsRefusal
          ? [widgetBlock('empty-state', { title: data.programsRefusal.title, description: data.programsRefusal.message })]
          : [widgetBlock('hrm-program-table', {
              rows: data.programRows,
              text: data.programTableText,
              total: data.programRows.length,
              truncated: false,
            })],
      }),
      grid('flex min-h-0 flex-col gap-5 overflow-y-auto', [
        panel({
          title: f('overview.attentionTitle'),
          iconKey: 'triangle-alert',
          bodyClassName: 'p-0',
          className: 'shrink-0',
          blocks: data.awardsRefusal || data.programsRefusal
            ? [widgetBlock('empty-state', {
                title: (data.awardsRefusal ?? data.programsRefusal)?.title ?? '',
                description: (data.awardsRefusal ?? data.programsRefusal)?.message,
              })]
            : [widgetBlock('attention-list', { items: data.overview.attention, allClear: data.overview.attentionEmpty })],
        }),
        ...moneyPanels,
        widgetBlock('directory-section', {
          title: data.overview.directoryTitle,
          items: data.overview.directory,
        }),
        widgetBlock('directory-section', {
          title: data.overview.reportsTitle,
          items: data.overview.reportLinks.map((report) => ({ href: report.href, label: report.label, iconKey: 'chart-no-axes-combined' })),
        }),
        ...(data.reportsRefusal ? [widgetBlock('empty-state', {
          title: data.reportsRefusal.title,
          description: data.reportsRefusal.message,
        })] : []),
      ]),
    ]),
  ]
}
