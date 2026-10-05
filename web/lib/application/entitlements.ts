import "server-only";
import { sql } from "drizzle-orm";
import { isUuid } from "@openbooks/engine/platform/identifiers";
import { db, withOrgContext } from "@openbooks/engine/platform/database";
import { ScopeNotFoundError } from "@openbooks/engine/organization/authority";
import {
  EntitlementError,
  checkEntitlement,
  resolveEntitlements,
  type EntitlementVerdict,
  type ResolvedSubscriptionEntitlements,
} from "@openbooks/engine/billing";
import { isFeatureEnabled } from "../features";
import type { ApplicationContext } from "./context";
import { assertApplicationPermission } from "./context";
import { ApplicationError, invalidInput, notFound } from "./errors";

/**
 * Public entitlement reads for storefront and provisioning callers. Customer
 * resolution accepts the native id, the exact display name, or a
 * `provider:external-id` platform reference; every miss refuses by name
 * with the remedy attached instead of resolving to an empty grant.
 */

export interface V1EntitlementsQuery {
  customer?: string;
  externalRef?: string;
  /** Pin the usage check to one subscription; required when the customer holds several. */
  subscription?: string;
  at?: string;
  feature?: string;
  used?: unknown;
}

export interface V1EntitlementsResult {
  customer: { id: string; displayName: string };
  subscriptions: ResolvedSubscriptionEntitlements[];
  check: EntitlementVerdict | null;
}

function mapEntitlementError(error: unknown, resource: string): never {
  if (error instanceof ScopeNotFoundError) throw notFound(resource);
  if (error instanceof EntitlementError) {
    const details = {
      code: error.code,
      remedy: error.remedy,
      ...(error.field ? { field: error.field } : {}),
    };
    if (error.status === 404) throw new ApplicationError("not_found", error.message, 404, details);
    if (error.status === 409) throw new ApplicationError("conflict", error.message, 409, details);
    throw new ApplicationError("invalid_input", error.message, 422, details);
  }
  throw error;
}

async function resolveCustomerId(
  orgId: string,
  query: Pick<V1EntitlementsQuery, "customer" | "externalRef">,
): Promise<{ id: string; displayName: string }> {
  if (query.externalRef !== undefined) {
    const ref = query.externalRef.trim();
    const separator = ref.indexOf(":");
    if (separator <= 0 || separator === ref.length - 1) {
      throw invalidInput("externalRef must look like provider:external-id");
    }
    const provider = ref.slice(0, separator);
    const externalId = ref.slice(separator + 1);
    const matches = (await db.execute<{ id: string; displayName: string }>(sql`
      select p.id, p.display_name as "displayName"
        from external_links l
        join parties p on p.org_id = l.org_id and p.id = l.native_id::uuid
       where l.org_id = ${orgId} and l.provider = ${provider}
         and l.object_type = 'customer' and l.external_id = ${externalId}
         and l.native_table = 'parties'`)).rows;
    if (matches.length === 0) {
      throw new ApplicationError(
        "not_found",
        `No customer is linked to external reference ${ref}.`,
        404,
        { remedy: "Link the customer first, or query by customer id or name." },
      );
    }
    if (matches.length > 1) {
      throw new ApplicationError(
        "conflict",
        `External reference ${ref} links ${matches.length} customers.`,
        409,
        { remedy: "Query by the customer id instead." },
      );
    }
    return matches[0]!;
  }
  const raw = query.customer?.trim();
  if (!raw) throw invalidInput("customer is required: pass a customer id, an exact customer name, or externalRef");
  if (isUuid(raw)) {
    const party = (await db.execute<{ id: string; displayName: string }>(sql`
      select id, display_name as "displayName" from parties
       where org_id = ${orgId} and id = ${raw}::uuid`)).rows[0];
    if (!party) {
      throw new ApplicationError(
        "not_found",
        `No customer has id ${raw} in this organization.`,
        404,
        { remedy: "Check the id, or query by the exact customer name." },
      );
    }
    return party;
  }
  const matches = (await db.execute<{ id: string; displayName: string }>(sql`
    select id, display_name as "displayName" from parties
     where org_id = ${orgId} and display_name = ${raw}`)).rows;
  if (matches.length === 0) {
    throw new ApplicationError(
      "not_found",
      `No customer is named ${raw} in this organization.`,
      404,
      { remedy: "Check the spelling, or query by customer id or external reference." },
    );
  }
  if (matches.length > 1) {
    throw new ApplicationError(
      "conflict",
      `${matches.length} customers are named ${raw}.`,
      409,
      { remedy: "Query by the customer id instead." },
    );
  }
  return matches[0]!;
}

export async function getV1Entitlements(
  context: ApplicationContext,
  query: V1EntitlementsQuery,
): Promise<V1EntitlementsResult> {
  assertApplicationPermission(context, "ar.read");
  const orgId = context.authz.user.orgId;
  // Token routes gate apiAccess in the wrapper; entitlements additionally
  // need the advanced-subscriptions surface, refused without existence leak.
  if (!(await isFeatureEnabled(orgId, "advancedSubscriptions"))) throw notFound("record");
  const customer = await withOrgContext(orgId, () => resolveCustomerId(orgId, query));
  if (query.feature === undefined) {
    try {
      const subscriptions = await withOrgContext(orgId, () =>
        resolveEntitlements(orgId, { customerId: customer.id }, query.at));
      return { customer, subscriptions, check: null };
    } catch (error) {
      mapEntitlementError(error, "customer");
    }
  }
  // A usage check can bill overage into rating, so it carries the billing
  // permission rather than riding the read.
  assertApplicationPermission(context, "usage.bill");
  try {
    const subscriptions = await withOrgContext(orgId, () =>
      resolveEntitlements(orgId, { customerId: customer.id }, query.at));
    if (subscriptions.length === 0) {
      throw new ApplicationError(
        "not_found",
        `Customer ${customer.displayName} has no subscriptions.`,
        404,
        { remedy: "Create a subscription for the customer before checking usage." },
      );
    }
    let target = subscriptions[0]!;
    if (query.subscription !== undefined) {
      if (!isUuid(query.subscription)) throw invalidInput("subscription must be a UUID");
      const owned = subscriptions.find((entry) => entry.subscriptionId === query.subscription);
      if (!owned) {
        throw new ApplicationError(
          "not_found",
          `Subscription ${query.subscription} does not belong to customer ${customer.displayName}.`,
          404,
          { remedy: "Pass one of the customer's own subscription ids." },
        );
      }
      target = owned;
    } else if (subscriptions.length > 1) {
      throw new ApplicationError(
        "conflict",
        `Customer ${customer.displayName} holds ${subscriptions.length} subscriptions.`,
        409,
        { remedy: "Pass subscription to check one of them." },
      );
    }
    const check = await withOrgContext(orgId, () =>
      checkEntitlement(orgId, context.authz.user.id, {
        subscriptionId: target.subscriptionId,
        featureKey: query.feature ?? "",
        used: query.used,
        occurredOn: query.at,
      }));
    return { customer, subscriptions, check };
  } catch (error) {
    mapEntitlementError(error, "customer");
  }
}
