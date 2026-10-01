/** Organization-scoped employee sales operations and assignment previews. */
export {
  SalesError,
  previewTerritory,
  salesScopeWhere,
  writeSalesCommand,
} from "./sales.ts";
export type { TerritoryPreview } from "./sales.ts";

export { routeSalesAccount } from "./sales-routing.ts";
export { salesSchemaReady, requireSalesSchema } from "./sales-readiness.ts";
