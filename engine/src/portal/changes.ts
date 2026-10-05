import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { businessToday } from "../platform/business-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { add, mul, neg } from "../money/money.ts";
import {
  applyAmendment,
  subscriptionComponentTotal,
} from "../billing/advanced-subscriptions.ts";
import {
  changeSubscription,
  monthlyRecurringRevenue,
  normalizeSubscriptionMoney,
  prorate,
  prorationDocument,
} from "../billing/subscription-billing.ts";
import { applyPromotion } from "../sales/promotions.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { portalRefusal } from "./errors.ts";
import { PORTAL_FEATURE, PORTAL_FEATURE_REMEDY, recordPortalEvent } from "./tokens.ts";
import { assertPortalDocument, assertPortalSubscription } from "./scope.ts";
import { readPortalSettings, returnWindowDeadline } from "./settings.ts";

/**
 * The portal's customer identity on engine writes. No customer holds a gate
 * user id, so portal-initiated rows carry the zero system actor plus a
 * portal_events row and request provenance naming the customer party and
 * link — the same attribution shape as scheduler renewals.
 */
export const PORTAL_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

async function requirePortalFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(runner, orgId, PORTAL_FEATURE))) {
    throw portalRefusal("The customer portal is turned off for this organization", "feature_disabled", 404, PORTAL_FEATURE_REMEDY);
  }
}

function parsePortalDecimal(value: unknown, label: string, remedy: string): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw portalRefusal(`${label} must be a plain number with up to four decimals`, "invalid_input", 422, remedy);
  }
  return exact;
}

type ClassicSubRow = {
  id: string;
  status: string;
  quantity: string;
  price_override: string | null;
  start_on: string;
  current_period_start: string | null;
  next_bill_on: string;
  plan_amount: string;
  plan_interval: string;
  plan_interval_count: number;
  advanced_lifecycle: boolean;
};

async function loadClassicSub(runner: SqlExecutor, orgId: string, subscriptionId: string): Promise<ClassicSubRow> {
  const row = (await runner.execute<ClassicSubRow>(sql`
    select s.id, s.status, s.quantity::text as quantity, s.price_override::text as price_override,
           s.start_on::text as start_on, s.current_period_start::text as current_period_start,
           s.next_bill_on::text as next_bill_on, p.amount::text as plan_amount,
           p.interval as plan_interval, p.interval_count as plan_interval_count,
           (sl.subscription_id is not null) as advanced_lifecycle
      from subscriptions s
      join subscription_plans p on p.org_id = s.org_id and p.id = s.plan_id
      left join subscription_lifecycles sl on sl.org_id = s.org_id and sl.subscription_id = s.id
     where s.org_id = ${orgId} and s.id = ${subscriptionId}
     limit 1
  `)).rows[0];
  if (!row) throw portalRefusal("That subscription was not found in your account", "not_found", 404, "Return to your portal home and choose from your own subscriptions");
  return row;
}

export type SubscriptionPreview = {
  beforeTotal: string;
  afterTotal: string;
  adjustment: string;
  documentKind: "customer_invoice" | "customer_credit" | null;
  periodStart: string;
  periodEnd: string;
  effectiveOn: string;
};

/**
 * Price a subscription change for the remaining slice of the current period.
 * Classic subscriptions use the billing engine's own proration (the same
 * `prorate` over the same period the commit path bills); advanced
 * lifecycles price the component totals the amendment snapshots carry, so
 * the preview and the applied amendment always agree.
 */
