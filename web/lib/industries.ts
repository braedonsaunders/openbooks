import 'server-only'

/**
 * Industry registry — the single source of truth for the vertical presets the
 * setup wizard can apply. Each industry is a *bundle*: a recommended set of
 * feature toggles, a chart-of-accounts template, and default control-account
 * mappings. The bundle is a *starting point, not a gate* — every feature
 * remains individually toggleable on the Features page (the authoritative
 * switchboard), and every account is editable at /accounts.
 *
 * Applying an industry:
 *   1. Inserts the COA template rows into `accounts` (idempotent by account number).
 *   2. Maps `controlAccounts` by account number → the inserted account IDs.
 *   3. Writes the feature presets to `orgs.settings.features` (merged with existing).
 *   4. Stores `orgs.settings.industry = <key>` for audit and re-run detection.
 *
 * Switching industries after postings exist is blocked (same integrity-probe
 * pattern as multiSubsidiary disable) because the COA and control accounts
 * become load-bearing. Company name, country, currency, and individual feature
 * toggles remain editable at all times.
 *
 * Keys are STABLE ids. Labels/descriptions are i18n
 * (`admin.industries.{key}.*`), never stored.
 */

export type AccountType =
  | 'asset_bank'
  | 'asset_receivable'
  | 'asset_current_other'
  | 'asset_fixed'
  | 'asset_other'
  | 'liability_payable'
  | 'liability_card'
  | 'liability_current_other'
  | 'liability_long_term'
  | 'equity'
  | 'income'
  | 'income_other'
  | 'cogs'
  | 'expense'
  | 'expense_other'
  | 'expense_deferred'

export interface CoaAccount {
  number: string
  name: string
  type: AccountType
  isSummary?: boolean
  reconcilable?: boolean
  requiredDimensions?: string[]
}

export interface IndustryDef {
  key: string
  /** Lucide icon name (resolved in the wizard component). */
  icon: string
  /** Category grouping for the picker grid. */
  category: 'services' | 'trade' | 'commerce' | 'property' | 'public' | 'general'
  /**
   * Feature overrides — only the keys this industry has an opinion about.
   * Missing keys fall through to the FEATURES registry default.
   * Users can still toggle any feature individually on the Features page.
   */
  features: Record<string, boolean>
  /** Chart-of-accounts template (lean: ~20-35 accounts). */
  coa: CoaAccount[]
  /**
   * Control-account mappings by account NUMBER (resolved to UUIDs at apply
   * time after the COA rows are inserted). Only the keys this industry sets.
   */
  controlAccounts: Record<string, string>
}

// ---------------------------------------------------------------------------
// Control-account keys (must match SettingsForm / posting engine expectations)
// ---------------------------------------------------------------------------
const AR = 'ar'
const AP = 'ap'
const BANK = 'bank'
const TAX_COLLECTED = 'taxCollected'
const TAX_PAID = 'taxPaid'
const EMPLOYEE_PAYABLE = 'employeePayable'
const FX_UNREAL = 'fxUnrealizedGainLoss'
const FX_REAL = 'fxRealizedGainLoss'
const LABOR_WIP = 'laborWip'
const LABOR_CLR = 'laborClearing'
const UNBILLED_AR = 'unbilledReceivable'
const PROJECT_REV = 'projectRevenue'
const RETAINAGE = 'retainageReceivable'

// ---------------------------------------------------------------------------
// Shared COA building blocks (composed per industry to stay DRY)
// ---------------------------------------------------------------------------

const standardEquity = (): CoaAccount[] => [
  { number: '3000', name: 'Share Capital', type: 'equity' },
  { number: '3100', name: 'Retained Earnings', type: 'equity' },
  { number: '3200', name: "Owner's Drawings", type: 'equity' },
]

const standardBank = (): CoaAccount[] => [
  { number: '1000', name: 'Operating Bank Account', type: 'asset_bank', reconcilable: true },
  { number: '1010', name: 'Savings Account', type: 'asset_bank', reconcilable: true },
]

