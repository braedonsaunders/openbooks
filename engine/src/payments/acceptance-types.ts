/** Shared contracts for customer payment acceptance: provider adapter
 *  interfaces, webhook event shapes, and hosted payment-link views. */

export type AcceptanceProvider = "stripe" | "adyen" | "gocardless";

export class PaymentAcceptanceError extends Error {}

export interface ProviderSecrets {
  apiKey?: string;
  webhookSecret?: string;
  publishableKey?: string;
  /** Adyen: merchant account code. GoCardless: creditor id (optional). */
  merchantAccount?: string;
  /** Adyen Recurring API base for stored-detail disable (a pal host, never
   *  the Checkout apiBase above — the two resolvers admit different hosts). */
  recurringApiBase?: string;
  /** Allowlisted provider API base (sandbox/test by default; set a published
   *  live provider URL in production). */
  apiBase?: string;
}

export interface CheckoutRequest {
  linkToken: string;
  description: string;
  /** Major-unit money strings, exact 4dp. */
  invoiceAmount: string;
  surchargeAmount: string;
  currency: string;
  /** Absolute URL the provider returns the customer to (our /pay/{token} page). */
  returnUrl: string;
}

export interface CheckoutSession {
  redirectUrl: string;
  externalRef: string;
}

export interface WebhookEvent {
  /** Provider object id (session / pspReference / payment id). */
  externalRef: string;
  /** True when the delivery completes a stored-method setup (setup session,
   *  mandate, recurring contract) rather than a payment. The autopay engine
   *  claims these; the payment-attempt path never sees them. */
  setupCompleted?: boolean;
  /** Provider setup object (setup intent, mandate, recurring detail). */
  setupRef?: string | null;
  /** Provider customer the setup belongs to (when the provider reports it). */
  setupCustomerRef?: string | null;
  /**
   * Card account updater refresh (Stripe `payment_method.automatically_updated`
   * and equivalents): the provider reissued or corrected the stored card, so
   * the autopay engine refreshes brand/last4/expiry off this detail. Claimed
   * before any payment path — no money moved.
   */
  cardUpdaterRefresh?: {
    providerMethodId: string;
    brand: string | null;
    last4: string | null;
    expMonth: number | null;
    expYear: number | null;
  } | null;
  /** True when a refund event is a provider chargeback/dispute rather than a
   *  voluntary refund. Persisted onto the attempt so autopay never
   *  auto-charges an invoice under dispute. */
  dispute?: boolean;
  /** A second provider id the attempt may be keyed under — GoCardless stores
   *  the billing request id at checkout while payment events reference the
   *  payment id, so resolution must try both. */
  alternateExternalRef?: string | null;
  /** Provider intent id (Stripe payment_intent). Persisted onto the attempt
   *  when the session completes so later refund/dispute events — keyed by the
   *  intent, not the session — resolve to the same attempt. */
  intentRef?: string | null;
  /** Some providers key events by our reference instead of their object id. */
  linkToken?: string | null;
  /** In-flight states never settle: "processing" means the provider reports
   *  the collection still pending (async ACH/SEPA). "disputed" routes to the
   *  dispute lifecycle; every other return routes to the refund path. */
  status: "succeeded" | "processing" | "failed" | "cancelled" | "refunded" | "disputed";
  /** Gross amount and ISO currency the provider confirms it collected. */
  paidAmount?: string | null;
  paidCurrency?: string | null;
  /** Provider delivery id (evt_..., notification id). The refund/dispute
   *  automation's idempotency key: redeliveries converge instead of posting
   *  twice. Null for providers that send none — those events park under the
   *  intent marker and replay once, never twice. */
  providerEventId?: string | null;
  /** Refunded amount and ISO currency (4dp major strings) the provider
   *  confirms it returned. Null when the provider reports no amount — the
   *  automation parks for review instead of guessing full vs partial. */
  refundedAmount?: string | null;
  refundCurrency?: string | null;
  refundAmountBasis?: "incremental" | "cumulative";
  providerRefundId?: string | null;
  /** Refund object updates describe an existing return; the Charge snapshot
   * is Stripe's authoritative cumulative accounting stream. */
  refundObservation?: boolean;
  /** Dispute lifecycle detail. State follows the provider: opened on
   *  creation/notification, won/lost on close/reversal. Separate from the
   *  `dispute` boolean above (which autopay reads): detail drives the
   *  refund/dispute automation's accounting, the flag drives collection. */
  disputeDetail?: {
    id: string;
    amount: string;
    currency: string;
    reason?: string | null;
    state: "opened" | "won" | "lost";
  } | null;
  raw: Record<string, unknown>;
}

