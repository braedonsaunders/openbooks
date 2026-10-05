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

/** Features-page tabs, in display order. Each tab follows the operating
 * cycle of its domain so related switches sit together. */
export const FEATURE_CATEGORIES = ['finance', 'sales', 'billing', 'inventory', 'projects', 'people', 'industries', 'platform'] as const
export type FeatureCategory = (typeof FEATURE_CATEGORIES)[number]

export interface FeatureDef {
  key: string
  /** Enabled for orgs that have never touched the toggle. */
  defaultEnabled: boolean
  /** Nav module keys hidden while the feature is off. */
  navModules?: string[]
  /** Features-page tab. Registry order within a category is display order. */
  category: FeatureCategory
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
  // Finance — legal structure, cash, planning, allocation, tax and close.
  // Multi-subsidiary: consolidation, intercompany, and per-entity
  // currencies/books. Data-dependent default — resolved by subsidiaryFeatureEnabled,
  // NOT the static defaultEnabled below (which only applies to brand-new orgs).
  { key: 'multiSubsidiary', defaultEnabled: false, category: 'finance' },
  // Multi-currency: transact in currencies other than the base, with FX rates,
  // revaluation, and realized/unrealized gain-loss. Data-dependent default (see
  // resolveMultiCurrency), NOT the static flag below.
  { key: 'multiCurrency', defaultEnabled: false, category: 'finance' },
  { key: 'banking', defaultEnabled: true, category: 'finance', navModules: ['banking', 'banking-cash', 'banking-transactions', 'banking-psp-settlements', 'banking-payouts', 'banking-match', 'banking-recons', 'banking-rules', 'banking-imports'] },
  // Automated bank connectivity (SFTP file drops + Plaid/GoCardless/TrueLayer
  // live feeds). Off by default — manual OFX/CSV import always works without it.
  { key: 'bankFeeds', defaultEnabled: false, category: 'finance' },
  { key: 'fixedAssets', defaultEnabled: true, category: 'finance', navModules: ['assets', 'leases', 'tax-depreciation'] },
  { key: 'budgets', defaultEnabled: true, category: 'finance', navModules: ['budgets'] },
  // Allocation kernel (docs/design/allocation-kernel.md): one versioned rule
  // model bound at three moments — entry distributions, posting
  // contributions, period sweeps. Off by default: switching it on is a
  // deliberate adoption decision (rules, drivers, and run policies must be
  // configured first). The two binding-moment gates are subordinate to this
  // parent — neither moment can resolve enabled while it is off — and exist
  // so one moment can be switched off without losing the other.
  { key: 'allocations', defaultEnabled: false, category: 'finance' },
  { key: 'allocationsAtEntry', defaultEnabled: true, category: 'finance', parentKey: 'allocations' },
  { key: 'allocationsAtPosting', defaultEnabled: true, category: 'finance', parentKey: 'allocations' },
  // Cross-border digital and e-commerce tax: place of supply from collected
  // evidence, business VAT ID validation with reverse charge, EU distance-sales
  // threshold monitoring, and One-Stop-Shop returns. Off by default: turning
  // it on is a deliberate adoption decision (OSS registrations and customer
  // evidence must be configured first). Data and evidence are kept when off.
  { key: 'crossBorderTax', defaultEnabled: false, category: 'finance' },
  { key: 'continuousClose', defaultEnabled: true, category: 'finance', navModules: ['continuous-close'] },
  // Core period close is always available. This gate adds the mature-team
  // governance layer: evidence-heavy blueprints, independent approval flows,
  // and governed close-package publication. It depends on Flows because the
  // independent approval must be real at the service boundary, not a UI flag.
  { key: 'advancedClose', defaultEnabled: false, category: 'finance', parentKey: 'flows' },

