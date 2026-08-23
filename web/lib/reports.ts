import "server-only";

/**
 * Financial reporting — the module's public surface.
 *
 * The original single-file `reports.ts` was split into cohesive sibling
 * modules below without changing any name or signature; this barrel
 * re-exports them so every importer keeps compiling unchanged.
 *
 * Domains:
 * - decimals:   exact-decimal helpers shared by every report
 * - filters:    dimension filter type/SQL + dimension picker options
 * - statements: P&L, balance sheet, trial balance, partner balances
 * - trends:     per-period performance/cash trend rows
 * - aging:      AR/AP aging summary and detail
 * - cash-flow:  direct-method statement of cash flows
 * - cash-flow-indirect: indirect-method (full GAAP) presentation
 * - registers:  account register, AR/AP register, partner statement
 * - ledger-reports: general ledger and journal report
 * - transaction-detail: drill-down behind any statement value
 * - projects:   project profitability / job costing
 * - periods:    fiscal-year helpers
 */

export { type DimFilter, dimensionOptions } from "./reports/filters";

export {
  type StatementRow,
  balanceSheet,
  partnerBalances,
  profitAndLoss,
  trialBalance,
} from "./reports/statements";

export { type FinancialTrendRow, financialTrends } from "./reports/trends";

export {
  type AgingResult,
  type AgingRow,
  type AgingSide,
  agingByParty,
} from "./reports/aging";

export {
  type AgingBucket,
  type AgingDetailResult,
  type AgingDetailRow,
  agingDetail,
} from "./reports/aging";

export {
  CASH_FLOW_SECTION,
  type CashFlowLine,
  type CashFlowResult,
  type CashFlowSection,
  cashFlow,
} from "./reports/cash-flow";

export {
  type CfAccountLine,
  type CfAdjustmentLine,
  type CfWorkingCapitalLine,
  type CashFlowIndirectResult,
  cashFlowIndirect,
} from "./reports/cash-flow-indirect";

export {
  accountRegister,
  type PartnerStatementResult,
  partnerStatement,
  partyRegister,
  type RegisterLine,
  type RegisterParty,
  type RegisterResult,
} from "./reports/registers";

export {
  type GeneralLedgerAccount,
  type GeneralLedgerLine,
  type GeneralLedgerResult,
  generalLedger,
  type JournalReportEntry,
  type JournalReportLine,
  type JournalReportResult,
  journalReport,
} from "./reports/ledger-reports";

export {
  type TxnDetailLine,
  type TxnDetailResult,
  transactionDetail,
} from "./reports/transaction-detail";

export {
  groupProjectProfitabilityRows,
  projectProfitability,
  projectProfitabilityCustomerOptions,
  type ProjectProfitCustomerGroup,
  type ProjectProfitResult,
  type ProjectProfitRow,
  type ProjectProfitTotals,
} from "./reports/projects";

export { currentFiscalYearEnd, fiscalYearRange } from "./reports/periods";
