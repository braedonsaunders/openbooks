/** Stable browser-safe sales identity, command and geographic contracts. */
export * from "./sales-contracts.ts";
export type { TerritoryRule, TerritorySubject } from "./crm-math.ts";
export {
  geographyMatches,
  geometryContains,
  hasGeographicCoverage,
  validateDrawnGeometry,
} from "./territory-geography.ts";
export { isIsoCalendarDate } from "../platform/iso-date.ts";
