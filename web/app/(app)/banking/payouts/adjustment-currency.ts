/**
 * Currency for the provider-adjustment confirmation. The line names its own
 * currency first and the batch backs it up; when neither names one there is
 * no honest figure to confirm, so the caller refuses instead of pricing the
 * line in a guessed currency.
 */
export function adjustmentCurrency(
  lineCurrency: string | null | undefined,
  batchCurrency: string | null | undefined,
): string | null {
  return lineCurrency ?? batchCurrency ?? null
}
