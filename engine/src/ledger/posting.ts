/** Public posting API. Implementations depend on internal modules, never this facade. */
export { postDocument } from "./posting-document.ts";
export { type SourceCorrectionAuthorization, glProjectionScopeUnchanged, glProjectionKey, regenerateGlImpactTx } from "./posting-replay.ts";
export { runPostDocumentEffects } from "./posting-dispatch.ts";
export { assertAccountCurrencyRestrictions } from "./posting-subsidiaries.ts";
export { providerTaxDocumentKind, defaultPartyAddress, taxConfigsFromEvidence } from "./posting-provider-tax.ts";
export { validateRequiredDimensions } from "./posting-accounts.ts";
export { type PostingDocument, type PostingDocumentLine, type KernelLine, type PostingDeps, type TaxPostingComponent, controlLineIsOpenItem, projectChargeKernelLines, componentsForLine, validateTaxControlAccounts, type ExpenseSettlement, settlementOf, RULES, PostingError, assertFinalKernelBalance, assertCreditMemoDirection } from "./posting-rules.ts";

export { ClosedPeriodError } from "./posting-contracts.ts";
