export type OperationStatus =
  "verified" | "partial" | "pending" | "product-specific";

export interface GlOperation {
  openbooksOperation: string;
  erpnextEquivalent: string;
  status: OperationStatus;
  evidencePrefixes: readonly string[];
  remaining?: string;
}

/**
 * Production modules allowed to mutate journal entries/lines directly.
 * A static contract test fails when a new writer appears without being added
 * here and classified in GL_OPERATION_REGISTRY.
 */
export const GL_MUTATION_SOURCE_FILES = [
  "asset-lifecycle.ts",
  "banking.ts",
  "consolidation.ts",
  "depreciation.ts",
  "document-void.ts",
  "fx-revaluation.ts",
  "income-tax-provision.ts",
  "inventory.ts",
  // Lessee lease accounting: commencement (ROU/liability), payment
  // interest+principal, ROU amortization, and the operating single-cost model.
  // (inventory-nrv.ts is NOT here: its GL writes go through inventory.ts's
  // postInventoryEntry, which is already registered.)
  "leases.ts",
  "payments.ts",
  "posting.ts",
  "project-recognition.ts",
  "property-management.ts",
  "psp-settlement.ts",
  "revenue-recognition.ts",
  "sync/source-deletions.ts",
  "sync/trueup.ts",
  "validation/repair-posted-tax-project-dimensions.ts",
] as const;

/**
 * Function-level register for every production OpenBooks path that directly
 * writes, reverses, or regenerates GL. This is intentionally more granular
 * than the economic-event matrix.
 */