  // Sales — pipeline, order entry and point-of-sale selling.
  // The account list is NOT here: leads, prospects and customers share one
  // list gated by parties.read, and turning CRM off narrows that list to
  // customers rather than removing a nav entry.
  { key: 'crm', defaultEnabled: true, category: 'sales', navModules: ['crm-opportunities', 'crm-activities', 'crm-forecasts'] },
  { key: 'salesManagement', defaultEnabled: true, category: 'sales', parentKey: 'crm', navModules: ['crm-sales'] },
  { key: 'geographicTerritories', defaultEnabled: false, category: 'sales', parentKey: 'salesManagement' },
  { key: 'orders', defaultEnabled: true, category: 'sales', navModules: ['estimates', 'sales-orders', 'purchase-orders'] },
  { key: 'customerPartNumbers', defaultEnabled: false, category: 'sales', requiresAll: ['orders'] },
  // Discount codes and campaigns captured on sales document lines, with
  // promotion performance reporting. Needs order entry to discount against.
  { key: 'promotions', defaultEnabled: false, category: 'sales', requiresAll: ['orders'] },
  // Paid-at-sale documents: cash sales (sales receipts) and cash refunds post
  // revenue, tax, and COGS with tenders straight to clearing/bank — no
  // receivable, no open item. Off by default; hiding the surface never
  // deletes posted sales or their history.
  { key: 'cashSales', defaultEnabled: false, category: 'sales', navModules: ['cash-sales'] },
  // Stored value: gift cards and store credit carried as liabilities, with
  // issuance, redemption, breakage and expiry. Off by default — selling a
  // gift card changes what a sale posts, so adoption is deliberate.
  { key: 'storedValue', defaultEnabled: false, category: 'sales', navModules: ['stored-value'] },
  // Storefront channel connections (channel records, the external-identity
  // map, the inbound webhook inbox, channel orders). Off by default: posting
  // needs orders and inventory beneath it, and connecting is adoption.
  { key: 'salesChannels', defaultEnabled: false, category: 'sales', requiresAll: ['orders', 'inventory'], navModules: ['channels'] },

  // Billing — recurring billing, collection and revenue recognition.
  // Subscription billing: plans + subscriptions that auto-generate recurring
  // invoices (SaaS/retainer style). Off by default — recurring document
  // schedules + dunning work without it; this adds the plan/subscription model.
  { key: 'subscriptionBilling', defaultEnabled: false, category: 'billing' },
  // Contract-grade subscription lifecycle layered over the base recurring
  // plan/subscription engine: versioned catalog terms, components, trials,
  // amendments, renewals, co-terming, and advance/arrears timing.
  { key: 'advancedSubscriptions', defaultEnabled: false, category: 'billing', requiresAll: ['subscriptionBilling'] },
  // Usage billing: metered usage rated onto subscriptions.
  { key: 'usageBilling', defaultEnabled: false, category: 'billing', requiresAll: ['subscriptionBilling'] },
  // Quote-to-cash: ramp-priced subscription terms on quotes, discount
  // approval through Flows, customer e-signature, and one-click activation
  // into billed subscriptions. Needs the order surface for quotes and the
  // subscription engine for activation; advanced ramps additionally need
  // advancedSubscriptions, checked where ramps are scheduled.
  { key: 'quoteToCash', defaultEnabled: false, category: 'billing', requiresAll: ['orders', 'subscriptionBilling'] },
  // Payer hierarchies and consolidated billing: a parent company, reseller
  // or franchise payer receives one invoice for its children's
  // subscriptions, including across legal entities with intercompany legs.
  // Off by default — without it every subscription bills its own customer.
  { key: 'consolidatedBilling', defaultEnabled: false, category: 'billing' },
  // SaaS metrics: recurring-revenue analytics read from subscription data.
  { key: 'saasMetrics', defaultEnabled: false, category: 'billing', requiresAll: ['subscriptionBilling'], recommends: ['revenueRecognition', 'advancedSubscriptions'] },
  // Billing-platform history import (Chargebee, Recurly, Maxio, Zuora):
  // customers, plans, subscriptions with change history, invoices, payments,
  // usage and coupons into native records with MRR/AR/deferred reconciliation.
  // Requires the subscription engine it writes through; usage, coupons and
  // amendments degrade to named refusals when their own gates stay off.
  { key: 'billingHistoryImport', defaultEnabled: false, category: 'billing', requiresAll: ['subscriptionBilling'] },
  // Online customer payments: hosted payment links on invoices (Stripe /
  // Adyen / GoCardless bank debit), surcharge rules, provider webhooks that
  // auto-apply receipts to open items. Off by default — manual receipts and
  // payment files work without it.
  { key: 'onlinePayments', defaultEnabled: false, category: 'billing' },
  // Automatic collection: stored payment methods (card on file, bank-debit
  // mandates), autopay enrollment per customer or subscription, scheduled
  // charging of due invoices with retries, and suspension on final failure.
  // Needs onlinePayments — every charge rides a configured PSP provider.
  { key: 'autopay', defaultEnabled: false, category: 'billing', requiresAll: ['onlinePayments'] },
  // Customer portal: passwordless customer sign-in with invoices and
  // pay-now, payment methods, subscription changes with proration preview,
  // usage and credit balances, order tracking, self-service returns and
  // gift card lookup. Off by default — opening customer self-service is
  // adoption. Pay-now and saved methods degrade to named refusals while
  // onlinePayments and autopay stay off.
  { key: 'customerPortal', defaultEnabled: false, category: 'billing' },
  { key: 'revenueRecognition', defaultEnabled: true, category: 'billing', navModules: ['revenue'] },
  // Revenue contracts spanning orders, subscriptions and several invoices.
  // Off by default: without it every invoice keeps its own contract. A child
  // of revenueRecognition, so it can never resolve on while recognition is off.
  { key: 'revenueContracts', defaultEnabled: false, category: 'billing', parentKey: 'revenueRecognition' },
  // Capitalized contract costs (ASC 340-40): sales commissions held as an
  // asset and amortized over the contract term or the expected customer
  // life. Subordinate to revenue recognition — amortization follows the
  // revenue schedule for pattern-method assets.
  { key: 'contractCosts', defaultEnabled: false, category: 'billing', requiresAll: ['revenueRecognition'] },