const standardLiabilities = (): CoaAccount[] => [
  { number: '2000', name: 'Accounts Payable', type: 'liability_payable' },
  { number: '2100', name: 'Accrued Expenses', type: 'liability_current_other' },
  { number: '2200', name: 'Sales Tax Payable', type: 'liability_current_other' },
  { number: '2300', name: 'Payroll Deductions Payable', type: 'liability_current_other' },
  { number: '2400', name: 'Employee Payable', type: 'liability_current_other' },
  { number: '2500', name: 'Credit Card', type: 'liability_card', reconcilable: true },
  { number: '2600', name: 'Long-Term Debt', type: 'liability_long_term' },
]

const standardOverhead = (): CoaAccount[] => [
  { number: '6000', name: 'Office Salaries & Wages', type: 'expense' },
  { number: '6100', name: 'Rent Expense', type: 'expense' },
  { number: '6200', name: 'Utilities', type: 'expense' },
  { number: '6300', name: 'Office Supplies', type: 'expense' },
  { number: '6400', name: 'Insurance', type: 'expense' },
  { number: '6500', name: 'Professional Fees', type: 'expense' },
  { number: '6600', name: 'Depreciation Expense', type: 'expense' },
  { number: '6700', name: 'Bank Charges', type: 'expense' },
  { number: '6800', name: 'Software & Subscriptions', type: 'expense' },
  { number: '6900', name: 'Marketing & Advertising', type: 'expense' },
]

const fxAccounts = (): CoaAccount[] => [
  { number: '4900', name: 'FX Gain/Loss — Unrealized', type: 'income_other' },
  { number: '4910', name: 'FX Gain/Loss — Realized', type: 'income_other' },
]

// ---------------------------------------------------------------------------
// Industry definitions
// ---------------------------------------------------------------------------

