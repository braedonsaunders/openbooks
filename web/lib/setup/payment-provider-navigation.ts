export type PaymentProviderView = "checkout" | "settlement" | "surcharge" | "processor_receipts";

const PAYMENT_PROVIDER_VIEWS = new Set<PaymentProviderView>([
  "checkout",
  "settlement",
  "surcharge",
  "processor_receipts",
]);

export function resolvePaymentProviderView(
  requestedView: string | null,
  fallbackView: PaymentProviderView,
  openingNewRule: boolean,
): PaymentProviderView {
  if (requestedView && PAYMENT_PROVIDER_VIEWS.has(requestedView as PaymentProviderView)) {
    return requestedView as PaymentProviderView;
  }
  return openingNewRule ? "surcharge" : fallbackView;
}

export function surchargeRuleDrawerHrefs(
  pathname: string,
  search: string,
): { closeHref: string; newHref: string } {
  const closeParams = new URLSearchParams(search);
  closeParams.set("view", "surcharge");
  closeParams.delete("rule");
  const closeHref = `${pathname}?${closeParams.toString()}`;
  const newParams = new URLSearchParams(closeParams);
  newParams.set("rule", "new");
  return { closeHref, newHref: `${pathname}?${newParams.toString()}` };
}