export async function previewSubscriptionChange(
  orgId: string,
  partyId: string,
  input: { subscriptionId: string; quantity?: unknown; unitPrice?: unknown; componentKey?: string; effectiveOn?: string },
): Promise<SubscriptionPreview> {
  return withOrgTransaction(orgId, async () => {
    await requirePortalFeature(db, orgId);
    await assertPortalSubscription(db, orgId, partyId, input.subscriptionId);
    const sub = await loadClassicSub(db, orgId, input.subscriptionId);
    if (sub.status === "canceled") {
      throw portalRefusal("This subscription is canceled", "wrong_state", 409, "Contact your supplier to start a new subscription");
    }
    const effectiveOn = input.effectiveOn ?? await businessToday(orgId);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(effectiveOn)) {
      throw portalRefusal("The change date must be a calendar date", "invalid_input", 422, "Pick the date the change takes effect");
    }
    const periodStart = sub.current_period_start ?? sub.start_on;
    const periodEnd = sub.next_bill_on;
    if (sub.advanced_lifecycle) {
      return previewAdvancedChange(orgId, input.subscriptionId, input, periodStart, periodEnd, effectiveOn);
    }
    const oldPrice = sub.price_override ?? sub.plan_amount;
    const newQuantity = input.quantity !== undefined
      ? parsePortalDecimal(input.quantity, "Quantity", "Enter how many seats or units you need")
      : sub.quantity;
    const newPrice = input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice !== ""
      ? parsePortalDecimal(input.unitPrice, "Price", "Enter the agreed price per unit")
      : oldPrice;
    const beforeTotal = mul(
      normalizeSubscriptionMoney(sub.quantity, "quantity", "positive"),
      normalizeSubscriptionMoney(oldPrice, "price", "nonnegative"),
    );
    const afterTotal = mul(
      normalizeSubscriptionMoney(newQuantity, "quantity", "positive"),
      normalizeSubscriptionMoney(newPrice, "price", "nonnegative"),
    );
    const beforeRemaining = prorate(beforeTotal, periodStart, periodEnd, effectiveOn);
    const afterRemaining = prorate(afterTotal, periodStart, periodEnd, effectiveOn);
    const adjustment = add(afterRemaining, neg(beforeRemaining));
    return {
      beforeTotal,
      afterTotal,
      adjustment,
      documentKind: adjustment === "0.0000" ? null : prorationDocument(adjustment).kind,
      periodStart,
      periodEnd,
      effectiveOn,
    };
  });
}

async function previewAdvancedChange(
  orgId: string,
  subscriptionId: string,
  input: { quantity?: unknown; unitPrice?: unknown; componentKey?: string },
  periodStart: string,
  periodEnd: string,
  effectiveOn: string,
): Promise<SubscriptionPreview> {
  if (!input.componentKey?.trim()) {
    throw portalRefusal("Choose the subscription line to change", "invalid_input", 422, "Pick one subscription line to upgrade or downgrade");
  }
  const components = (await db.execute<{ componentKey: string; quantity: string; unitPrice: string }>(sql`
    select component_key as "componentKey", quantity::text as quantity, unit_price::text as "unitPrice"
      from subscription_components
     where org_id = ${orgId} and subscription_id = ${subscriptionId}
       and effective_from <= ${effectiveOn} and (effective_to is null or effective_to >= ${effectiveOn})
  `)).rows;
  const current = components.find((component) => component.componentKey === input.componentKey);
  if (!current) {
    throw portalRefusal("That subscription line is not active", "invalid_input", 422, "Pick an active subscription line");
  }
  const before = components.map((component) => ({ quantity: component.quantity, unitPrice: component.unitPrice }));
  const after = components.map((component) => component.componentKey === input.componentKey
    ? {
      quantity: input.quantity !== undefined ? parsePortalDecimal(input.quantity, "Quantity", "Enter how many seats or units you need") : component.quantity,
      unitPrice: input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice !== ""
        ? parsePortalDecimal(input.unitPrice, "Price", "Enter the agreed price per unit")
        : component.unitPrice,
    }
    : { quantity: component.quantity, unitPrice: component.unitPrice });
  const beforeTotal = subscriptionComponentTotal(before).toString();
  const afterTotal = subscriptionComponentTotal(after).toString();
  const adjustment = add(prorate(afterTotal, periodStart, periodEnd, effectiveOn), neg(prorate(beforeTotal, periodStart, periodEnd, effectiveOn)));
  return {
    beforeTotal,
    afterTotal,
    adjustment,
    documentKind: adjustment === "0.0000" ? null : prorationDocument(adjustment).kind,
    periodStart,
    periodEnd,
    effectiveOn,
  };
}

export type AppliedSubscriptionChange = {
  adjustment: string;
  invoiceId: string | null;
  documentNumber: string | null;
  amendmentId: string | null;
};

/**
 * Commit a subscription upgrade or downgrade through the billing engine:
 * classic subscriptions ride `changeSubscription` (which cuts the proration
 * invoice or credit itself), advanced lifecycles ride `applyAmendment`.
 */
