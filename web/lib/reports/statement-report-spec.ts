import {
  filterBar,
  page,
  pageHeader,
  paper,
  widget,
  type Block,
  type FieldRef,
  type FilterBarBlock,
  type FilterBarControls,
  type PageHeaderBlock,
  type PageSpec,
  type PaperBlock,
  type WidgetRef,
} from '@braedonsaunders/appkit-viewspec'

type FilterOptions = Omit<FilterBarBlock, 'kind' | 'controls' | 'actions'>

export interface StatementReportFilter {
  controls: FilterBarControls
  options?: FilterOptions
  actions?: WidgetRef[]
}

export interface StatementReportSchedule {
  definitionId: string
  statementParams?: Record<string, string | undefined>
  historyHref?: string
  when?: FieldRef
}

export interface StatementReportExport {
  kind?: string
  params?: Record<string, string | undefined>
  baseHref?: string
}

export interface StatementReportSpecOptions {
  route: string
  header: Omit<PageHeaderBlock, 'kind'>
  filters?: StatementReportFilter[]
  actionsBefore?: WidgetRef[]
  schedule?: StatementReportSchedule
  saveView?: boolean
  exportMenu?: StatementReportExport
  headerBeforeFilters?: Block[]
  headerAfterFilters?: Block[]
  bodyBeforePaper?: Block[]
  bodyAfterPaper?: Block[]
  paper: Omit<PaperBlock, 'kind' | 'blocks'>
  blocks: Block[]
  showPaper?: boolean
}

/**
 * Compose a native report page with the shared filter, saved-view, export and
 * printable-paper blocks. Report-specific filters, notices and data blocks
 * remain owned by each report.
 */
export function statementReportSpec({
  route,
  header,
  filters = [],
  actionsBefore = [],
  schedule,
  saveView = true,
  exportMenu,
  headerBeforeFilters = [],
  headerAfterFilters = [],
  bodyBeforePaper = [],
  bodyAfterPaper = [],
  paper: paperOptions,
  blocks,
  showPaper = true,
}: StatementReportSpecOptions): PageSpec {
  const actions: WidgetRef[] = [
    ...actionsBefore,
    ...(schedule
      ? [
          widget(
            'schedule-report',
            {
              definitionId: schedule.definitionId,
              ...(schedule.statementParams === undefined ? {} : { statementParams: schedule.statementParams }),
              ...(schedule.historyHref === undefined ? {} : { historyHref: schedule.historyHref }),
            },
            schedule.when,
          ),
        ]
      : []),
    ...(saveView ? [widget('save-view')] : []),
    ...(exportMenu
      ? [
          widget('export-menu', {
            ...(exportMenu.kind === undefined ? {} : { kind: exportMenu.kind }),
            ...(exportMenu.params === undefined ? {} : { params: exportMenu.params }),
            ...(exportMenu.baseHref === undefined ? {} : { baseHref: exportMenu.baseHref }),
          }),
        ]
      : []),
  ]

  return page({
    route,
    layout: 'list',
    header: [
      pageHeader(header),
      ...headerBeforeFilters,
      ...filters.map(({ controls, options = {}, actions: filterActions }) =>
        filterBar(controls, { ...options, actions: filterActions ?? actions }),
      ),
      ...headerAfterFilters,
    ],
    body: [
      ...bodyBeforePaper,
      ...(showPaper ? [paper({ ...paperOptions, blocks })] : []),
      ...bodyAfterPaper,
    ],
  })
}

export function stringReportParams(
  searchParams: Record<string, string | string[] | undefined>,
): Record<string, string> {
  const params: Record<string, string> = {}
  for (const [key, value] of Object.entries(searchParams)) {
    if (typeof value === 'string') params[key] = value
  }
  return params
}