export const INDUSTRIES: IndustryDef[] = [
  // ── General Business ──────────────────────────────────────────────────
  {
    key: 'general_business',
    icon: 'Building2',
    category: 'general',
    features: {},
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '4000', name: 'Sales Revenue', type: 'income' },
      { number: '4100', name: 'Service Revenue', type: 'income' },
      { number: '4200', name: 'Other Income', type: 'income_other' },
      { number: '5000', name: 'Cost of Goods Sold', type: 'cogs' },
      ...standardOverhead(),
      { number: '7000', name: 'Interest Expense', type: 'expense_other' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
    },
  },

  // ── Construction & Trade Contractors ──────────────────────────────────
  {
    key: 'construction_contractor',
    icon: 'HardHat',
    category: 'trade',
    features: {
      projects: true,
      fieldTickets: true,
      equipment: true,
      inventory: true,
      timeTracking: true,
      subscriptionBilling: false,
      revenueRecognition: true,
      // A general contractor cannot release a subcontractor's money without
      // current insurance and a signed waiver, and files 1099-NEC every January.
      subcontractorCompliance: true,
    },
    coa: [
      { number: '1000', name: 'Operating Account', type: 'asset_bank', reconcilable: true },
      { number: '1010', name: 'Payroll Account', type: 'asset_bank', reconcilable: true },
      { number: '1020', name: 'Materials Deposit', type: 'asset_bank', reconcilable: true },
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1110', name: 'Retainage Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Materials Inventory', type: 'asset_current_other' },
      { number: '1300', name: 'Work in Progress', type: 'asset_current_other' },
      { number: '1400', name: 'Equipment', type: 'asset_fixed' },
      { number: '1410', name: 'Accumulated Depreciation — Equipment', type: 'asset_fixed' },
      { number: '1420', name: 'Vehicles', type: 'asset_fixed' },
      { number: '1430', name: 'Accumulated Depreciation — Vehicles', type: 'asset_fixed' },
      { number: '2000', name: 'Accounts Payable', type: 'liability_payable' },
      { number: '2100', name: 'Accrued Wages', type: 'liability_current_other' },
      { number: '2110', name: 'Payroll Deductions', type: 'liability_current_other' },
      { number: '2120', name: "Workers' Comp Payable", type: 'liability_current_other' },
      { number: '2130', name: 'Subcontractor Payable', type: 'liability_payable' },
      { number: '2200', name: 'Sales Tax Payable', type: 'liability_current_other' },
      { number: '2300', name: 'Employee Payable', type: 'liability_current_other' },
      { number: '2500', name: 'Credit Card', type: 'liability_card', reconcilable: true },
      { number: '2600', name: 'Long-Term Debt', type: 'liability_long_term' },
      ...standardEquity(),
      { number: '4000', name: 'Contract Revenue', type: 'income' },
      { number: '4100', name: 'Time & Materials Revenue', type: 'income' },
      { number: '4200', name: 'Progress Billings', type: 'income' },
      { number: '4300', name: 'Equipment Rental Revenue', type: 'income' },
      ...fxAccounts(),
      { number: '5000', name: 'Materials', type: 'cogs' },
      { number: '5100', name: 'Subcontractor Costs', type: 'cogs' },
      { number: '5200', name: 'Equipment Rental Cost', type: 'cogs' },
      { number: '5300', name: 'Direct Labor', type: 'cogs' },
      { number: '5400', name: 'Project Overhead', type: 'cogs' },
      { number: '6000', name: 'Office Salaries', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Insurance', type: 'expense' },
      { number: '6400', name: 'Depreciation', type: 'expense' },
      { number: '6500', name: 'Professional Fees', type: 'expense' },
      { number: '6600', name: 'Vehicle Expense', type: 'expense' },
      { number: '6700', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2300',
      [RETAINAGE]: '1110',
      [LABOR_WIP]: '1300',
      [UNBILLED_AR]: '1300',
      [PROJECT_REV]: '4200',
    },
  },

  // ── Professional Services & Consulting ────────────────────────────────
  {
    key: 'professional_services',
    icon: 'Briefcase',
    category: 'services',
    features: {
      projects: true,
      timeTracking: true,
      fieldTickets: false,
      inventory: false,
      equipment: false,
      subscriptionBilling: true,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Unbilled Receivable', type: 'asset_current_other' },
      { number: '1300', name: 'Work in Progress', type: 'asset_current_other' },
      { number: '1500', name: 'Office Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '4000', name: 'Professional Fees', type: 'income' },
      { number: '4100', name: 'Retainer Revenue', type: 'income' },
      { number: '4200', name: 'Project Revenue', type: 'income' },
      { number: '4300', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Subcontractor Costs', type: 'cogs' },
      { number: '5100', name: 'Project Expenses', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Office Supplies', type: 'expense' },
      { number: '6400', name: 'Insurance', type: 'expense' },
      { number: '6500', name: 'Depreciation', type: 'expense' },
      { number: '6600', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6700', name: 'Marketing', type: 'expense' },
      { number: '6800', name: 'Professional Development', type: 'expense' },
      { number: '6900', name: 'Bank Charges', type: 'expense' },
      { number: '7000', name: 'Interest Expense', type: 'expense_other' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
      [LABOR_WIP]: '1300',
      [LABOR_CLR]: '2400',
      [UNBILLED_AR]: '1200',
      [PROJECT_REV]: '4200',
    },
  },

  // ── Engineering & Architecture (EPC/AEC) ─────────────────────────────
  {
    key: 'engineering_architecture',
    icon: 'Ruler',
    category: 'trade',
    features: {
      projects: true,
      timeTracking: true,
      fieldTickets: true,
      equipment: true,
      inventory: true,
      subscriptionBilling: false,
      revenueRecognition: true,
      // Design firms sub out geotechnical, survey and specialty engineering:
      // same certificate-of-insurance and 1099 obligations as a contractor.
      subcontractorCompliance: true,
    },
    coa: [
      { number: '1000', name: 'Operating Account', type: 'asset_bank', reconcilable: true },
      { number: '1010', name: 'Project Account', type: 'asset_bank', reconcilable: true },
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1110', name: 'Retainage Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Unbilled Receivable', type: 'asset_current_other' },
      { number: '1300', name: 'Work in Progress', type: 'asset_current_other' },
      { number: '1400', name: 'Surveying & Testing Equipment', type: 'asset_fixed' },
      { number: '1410', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      { number: '1420', name: 'Vehicles', type: 'asset_fixed' },
      { number: '1430', name: 'Accumulated Depreciation — Vehicles', type: 'asset_fixed' },
      { number: '2000', name: 'Accounts Payable', type: 'liability_payable' },
      { number: '2100', name: 'Accrued Wages', type: 'liability_current_other' },
      { number: '2110', name: 'Payroll Deductions', type: 'liability_current_other' },
      { number: '2200', name: 'Sales Tax Payable', type: 'liability_current_other' },
      { number: '2300', name: 'Employee Payable', type: 'liability_current_other' },
      { number: '2500', name: 'Credit Card', type: 'liability_card', reconcilable: true },
      { number: '2600', name: 'Long-Term Debt', type: 'liability_long_term' },
      ...standardEquity(),
      { number: '4000', name: 'Engineering Fees', type: 'income' },
      { number: '4100', name: 'Project Revenue', type: 'income' },
      { number: '4200', name: 'Progress Billings', type: 'income' },
      { number: '4300', name: ' reimbursable Expenses', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Direct Labor', type: 'cogs' },
      { number: '5100', name: 'Subcontractor Costs', type: 'cogs' },
      { number: '5200', name: 'Materials & Supplies', type: 'cogs' },
      { number: '5300', name: 'Equipment Costs', type: 'cogs' },
      { number: '5400', name: 'Project Overhead', type: 'cogs' },
      { number: '6000', name: 'Office Salaries', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Insurance', type: 'expense' },
      { number: '6400', name: 'Depreciation', type: 'expense' },
      { number: '6500', name: 'Professional Fees', type: 'expense' },
      { number: '6600', name: 'Software & Licenses', type: 'expense' },
      { number: '6700', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2300',
      [RETAINAGE]: '1110',
      [LABOR_WIP]: '1300',
      [UNBILLED_AR]: '1200',
      [PROJECT_REV]: '4100',
    },
  },

  // ── Software & SaaS ──────────────────────────────────────────────────
  {
    key: 'it_software_saas',
    icon: 'Cloud',
    category: 'services',
    features: {
      subscriptionBilling: true,
      revenueRecognition: true,
      projects: true,
      timeTracking: true,
      fieldTickets: false,
      inventory: false,
      equipment: false,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Deferred Commissions', type: 'asset_current_other' },
      { number: '1300', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Computer Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      { number: '1600', name: 'Software Development Costs', type: 'asset_other' },
      ...standardLiabilities(),
      { number: '2700', name: 'Deferred Revenue', type: 'liability_current_other' },
      { number: '2800', name: 'Deferred Commissions Liability', type: 'liability_current_other' },
      ...standardEquity(),
      { number: '4000', name: 'Subscription Revenue', type: 'income' },
      { number: '4100', name: 'Professional Services Revenue', type: 'income' },
      { number: '4200', name: 'Usage Revenue', type: 'income' },
      { number: '4300', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Cost of Revenue — Hosting', type: 'cogs' },
      { number: '5100', name: 'Cost of Revenue — Support', type: 'cogs' },
      { number: '5200', name: 'Cost of Revenue — Professional Services', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Office Supplies', type: 'expense' },
      { number: '6400', name: 'Insurance', type: 'expense' },
      { number: '6500', name: 'Depreciation', type: 'expense' },
      { number: '6600', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6700', name: 'Marketing & Advertising', type: 'expense' },
      { number: '6800', name: 'Research & Development', type: 'expense' },
      { number: '6900', name: 'Bank Charges', type: 'expense' },
      { number: '7000', name: 'Interest Expense', type: 'expense_other' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
      [UNBILLED_AR]: '1200',
      [PROJECT_REV]: '4100',
    },
  },

  // ── Accounting & Bookkeeping Practice ────────────────────────────────
  {
    key: 'accounting_firm',
    icon: 'Calculator',
    category: 'services',
    features: {
      multiSubsidiary: true,
      projects: true,
      timeTracking: true,
      fieldTickets: false,
      inventory: false,
      equipment: false,
      subscriptionBilling: false,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Client Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Unbilled Receivable', type: 'asset_current_other' },
      { number: '1300', name: 'Work in Progress', type: 'asset_current_other' },
      { number: '1400', name: 'Trust Account', type: 'asset_bank', reconcilable: true },
      { number: '1500', name: 'Office Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      ...standardLiabilities(),
      { number: '2700', name: 'Client Trust Liability', type: 'liability_current_other' },
      ...standardEquity(),
      { number: '4000', name: 'Accounting Fees', type: 'income' },
      { number: '4100', name: 'Bookkeeping Fees', type: 'income' },
      { number: '4200', name: 'Advisory Fees', type: 'income' },
      { number: '4300', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Subcontractor Costs', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Office Supplies', type: 'expense' },
      { number: '6400', name: 'Insurance', type: 'expense' },
      { number: '6500', name: 'Depreciation', type: 'expense' },
      { number: '6600', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6700', name: 'Professional Development', type: 'expense' },
      { number: '6800', name: 'Marketing', type: 'expense' },
      { number: '6900', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
      [LABOR_WIP]: '1300',
      [UNBILLED_AR]: '1200',
      [PROJECT_REV]: '4100',
    },
  },

  // ── Wholesale & Distribution ──────────────────────────────────────────
  {
    key: 'wholesale_distribution',
    icon: 'Warehouse',
    category: 'commerce',
    features: {
      inventory: true,
      projects: false,
      fieldTickets: false,
      equipment: false,
      subscriptionBilling: false,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Inventory', type: 'asset_current_other' },
      { number: '1210', name: 'Inventory — In Transit', type: 'asset_current_other' },
      { number: '1300', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Warehouse Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      { number: '1520', name: 'Delivery Vehicles', type: 'asset_fixed' },
      { number: '1530', name: 'Accumulated Depreciation — Vehicles', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '4000', name: 'Sales Revenue', type: 'income' },
      { number: '4100', name: 'Freight Revenue', type: 'income' },
      { number: '4200', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Cost of Goods Sold', type: 'cogs' },
      { number: '5100', name: 'Freight & Duty', type: 'cogs' },
      { number: '5200', name: 'Warehouse Costs', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Fuel & Vehicle Costs', type: 'expense' },
      { number: '6400', name: 'Insurance', type: 'expense' },
      { number: '6500', name: 'Depreciation', type: 'expense' },
      { number: '6600', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6700', name: 'Marketing', type: 'expense' },
      { number: '6800', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
    },
  },

  // ── Property Management & Real Estate ─────────────────────────────────
  {
    key: 'property_management',
    icon: 'Home',
    category: 'property',
    features: {
      multiSubsidiary: true,
      fixedAssets: true,
      subscriptionBilling: true,
      projects: false,
      fieldTickets: false,
      inventory: false,
      equipment: false,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Tenant Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Prepaid Rent', type: 'asset_current_other' },
      { number: '1500', name: 'Land', type: 'asset_fixed' },
      { number: '1510', name: 'Buildings', type: 'asset_fixed' },
      { number: '1520', name: 'Accumulated Depreciation — Buildings', type: 'asset_fixed' },
      { number: '1530', name: 'Building Improvements', type: 'asset_fixed' },
      { number: '1540', name: 'Accumulated Depreciation — Improvements', type: 'asset_fixed' },
      { number: '2000', name: 'Accounts Payable', type: 'liability_payable' },
      { number: '2100', name: 'Accrued Expenses', type: 'liability_current_other' },
      { number: '2200', name: 'Sales Tax Payable', type: 'liability_current_other' },
      { number: '2300', name: 'Security Deposits Held', type: 'liability_current_other' },
      { number: '2400', name: 'Employee Payable', type: 'liability_current_other' },
      { number: '2500', name: 'Credit Card', type: 'liability_card', reconcilable: true },
      { number: '2600', name: 'Mortgage Payable', type: 'liability_long_term' },
      ...standardEquity(),
      { number: '4000', name: 'Rental Income', type: 'income' },
      { number: '4100', name: 'CAM Revenue', type: 'income' },
      { number: '4200', name: 'Late Fees', type: 'income_other' },
      { number: '4300', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Property Maintenance', type: 'cogs' },
      { number: '5100', name: 'Repairs', type: 'cogs' },
      { number: '6000', name: 'Property Management Salaries', type: 'expense' },
      { number: '6100', name: 'Property Taxes', type: 'expense' },
      { number: '6200', name: 'Insurance', type: 'expense' },
      { number: '6300', name: 'Utilities', type: 'expense' },
      { number: '6400', name: 'Depreciation', type: 'expense' },
      { number: '6500', name: 'Professional Fees', type: 'expense' },
      { number: '6600', name: 'Marketing', type: 'expense' },
      { number: '6700', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
    },
  },

  // ── Non-Profit & Charity ─────────────────────────────────────────────
  {
    key: 'nonprofit',
    icon: 'HeartHandshake',
    category: 'public',
    features: {
      projects: true,
      budgets: true,
      fieldTickets: false,
      inventory: false,
      equipment: false,
      subscriptionBilling: true,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '3000', name: 'Unrestricted Net Assets', type: 'equity' },
      { number: '3100', name: 'Temporarily Restricted Net Assets', type: 'equity' },
      { number: '3200', name: 'Permanently Restricted Net Assets', type: 'equity' },
      { number: '4000', name: 'Donation Revenue', type: 'income' },
      { number: '4100', name: 'Grant Revenue', type: 'income' },
      { number: '4200', name: 'Membership Dues', type: 'income' },
      { number: '4300', name: 'Program Fees', type: 'income' },
      { number: '4400', name: 'Fundraising Event Revenue', type: 'income_other' },
      { number: '4500', name: 'Investment Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Program Expenses', type: 'cogs' },
      { number: '5100', name: 'Grant Expenses', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Office Supplies', type: 'expense' },
      { number: '6400', name: 'Insurance', type: 'expense' },
      { number: '6500', name: 'Depreciation', type: 'expense' },
      { number: '6600', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6700', name: 'Fundraising Expenses', type: 'expense' },
      { number: '6800', name: 'Professional Fees', type: 'expense' },
      { number: '6900', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
      [PROJECT_REV]: '4100',
    },
  },

  // ── Manufacturing (Light / Discrete) ─────────────────────────────────
  {
    key: 'manufacturing',
    icon: 'Factory',
    category: 'commerce',
    features: {
      inventory: true,
      equipment: true,
      projects: false,
      fieldTickets: false,
      subscriptionBilling: false,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Raw Materials Inventory', type: 'asset_current_other' },
      { number: '1210', name: 'Work in Process', type: 'asset_current_other' },
      { number: '1220', name: 'Finished Goods', type: 'asset_current_other' },
      { number: '1230', name: 'Inventory — In Transit', type: 'asset_current_other' },
      { number: '1300', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Machinery & Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation — Equipment', type: 'asset_fixed' },
      { number: '1520', name: 'Building', type: 'asset_fixed' },
      { number: '1530', name: 'Accumulated Depreciation — Building', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '4000', name: 'Product Sales', type: 'income' },
      { number: '4100', name: 'Service Revenue', type: 'income' },
      { number: '4200', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Cost of Goods Sold', type: 'cogs' },
      { number: '5100', name: 'Direct Materials', type: 'cogs' },
      { number: '5200', name: 'Direct Labor', type: 'cogs' },
      { number: '5300', name: 'Manufacturing Overhead', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Insurance', type: 'expense' },
      { number: '6400', name: 'Depreciation', type: 'expense' },
      { number: '6500', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6600', name: 'Marketing', type: 'expense' },
      { number: '6700', name: 'Professional Fees', type: 'expense' },
      { number: '6800', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
    },
  },

  // ── Healthcare Practice ──────────────────────────────────────────────
  {
    key: 'healthcare_practice',
    icon: 'Stethoscope',
    category: 'services',
    features: {
      projects: false,
      fieldTickets: false,
      inventory: true,
      equipment: true,
      subscriptionBilling: false,
      revenueRecognition: true,
    },
    coa: [
      ...standardBank(),
      { number: '1100', name: 'Patient Accounts Receivable', type: 'asset_receivable' },
      { number: '1200', name: 'Medical Supplies Inventory', type: 'asset_current_other' },
      { number: '1300', name: 'Prepaid Expenses', type: 'asset_current_other' },
      { number: '1500', name: 'Medical Equipment', type: 'asset_fixed' },
      { number: '1510', name: 'Accumulated Depreciation', type: 'asset_fixed' },
      { number: '1520', name: 'Furniture & Fixtures', type: 'asset_fixed' },
      { number: '1530', name: 'Accumulated Depreciation — F&F', type: 'asset_fixed' },
      ...standardLiabilities(),
      ...standardEquity(),
      { number: '4000', name: 'Professional Fees', type: 'income' },
      { number: '4100', name: 'Insurance Reimbursements', type: 'income' },
      { number: '4200', name: 'Other Income', type: 'income_other' },
      ...fxAccounts(),
      { number: '5000', name: 'Medical Supplies', type: 'cogs' },
      { number: '5100', name: 'Lab Costs', type: 'cogs' },
      { number: '6000', name: 'Salaries & Wages', type: 'expense' },
      { number: '6100', name: 'Rent', type: 'expense' },
      { number: '6200', name: 'Utilities', type: 'expense' },
      { number: '6300', name: 'Insurance', type: 'expense' },
      { number: '6400', name: 'Depreciation', type: 'expense' },
      { number: '6500', name: 'Software & Subscriptions', type: 'expense' },
      { number: '6600', name: 'Professional Fees', type: 'expense' },
      { number: '6700', name: 'Marketing', type: 'expense' },
      { number: '6800', name: 'Bank Charges', type: 'expense' },
    ],
    controlAccounts: {
      [AR]: '1100',
      [AP]: '2000',
      [BANK]: '1000',
      [TAX_COLLECTED]: '2200',
      [TAX_PAID]: '2200',
      [EMPLOYEE_PAYABLE]: '2400',
    },
  },
]

export const INDUSTRY_BY_KEY = new Map(INDUSTRIES.map((i) => [i.key, i]))

export const INDUSTRY_CATEGORIES = [
  'general',
  'services',
  'trade',
  'commerce',
  'property',
  'public',
] as const

/**
 * Whether the org can switch its industry — blocked once postings exist, the
 * same integrity-probe pattern as the multiSubsidiary disable check. Company
 * name, country, currency, and individual feature toggles remain editable.
 */
export async function canSwitchIndustry(orgId: string): Promise<boolean> {
  const { db } = await import('@openbooks/engine/src/db.ts')
  const { sql } = await import('drizzle-orm')
  const r = (await db.execute(sql`
    select count(*)::int as n from journal_lines where org_id = ${orgId}`)) as unknown as {
    rows: { n: number }[]
  }
  return (r.rows[0]?.n ?? 0) === 0
}