export async function applySubscriptionChange(
  orgId: string,
  partyId: string,
  linkId: string,
  input: { subscriptionId: string; quantity?: unknown; unitPrice?: unknown; componentKey?: string; effectiveOn?: string },
): Promise<AppliedSubscriptionChange> {
  const preview = await previewSubscriptionChange(orgId, partyId, input);
  const sub = await withOrgTransaction(orgId, async () => {
    await assertPortalSubscription(db, orgId, partyId, input.subscriptionId);
    return loadClassicSub(db, orgId, input.subscriptionId);
  });
  if (sub.advanced_lifecycle) {
    const amendment = await applyAmendment(orgId, null, {
      subscriptionId: input.subscriptionId,
      type: "change_component",
      componentKey: input.componentKey!.trim(),
      quantity: input.quantity !== undefined ? parsePortalDecimal(input.quantity, "Quantity", "Enter how many seats or units you need") : undefined,
      unitPrice: input.unitPrice !== undefined && input.unitPrice !== null && input.unitPrice !== ""
        ? parsePortalDecimal(input.unitPrice, "Price", "Enter the agreed price per unit")
        : undefined,
      effectiveOn: preview.effectiveOn,
      idempotencyKey: randomUUID(),
      reason: "Customer portal change",
    }, { system: { origin: "customer_portal", detail: { partyId, linkId } } });
    await withOrgTransaction(orgId, async () => {
      await recordPortalEvent(db, orgId, {
        partyId, linkId, action: "subscription_changed", reasonCode: null,
        detail: { subscriptionId: input.subscriptionId, amendmentId: amendment.id, adjustment: preview.adjustment },
      });
    });
    return { adjustment: preview.adjustment, invoiceId: null, documentNumber: null, amendmentId: amendment.id };
  }
  const change = await changeSubscription(
    orgId,
    input.subscriptionId,
    {
      quantity: input.quantity !== undefined ? parsePortalDecimal(input.quantity, "Quantity", "Enter how many seats or units you need") : undefined,
      priceOverride: input.unitPrice !== undefined ? parsePortalDecimal(input.unitPrice, "Price", "Enter the agreed price per unit") : undefined,
    },
    preview.effectiveOn,
    { actorId: null },
    null,
  );
  await withOrgTransaction(orgId, async () => {
    await assertPortalSubscription(db, orgId, partyId, input.subscriptionId);
    await recordPortalEvent(db, orgId, {
      partyId, linkId, action: "subscription_changed", reasonCode: null,
      detail: {
        subscriptionId: input.subscriptionId, adjustment: change.adjustment,
        invoiceId: change.invoiceId, documentNumber: change.documentNumber,
      },
    });
  });
  return { adjustment: change.adjustment, invoiceId: change.invoiceId, documentNumber: change.documentNumber, amendmentId: null };
}

export type SubscriptionTransition = { status: string };

async function transitionSubscription(
  orgId: string,
  partyId: string,
  linkId: string,
  subscriptionId: string,
  to: "paused" | "active" | "canceled",
  reason: string | null,
  action: string,
): Promise<SubscriptionTransition> {
  return withOrgTransaction(orgId, async () => {
    await requirePortalFeature(db, orgId);
    await assertPortalSubscription(db, orgId, partyId, subscriptionId);
    const sub = await loadClassicSub(db, orgId, subscriptionId);
    if (sub.advanced_lifecycle) {
      throw portalRefusal(
        "This subscription runs on a contract schedule your supplier manages",
        "wrong_state",
        409,
        "Contact your supplier to pause, resume or cancel this subscription",
      );
    }
    if (sub.status === "canceled") {
      throw portalRefusal("This subscription is already canceled", "wrong_state", 409, "Contact your supplier to start a new subscription");
    }
    if (sub.status === "suspended") {
      throw portalRefusal(
        "This subscription is suspended after failed collection",
        "wrong_state",
        409,
        "Add a working payment method so collection can succeed, then resume",
      );
    }
    if (sub.status === to) {
      throw portalRefusal(`This subscription is already ${to}`, "wrong_state", 409, "Choose a different change");
    }
    if (to === "canceled" && !reason?.trim()) {
      throw portalRefusal("Tell us why you are canceling", "invalid_input", 422, "Write a sentence about why you are canceling");
    }
    const today = await businessToday(orgId);
    const updated = (await db.execute<{ id: string }>(sql`
      update subscriptions
         set status = ${to},
             canceled_on = case when ${to} = 'canceled' then ${today} else canceled_on end,
             updated_at = now(), updated_by = ${PORTAL_ACTOR_ID}
       where org_id = ${orgId} and id = ${subscriptionId} and status = ${sub.status}
      returning id
    `)).rows[0];
    if (!updated) {
      throw portalRefusal("The subscription changed while saving", "changed_concurrently", 409, "Reload the subscription and try again");
    }
    await recordPortalEvent(db, orgId, {
      partyId, linkId, action, reasonCode: null,
      detail: { subscriptionId, from: sub.status, to, ...(reason?.trim() ? { reason: reason.trim().slice(0, 200) } : {}) },
    });
    return { status: to };
  });
}

