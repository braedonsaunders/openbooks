/**
 * Customer payment acceptance — hosted checkout links on posted invoices.
 *
 * One provider framework (Stripe / Adyen / GoCardless ACH-debit) behind the
 * same `psp_provider_configs` row the settlement importer uses: acceptance
 * brings the money in (this module), settlement import reconciles the payout
 * and fees (psp-settlement.ts). Secrets are AES-256-GCM sealed; webhooks are
 * HMAC-verified per provider before any org context is resolved; processing
 * is idempotent on (org, provider, external_ref).
 *
 * The receipt itself rides the standard open-item engine: a customer_payment
 * document auto-applied to the invoice, with the surcharge as a fee-income
 * leg (see the customer_payment posting rule).
 */

export {
  fromMinorUnits,
  THREE_DECIMAL_CURRENCIES,
  ZERO_DECIMAL_CURRENCIES,
} from "./minor-units.ts";
export {
  type AcceptanceProvider,
  PaymentAcceptanceError,
  type ProviderSecrets,
  type CheckoutRequest,
  type CheckoutSession,
  type WebhookEvent,
  type WebhookVerification,
  type FetchFn,
  type SetupSessionRequest,
  type SetupSession,
  type OffSessionChargeRequest,
  type OffSessionChargeOutcome,
  type DetachMethodRequest,
  type PaymentProviderAdapter,
  type ProviderConfigRow,
  type SurchargeResolution,
  type PaymentLinkView,
  type PublicPaymentPage,
  type ProviderWebhookResult,
  PaymentWebhookBatchError,
} from "./acceptance-types.ts";
export {
  defaultFetch,
  resolveAcceptanceProviderApiBase,
  normalizeAcceptanceProviderSettings,
  resolveAdyenRecurringApiBase,
  toMinorUnits,
  PAYMENT_WEBHOOK_EVENT_FAILURE_LOG_EVENT,
  PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT,
} from "./acceptance-provider-utils.ts";
export { ACCEPTANCE_ADAPTERS } from "./acceptance-adapters.ts";
export {
  configSecrets,
  computeSurcharge,
  providerPaymentMethod,
  resolveSurcharge,
} from "./acceptance-surcharge.ts";
export {
  listPaymentLinks,
  createPaymentLink,
  voidPaymentLink,
  onlinePaymentsFeatureEnabled,
  paymentLinkOrgId,
} from "./acceptance-links.ts";
export {
  publicPaymentPage,
  checkoutSessionLockKey,
  createCheckoutSession,
} from "./acceptance-checkout.ts";
export { handleProviderWebhook, CLAIMABLE_FROM } from "./acceptance-webhooks.ts";
export { testAcceptanceConnection, saveAcceptanceConfig } from "./acceptance-config.ts";