export const GL_OPERATION_REGISTRY: readonly GlOperation[] = [
  {
    openbooksOperation: "property-management.recordSecurityDeposit",
    erpnextEquivalent: "Journal Entry / Payment Entry (semantic)",
    status: "partial",
    evidencePrefixes: ["property-deposit-"],
    remaining: "Dedicated property-deposit subledger parity fixture",
  },
  {
    openbooksOperation: "posting.RULES.journal",
    erpnextEquivalent: "Journal Entry",
    status: "verified",
    evidencePrefixes: ["journal-"],
  },
  {
    openbooksOperation: "posting.RULES.customer_invoice",
    erpnextEquivalent: "Sales Invoice",
    status: "verified",
    evidencePrefixes: ["sales-invoice-"],
  },
  {
    openbooksOperation: "posting.RULES.vendor_bill",
    erpnextEquivalent: "Purchase Invoice",
    status: "verified",
    evidencePrefixes: ["purchase-invoice-"],
  },
  {
    openbooksOperation: "posting.RULES.customer_payment",
    erpnextEquivalent: "Payment Entry Receive",
    status: "verified",
    evidencePrefixes: ["customer-payment-"],
  },
  {
    openbooksOperation: "posting.RULES.vendor_payment",
    erpnextEquivalent: "Payment Entry Pay",
    status: "verified",
    evidencePrefixes: ["vendor-payment-"],
  },
  {
    openbooksOperation: "posting.RULES.customer_credit",
    erpnextEquivalent: "Sales Invoice Return",
    status: "verified",
    evidencePrefixes: ["sales-credit-"],
  },
  {
    openbooksOperation: "posting.RULES.vendor_credit",
    erpnextEquivalent: "Purchase Invoice Return",
    status: "verified",
    evidencePrefixes: ["purchase-credit-"],
  },
  {
    openbooksOperation: "posting.RULES.transfer",
    erpnextEquivalent: "Payment Entry Internal Transfer",
    status: "verified",
    evidencePrefixes: ["transfer-"],
  },
  {
    openbooksOperation: "posting.RULES.check",
    erpnextEquivalent: "Journal Entry (semantic)",
    status: "verified",
    evidencePrefixes: ["check-"],
  },
  {
    openbooksOperation: "posting.RULES.deposit",
    erpnextEquivalent: "Journal Entry (semantic)",
    status: "verified",
    evidencePrefixes: ["deposit-"],
  },
  {
    openbooksOperation: "posting.RULES.expense_report",
    erpnextEquivalent:
      "Journal Entry plus allocated Payment Entry (semantic); Expense Claim is in the separate HRMS app",
    status: "verified",
    evidencePrefixes: ["employee-expense-"],
  },
  {
    openbooksOperation: "posting.RULES.card_charge",
    erpnextEquivalent: "Journal Entry (semantic)",
    status: "verified",
    evidencePrefixes: ["card-charge-"],
  },
  {
    openbooksOperation: "posting.RULES.card_refund",
    erpnextEquivalent: "Journal Entry (semantic)",
    status: "verified",
    evidencePrefixes: ["card-refund-"],
  },
  {
    openbooksOperation: "posting.RULES.project_charge",
    erpnextEquivalent: "Project-cost reclassification Journal Entry",
    status: "verified",
    evidencePrefixes: ["project-charge-"],
  },
  {
    openbooksOperation:
      "posting tax components (standard exclusive/inclusive, returns, and half-cent rounding)",
    erpnextEquivalent: "Sales/Purchase Taxes and Charges",
    status: "verified",
    evidencePrefixes: [
      "sales-tax-exclusive-",
      "purchase-tax-exclusive-",
      "sales-tax-inclusive-",
      "purchase-tax-inclusive-",
      "sales-tax-rounding-",
      "purchase-tax-rounding-",
      "sales-tax-return-",
      "purchase-tax-return-",
    ],
  },
  {
    openbooksOperation:
      "posting tax components (compound/withholding/reverse charge)",
    erpnextEquivalent: "Sales/Purchase Taxes and Charges",
    status: "verified",
    evidencePrefixes: [
      "sales-tax-compound-",
      "purchase-tax-compound-",
      "purchase-tax-withholding-",
      "purchase-tax-reverse-charge-",
    ],
  },
  {
    openbooksOperation: "payments.postPaymentWithApplications",
    erpnextEquivalent: "Payment Entry references",
    status: "verified",
    evidencePrefixes: ["customer-payment-", "vendor-payment-"],
  },
  {
    openbooksOperation:
      "banking.markReconciled / createMatch / unmatchStatementLine",
    erpnextEquivalent: "Bank Reconciliation Tool",
    status: "product-specific",
    evidencePrefixes: ["bank-reconciliation-"],
  },
  {
    openbooksOperation: "documentVoid.requestDocumentVoid",
    erpnextEquivalent: "Cancel",
    status: "verified",
    evidencePrefixes: [
      "journal-",
      "sales-invoice-",
      "purchase-invoice-",
      "customer-payment-",
      "vendor-payment-",
      "sales-credit-",
      "purchase-credit-",
      "transfer-",
      "check-",
      "deposit-",
      "employee-expense-",
      "card-charge-",
      "card-refund-",
      "project-charge-",
      "sales-tax-exclusive-",
      "purchase-tax-exclusive-",
      "sales-tax-inclusive-",
      "purchase-tax-inclusive-",
      "sales-tax-rounding-",
      "purchase-tax-rounding-",
      "sales-tax-return-",
      "purchase-tax-return-",
    ],
  },
  {
    openbooksOperation:
      "posting.regenerateGlImpactTx / documentCorrection.createDocumentCorrectionDraft",
    erpnextEquivalent: "Cancel / Amend / Repost Accounting Ledger",
    status: "verified",
    evidencePrefixes: ["gl-replay-", "gl-correction-"],
  },
  {
    openbooksOperation:
      "inventory.receiveInventory / issueInventory / transferInventory",
    erpnextEquivalent: "Stock Entry Material Receipt / Issue / Transfer",
    status: "verified",
    evidencePrefixes: [
      "inventory-receipt-",
      "inventory-issue-",
      "inventory-transfer-",
    ],
  },
  {
    openbooksOperation:
      "inventory.adjustInventory / buildAssembly / allocateLandedCost / postLandedCostVoucher",
    erpnextEquivalent:
      "Stock Reconciliation / Manufacture Stock Entry / Landed Cost Voucher",
    status: "verified",
    evidencePrefixes: ["inventory-advanced-"],
  },
  {
    openbooksOperation:
      "inventory.reverseInventoryMovement / reverseAssemblyBuild / reverseLandedCostVoucher controlled correction lineage",
    erpnextEquivalent:
      "Stock Entry / Stock Reconciliation / Landed Cost Voucher cancellation",
    status: "verified",
    evidencePrefixes: [
      "inventory-receipt-",
      "inventory-issue-",
      "inventory-transfer-",
      "inventory-advanced-",
    ],
  },
  {
    openbooksOperation: "depreciation.runDepreciation",
    erpnextEquivalent: "Asset Depreciation",
    status: "verified",
    evidencePrefixes: ["depreciation-"],
  },
  {
    openbooksOperation: "assetLifecycle.disposeAsset / remeasureAsset",
    erpnextEquivalent: "Asset Disposal / impairment or revaluation journal",
    status: "verified",
    evidencePrefixes: ["asset-lifecycle-"],
  },
  {
    openbooksOperation: "fxRevaluation.runRevaluation",
    erpnextEquivalent: "Exchange Rate Revaluation / Payment Entry exchange",
    status: "verified",
    evidencePrefixes: ["fx-revaluation-", "fx-settlement-"],
  },
  {
    openbooksOperation: "revenueRecognition.runRevenueRecognition",
    erpnextEquivalent: "Process Deferred Accounting",
    status: "verified",
    evidencePrefixes: ["revenue-recognition-"],
  },
  {
    openbooksOperation:
      "projectRecognition.postProjectGlEntry / postProjectLaborCost / reversal",
    erpnextEquivalent:
      "Project / Activity Cost with project-dimensional Journal Entry",
    status: "verified",
    evidencePrefixes: ["project-recognition-", "project-charge-"],
  },
  {
    openbooksOperation:
      "consolidation.runOwnershipConsolidation / runAutoElimination",
    erpnextEquivalent: "Inter Company Journal Entry / consolidation",
    status: "verified",
    evidencePrefixes: ["consolidation-"],
  },
  {
    openbooksOperation:
      "pspSettlement.postSettlementBatch / reverseSettlementBatch",
    erpnextEquivalent: "No single native equivalent",
    status: "product-specific",
    evidencePrefixes: ["psp-settlement-"],
  },
  {
    openbooksOperation: "incomeTaxProvision.postProvisionRun",
    erpnextEquivalent: "Tax provision Journal Entry",
    status: "verified",
    evidencePrefixes: ["income-tax-provision-"],
  },
  {
    openbooksOperation: "sync.sourceDeletions / sync.trueup ledger corrections",
    erpnextEquivalent: "Data Import / repost corrections",
    status: "verified",
    evidencePrefixes: ["sync-correction-"],
  },
  {
    openbooksOperation: "validation.repairPostedTaxProjectDimensions",
    erpnextEquivalent: "No native direct equivalent",
    status: "product-specific",
    evidencePrefixes: ["repair-tax-project-"],
  },
  {
    openbooksOperation: "validation.repairInvoiceLineCommercialProvenance",
    erpnextEquivalent: "No native direct equivalent",
    status: "product-specific",
    evidencePrefixes: ["repair-commercial-provenance-"],
  },
] as const;
