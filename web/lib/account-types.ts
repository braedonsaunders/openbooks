/**
 * Canonical account-type universes — re-exported from the engine so posting
 * paths, consolidation and statements share one definition.
 * Importing from here keeps existing import sites working; the source of
 * truth is `@openbooks/engine/records/account-types`.
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
} from "@openbooks/engine/records/account-types";
