/**
 * Optional-feature registry — the single source of truth for what an org can
 * switch on/off in Company Settings → Features. Not every company uses every
 * feature: a feature that's off disappears from nav, its routes 404, and its
 * setup surfaces hide — but its DATA is never touched by toggling.
 *
 * Keys are STABLE ids (org settings reference them). State lives in
 * `orgs.settings.features.{key}` (boolean); absence = the registry default.
 * Labels/descriptions are i18n (`admin.features.{key}.*`), never stored.
 */
export interface FeatureDef {
  key: string
  /** Enabled for orgs that have never touched the toggle. */
  defaultEnabled: boolean
  /** Nav module keys hidden while the feature is off. */
  navModules?: string[]
  /** Grouping on the Features page. */
  category: 'sales' | 'operations' | 'accounting' | 'platform'
  /** Optional authoritative parent module. A child can never resolve enabled
   *  while its parent is disabled, regardless of stale stored overrides. */
  parentKey?: string
  /** Every listed feature must be enabled before this feature can resolve on.
   *  `parentKey` is the single-parent shorthand used by hierarchical modules;
   *  cross-module capabilities declare their complete dependency set. */
  requiresAll?: string[]
  /** Helpful companions shown on the Features page. Recommendations never
   *  prevent enablement because the underlying module remains independently useful. */
  recommends?: string[]
}

/** The full feature switchboard:
 * everything currently visible defaults ON so existing orgs see no change;
 * new optional modules (field tickets) default OFF. */
