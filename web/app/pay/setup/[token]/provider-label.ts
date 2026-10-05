/** Customer-facing provider names for the hosted setup flow (proper nouns, untranslated). */
export function setupProviderLabel(provider: string): string {
  if (provider === "gocardless") return "GoCardless";
  if (provider === "adyen") return "Adyen";
  return "Stripe";
}
