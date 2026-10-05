import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { portalRefusal } from "./errors.ts";

/**
 * Customer scope: every portal read and write names the customer party and
 * the row must belong to it. A miss 404s without disclosing whether the row
 * exists in another customer's scope.
 */
export async function assertPortalDocument(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  documentId: string,
): Promise<{ id: string; kind: string; status: string; documentNumber: string; currency: string; openBalance: string }> {
  const row = (await runner.execute<{
    id: string; kind: string; status: string; documentNumber: string; currency: string; openBalance: string;
  }>(sql`
    select id, kind, status, document_number as "documentNumber", currency,
           coalesce(open_balance, '0')::text as "openBalance"
      from documents
     where org_id = ${orgId} and id = ${documentId} and party_id = ${partyId}
     limit 1
  `)).rows[0];
  if (!row) {
    throw portalRefusal("That record was not found in your account", "not_found", 404, "Return to your portal home and choose from your own records");
  }
  return row;
}

export async function assertPortalSubscription(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  subscriptionId: string,
): Promise<{ id: string; status: string; customerId: string }> {
  const row = (await runner.execute<{ id: string; status: string; customerId: string }>(sql`
    select id, status, customer_id as "customerId"
      from subscriptions
     where org_id = ${orgId} and id = ${subscriptionId} and customer_id = ${partyId}
     limit 1
  `)).rows[0];
  if (!row) {
    throw portalRefusal("That subscription was not found in your account", "not_found", 404, "Return to your portal home and choose from your own subscriptions");
  }
  return row;
}

export async function assertPortalChannelOrder(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  orderId: string,
): Promise<{ id: string }> {
  const row = (await runner.execute<{ id: string }>(sql`
    select id from channel_orders
     where org_id = ${orgId} and id = ${orderId} and customer_party_id = ${partyId}
     limit 1
  `)).rows[0];
  if (!row) {
    throw portalRefusal("That order was not found in your account", "not_found", 404, "Return to your portal home and choose from your own orders");
  }
  return row;
}

export async function assertPortalPaymentMethod(
  runner: SqlExecutor,
  orgId: string,
  partyId: string,
  methodId: string,
): Promise<{ id: string; provider: string; status: string }> {
  const row = (await runner.execute<{ id: string; provider: string; status: string }>(sql`
    select id, provider, status from customer_payment_methods
     where org_id = ${orgId} and id = ${methodId} and party_id = ${partyId}
     limit 1
  `)).rows[0];
  if (!row) {
    throw portalRefusal("That payment method was not found in your account", "not_found", 404, "Return to your portal home and choose from your own payment methods");
  }
  return row;
}