export type WebhookVerification =
  | { signatureValid: false; events: [] }
  /** Every actionable event in the authenticated delivery, in provider order. */
  | { signatureValid: true; events: WebhookEvent[] };

export type FetchFn = (
  url: string,
  init: {
    method: string;
    headers: Record<string, string>;
    body?: string;
    redirect: "error";
  },
) => Promise<{ status: number; json: () => Promise<unknown> }>;

export interface SetupSessionRequest {
  /** Our pending method row id: stored as the provider session's client
   *  reference / metadata so completion maps back to exactly one row. */
  linkToken: string;
  description: string;
  currency: string;
  /** Absolute URL the provider returns the customer to (our /pay/{token} page). */
  returnUrl: string;
  /** Existing provider customer to attach the method to, when linked. */
  providerCustomerId?: string | null;
}

export interface SetupSession {
  redirectUrl: string;
  /** Provider setup object id (session / billing request / payment link). The
   *  pending method row holds it until completion replaces it with the real
   *  method id. */
  externalRef: string;
  providerCustomerId?: string | null;
}

export interface OffSessionChargeRequest {
  providerCustomerId?: string | null;
  providerMethodId: string;
  /** Major-unit money string, exact 4dp. */
  amount: string;
  currency: string;
  description: string;
  /**
   * Stable per collection position (invoice and retry position), so a replay
   * after an interrupted run returns the first charge instead of a second.
   */
  idempotencyKey: string;
}

export type OffSessionChargeOutcome =
  | { status: "succeeded"; providerRef: string }
  | { status: "processing"; providerRef: string }
  | { status: "failed"; providerRef: string | null; declineCode: string | null }
  /**
   * The charge needs the customer to verify (3DS / issuer authentication).
   * The attempt records needs_authentication and keeps the link — it never
   * retries automatically.
   */
  | {
      status: "requires_action";
      providerRef: string | null;
      authUrl: string | null;
      declineCode: string | null;
    };

export interface DetachMethodRequest {
  providerCustomerId?: string | null;
  providerMethodId: string;
}

export interface PaymentProviderAdapter {
  key: AcceptanceProvider;
  createCheckout(
    secrets: ProviderSecrets,
    req: CheckoutRequest,
    fetchFn?: FetchFn,
  ): Promise<CheckoutSession>;
  /** Hosted setup session that tokenizes a method without charging it. */
  createSetupSession(
    secrets: ProviderSecrets,
    req: SetupSessionRequest,
    fetchFn?: FetchFn,
  ): Promise<SetupSession>;
  /** Merchant-initiated charge against a stored method (autopay attempt). */
  chargeOffSession(
    secrets: ProviderSecrets,
    req: OffSessionChargeRequest,
    fetchFn?: FetchFn,
  ): Promise<OffSessionChargeOutcome>;
  /** Release a stored method at the provider (local row flips separately). */
  detachMethod(
    secrets: ProviderSecrets,
    req: DetachMethodRequest,
    fetchFn?: FetchFn,
  ): Promise<void>;
  /** Verify and normalize a complete delivery without conflating authentication
   *  with whether this service handles any of its event types. A signature-
   *  valid item whose fields cannot be normalized exactly is isolated — logged
   *  under PAYMENT_WEBHOOK_ITEM_MALFORMED_LOG_EVENT and skipped — so it never
   *  crashes the delivery boundary or starves its signed siblings. */
  verifyWebhookDelivery(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    secrets: ProviderSecrets,
  ): WebhookVerification;
  /** Normalize the first actionable event in a delivery, if one exists. */
  verifyWebhook(
    headers: Record<string, string | string[] | undefined>,
    rawBody: string,
    secrets: ProviderSecrets,
  ): WebhookEvent | null;
}

