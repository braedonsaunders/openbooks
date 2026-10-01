import { resolvePath } from '@braedonsaunders/appkit-viewspec'

export interface PreparedListSource {
  route: string
  /** The authorized loader's collection and stable identity fields. */
  rowsField?: string
  rowKeyField?: string
  mode: 'loaded' | 'server' | 'external'
  basePathField?: string
  clientSearch?: boolean
  paging?: {
    totalField: string
    pageField: string
    perPageField: string
    pageParamKey?: string
  }
}

/** Lists whose domain readers supply authorized rows. Authorization, effective
 * dates and financial calculations remain in those readers; this registry
 * owns the collection contract and pagination mode consumed by shared tables.
 * A server window must never be filtered or paginated again in the browser. */
const SOURCES = {
  admin_api_keys: {
    clientSearch: false,
    route: '/admin/api-keys',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_apps: {
    clientSearch: false,
    route: '/admin/apps',
    rowsField: 'rows',
    rowKeyField: 'rowId',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_automations: {
    route: '/admin/automations',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  admin_backups: {
    route: '/admin/backups',
    rowsField: 'runs',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  admin_custom_fields: {
    clientSearch: false,
    route: '/admin/custom-fields',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_customization_form_rows: {
    clientSearch: false,
    route: '/admin/customization',
    rowsField: 'formRows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'totalForms',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_customization_view_rows: {
    clientSearch: false,
    route: '/admin/customization',
    rowsField: 'viewRows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'totalViews',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_flows: {
    clientSearch: false,
    route: '/admin/flows',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  admin_page_layouts: {
    clientSearch: false,
    route: '/admin/page-layouts',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  admin_sandboxes: {
    route: '/admin/sandboxes',
    rowsField: 'sandboxes',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  admin_scripts: {
    clientSearch: false,
    route: '/admin/scripts',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  inbox: {
    clientSearch: false,
    route: '/inbox',
    rowsField: 'submittedRows',
    rowKeyField: 'key',
    mode: 'server',
    paging: {
      totalField: 'submittedTotal',
      pageField: 'page',
      perPageField: 'perPage',
    },
  },
  accounts_search: {
    clientSearch: false,
    route: '/accounts',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  agents: {
    clientSearch: false,
    route: '/agents',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  compliance_lien_waivers: {
    route: '/compliance/lien-waivers',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  data_import_history: {
    route: '/data/import/history',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_change_requests: {
    route: '/hrm/change-requests',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_equity: {
    route: '/hrm/compensation/equity',
    rowsField: 'categories',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_documents: {
    route: '/hrm/documents',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_leave: {
    clientSearch: false,
    route: '/hrm/leave',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_my_leave: {
    route: '/hrm/my-leave',
    rowsField: 'requests',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_performance_rows: {
    clientSearch: false,
    route: '/hrm/performance',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_performance_retention_gaps: {
    clientSearch: false,
    route: '/hrm/performance',
    rowsField: 'retention.gaps',
    rowKeyField: 'employmentHref',
    mode: 'loaded',
  },
  hrm_positions: {
    clientSearch: false,
    route: '/hrm/positions',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_processes: {
    clientSearch: false,
    route: '/hrm/processes',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_recruiting_depth_rows: {
    clientSearch: false,
    route: '/hrm/recruiting',
    rowsField: 'depthRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_recruiting_rows: {
    clientSearch: false,
    route: '/hrm/recruiting',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_surveys: {
    route: '/hrm/surveys',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_checklists: {
    route: '/me/checklists',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_documents_rows: {
    route: '/me/documents',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_documents_export_rows: {
    route: '/me/documents',
    rowsField: 'exportRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_surveys: {
    route: '/me/surveys',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  insights: {
    clientSearch: false,
    route: '/insights',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  insights_dashboards: {
    clientSearch: false,
    route: '/insights/dashboards',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  inventory_bom: {
    route: '/inventory',
    rowsField: 'assemblies',
    rowKeyField: 'assemblyItemId',
    mode: 'loaded',
  },
  inventory_count_lines: {
    route: '/inventory',
    rowsField: 'lines',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  inventory_counts: {
    route: '/inventory',
    rowsField: 'counts',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  knowledge_views: {
    clientSearch: false,
    route: '/knowledge/views',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  records_types: {
    clientSearch: false,
    route: '/records/types',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  records_type_key: {
    clientSearch: false,
    route: '/records/[typeKey]',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'filteredTotal',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
    basePathField: 'basePath',
  },
  parties: {
    clientSearch: false,
    route: '/parties',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  sync_runs: {
    route: '/sync',
    rowsField: 'runs',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  payments_runs: {
    clientSearch: false,
    route: '/payments',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    basePathField: 'basePath',
    paging: {
      totalField: 'total',
      pageField: 'page',
      perPageField: 'perPage',
    },
  },
  payroll_anomalies: {
    route: '/payroll/anomalies',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_org_chart_directory: {
    route: '/hrm/org-chart',
    rowsField: 'directoryRows',
    rowKeyField: 'id',
    mode: 'server',
    clientSearch: false,
    paging: { totalField: 'directoryTotal', pageField: 'directoryPage', perPageField: 'directoryPageSize' },
  },
  projects_wip_prebills: { route: '/projects/wip-billing', mode: 'loaded' },
  subcontracts_register: { route: '/subcontracts', mode: 'loaded' },
  subcontracts_changes: { route: '/subcontracts', mode: 'loaded' },
  subcontracts_applications: { route: '/subcontracts', mode: 'loaded' },
  subcontracts_retainage: { route: '/subcontracts', mode: 'loaded' },
  subcontracts_payment_controls: { route: '/subcontracts', mode: 'loaded' },
  close_posting_periods: { route: '/close/posting-periods', mode: 'loaded' },
  projects_duplicate_candidates: { route: '/projects/duplicates', mode: 'loaded' },
  admin_pdf_templates: { route: '/admin/pdf-templates', mode: 'loaded' },
  payroll_work_locations: { route: '/payroll/work-locations', mode: 'loaded' },
  admin_audit: { route: '/admin/audit', mode: 'external' },
  admin_roles: { route: '/admin/roles', mode: 'external' },
  admin_users: { route: '/admin/users', mode: 'external' },
  inbox_approvals: { route: '/inbox', mode: 'external' },
  inbox_tasks: { route: '/inbox', mode: 'external' },
  notifications: { route: '/notifications', mode: 'external' },
  ap_capture: { route: '/ap/capture', mode: 'external' },
  compliance_vendors: { route: '/compliance/vendors', mode: 'loaded' },
  documents_trash: { route: '/documents/trash', mode: 'loaded' },
  tax_provisions: { route: '/tax/provisions', mode: 'loaded' },
  time_clock_pairs: {
    route: '/time/clock',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  time_crew_batches: {
    route: '/time/crew',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  warehouse_list: {
    route: '/warehouse',
    rowsField: 'rows',
    rowKeyField: 'warehouseId',
    mode: 'loaded',
  },
  warehouse_putaway: {
    route: '/warehouse',
    rowsField: 'staged',
    rowKeyField: 'stagingLocationId',
    mode: 'loaded',
  },
} satisfies Record<string, PreparedListSource>

export type PreparedListSourceKey = keyof typeof SOURCES

export function preparedListSource(key: string): PreparedListSource {
  if (!Object.hasOwn(SOURCES, key))
    throw new Error('Unregistered record list source: ' + key)
  return SOURCES[key as PreparedListSourceKey]
}

export function preparedListSources(): Readonly<
  Record<PreparedListSourceKey, PreparedListSource>
> {
  return SOURCES
}

export function preparedPageState(source: PreparedListSource, scope: unknown) {
  if (!source.paging)
    throw new Error('The list source does not declare server pagination.')
  const integer = (field: string, minimum: number): number => {
    const value = resolvePath(scope, field)
    if (
      typeof value !== 'number' ||
      !Number.isSafeInteger(value) ||
      value < minimum
    ) {
      throw new Error('Invalid record-list pagination field: ' + field)
    }
    return value
  }
  return {
    total: integer(source.paging.totalField, 0),
    page: integer(source.paging.pageField, 1),
    perPage: integer(source.paging.perPageField, 1),
  }
}