  // Inventory — stock, warehousing, fulfillment, planning and production.
  { key: 'inventory', defaultEnabled: true, category: 'inventory', navModules: ['inventory'] },
  // Item variants: product families with ordered options whose combinations
  // become ordinary variant items. Needs the item catalog's stocked kinds.
  { key: 'itemVariants', defaultEnabled: false, category: 'inventory', requiresAll: ['inventory'] },
  { key: 'barcodeScanning', defaultEnabled: false, category: 'inventory', requiresAll: ['inventory'] },
  // Warehousing and fulfillment: warehouse locations, then pick and ship.
  { key: 'warehousing', defaultEnabled: false, category: 'inventory', navModules: ['warehouses'], requiresAll: ['inventory'] },
  { key: 'fulfillment', defaultEnabled: false, category: 'inventory', navModules: ['picks', 'shipments'], requiresAll: ['orders', 'warehousing'] },
  // Carrier hub: live rates, labels, tracking, and carrier cost on shipments.
  // Subordinate to fulfillment — rating a shipment the org cannot ship is
  // refused, and switching it off hides the surface while keeping labels,
  // quotes, and posted cost history.
  { key: 'shippingHub', defaultEnabled: false, category: 'inventory', navModules: ['shipments'], parentKey: 'fulfillment' },
  { key: 'returnAuthorizations', defaultEnabled: false, category: 'inventory', navModules: ['returns'], requiresAll: ['fulfillment'] },
  { key: 'dropShipping', defaultEnabled: false, category: 'inventory', requiresAll: ['orders', 'inventory'] },
  // Demand planning: statistical forecasts per item and location with
  // stockout correction, feeding reviewable purchase and transfer
  // suggestions. Needs stocked items and their movements. Off by default —
  // planning suggestions stay out of the way until the org wants them.
  { key: 'demandPlanning', defaultEnabled: false, category: 'inventory', requiresAll: ['inventory'] },
  // Manufacturing: building finished goods from inventory components.
  { key: 'manufacturing', defaultEnabled: false, category: 'inventory', navModules: ['manufacturing'], requiresAll: ['inventory'] },
  { key: 'manufacturingMrp', defaultEnabled: false, category: 'inventory', parentKey: 'manufacturing', recommends: ['orders'] },