// ---------------------------------------------------------------------------
// Config + surcharge resolution
// ---------------------------------------------------------------------------
export type ProviderConfigRow = {
  id: string;
  provider: AcceptanceProvider;
  display_name: string;
  is_enabled: boolean;
  acceptance_enabled: boolean;
  default_bank_account_id: string | null;
  publishable_key: string | null;
  settings: Record<string, unknown>;
  surcharge_rule_id: string | null;
  secrets: string | null;
  default_disputed_funds_account_id: string | null;
  default_chargeback_loss_account_id: string | null;
  default_dispute_fee_account_id: string | null;
};

export interface SurchargeResolution {
  amount: string;
  ruleId: string | null;
  feeIncomeAccountId: string | null;
}

export type PaymentLinkView = {
  id: string;
  token: string;
  /**
   * Whether the pay URL can be rebuilt: "ok" carries a usable token, while
   * "unsealable" means the sealed token no longer opens (data-key rotation
   * or tampering) — the link collects nothing until it is reissued. The
   * token is then empty ON PURPOSE and no URL may be built from it.
   */
  tokenState: "ok" | "unsealable";
  documentId: string;
  provider: AcceptanceProvider;
  amount: string;
  surchargeAmount: string;
  currency: string;
  status: string;
  expiresOn: string | null;
  memo: string | null;
  paidPaymentDocumentId: string | null;
  createdAt: string;
};

export interface LinkWithContext {
  id: string;
  orgId: string;
  token: string;
  documentId: string;
  partyId: string;
  subsidiaryId: string;
  provider: AcceptanceProvider;
  bankAccountId: string;
  /** Quoted at link creation; null only on rows predating the columns. */
  amount: string | null;
  surchargeAmount: string | null;
  currency: string;
  status: string;
  expiresOn: string | null;
}

export interface PublicPaymentPageBase {
  orgName: string;
  documentNumber: string;
  partyName: string;
  currency: string;
  provider: AcceptanceProvider;
  publishableKey: string | null;
}

export type PublicPaymentPage = PublicPaymentPageBase &
  (
    | { status: "outdated" }
    | {
        status: "paid" | "active";
        invoiceAmount: string;
        surchargeAmount: string;
        totalAmount: string;
      }
  );

/**
 * Verify and route a provider webhook. The provider signature is checked
 * against EVERY org configured for acceptance with this provider — per-org
 * webhook secrets share one provider endpoint, so sibling orgs can verify the
 * same delivery and each verifying org must get a chance to claim each event.
 * Returns null only when no signature verifies anywhere. Authenticated
 * deliveries containing no actionable events return "unhandled" so the HTTP
 * boundary acknowledges them instead of misreporting a signature failure.
 */
export interface ProviderWebhookResult {
  signatureValid: true;
  orgId: string;
  status: string;
  eventResults: {
    externalRef: string;
    orgId: string;
    status: string;
  }[];
}

/**
 * One or more authenticated events failed after every event in the delivery
 * was attempted. The HTTP boundary uses the completed result for a stable
 * retry response while the original failure remains the error cause.
 */
export class PaymentWebhookBatchError extends PaymentAcceptanceError {
  constructor(
    readonly result: ProviderWebhookResult,
    cause: unknown,
  ) {
    super(cause instanceof Error ? cause.message : "payment webhook event processing failed", {
      cause,
    });
    this.name = "PaymentWebhookBatchError";
  }
}

export interface SettlementDiscrepancyEvidence {
  reason:
    "missing_settlement_evidence" | "amount_currency_mismatch" | "collection_exceeds_open_balance";
  provider: AcceptanceProvider;
  externalRef: string;
  reportedAmount: string | null;
  reportedCurrency: string | null;
  expectedAmount: string;
  expectedCurrency: string;
}

export type WebhookEventOutcome = string | { discrepancy: PaymentAcceptanceError };
