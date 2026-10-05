import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { portalRefusal } from "./errors.ts";
import { readPortalSettings, type PortalSettings } from "./settings.ts";

export type PortalInvoice = {
  id: string;
  documentNumber: string;
  documentDate: string;
  currency: string;
  total: string;
  openBalance: string;
  status: string;
};

export type PortalSubscription = {
  id: string;
  status: string;
  quantity: string;
  priceOverride: string | null;
  startOn: string;
  nextBillOn: string;
  planName: string;
  planAmount: string;
  planCurrency: string;
  planInterval: string;
  planIntervalCount: number;
};

export type PortalPaymentMethod = {
  id: string;
  provider: string;
  brand: string | null;
  last4: string | null;
  expMonth: number | null;
  expYear: number | null;
  isDefault: boolean;
};

export type PortalChannelOrder = {
  id: string;
  externalNumber: string;
  orderedAt: string;
  currency: string;
  totalMinor: string;
  /** Channel totals are ISO minor units; unknown registry precision remains unreadable. */
  minorUnits: number | null;
  financialStatus: string;
  fulfilmentStatus: string;
  postingStatus: string;
};

export type PortalStoredCredit = {
  id: string;
  kind: string;
  codeLast4: string;
  currency: string;
  balanceMinor: string;
  status: string;
  expiresOn: string | null;
};

export type PortalPrepaidGrant = {
  id: string;
  amount: string;
  currency: string;
  expiresOn: string | null;
};

export type PortalAcceptanceProvider = { provider: string };

/** Acceptance-enabled PSP providers for this org, in preference order. */
export async function portalAcceptanceProviders(orgId: string, runner: SqlExecutor = db): Promise<PortalAcceptanceProvider[]> {
  const rows = (await runner.execute<{ provider: string }>(sql`
    select provider from psp_provider_configs
     where org_id = ${orgId} and is_enabled and acceptance_enabled
     order by case provider when 'stripe' then 0 when 'adyen' then 1 else 2 end
  `)).rows;
  return rows.map((row) => ({ provider: row.provider }));
}

export type PortalHome = {
  partyName: string;
  email: string;
  settings: PortalSettings;
  invoices: PortalInvoice[];
  subscriptions: PortalSubscription[];
  paymentMethods: PortalPaymentMethod[];
  orders: PortalChannelOrder[];
  storeCredit: PortalStoredCredit[];
  prepaidGrants: PortalPrepaidGrant[];
};

/** Everything one customer sees on portal home — every list filtered to their party. */
export async function portalHome(orgId: string, partyId: string, runner: SqlExecutor = db): Promise<PortalHome> {
  const party = (await runner.execute<{ name: string; email: string }>(sql`
    select display_name as name, coalesce(email, '') as email from parties where org_id = ${orgId} and id = ${partyId} limit 1
  `)).rows[0];
  const settings = await readPortalSettings(orgId, runner);
  const invoices = (await runner.execute<PortalInvoice>(sql`
    select id, document_number as "documentNumber", document_date::text as "documentDate",
           currency, total::text as total, coalesce(open_balance, '0')::text as "openBalance", status
      from documents
     where org_id = ${orgId} and party_id = ${partyId} and kind = 'customer_invoice' and status = 'posted'
     order by document_date desc
     limit 20
  `)).rows;
  const subscriptions = (await runner.execute<PortalSubscription>(sql`
    select s.id, s.status, s.quantity::text as quantity, s.price_override::text as "priceOverride",
           s.start_on::text as "startOn", s.next_bill_on::text as "nextBillOn",
           p.name as "planName", p.amount::text as "planAmount",
           coalesce(p.currency_code, '') as "planCurrency", p.interval as "planInterval",
           p.interval_count as "planIntervalCount"
      from subscriptions s
      join subscription_plans p on p.org_id = s.org_id and p.id = s.plan_id
     where s.org_id = ${orgId} and s.customer_id = ${partyId}
     order by s.start_on desc
     limit 20
  `)).rows;
  const paymentMethods = (await runner.execute<PortalPaymentMethod>(sql`
    select id, provider, brand, last4, exp_month as "expMonth", exp_year as "expYear",
           is_default as "isDefault"
      from customer_payment_methods
     where org_id = ${orgId} and party_id = ${partyId} and status = 'active'
     order by is_default desc, created_at desc
     limit 20
  `)).rows;
  const orders = (await runner.execute<PortalChannelOrder>(sql`
    select o.id, o.external_number as "externalNumber", o.ordered_at::text as "orderedAt",
           o.shop_currency as currency, o.total_minor::text as "totalMinor",
           case when c.minor_units between 0 and 4 then c.minor_units else null end as "minorUnits",
           o.financial_status as "financialStatus", o.fulfilment_status as "fulfilmentStatus",
           o.posting_status as "postingStatus"
      from channel_orders o
      left join currencies c on c.code = o.shop_currency
     where o.org_id = ${orgId} and o.customer_party_id = ${partyId}
     order by o.ordered_at desc
     limit 20
  `)).rows;
  const storeCredit = (await runner.execute<PortalStoredCredit>(sql`
    select id, kind, code_last4 as "codeLast4", currency,
           balance_minor::text as "balanceMinor", status, expires_on::text as "expiresOn"
      from stored_value_accounts
     where org_id = ${orgId} and customer_party_id = ${partyId} and kind = 'store_credit'
     order by created_at desc
     limit 20
  `)).rows;
  const prepaidGrants = (await runner.execute<PortalPrepaidGrant>(sql`
    select id, amount::text as amount, coalesce(currency_code, '') as currency,
           expires_on::text as "expiresOn"
      from usage_prepaid_grants
     where org_id = ${orgId} and customer_id = ${partyId}
     order by expires_on nulls last
     limit 20
  `)).rows;
  return {
    partyName: party?.name ?? "",
    email: party?.email ?? "",
    settings,
    invoices,
    subscriptions,
    paymentMethods,
    orders,
    storeCredit,
    prepaidGrants,
  };
}

