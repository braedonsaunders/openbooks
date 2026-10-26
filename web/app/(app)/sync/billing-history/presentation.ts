export interface BillingImportCounts {
  customers: number;
  plans: number;
  subscriptions: number;
  invoices: number;
  creditNotes: number;
  payments: number;
  usage: number;
  coupons: number;
  revenueSchedules: number;
}

export type BillingImportCountKey = keyof BillingImportCounts;
export type BillingImportCountTranslationKey = `count_${BillingImportCountKey}`;

export function shouldOpenImportWizard(searchParams: Pick<URLSearchParams, "get">): boolean {
  return searchParams.get("import") === "new";
}

export const BILLING_IMPORT_COUNT_KEYS: BillingImportCountKey[] = [
  "customers",
  "plans",
  "subscriptions",
  "invoices",
  "creditNotes",
  "payments",
  "usage",
  "coupons",
  "revenueSchedules",
];

export function formatObjectCounts(
  counts: BillingImportCounts | null,
  translate: (key: BillingImportCountTranslationKey) => string,
): string {
  if (!counts) return "—";
  const entries = BILLING_IMPORT_COUNT_KEYS.flatMap((key) => {
    const count = counts[key] ?? 0;
    return count > 0 ? [`${translate(`count_${key}`)} ${count}`] : [];
  });
  return entries.length > 0 ? entries.join(" · ") : "—";
}