  // Projects — project delivery, field work and the buy side of a job.
  // Projects is a parent gate on the centralized Features page.
  // Schedule-of-values billing remains a project-type procedure, not a gate.
  { key: 'projects', defaultEnabled: true, category: 'projects', navModules: ['projects', 'field-tickets', 'lien-waivers'] },
  { key: 'timeTracking', defaultEnabled: true, category: 'projects', navModules: ['timesheets'], parentKey: 'projects' },
  // Field time capture — ONE switch for mobile and kiosk clock-in,
  // geofence checks, clock photos, the offline queue, foreman crew batches
  // and equipment hours on time. It rides timeTracking (office orgs never
  // see a clock) and needs projects. What stays tunable is configuration,
  // not a feature: geofences are declared per project, photo requirements
  // live in Timesheets setup and on each kiosk, equipment hours need the
  // Equipment module, and approval routing is authored in Flows. Off stops
  // rendering and writing, never data.
  { key: 'fieldTime', defaultEnabled: false, category: 'projects', navModules: ['timesheets'], parentKey: 'timeTracking', requiresAll: ['projects'] },
  { key: 'fieldTickets', defaultEnabled: false, category: 'projects', navModules: ['field-tickets'], parentKey: 'projects' },
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
  { key: 'projectScheduling', defaultEnabled: false, category: 'projects', parentKey: 'projects' },
  // Resourcing: staffing project demand, request approval, and retainers.
  { key: 'resourcing', defaultEnabled: false, category: 'projects', navModules: ['resourcing'], parentKey: 'projects' },
  { key: 'resourceRequests', defaultEnabled: false, category: 'projects', parentKey: 'resourcing', requiresAll: ['flows'] },
  { key: 'retainerBilling', defaultEnabled: false, category: 'projects', parentKey: 'resourcing', requiresAll: ['revenueRecognition'] },
  // Commercial review of billable project work before it reaches a customer
  // invoice. Time is a recommended source; project cost WIP works without it.
  { key: 'wipBilling', defaultEnabled: false, category: 'projects', navModules: ['wip-billing'], requiresAll: ['projects'], recommends: ['timeTracking'] },
  // Vendor-side project commitments and AP progress billing. Purchase orders
  // and compliance make the workflow richer but are not required to account
  // for a direct subcontract.
  { key: 'subcontracts', defaultEnabled: false, category: 'projects', navModules: ['subcontracts'], requiresAll: ['projects'], recommends: ['orders', 'subcontractorCompliance'] },
  // Subcontractor compliance: certificates of insurance, lien waivers, and
  // year-end information returns (1099-NEC/MISC, T4A) for the people you pay.
  // Off by default and deliberately NOT a child of `projects`: COI tracking and
  // 1099 filing are buy-side controls that stand on their own, and an org with
  // no projects still has subcontractors to vet. The lien-waiver surface is the
  // one part that needs a project, so it additionally requires the Projects
  // gate — enforced at its own page/API boundary, not by a parent gate that
  // would take insurance tracking down with it.
  { key: 'subcontractorCompliance', defaultEnabled: false, category: 'projects', navModules: ['compliance', 'compliance-vendors', 'lien-waivers', 'information-returns'] },
  { key: 'equipment', defaultEnabled: true, category: 'projects', navModules: ['equipment'] },

  // People — hire to retire, pay and employee spend.
  // Human resources — the native employment record read surface (as-of
  // employment, headcount, change-request tracking). Off by default:
  // enabling HRM is a deliberate adoption decision (employment records must
  // exist before the cockpit says anything true). Stands alone: it reads
  // the HRM foundation but never drives payroll.
  { key: 'hrm', defaultEnabled: false, category: 'people', navModules: ['hrm'] },
  // Every HRM module below is ONE switch under Human resources — no module
  // carries sub-switches. What a module does is on whenever the module is;
  // what a tenant may reasonably tune is configuration inside the module.
  // Human resources itself covers the core record surface: change
  // requests with action and reason codes and cancel/rescind/correct
  // verbs, the org chart, and the persona-home widgets (celebrations and
  // manager nudges, placed through dashboard layouts).
  //
  // Recruiting — the vacancy-to-hire funnel with interview kits,
  // scheduling, offer signing, job boards, candidate retention and talent
  // pools.
  { key: 'hrmRecruiting', defaultEnabled: true, category: 'people', parentKey: 'hrm' },
  // Performance — cycles, reviews and goals, plus 1:1s, feedback,
  // competencies, calibration, talent reviews and succession. Off hides the
  // tab, widgets, tools and setup — never data.
  { key: 'hrmPerformance', defaultEnabled: true, category: 'people', parentKey: 'hrm' },
  // Compensation — job architecture, bands, merit cycles, headcount plans
  // and pay transparency. Merit cycles additionally need Payroll, checked
  // where they read pay truth or push rates.
  { key: 'hrmCompensation', defaultEnabled: false, category: 'people', parentKey: 'hrm' },
  // Certifications and licenses — the worker qualification ledger, its
  // daily expiry alerts, dispatch gating on the project scheduling board
  // (where Project Scheduling is on) and equipment qualification
  // requirements (where Equipment is on). Toggling never deletes data.
  { key: 'hrmCertifications', defaultEnabled: false, category: 'people', parentKey: 'hrm' },
  // HR documents — hire-to-retire documents with e-signature, retention
  // schedules with audited deletion, and subject-access exports. Toggling
  // never deletes data — rows stay and re-render when re-on.
  { key: 'hrmDocuments', defaultEnabled: false, category: 'people', parentKey: 'hrm' },
  // Engagement surveys — one-off and recurring pulse surveys with
  // anonymity-grade results.
  { key: 'hrmSurveys', defaultEnabled: false, category: 'people', parentKey: 'hrm' },
  // Construction compliance — prevailing-wage and union rate tables,
  // certified payroll, workers'-comp class splits, apprentice ratios, and
  // per-diem and travel pay. A general-business org never sees any of it:
  // the module needs payroll, projects and time tracking. Toggling never
  // deletes data.
  { key: 'hrmConstructionCompliance', defaultEnabled: false, category: 'people', parentKey: 'hrm', requiresAll: ['payroll', 'projects', 'timeTracking'] },
  // Payroll — country-pack statutory engines (CA T4127, US Pub 15-T), pay
  // runs, stubs, remittance liabilities. Off by default: enabling payroll is
  // a deliberate adoption decision (TD1/W-4 profiles, control accounts,
  // schedules must be configured).
  { key: 'payroll', defaultEnabled: false, category: 'people', navModules: ['payroll'], recommends: ['timeTracking'] },
  { key: 'expenses', defaultEnabled: true, category: 'people', navModules: ['expenses'] },

