/** Native indirect-tax selection and retained calculation evidence. */
export { quoteGoodsPlaceOfSupply, PlaceOfSupplyError, type GoodsSupplyQuoteInput } from './place-of-supply.ts';
export { parseCanadianGoodsSelection,resolveCanadianGoodsTaxes,persistGoodsTaxSnapshot,assertCanadianGoodsTaxEvidence,type CanadianGoodsSelection,type GoodsTaxSnapshot } from './goods-selection.ts'
export { validateMarketplaceFacilitatorWrite } from './marketplace-facilitators.ts';
export {
  assessEuDistanceThreshold,
  determineCrossBorderSupply,
  DEFAULT_EVIDENCE_PRECEDENCE,
  CrossBorderTaxError,
  type CrossBorderOutcome,
  type CrossBorderSupplyInput,
  type CustomerKind,
  type BusinessVatId,
  type EuDistanceThresholdAssessment,
  type EvidenceKind,
  type SupplyEvidence,
  type SupplyKind,
  type VatIdScheme,
  type VatIdStatus,
} from './cross-border-place-of-supply.ts';
export {
  validatePartyTaxId,
  runTaxIdRevalidationScan,
  runTaxIdRevalidationScanForOrg,
  TAX_ID_REVALIDATION_SCAN_KIND,
  type TaxIdCredentials,
  type TaxIdRevalidationScanOptions,
  type TaxIdRevalidationScanResult,
  type TaxIdValidationOutcome,
  type ValidateTaxIdOptions,
} from './vat-id-validation.ts';
export {
  assertCrossBorderSupplyEvidence,
  parseCrossBorderElection,
  type CrossBorderElection,
  type CrossBorderVerdict,
} from './cross-border-posting.ts';
export {
  savePartyTaxId,
  recordSupplyEvidence,
  validateStoredTaxId,
  type SavePartyTaxIdInput,
  type RecordSupplyEvidenceInput,
  type SupplyEvidenceInput,
  type ValidateStoredTaxIdOptions,
} from './cross-border-records.ts';
