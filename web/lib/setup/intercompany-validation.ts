import "server-only";
import type { SetupEntityValidationHook } from "./types";

/**
 * The representation is validated against its subject before the storage
 * guard: the parties hold the matching active role, neither already trades
 * with the entity it represents, and each represents only this entity. The
 * hooks run in the server write pipeline; browser descriptors contain
 * only the configuration fields and display metadata.
 */
export const validateRepresentingPartiesWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { representingPartiesRefusal } = await import("@openbooks/engine/intercompany");
  const current = rowId
    ? ((
        await executor.execute<Record<string, unknown>>(
          sql`
        select subsidiary_id, customer_party_id, vendor_party_id, is_active
          from intercompany_representing_parties where org_id = ${orgId} and id = ${rowId}`,
          "objects",
        )
      )[0] ?? null)
    : null;
  return representingPartiesRefusal(executor, orgId, body, current, rowId ?? null);
};

export const validateTransferPricingWrite: SetupEntityValidationHook = async ({
  orgId,
  body,
  rowId,
  executor,
}) => {
  const { sql } = await import("drizzle-orm");
  const { transferPricingPolicySetupRefusal } = await import("@openbooks/engine/intercompany");
  const current = rowId
    ? ((
        await executor.execute<Record<string, unknown>>(
          sql`
        select seller_subsidiary_id, buyer_subsidiary_id, method, price_level_id, markup_percent::text as markup_percent,
               revenue_account_id, cost_account_id, effective_from::text as effective_from, effective_to::text as effective_to
          from intercompany_transfer_pricing_policies where org_id = ${orgId} and id = ${rowId}`,
          "objects",
        )
      )[0] ?? null)
    : null;
  return transferPricingPolicySetupRefusal(executor, orgId, body, current);
};
