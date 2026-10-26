import { FINANCIAL_CHANGE_AUTHORITY } from "@openbooks/engine/platform/financial-changes";

export const changeAuthority = FINANCIAL_CHANGE_AUTHORITY;

export type AccountingChangeDomain = keyof typeof changeAuthority;
export type AccountingChangeFeature = Exclude<
  (typeof changeAuthority)[AccountingChangeDomain]["feature"],
  null
>;
export type AccountingChangeFeatureState = Partial<Record<AccountingChangeFeature, boolean>>;

export function enabledAccountingChangeDomains(
  candidates: readonly AccountingChangeDomain[],
  features: AccountingChangeFeatureState,
): AccountingChangeDomain[] {
  return candidates.filter((domain) => {
    const feature = changeAuthority[domain].feature;
    return feature === null || features[feature] === true;
  });
}

export function canShowNetInvestmentOciReversal(
  candidates: readonly AccountingChangeDomain[],
  features: AccountingChangeFeatureState,
): boolean {
  return candidates.includes("consolidation") && features.multiSubsidiary === false;
}

export function isAccountingChangeFeatureAllowed(
  domain: string,
  operation: string,
  enabledDomains: readonly AccountingChangeDomain[],
  allowNetInvestmentOciReversal: boolean,
): boolean {
  return (
    enabledDomains.includes(domain as AccountingChangeDomain) ||
    (allowNetInvestmentOciReversal &&
      domain === "consolidation" &&
      operation === "net_investment_oci_reversal")
  );
}