/** Pause billing on a classic subscription; the contract stays for reactivation. */
export async function pauseSubscription(orgId: string, partyId: string, linkId: string, subscriptionId: string): Promise<SubscriptionTransition> {
  return transitionSubscription(orgId, partyId, linkId, subscriptionId, "paused", null, "subscription_paused");
}

/** Resume a paused classic subscription. */
export async function resumeSubscription(orgId: string, partyId: string, linkId: string, subscriptionId: string): Promise<SubscriptionTransition> {
  return transitionSubscription(orgId, partyId, linkId, subscriptionId, "active", null, "subscription_resumed");
}

/** Cancel with reason capture; the reason is required and travels in the audit. */
export async function cancelSubscription(
  orgId: string,
  partyId: string,
  linkId: string,
  subscriptionId: string,
  reason: unknown,
): Promise<SubscriptionTransition> {
  return transitionSubscription(orgId, partyId, linkId, subscriptionId, "canceled", String(reason ?? ""), "subscription_canceled");
}

export type AcceptedSaveOffer = {
  offerId: string;
  kind: "pause" | "discount";
  promotionCode: string | null;
  discountMinor: string | null;
  documentNumber: string | null;
};

/**
 * Take a configured cancel save offer. A pause offer pauses the
 * subscription; a discount offer applies its promotion to the customer's
 * open draft document through the promotions engine — which refuses by name
 * when there is nothing to discount.
 */
export async function acceptSaveOffer(
  orgId: string,
  partyId: string,
  linkId: string,
  input: { subscriptionId: string; offerId: string },
): Promise<AcceptedSaveOffer> {
  const preflight = await withOrgTransaction(orgId, async () => {
    await requirePortalFeature(db, orgId);
    await assertPortalSubscription(db, orgId, partyId, input.subscriptionId);
    const settings = await readPortalSettings(orgId, db);
    const offer = settings.saveOffers.find((candidate) => candidate.id === input.offerId);
    if (!offer) {
      throw portalRefusal("That save offer is no longer available", "invalid_input", 422, "Choose one of the current offers or continue canceling");
    }
    return offer.kind;
  });
  if (preflight === "pause") {
    await pauseSubscription(orgId, partyId, linkId, input.subscriptionId);
    return { offerId: input.offerId, kind: "pause", promotionCode: null, discountMinor: null, documentNumber: null };
  }
  return withOrgTransaction(orgId, async () => {
    await requirePortalFeature(db, orgId);
    await assertPortalSubscription(db, orgId, partyId, input.subscriptionId);
    const settings = await readPortalSettings(orgId, db);
    const offer = settings.saveOffers.find((candidate) => candidate.id === input.offerId);
    if (!offer || offer.kind !== "discount") {
      throw portalRefusal("That save offer is no longer available", "invalid_input", 422, "Choose one of the current offers or continue canceling");
    }
    const draft = (await db.execute<{ id: string; document_number: string }>(sql`
      select id, document_number
        from documents
       where org_id = ${orgId} and party_id = ${partyId} and status = 'draft'
         and kind in ('customer_invoice', 'sales_order', 'estimate')
       order by created_at desc
       limit 1
      for update
    `)).rows[0];
    if (!draft) {
      throw portalRefusal(
        "There is no open draft to discount",
        "no_draft_invoice",
        409,
        "Take the pause offer instead, or ask your supplier to send the next invoice before you accept this discount",
      );
    }
    const applied = await applyPromotion(db, orgId, PORTAL_ACTOR_ID, {
      documentId: draft.id,
      code: offer.promotionCode,
      channelId: null,
      allowedSubsidiaryIds: null,
    });
    await recordPortalEvent(db, orgId, {
      partyId, linkId, action: "save_offer_accepted", reasonCode: null,
      detail: {
        subscriptionId: input.subscriptionId, offerId: offer.id, promotionCode: applied.code,
        discountMinor: applied.discountMinor, documentNumber: draft.document_number,
      },
    });
    return {
      offerId: offer.id,
      kind: "discount",
      promotionCode: applied.code,
      discountMinor: applied.discountMinor,
      documentNumber: draft.document_number,
    };
  });
}

