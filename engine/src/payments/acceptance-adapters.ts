/** Acceptance provider adapter registry, keyed by provider code. */
import { adyenAdapter } from "./acceptance-adyen.ts";
import { gocardlessAdapter } from "./acceptance-gocardless.ts";
import { stripeAdapter } from "./acceptance-stripe.ts";
import { type AcceptanceProvider, type PaymentProviderAdapter } from "./acceptance-types.ts";

export const ACCEPTANCE_ADAPTERS: Record<AcceptanceProvider, PaymentProviderAdapter> = {
  stripe: stripeAdapter,
  adyen: adyenAdapter,
  gocardless: gocardlessAdapter,
};
