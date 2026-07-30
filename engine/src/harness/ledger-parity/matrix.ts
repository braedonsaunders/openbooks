export type CoverageDisposition =
  | "direct"
  | "semantic"
  | "openbooks-only"
  | "erpnext-only"
  | "pending";

export interface CoverageCase {
  capability: string;
  openbooksPath: string;
  erpnextPath: string;
  disposition: CoverageDisposition;
  checkpoints: string[];
}

/**
 * The committed scope register. A run is not "exhaustive" unless every row is
 * direct/semantic and every checkpoint has evidence, or is explicitly classified
 * as product-specific with a documented invariant suite.
 */
export const GL_COVERAGE_MATRIX: readonly CoverageCase[] = [
  {
    capability: "manual journal",
    openbooksPath: "journal",
    erpnextPath: "Journal Entry",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "cancel-or-reverse"],
  },
  {
    capability: "sales invoice",
    openbooksPath: "customer_invoice",
    erpnextPath: "Sales Invoice",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "amend", "cancel-or-reverse"],
  },
  {
    capability: "purchase invoice",
    openbooksPath: "vendor_bill",
    erpnextPath: "Purchase Invoice",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "amend", "cancel-or-reverse"],
  },
  {
    capability: "customer receipt and allocation",
    openbooksPath: "customer_payment + applications",
    erpnextPath: "Payment Entry Receive + references",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "allocate", "unallocate", "cancel-or-reverse"],
  },
  {
    capability: "supplier payment and allocation",
    openbooksPath: "vendor_payment + applications",
    erpnextPath: "Payment Entry Pay + references",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "allocate", "unallocate", "cancel-or-reverse"],
  },
  {
    capability: "sales credit/return",
    openbooksPath: "customer_credit",
    erpnextPath: "Sales Invoice is_return",
    disposition: "direct",
    checkpoints: ["submit", "allocate", "cancel-or-reverse"],
  },
  {
    capability: "purchase credit/return",
    openbooksPath: "vendor_credit",
    erpnextPath: "Purchase Invoice is_return",
    disposition: "direct",
    checkpoints: ["submit", "allocate", "cancel-or-reverse"],
  },
  {
    capability: "bank transfer",
    openbooksPath: "transfer",
    erpnextPath: "Payment Entry Internal Transfer",
    disposition: "direct",
    checkpoints: ["draft-no-gl", "submit", "cancel-or-reverse"],
  },
  {
    capability: "direct disbursement/check",
    openbooksPath: "check",
    erpnextPath: "Journal Entry / Payment Entry",
    disposition: "semantic",
    checkpoints: ["submit", "cancel-or-reverse"],
  },
  {
    capability: "bank deposit",
    openbooksPath: "deposit",
    erpnextPath: "Journal Entry / Payment Entry",
    disposition: "semantic",
    checkpoints: ["submit", "cancel-or-reverse"],
  },
  {
    capability: "employee expense",
    openbooksPath: "expense_report",
    erpnextPath: "Journal Entry semantic equivalent (Expense Claim is HRMS)",
    disposition: "semantic",
    checkpoints: ["submit", "pay", "cancel-or-reverse"],
  },
  {
    capability: "card purchase and refund",
    openbooksPath: "card_charge / card_refund",
    erpnextPath: "Expense Claim / Journal Entry",
    disposition: "semantic",
    checkpoints: ["charge", "refund", "settle"],
  },
  {
    capability: "output/input tax, inclusive tax, rounding, withholding, reverse charge",
    openbooksPath: "tax components",
    erpnextPath: "Sales/Purchase Taxes and Charges",
    disposition: "direct",
    checkpoints: ["draft-calculation", "submit", "return", "payment"],
  },
  {
    capability: "inventory receipt, issue, transfer, reconciliation, landed cost",
    openbooksPath: "inventory subledger + document effects",
    erpnextPath: "Purchase Receipt / Delivery Note / Stock Entry / Stock Reconciliation / Landed Cost Voucher",
    disposition: "direct",
    checkpoints: ["each-stock-movement", "invoice", "return", "cancel-or-reverse"],
  },
  {
    capability: "fixed asset capitalization, depreciation, disposal, impairment",
    openbooksPath: "asset lifecycle",
    erpnextPath: "Asset / Purchase Invoice / Depreciation / Asset Disposal",
    disposition: "direct",
    checkpoints: ["capitalize", "each-depreciation", "dispose", "cancel-or-reverse"],
  },
  {
    capability: "foreign currency settlement and revaluation",
    openbooksPath: "payments FX + fx_revaluation",
    erpnextPath: "Payment Entry exchange + Exchange Rate Revaluation",
    disposition: "direct",
    checkpoints: ["invoice", "partial-payment", "final-payment", "revaluation", "reverse"],
  },
  {
    capability: "revenue recognition",
    openbooksPath: "revenue recognition schedules",
    erpnextPath: "Process Deferred Accounting",
    disposition: "direct",
    checkpoints: ["invoice", "each-recognition-period", "credit", "cancel-or-reverse"],
  },
  {
    capability: "project/labor/equipment/overhead allocation",
    openbooksPath: "project_charge and project recognition",
    erpnextPath: "Project / Timesheet / Activity Cost / Stock Entry",
    disposition: "semantic",
    checkpoints: ["cost", "reclass", "bill", "recognize", "reverse"],
  },
  {
    capability: "multi-entity/intercompany and consolidation",
    openbooksPath: "subsidiary balancing + consolidation",
    erpnextPath: "Inter Company Journal Entry / multi-company consolidation",
    disposition: "semantic",
    checkpoints: ["each-entity", "elimination", "consolidated"],
  },
  {
    capability: "period close and immutable history",
    openbooksPath: "close/reopen/reversal",
    erpnextPath: "Accounts Settings freeze + Period Closing Voucher",
    disposition: "semantic",
    checkpoints: ["pre-close", "close", "rejected-post", "reopen-or-correction"],
  },
  {
    capability: "OpenBooks PSP settlement, tax provision, construction billing",
    openbooksPath: "specialized GL services",
    erpnextPath: "no single native equivalent",
    disposition: "openbooks-only",
    checkpoints: ["post", "idempotent-retry", "reverse"],
  },
  {
    capability: "ERPNext manufacturing, payroll, loan and subscription doctypes",
    openbooksPath: "no complete native equivalent",
    erpnextPath: "manufacturing/payroll/loan/subscription GL controllers",
    disposition: "erpnext-only",
    checkpoints: ["submit", "dependent-postings", "cancel"],
  },
] as const;