export type ValidatedPortalReturn = {
  sourceDocumentId: string;
  subsidiaryId: string;
  currency: string;
  documentDate: string;
  deadline: string;
  reasonCode: string;
  resolution: "refund" | "exchange" | "store_credit";
  storeCreditBonusPercent: string;
  lines: Array<{ sourceIssueMovementId: string; quantity: string }>;
};

/**
 * Validate a self-service return request against the org's portal return
 * rules. Refusals name the rule: the window with its deadline, the allowed
 * reasons, the enabled outcomes.
 */
export async function validatePortalReturn(
  orgId: string,
  partyId: string,
  input: {
    sourceDocumentId: string;
    reasonCode: unknown;
    resolution: unknown;
    lines: Array<{ sourceIssueMovementId: unknown; quantity: unknown }>;
  },
): Promise<ValidatedPortalReturn> {
  return withOrgTransaction(orgId, async () => {
    await requirePortalFeature(db, orgId);
    const settings = await readPortalSettings(orgId, db);
    const source = await assertPortalDocument(db, orgId, partyId, input.sourceDocumentId);
    if (source.kind !== "customer_invoice" && source.kind !== "sales_fulfillment") {
      throw portalRefusal(
        `Returns start from an invoice or a sales fulfillment, not ${source.kind}`,
        "invalid_input",
        422,
        "Choose one of your invoices or delivered shipments to return from",
      );
    }
    const sourceRow = (await db.execute<{ documentDate: string; subsidiaryId: string }>(sql`
      select document_date::text as "documentDate", subsidiary_id as "subsidiaryId"
        from documents where org_id = ${orgId} and id = ${input.sourceDocumentId} limit 1
    `)).rows[0];
    if (!sourceRow) throw portalRefusal("That record was not found in your account", "not_found", 404, "Return to your portal home and choose from your own records");
    const today = await businessToday(orgId);
    const deadline = returnWindowDeadline(sourceRow.documentDate, settings.returnWindowDays);
    if (today > deadline) {
      throw portalRefusal(
        `${source.documentNumber} is outside the ${settings.returnWindowDays}-day return window (last day ${deadline})`,
        "outside_return_window",
        409,
        "Contact your supplier — they can still accept a late return on your behalf",
      );
    }
    if (typeof input.reasonCode !== "string" || !settings.returnReasons.includes(input.reasonCode)) {
      throw portalRefusal(
        `Choose one of the accepted return reasons: ${settings.returnReasons.join(", ")}`,
        "return_reason_not_allowed",
        422,
        "Pick the reason that best matches from the list",
      );
    }
    if (input.resolution !== "refund" && input.resolution !== "exchange" && input.resolution !== "store_credit") {
      throw portalRefusal("Choose refund, exchange or store credit", "return_resolution_not_allowed", 422, "Pick how you want the return settled");
    }
    const enabled = input.resolution === "refund"
      ? settings.returnResolutions.refund
      : input.resolution === "exchange"
        ? settings.returnResolutions.exchange
        : settings.returnResolutions.storeCredit;
    if (!enabled) {
      throw portalRefusal(
        `This supplier does not offer ${input.resolution === "store_credit" ? "store credit" : input.resolution} for portal returns`,
        "return_resolution_not_allowed",
        422,
        "Pick one of the outcomes your supplier offers",
      );
    }
    if (!Array.isArray(input.lines) || input.lines.length === 0 || input.lines.length > 50) {
      throw portalRefusal("Choose 1–50 return lines", "invalid_input", 422, "Select the items you are returning");
    }
    const lines = input.lines.map((line, index) => {
      if (typeof line.sourceIssueMovementId !== "string" || !line.sourceIssueMovementId.trim()) {
        throw portalRefusal(`Return line ${index + 1} names no shipment`, "invalid_input", 422, "Choose a shipped item for every return line");
      }
      return {
        sourceIssueMovementId: line.sourceIssueMovementId,
        quantity: parsePortalDecimal(line.quantity, `Return line ${index + 1} quantity`, "Enter how many you are returning"),
      };
    });
    return {
      sourceDocumentId: input.sourceDocumentId,
      subsidiaryId: sourceRow.subsidiaryId,
      currency: source.currency,
      documentDate: sourceRow.documentDate,
      deadline,
      reasonCode: input.reasonCode,
      resolution: input.resolution,
      storeCreditBonusPercent: input.resolution === "store_credit" ? settings.returnResolutions.storeCreditBonusPercent : "0",
      lines,
    };
  });
}

export { monthlyRecurringRevenue };
