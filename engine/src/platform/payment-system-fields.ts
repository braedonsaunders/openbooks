/** Custom JSON keys owned by payment services and posting policy. */
export const PAYMENT_SYSTEM_CUSTOM_FIELDS = [
  "bankAccountId",
  "allocations",
  "creditAllocations",
  "discountAmount",
  "discountAccountId",
  "controlAccountId",
  "feeAmount",
  "feeIncomeAccountId",
  "onAccountAmount",
] as const;

export const PAYMENT_SYSTEM_CUSTOM_FIELD_SET: ReadonlySet<string> =
  new Set(PAYMENT_SYSTEM_CUSTOM_FIELDS);
