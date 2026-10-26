export interface BillingMappingSuggestion {
  kind: "plan" | "currency" | "tax_code" | "customer";
  externalRef: string;
  suggestion: { nativeId: string | null; label: string } | null;
}

export function suggestedBillingMappings(attention: readonly BillingMappingSuggestion[]): {
  planMap: Record<string, string>;
  customerMap: Record<string, string>;
} {
  return {
    planMap: Object.fromEntries(
      attention.flatMap((item) =>
        item.kind === "plan" && item.suggestion?.nativeId
          ? [[item.externalRef, item.suggestion.nativeId] as const]
          : [],
      ),
    ),
    customerMap: Object.fromEntries(
      attention.flatMap((item) =>
        item.kind === "customer" && item.suggestion?.nativeId
          ? [[item.externalRef, item.suggestion.nativeId] as const]
          : [],
      ),
    ),
  };
}

export function canRerunBillingImport(status: string): boolean {
  return status === "ready" || status === "failed";
}

export interface BillingAcceptConfigInput {
  mode: "post_historical" | "opening_balances";
  cutoverOn: string;
  historyDepthMonths: string;
  incomeAccountId: string;
  clearingAccountId: string;
  taxCodeId: string;
  planMap: Record<string, string>;
  customerMap: Record<string, string>;
  autoSync: boolean;
}

export function billingAcceptConfig(input: BillingAcceptConfigInput) {
  return {
    mode: input.mode,
    cutoverOn: input.cutoverOn || null,
    historyDepthMonths: input.historyDepthMonths === "" ? null : Number(input.historyDepthMonths),
    incomeAccountId: input.incomeAccountId || null,
    clearingAccountId: input.clearingAccountId || null,
    taxCodeId: input.taxCodeId || null,
    planMap: { ...input.planMap },
    customerMap: { ...input.customerMap },
    autoSync: input.autoSync,
  };
}
