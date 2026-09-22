/**
 * Canonical account-type universes — re-exported from the engine so posting
 * paths, consolidation and statements share one definition (F-u1-001 / P2).
 * Importing from here keeps existing import sites working; the source of
 * truth is `@openbooks/engine/src/records/account-types.ts`.
 */
export {
  ACCOUNT_CLASS_TYPES,
  ASSET_TYPES,
  EQUITY_TYPES,
  LIABILITY_TYPES,
  PNL_COST_TYPES,
  PNL_TYPES,
  accountClassTypes,
  type AccountClassKey,
} from "@openbooks/engine/src/records/account-types.ts";
