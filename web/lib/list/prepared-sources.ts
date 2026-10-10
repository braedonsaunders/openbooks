import { resolvePath } from '@braedonsaunders/appkit-viewspec'

export interface PreparedListSource {
  route: string
  /** The authorized loader's collection and stable identity fields. */
  rowsField?: string
  rowKeyField?: string
  mode: 'loaded' | 'server' | 'external'
  basePathField?: string
  clientSearch?: boolean
  /** Fixed-size readers do not expose a selector they cannot honor. */
  showPerPage?: boolean
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
  manufacturing_home_queue: {route:'/manufacturing',rowsField:'orders.rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'orders.total',pageField:'orders.page',perPageField:'orders.perPage'}},
  manufacturing_work_orders: {route:'/manufacturing/work-orders',rowsField:'rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'total',pageField:'page',perPageField:'perPage'}},
  manufacturing_work_centers: {route:'/manufacturing/work-centers',rowsField:'rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'total',pageField:'page',perPageField:'perPage'}},
  manufacturing_routings: {route:'/manufacturing/routings',rowsField:'rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'total',pageField:'page',perPageField:'perPage'}},
  manufacturing_mrp: {route:'/manufacturing/mrp',rowsField:'rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'total',pageField:'page',perPageField:'perPage'}},
  manufacturing_genealogy: {route:'/manufacturing/genealogy',rowsField:'edges',rowKeyField:'id',mode:'loaded'},
  manufacturing_quality: {route:'/manufacturing/quality',rowsField:'queue.rows',rowKeyField:'id',mode:'server',clientSearch:false,showPerPage:false,paging:{totalField:'queue.total',pageField:'queue.page',perPageField:'queue.perPage'}},
  manufacturing_record_rows: {route:'/manufacturing',rowsField:'rows',rowKeyField:'id',mode:'loaded'},
  manufacturing_vendor_services: {route:'/manufacturing/work-orders',rowsField:'services',rowKeyField:'id',mode:'loaded'},
  manufacturing_vendor_shipments: {route:'/manufacturing/work-orders',rowsField:'shipments',rowKeyField:'id',mode:'loaded'},
  manufacturing_vendor_returns: {route:'/manufacturing/work-orders',rowsField:'deliveries',rowKeyField:'id',mode:'loaded'},
  inventory_stock_controls: {route:'/inventory',rowsField:'rows',rowKeyField:'id',mode:'server',clientSearch:false,paging:{totalField:'totalCount',pageField:'currentPage',perPageField:'perPage'}},
  contractor_withholding_payment_deductions: { route: '/payments', rowsField: 'withholdings', rowKeyField: 'openLineId', mode: 'loaded' },
  contractor_withholding_deposits: { route: '/contractor-withholding?tab=deposits', rowsField: 'deposits', rowKeyField: 'documentId', mode: 'loaded' },
  contractor_withholding_periods: { route: '/contractor-withholding', rowsField: 'periods', rowKeyField: 'periodStart', mode: 'loaded' },
  contractor_withholding_standings: { route: '/contractor-withholding?tab=standings', rowsField: 'standings', rowKeyField: 'id', mode: 'loaded' },
  contractor_withholding_return_payments: { route: '/contractor-withholding', rowsField: 'sourcePayments', rowKeyField: 'documentId', mode: 'loaded' },
  contractor_withholding_return_payees: { route: '/contractor-withholding', rowsField: 'lines', rowKeyField: 'partyId', mode: 'loaded' },
  assistant_action_limits: { route: '/admin/setup/ai-capabilities', rowsField: 'capabilities', rowKeyField: 'key', mode: 'loaded' },
  assistant_activity: { route: '/admin/setup/ai-capabilities?tab=activity', rowsField: 'decisions', rowKeyField: 'id', mode: 'server', clientSearch: false, paging: { totalField: 'total', pageField: 'page', perPageField: 'perPage' } },
  setup_configuration_records: {
    route: '/admin/setup', rowsField: 'rows', rowKeyField: 'id', mode: 'server',
    clientSearch: false, showPerPage: false,
    paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' },
  },
  hrm_employee_benefits: { route: '/hrm/benefits', rowsField: 'assignments', rowKeyField: 'id', mode: 'loaded' },
  // Program workspaces own has-more pagination without a total count.
  hrm_benefit_program_participants_page: { route: '/hrm/benefits', rowsField: 'participants', rowKeyField: 'id', mode: 'external', clientSearch: false, showPerPage: false },
  hrm_benefit_program_activity_page: { route: '/hrm/benefits', rowsField: 'activity', rowKeyField: 'id', mode: 'external', clientSearch: false, showPerPage: false },
  hrm_benefit_program_participants: { route: '/hrm/benefits', rowsField: 'participants', rowKeyField: 'id', mode: 'loaded' },
  hrm_benefit_program_activity: { route: '/hrm/benefits', rowsField: 'activity', rowKeyField: 'id', mode: 'loaded' },
  employee_benefit_enrollments: { route: '/entities/employees', rowsField: 'enrollments', rowKeyField: 'id', mode: 'loaded' },
  employee_vacation_terms: { route: '/entities/employees', rowsField: 'vacation', rowKeyField: 'id', mode: 'loaded' },
  employee_service_credits: { route: '/entities/employees', rowsField: 'service', rowKeyField: 'id', mode: 'loaded' },
  hrm_conversation_worklist: { route: "/hrm/performance/conversations", rowsField: "rows", rowKeyField: "id", mode: "server", clientSearch: false, paging: { totalField: "total", pageField: "currentPage", perPageField: "perPage" } },
  collections_worklist: { route: '/collections', rowsField: 'rows', rowKeyField: 'id', mode: 'loaded' },
  collections_recurring: { route: '/collections?view=recurring', rowsField: 'schedules', rowKeyField: 'id', mode: 'loaded' },
  collections_policies: { route: '/collections?view=policies', rowsField: 'policies', rowKeyField: 'id', mode: 'loaded' },
  collections_plans: { route: '/collections?view=plans', rowsField: 'plans', rowKeyField: 'id', mode: 'loaded' },
  collections_subscriptions: { route: '/collections?view=subscriptions', rowsField: 'subscriptions', rowKeyField: 'id', mode: 'loaded' },
  collections_versions: { route: '/collections?view=versions', rowsField: 'versions', rowKeyField: 'id', mode: 'loaded' },
  collections_contracts: { route: '/collections?view=contracts', rowsField: 'lifecycles', rowKeyField: 'subscriptionId', mode: 'loaded' },
  collections_amendments: { route: '/collections?view=amendments', rowsField: 'amendments', rowKeyField: 'id', mode: 'loaded' },
  crm_sales_representatives: { route: '/crm/sales/representatives', rowsField: 'rows', rowKeyField: 'id', mode: 'server', clientSearch: false, paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' } },
  crm_sales_teams: { route: '/crm/sales/teams', rowsField: 'rows', rowKeyField: 'id', mode: 'server', clientSearch: false, paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' } },
  crm_sales_quotas: { route: '/crm/sales/quotas', rowsField: 'rows', rowKeyField: 'id', mode: 'server', clientSearch: false, paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' } },
  crm_sales_territories: { route: '/crm/sales/territories', rowsField: 'rows', rowKeyField: 'id', mode: 'server', clientSearch: false, paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' } },
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
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
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
    showPerPage: false,
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
  close_periods: {
    clientSearch: false,
    route: '/close',
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
  compliance_information_returns: {
    route: '/compliance/information-returns',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  compliance_information_return_readiness: {
    route: '/compliance/information-returns',
    rowsField: 'readiness',
    rowKeyField: 'partyId',
    mode: 'loaded',
  },
  banking_psp_settlement_batches: {
    route: '/banking/psp-settlements',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  property_properties: {
    route: '/property-management',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  property_rent_roll: {
    route: '/property-management',
    rowsField: 'rows',
    rowKeyField: 'key',
    mode: 'loaded',
  },
  property_cam_pools: {
    route: '/property-management',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  property_deposit_reconciliation: {
    route: '/property-management',
    rowsField: 'rows',
    rowKeyField: 'propertyId',
    mode: 'loaded',
  },
  // Period identity is the composite (employee, source pay run) and bucket
  // identity is component-plus-index; no single field holds either, so the
  // client tables key rows with those pairs instead.
  payroll_retro_periods: {
    route: '/payroll/retro',
    rowsField: 'rows',
    mode: 'loaded',
  },
  payroll_retro_buckets: {
    route: '/payroll/retro',
    rowsField: 'rows',
    mode: 'loaded',
  },
  payroll_parallel_comparisons: {
    route: '/payroll/parallel-run',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  payroll_parallel_registers: {
    route: '/payroll/parallel-run',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  payroll_parallel_findings: {
    route: '/payroll/parallel-run',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  // Group identity is the composite (destination, filing account), which no
  // single field holds; the client table keys rows with that pair instead.
  payroll_opening_employees: { route: '/payroll/opening-balances', rowsField: 'balances.initial.rows', rowKeyField: 'employeePartyId', mode: 'loaded' },
  payroll_opening_banks: { route: '/payroll/opening-balances', rowsField: 'banks.initial.rows', rowKeyField: 'employeePartyId', mode: 'loaded' },
  payroll_opening_levies: { route: '/payroll/opening-balances', rowsField: 'employerLevies.levies', mode: 'loaded' },
  payroll_remittance_groups: {
    route: '/payroll/remittances',
    rowsField: 'groups',
    mode: 'loaded',
  },
  continuous_close_findings: {
    clientSearch: false,
    route: '/continuous-close',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    paging: {
      totalField: 'total',
      pageField: 'currentPage',
      perPageField: 'perPage',
    },
  },
  crm_forecast_quotas: {
    route: '/crm/forecasts',
    rowsField: 'quotaRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  crm_forecast_snapshots: {
    route: '/crm/forecasts',
    rowsField: 'snapshotRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  data_import_history: {
    route: '/data/import/history',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    clientSearch: false,
    paging: { totalField: 'total', pageField: 'currentPage', perPageField: 'perPage' },
  },
  hrm_change_requests: {
    route: '/hrm/change-requests',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_benefit_programs: { route: '/hrm/benefits', rowsField: 'programRows', rowKeyField: 'id', mode: 'loaded' },
  hrm_benefit_awards: { route: '/hrm/benefits', rowsField: 'awardRows', rowKeyField: 'id', mode: 'loaded' },
  me_benefit_awards_paid: { route: '/me/benefits', rowsField: 'paidAwards', rowKeyField: 'id', mode: 'loaded' },
  me_benefit_awards_reversed: { route: '/me/benefits', rowsField: 'reversedAwards', rowKeyField: 'id', mode: 'loaded' },
  me_benefit_awards_pending: { route: '/me/benefits', rowsField: 'pendingAwards', rowKeyField: 'id', mode: 'loaded' },
  hrm_benefits_windows: {
    route: '/hrm/benefits',
    rowsField: 'windowRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_benefits_enrolments: {
    route: '/hrm/benefits',
    rowsField: 'enrollmentRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_bands: {
    route: '/hrm/compensation',
    rowsField: 'bands',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_source_lines: { route: '/hrm/compensation/cycles', rowsField: 'rows', rowKeyField: 'id', mode: 'loaded' },
  hrm_compensation_cycles: {
    route: '/hrm/compensation',
    rowsField: 'cycles',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_plans: {
    route: '/hrm/compensation',
    rowsField: 'plans',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_cycle_lines: {
    route: '/hrm/compensation/cycles',
    rowsField: 'lines',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compensation_plan_lines: {
    route: '/hrm/compensation/plans',
    rowsField: 'lines',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compliance_findings: {
    // 200-capped window beside full-list tiles: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/hrm/compliance',
    rowsField: 'findings',
    rowKeyField: 'id',
    mode: 'external',
  },
  hrm_compliance_schedules: {
    route: '/hrm/compliance',
    rowsField: 'schedules',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compliance_runs: {
    // 200-capped window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/hrm/compliance',
    rowsField: 'runs',
    rowKeyField: 'id',
    mode: 'external',
  },
  hrm_compliance_classes: {
    route: '/hrm/compliance',
    rowsField: 'classes',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_compliance_entries: {
    // 200-capped window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/hrm/compliance',
    rowsField: 'entries',
    rowKeyField: 'id',
    mode: 'external',
  },
  hrm_qualifications_ledger: {
    // 200-capped window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/hrm/qualifications',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'external',
  },
  hrm_qualifications_requirements: {
    route: '/hrm/qualifications',
    rowsField: 'requirements',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  hrm_qualifications_coverage: {
    clientSearch: false,
    showPerPage: false,
    route: '/hrm/qualifications',
    rowsField: 'coverageRows',
    rowKeyField: 'employmentId',
    mode: 'server',
    paging: {
      totalField: 'coverageTotal',
      pageField: 'coveragePage',
      perPageField: 'coveragePerPage',
      pageParamKey: 'crewPage',
    },
  },
  hrm_qualifications_alerts: {
    route: '/hrm/qualifications',
    rowsField: 'alerts',
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
  hrm_calibration_sessions: { route: '/hrm/performance', rowsField: 'continuous.calibration.sessions', rowKeyField: 'id', mode: 'loaded' },
  hrm_calibration_entries: { route: '/hrm/performance', rowsField: 'entries', rowKeyField: 'id', mode: 'loaded' },
  hrm_talent_reviews: { route: '/hrm/performance', rowsField: 'continuous.talent.reviews', rowKeyField: 'id', mode: 'loaded' },
  hrm_succession_candidates: { route: '/hrm/performance', rowsField: 'candidates', rowKeyField: 'id', mode: 'loaded' },
  hrm_succession_plans: { route: '/hrm/performance', rowsField: 'continuous.talent.plans', rowKeyField: 'id', mode: 'loaded' },
  hrm_talent_matrix: { route: '/hrm/performance', rowsField: 'continuous.talent.boxRows', rowKeyField: 'perf', mode: 'loaded' },
  hrm_goal_worklist: {route:'/hrm/performance/goals',rowsField:'rows',rowKeyField:'id',mode:'loaded'},
  hrm_review_template_documents: {route:'/hrm/performance/templates',rowsField:'rows',rowKeyField:'id',mode:'loaded'},
  hrm_review_worklist: {route:'/hrm/performance',rowsField:'reviewRows',rowKeyField:'id',mode:'loaded'},
  hrm_application_worklist: {route:'/hrm/recruiting',rowsField:'applicationRows',rowKeyField:'id',mode:'loaded'},
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
  me_training: { route: '/me/training', rowsField: 'rows', rowKeyField: 'id', mode: 'loaded' },
  me_checklists: {
    route: '/me/checklists',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_overview_employments: {
    route: '/me',
    rowsField: 'employments',
    rowKeyField: 'employmentId',
    mode: 'loaded',
  },
  me_overview_steps: {
    // top-5 window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/me',
    rowsField: 'steps',
    rowKeyField: 'id',
    mode: 'external',
  },
  me_overview_requests: {
    // top-5 window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/me',
    rowsField: 'requests',
    rowKeyField: 'id',
    mode: 'external',
  },
  me_overview_qualifications: {
    // top-5 window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/me',
    rowsField: 'qualifications',
    rowKeyField: 'id',
    mode: 'external',
  },
  me_overview_pay: {
    // six-stub window: the domain reader owns the displayed window; no client filtering or second pagination.
    clientSearch: false,
    route: '/me',
    rowsField: 'payStubs',
    rowKeyField: 'id',
    mode: 'external',
  },
  me_benefits_elections: {
    route: '/me/benefits',
    rowsField: 'elections',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_benefits_windows: {
    route: '/me/benefits',
    rowsField: 'windows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_compensation_statements: {
    route: '/me/compensation',
    rowsField: 'statements',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_one_on_ones_upcoming: {
    route: '/me/one-on-ones',
    rowsField: 'upcoming',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_one_on_ones_past: {
    route: '/me/one-on-ones',
    rowsField: 'past',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_one_on_ones_requests: {
    route: '/me/one-on-ones',
    rowsField: 'requests',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_reviews_self: {
    route: '/me/reviews',
    rowsField: 'selfRows',
    rowKeyField: 'reviewId',
    mode: 'loaded',
  },
  me_reviews_shared: {
    route: '/me/reviews',
    rowsField: 'sharedRows',
    rowKeyField: 'reviewId',
    mode: 'loaded',
  },
  me_reviews_goals: {
    route: '/me/reviews',
    rowsField: 'goalRows',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_team_roster: {
    route: '/me/team',
    rowsField: 'roster',
    rowKeyField: 'employmentId',
    mode: 'loaded',
  },
  me_team_steps: {
    route: '/me/team',
    rowsField: 'teamSteps',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_team_leave: {
    route: '/me/team',
    rowsField: 'pendingLeave',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_team_changes: {
    route: '/me/team',
    rowsField: 'pendingChanges',
    rowKeyField: 'id',
    mode: 'loaded',
  },
  me_team_owed: {
    route: '/me/team',
    rowsField: 'owedReviews',
    rowKeyField: 'reviewId',
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
    showPerPage: false,
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
  customer_pulse_history: {
    route: '/parties',
    rowsField: 'rows',
    rowKeyField: 'id',
    mode: 'server',
    clientSearch: false,
    showPerPage: false,
    paging: { totalField: 'total', pageField: 'page', perPageField: 'perPage', pageParamKey: 'pulseHistoryPage' },
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
    showPerPage: false,
    route: '/hrm/org-chart',
    rowsField: 'directoryRows',
    rowKeyField: 'id',
    mode: 'server',
    clientSearch: false,
    paging: { totalField: 'directoryTotal', pageField: 'directoryPage', perPageField: 'directoryPageSize' },
  },
  projects_prebills: { route: '/projects/pre-billing', mode: 'loaded' },
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
  close_reopen_requests: { route: '/accounting/reopen-requests', mode: 'loaded' },
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
  fulfillment_pick_execution: {route:'/picks',rowsField:'document.lines',rowKeyField:'lineId',mode:'loaded'},
  handling_unit_contents: {route:'/shipments',rowsField:'unit.lines',rowKeyField:'lineId',mode:'loaded'},
  warehouse_receipts: {route:'/warehouse',rowsField:'receipts',rowKeyField:'lineId',mode:'loaded'},
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