  // Industries — vertical solutions an org adopts as a whole.
  // Lease, rent, CAM, and deposit operations. A third-party manager may not
  // own the buildings or use separate legal entities, so adjacent accounting
  // capabilities are recommendations rather than hard dependencies.
  { key: 'propertyManagement', defaultEnabled: false, category: 'industries', navModules: ['property-management'], recommends: ['fixedAssets', 'multiSubsidiary', 'onlinePayments', 'revenueRecognition'] },
  // Nonprofit accounting: funds, grants, pledges, encumbrances, and
  // functional-expense reporting, all subordinate to the nonprofit parent.
  { key: 'nonprofit', defaultEnabled: false, category: 'industries', navModules: ['nonprofit'] },
  { key: 'fundAccounting', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit' },
  { key: 'grantManagement', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit', requiresAll: ['fundAccounting'] },
  { key: 'pledges', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit' },
  { key: 'encumbrances', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit', requiresAll: ['budgets'] },
  { key: 'functionalExpenses', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit' },
  { key: 'form990', defaultEnabled: false, category: 'industries', parentKey: 'nonprofit', requiresAll: ['functionalExpenses'] },

  // Platform — workflow, workspace, extensibility and developer access.
  // The inbox nav module ('approvals') is not a flows surface. It is the one
  // place a person completes work — leave requests, checklist steps,
  // signatures and notices all arrive there, and only the decision rows come
  // from flows. Claiming it here would make the switchboard promise that
  // turning flows off hides the inbox, stranding every non-flows task; the
  // flows adapter already returns nothing when flows is off.
  { key: 'flows', defaultEnabled: true, category: 'platform', navModules: ['flows'] },
  // Automations on Flows: trigger/rule/condition/action recipes over the
  // existing Flows gates. The builder is platform nav under Flows;
  // exception-only approval is a per-flow setting, not a feature.
  { key: 'automations', defaultEnabled: false, category: 'platform', parentKey: 'flows', navModules: ['automations'] },
  { key: 'automationDateTriggers', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'automationFieldTriggers', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'automationWebhooks', defaultEnabled: false, category: 'platform', parentKey: 'automations', requiresAll: ['outboundWebhooks'] },
  { key: 'automationSimulator', defaultEnabled: false, category: 'platform', parentKey: 'automations' },
  { key: 'homeAnnouncements', defaultEnabled: true, category: 'platform' },
  // The AI governance ledger records every AI-assisted answer across the
  // product. It is platform governance, not an HRM module: the AI
  // capabilities it logs ride the module that owns their data.
  { key: 'aiGovernanceLedger', defaultEnabled: true, category: 'platform' },
  { key: 'apps', defaultEnabled: true, category: 'platform', navModules: ['apps'] },
  { key: 'scripts', defaultEnabled: false, category: 'platform', navModules: ['admin-scripts'] },
  { key: 'apiAccess', defaultEnabled: false, category: 'platform', navModules: ['admin-api-keys', 'api-docs'] },
  // Outbound webhooks: signed domain-event delivery to subscriber
  // endpoints (Settings → Developers → Webhooks). The automation webhook
  // action additionally requires this gate (see automationWebhooks).
  { key: 'outboundWebhooks', defaultEnabled: false, category: 'platform', requiresAll: ['apiAccess'] },
  { key: 'mcpAccess', defaultEnabled: false, category: 'platform', requiresAll: ['apiAccess'] },
  { key: 'queryConsole', defaultEnabled: false, category: 'platform', navModules: ['sql'] },
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
