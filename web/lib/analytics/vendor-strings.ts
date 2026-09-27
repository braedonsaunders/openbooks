/**
 * Localizable sentence templates for vendor performance.
 *
 * `vendorStrings(t)` builds the bundle from `getTranslations('analytics')`
 * in the request locale. Tier, grade and
 * quadrant codes never localize — only the month labels and the
 * `coalesce(…, 'Unknown')` party display name do.
 */

import type { CatalogMessageFn } from "./catalog-strings";
import { catalogMonthLabel } from "./catalog-strings";


export interface VendorStrings {
  locale: string;
  monthLabel(ym: string): string;
  /** Map the SQL `coalesce(…, 'Unknown')` sentinel to the request language. */
  displayVendorName(name: string): string;
}

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function vendorStrings(t: CatalogMessageFn, locale: string): VendorStrings {
  return {
    locale,
    monthLabel: catalogMonthLabel(t),
    displayVendorName: (name) => (name === "Unknown" ? t("vendor.labels.unknownVendor") : name),
  };
}