export const FEATURES: FeatureDef[] = [
  // Sales & customers
  // The account list is NOT here: leads, prospects and customers share one
  // list gated by parties.read, and turning CRM off narrows that list to
  // customers rather than removing a nav entry.
  { key: 'crm', defaultEnabled: true, category: 'sales', navModules: ['crm-opportunities', 'crm-activities', 'crm-forecasts'] },
  { key: 'orders', defaultEnabled: true, category: 'sales', navModules: ['estimates', 'sales-orders', 'purchase-orders'] },
  { key: 'revenueRecognition', defaultEnabled: true, category: 'sales', navModules: ['revenue'] },
  // Subscription billing: plans + subscriptions that auto-generate recurring
  // invoices (SaaS/retainer style). Off by default — recurring document
  // schedules + dunning work without it; this adds the plan/subscription model.
  { key: 'subscriptionBilling', defaultEnabled: false, category: 'sales' },
  // Contract-grade subscription lifecycle layered over the base recurring
  // plan/subscription engine: versioned catalog terms, components, trials,
  // amendments, renewals, co-terming, and advance/arrears timing.
  { key: 'advancedSubscriptions', defaultEnabled: false, category: 'sales', requiresAll: ['subscriptionBilling'] },
  // Online customer payments: hosted payment links on invoices (Stripe /
  // Adyen / GoCardless bank debit), surcharge rules, provider webhooks that
  // auto-apply receipts to open items. Off by default — manual receipts and
  // payment files work without it.
  { key: 'onlinePayments', defaultEnabled: false, category: 'sales' },
  // Operations
  // Projects is a parent gate on the centralized Features page.
  // Schedule-of-values billing remains a project-type procedure, not a gate.
  { key: 'projects', defaultEnabled: true, category: 'operations', navModules: ['projects', 'field-tickets', 'lien-waivers'] },
  { key: 'timeTracking', defaultEnabled: true, category: 'operations', navModules: ['timesheets'], parentKey: 'projects' },
  // HR-20 begin: field time capture — mobile and kiosk clock-in with
  // geofence, photo and offline queue; foreman crew batch entry;
  // equipment hours on entries; multi-stage approval. The parent rides
  // timeTracking (office orgs never see a clock) and needs projects;
  // sub-features hide optional complexity. Off stops rendering and
  // writing, never data.
  { key: 'fieldTime', defaultEnabled: false, category: 'operations', navModules: ['timesheets'], parentKey: 'timeTracking', requiresAll: ['projects'] },
  { key: 'fieldTimeGeofence', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime' },
  { key: 'fieldTimePhoto', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime' },
  { key: 'fieldTimeKiosk', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime' },
  { key: 'fieldTimeCrewEntry', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime' },
  { key: 'fieldTimeEquipment', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime', requiresAll: ['equipment'] },
  { key: 'fieldTimeMultiStageApproval', defaultEnabled: false, category: 'operations', parentKey: 'fieldTime' },
  // HR-20 end
  // Payroll — country-pack statutory engines (CA T4127, US Pub 15-T), pay
  // runs, stubs, remittance liabilities. Off by default: enabling payroll is
  // a deliberate adoption decision (TD1/W-4 profiles, control accounts,
  // schedules must be configured).
  { key: 'payroll', defaultEnabled: false, category: 'operations', navModules: ['payroll'], recommends: ['timeTracking'] },
  // Human resources — the native employment record read surface (as-of
  // employment, headcount, change-request tracking). Off by default:
  // enabling HRM is a deliberate adoption decision (employment records must
  // exist before the cockpit says anything true). Stands alone: it reads
  // the HRM foundation but never drives payroll.
  { key: 'hrm', defaultEnabled: false, category: 'operations', navModules: ['hrm'] },
  // HR-12 begin: compensation — job architecture and bands ride the
  // parent; merit cycles, headcount plans and pay transparency are
  // opt-in sub-features. Merit cycles push to payroll and read pay
  // truth, so hrmMeritCycles additionally requires payroll.
  { key: 'hrmCompensation', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmMeritCycles', defaultEnabled: false, category: 'operations', parentKey: 'hrmCompensation', requiresAll: ['payroll'] },
  { key: 'hrmHeadcountPlans', defaultEnabled: false, category: 'operations', parentKey: 'hrmCompensation' },
  { key: 'hrmPayTransparency', defaultEnabled: false, category: 'operations', parentKey: 'hrmCompensation' },
  // HR-12 end
  // HR-17 begin: continuous performance. hrmPerformance is the parent
  // gate for the whole review-and-growth surface (HR-7's cycles, reviews
  // and goals move under it additively); 1:1s, feedback, competencies,
  // calibration and succession are opt-in sub-features. Off hides the
  // tab, widgets, tools and setup — never data.
  { key: 'hrmPerformance', defaultEnabled: true, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmOneOnOnes', defaultEnabled: false, category: 'operations', parentKey: 'hrmPerformance' },
  { key: 'hrmFeedback', defaultEnabled: false, category: 'operations', parentKey: 'hrmPerformance' },
  { key: 'hrmCompetencies', defaultEnabled: false, category: 'operations', parentKey: 'hrmPerformance' },
  { key: 'hrmCalibration', defaultEnabled: false, category: 'operations', parentKey: 'hrmPerformance' },
  { key: 'hrmSuccession', defaultEnabled: false, category: 'operations', parentKey: 'hrmPerformance' },
  // HR-17 end
  // HR-15 begin: optional persona-home complexity. The inbox and the persona
  // homes are core; only these widgets gate. Off hides the widget, never data.
  { key: 'hrmCelebrations', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmManagerNudges', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'homeAnnouncements', defaultEnabled: true, category: 'platform' },
  // HR-15 end
  { key: 'fieldTickets', defaultEnabled: false, category: 'operations', navModules: ['field-tickets'], parentKey: 'projects' },
  // Project scheduling: critical-path Gantt, working calendars, baselines and
  // resource levelling. Off by default — a schedule is a planning instrument,
  // not an accounting one, and orgs that only job-cost projects should not
  // carry it. Subordinate to the Projects parent gate.
  //
  // The work-breakdown outline is NOT part of this gate, despite once being
  // described here as if it were. It is core Projects: the tasks it edits are
  // the job's own structure, `/api/projects/[id]/tasks` gates on Projects
  // accordingly, and the tab stays available to every org that runs projects.
  // Only the Schedule subtab and /api/project-schedule sit behind this key.
  { key: 'projectScheduling', defaultEnabled: false, category: 'operations', parentKey: 'projects' },
  // Vendor-side project commitments and AP progress billing. Purchase orders
  // and compliance make the workflow richer but are not required to account
  // for a direct subcontract.
  { key: 'subcontracts', defaultEnabled: false, category: 'operations', navModules: ['subcontracts'], requiresAll: ['projects'], recommends: ['orders', 'subcontractorCompliance'] },
  // Commercial review of billable project work before it reaches a customer
  // invoice. Time is a recommended source; project cost WIP works without it.
  { key: 'wipBilling', defaultEnabled: false, category: 'operations', navModules: ['wip-billing'], requiresAll: ['projects'], recommends: ['timeTracking'] },
  // Lease, rent, CAM, and deposit operations. A third-party manager may not
  // own the buildings or use separate legal entities, so adjacent accounting
  // capabilities are recommendations rather than hard dependencies.
  { key: 'propertyManagement', defaultEnabled: false, category: 'operations', navModules: ['property-management'], recommends: ['fixedAssets', 'multiSubsidiary', 'onlinePayments', 'revenueRecognition'] },
  // Subcontractor compliance: certificates of insurance, lien waivers, and
  // year-end information returns (1099-NEC/MISC, T4A) for the people you pay.
  // Off by default and deliberately NOT a child of `projects`: COI tracking and
  // 1099 filing are buy-side controls that stand on their own, and an org with
  // no projects still has subcontractors to vet. The lien-waiver surface is the
  // one part that needs a project, so it additionally requires the Projects
  // gate — enforced at its own page/API boundary, not by a parent gate that
  // would take insurance tracking down with it.
  { key: 'subcontractorCompliance', defaultEnabled: false, category: 'operations', navModules: ['compliance', 'compliance-vendors', 'lien-waivers', 'information-returns'] },
  { key: 'inventory', defaultEnabled: true, category: 'operations', navModules: ['inventory'] },
  { key: 'equipment', defaultEnabled: true, category: 'operations', navModules: ['equipment'] },
  { key: 'expenses', defaultEnabled: true, category: 'operations', navModules: ['expenses'] },
  // Accounting
  // Multi-subsidiary: consolidation, intercompany, and per-entity
  // currencies/books. Data-dependent default — resolved by subsidiaryFeatureEnabled,
  // NOT the static defaultEnabled below (which only applies to brand-new orgs).
  { key: 'multiSubsidiary', defaultEnabled: false, category: 'accounting' },
  // Multi-currency: transact in currencies other than the base, with FX rates,
  // revaluation, and realized/unrealized gain-loss. Data-dependent default (see
  // resolveMultiCurrency), NOT the static flag below.
  { key: 'multiCurrency', defaultEnabled: false, category: 'accounting' },
  { key: 'banking', defaultEnabled: true, category: 'accounting', navModules: ['banking', 'banking-cash', 'banking-transactions', 'banking-psp-settlements', 'banking-match', 'banking-recons', 'banking-rules', 'banking-imports'] },
  // Automated bank connectivity (SFTP file drops + Plaid/GoCardless/TrueLayer
  // live feeds). Off by default — manual OFX/CSV import always works without it.
  { key: 'bankFeeds', defaultEnabled: false, category: 'accounting' },
  { key: 'fixedAssets', defaultEnabled: true, category: 'accounting', navModules: ['assets', 'leases', 'tax-depreciation'] },
  { key: 'budgets', defaultEnabled: true, category: 'accounting', navModules: ['budgets'] },
  { key: 'continuousClose', defaultEnabled: true, category: 'accounting', navModules: ['continuous-close'] },
  // Core period close is always available. This gate adds the mature-team
  // governance layer: evidence-heavy blueprints, independent approval flows,
  // and governed close-package publication. It depends on Flows because the
  // independent approval must be real at the service boundary, not a UI flag.
  { key: 'advancedClose', defaultEnabled: false, category: 'accounting', parentKey: 'flows' },
  // Allocation kernel (docs/design/allocation-kernel.md): one versioned rule
  // model bound at three moments — entry distributions, posting
  // contributions, period sweeps. Off by default: switching it on is a
  // deliberate adoption decision (rules, drivers, and run policies must be
  // configured first). The two binding-moment gates are subordinate to this
  // parent — neither moment can resolve enabled while it is off — and exist
  // so one moment can be switched off without losing the other.
  { key: 'allocations', defaultEnabled: false, category: 'accounting' },
  { key: 'allocationsAtEntry', defaultEnabled: true, category: 'accounting', parentKey: 'allocations' },
  { key: 'allocationsAtPosting', defaultEnabled: true, category: 'accounting', parentKey: 'allocations' },
  // Platform
  // HR-15: the inbox nav module ('approvals') is NO LONGER a flows surface.
  // It is the one place a person completes work — leave requests, checklist
  // steps, signatures and notices all arrive there, and only the decision
  // rows come from flows. Claiming it here made the switchboard promise that
  // turning flows off hides the inbox, which would strand every non-flows
  // task; the flows ADAPTER already returns nothing when flows is off.
  { key: 'flows', defaultEnabled: true, category: 'platform', navModules: ['flows'] },
  // HR-16 automations on Flows (0226): trigger/rule/condition/action recipes
  // over the existing Flows gates. The builder is platform-nav under Flows;
  // exception-only approval is a per-flow SETTING, not a feature.
  // HR-16 begin
  { key: 'automations', defaultEnabled: false, category: 'platform', parentKey: 'flows', navModules: ['automations'] },
  { key: 'automationDateTriggers', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'automationFieldTriggers', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'automationWebhooks', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'automationSimulator', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  // HR-16 end
  // HR-16 action/reason codes (0227): cheap, every enterprise suite has
  // them — default ON. Event verbs (cancel/rescind/correct) on completed
  // employment changes.
  // HR-16 begin
  { key: 'hrmActionReasons', defaultEnabled: true, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmEventVerbs', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  // HR-16 end
  { key: 'apps', defaultEnabled: true, category: 'platform', navModules: ['apps'] },
  { key: 'scripts', defaultEnabled: false, category: 'platform', navModules: ['admin-scripts'] },
  { key: 'apiAccess', defaultEnabled: false, category: 'platform', navModules: ['admin-api-keys', 'api-docs'] },
  { key: 'mcpAccess', defaultEnabled: false, category: 'platform', requiresAll: ['apiAccess'] },
  { key: 'queryConsole', defaultEnabled: false, category: 'platform', navModules: ['sql'] },
  // HR-13 begin: construction compliance — prevailing-wage and union rate
  // tables, certified payroll, workers'-comp class splits, apprentice
  // ratios, per-diem and travel pay. A general-business org never sees
  // any of this: the parent needs payroll, projects and time tracking,
  // and every complexity below it is a sub-feature that hides and
  // switches off independently. Toggling never deletes data.
  { key: 'hrmConstructionCompliance', defaultEnabled: false, category: 'operations', navModules: ['hrm-compliance'], parentKey: 'hrm', requiresAll: ['payroll', 'projects', 'timeTracking'] },
  { key: 'hrmPrevailingWage', defaultEnabled: false, category: 'operations', parentKey: 'hrmConstructionCompliance' },
  { key: 'hrmCertifiedPayroll', defaultEnabled: false, category: 'operations', parentKey: 'hrmConstructionCompliance', requiresAll: ['hrmPrevailingWage'] },
  { key: 'hrmWorkersCompClasses', defaultEnabled: false, category: 'operations', parentKey: 'hrmConstructionCompliance' },
  { key: 'hrmApprenticeRatios', defaultEnabled: false, category: 'operations', parentKey: 'hrmConstructionCompliance', requiresAll: ['hrmPrevailingWage'] },
  { key: 'hrmPerDiem', defaultEnabled: false, category: 'operations', parentKey: 'hrmConstructionCompliance' },
  // HR-13 end
  // HR-14 begin: certifications, licenses and dispatch gating — the worker
  // qualification ledger. Dispatch gating refuses unqualified assignments
  // on the projectScheduling board (needs projects + projectScheduling);
  // equipment qualifications gate machine assignments (needs equipment);
  // certification alerts are the daily expiry scan (needs nothing else).
  // Toggling any of these never deletes data.
  { key: 'hrmCertifications', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmDispatchGating', defaultEnabled: false, category: 'operations', parentKey: 'hrmCertifications', requiresAll: ['projects', 'projectScheduling'] },
  { key: 'hrmEquipmentQualifications', defaultEnabled: false, category: 'operations', parentKey: 'hrmCertifications', requiresAll: ['equipment'] },
  { key: 'hrmCertificationAlerts', defaultEnabled: false, category: 'operations', parentKey: 'hrmCertifications' },
  // HR-14 end
  // HR-19 begin: documents with e-sign ride the hrm parent; retention
  // schedules with audited deletion and one-click subject-access exports
  // are opt-in sub-features. Surveys ride hrm with pulse cadence as the
  // opt-in complexity. The org chart is default-on: every suite has one.
  // Toggling never deletes data — rows stay and re-render when re-on.
  { key: 'hrmDocuments', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmDocumentRetention', defaultEnabled: false, category: 'operations', parentKey: 'hrmDocuments' },
  { key: 'hrmDataSubjectExport', defaultEnabled: false, category: 'operations', parentKey: 'hrmDocuments' },
  { key: 'hrmSurveys', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmPulseSurveys', defaultEnabled: false, category: 'operations', parentKey: 'hrmSurveys' },
  { key: 'hrmOrgChart', defaultEnabled: true, category: 'operations', parentKey: 'hrm' },
  // HR-19 end
  // HR-18 begin: recruiting depth — the HR-6 funnel rides the parent (on
  // wherever hrm is on); kits, scheduling, signing, boards, retention and
  // pools are opt-in sub-features. hrmOfferSigning will requireAll
  // hrmDocuments when HR-19 lands; until then it signs through the File
  // Cabinet HMAC primitive the field-ticket surface uses, so no documents
  // edge is declared here.
  { key: 'hrmRecruiting', defaultEnabled: true, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmStructuredInterviews', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  { key: 'hrmInterviewScheduling', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  { key: 'hrmOfferSigning', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  { key: 'hrmJobBoards', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  { key: 'hrmCandidateRetention', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  { key: 'hrmTalentPool', defaultEnabled: false, category: 'operations', parentKey: 'hrmRecruiting' },
  // HR-18 end
  // HR-21 begin: AI on the rails — every capability is a tool or a
  // deterministic service; the LLM only phrases and drafts. The parent
  // hides all AI complexity; sub-features switch independently and
  // turning them off preserves data and audit history. The ledger is
  // governance: it is on whenever any AI feature is.
  { key: 'hrmAiAssist', defaultEnabled: false, category: 'operations', parentKey: 'hrm' },
  { key: 'hrmExplainPay', defaultEnabled: false, category: 'operations', parentKey: 'hrmAiAssist', requiresAll: ['payroll'] },
  { key: 'hrmPayrollAnomalies', defaultEnabled: false, category: 'operations', parentKey: 'hrmAiAssist', requiresAll: ['payroll'] },
  { key: 'hrmTimeAnomalies', defaultEnabled: false, category: 'operations', parentKey: 'hrmAiAssist', requiresAll: ['timeTracking'] },
  { key: 'hrmDrafting', defaultEnabled: false, category: 'operations', parentKey: 'hrmAiAssist' },
  { key: 'hrmNlReports', defaultEnabled: false, category: 'operations', parentKey: 'hrmAiAssist' },
  { key: 'aiGovernanceLedger', defaultEnabled: true, category: 'platform' },
  // HR-21 end
]

export const FEATURE_BY_KEY = new Map(FEATURES.map((f) => [f.key, f]))

export type FeatureState = Record<string, boolean>

/** Hard requirements for one feature, normalized across single-parent and
 * multi-dependency declarations. Stable ordering keeps UI/API errors deterministic. */
export function featureRequirements(def: FeatureDef): string[] {
  return [...new Set([...(def.parentKey ? [def.parentKey] : []), ...(def.requiresAll ?? [])])]
}

/** Pure: resolve one feature from a settings.features object. */
export function featureEnabled(
  state: FeatureState | null | undefined,
  key: string,
  resolving: Set<string> = new Set(),
): boolean {
  const def = FEATURE_BY_KEY.get(key)
  if (!def) return false
  // A registry cycle is invalid configuration. Fail closed instead of recursing
  // forever or exposing a partially gated module.
  if (resolving.has(key)) return false
  const nextResolving = new Set(resolving).add(key)
  if (featureRequirements(def).some((required) => !featureEnabled(state, required, nextResolving))) return false
  const v = state?.[key]
  return typeof v === 'boolean' ? v : def.defaultEnabled
}