export type PortalOrderTracking = {
  carrier: string | null;
  trackingNumber: string | null;
  status: string;
  occurredAt: string | null;
  source: "shipping_label" | "channel_fulfilment";
};

/**
 * Tracking for one customer order: native shipping labels on the posted
 * document first, then the channel fulfilment payload (whose tracking shape
 * varies by storefront, so keys are read defensively).
 */
export function extractPayloadTracking(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const record = payload as Record<string, unknown>;
  for (const key of ["tracking_number", "trackingNumber"]) {
    if (typeof record[key] === "string" && (record[key] as string).trim()) return (record[key] as string).trim();
  }
  const tracking = record["tracking"];
  if (tracking && typeof tracking === "object") {
    const number = (tracking as Record<string, unknown>)["number"];
    if (typeof number === "string" && number.trim()) return number.trim();
  }
  const trackings = record["trackings"];
  if (Array.isArray(trackings)) {
    for (const entry of trackings) {
      if (entry && typeof entry === "object") {
        const number = (entry as Record<string, unknown>)["number"] ?? (entry as Record<string, unknown>)["tracking_number"];
        if (typeof number === "string" && number.trim()) return number.trim();
      }
    }
  }
  return null;
}

export async function portalOrderTracking(
  orgId: string,
  orderId: string,
  runner: SqlExecutor = db,
): Promise<PortalOrderTracking[]> {
  const order = (await runner.execute<{ postingId: string | null }>(sql`
    select posting_document_id as "postingId" from channel_orders
     where org_id = ${orgId} and id = ${orderId} limit 1
  `)).rows[0];
  const tracking: PortalOrderTracking[] = [];
  if (order?.postingId) {
    const labels = (await runner.execute<{
      carrier: string; trackingNumber: string | null; status: string; purchasedAt: string;
    }>(sql`
      select carrier, tracking_number as "trackingNumber", tracking_status as status,
             purchased_at::text as "purchasedAt"
        from shipment_labels
       where org_id = ${orgId}
         and (order_document_id = ${order.postingId} or shipment_document_id = ${order.postingId})
         and status = 'purchased'
       order by purchased_at desc
    `)).rows;
    for (const label of labels) {
      tracking.push({
        carrier: label.carrier,
        trackingNumber: label.trackingNumber,
        status: label.status,
        occurredAt: label.purchasedAt,
        source: "shipping_label",
      });
    }
  }
  const fulfilments = (await runner.execute<{ payload: unknown; occurredAt: string }>(sql`
    select payload, occurred_at::text as "occurredAt" from channel_order_events
     where org_id = ${orgId} and order_id = ${orderId} and kind = 'fulfilment'
     order by occurred_at desc
  `)).rows;
  for (const event of fulfilments) {
    tracking.push({
      carrier: null,
      trackingNumber: extractPayloadTracking(event.payload),
      status: "fulfilled",
      occurredAt: event.occurredAt,
      source: "channel_fulfilment",
    });
  }
  return tracking;
}

/**
 * The currency a payment-method setup collects in: the customer's latest
 * invoice currency, else the organization's base currency. Owned here so
 * the portal route and any future setup surface resolve it the same way;
 * the setup itself still validates the currency it receives. Latest means
 * latest invoiced day, breaking same-day ties by record order, so two
 * invoices on one day never resolve ambiguously. When neither source names
 * a currency the organization is outside the caller's scope, so the lookup
 * refuses as not-found — it never invents one.
 */
export async function resolvePortalSetupCurrency(
  orgId: string,
  partyId: string,
  runner: SqlExecutor = db,
): Promise<string> {
  const row = (await runner.execute<{ currency: string | null }>(sql`
    with ranked as (
      select currency, row_number() over (order by document_date desc, created_at desc, id desc) as rn
        from documents
       where org_id = ${orgId} and party_id = ${partyId} and kind = 'customer_invoice'
    )
    select coalesce((select currency from ranked where rn = 1),
                    (select base_currency from orgs where id = ${orgId})) as currency`)).rows[0];
  if (!row?.currency) {
    throw portalRefusal(
      "No payment currency is on file for this account",
      "not_found",
      404,
      "Request a new link from the portal sign-in",
    );
  }
  return row.currency;
}
