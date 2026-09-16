/**
 * Localizable sentence templates for vendor performance.
 *
 * Same pattern as the other analytics bundles: `englishVendorStrings` is the
 * exact legacy English copy (direct callers keep byte-identical output);
 * `vendorStrings(t)` builds the catalog-backed bundle from
 * `getTranslations('analytics')` in the request locale. Tier, grade and
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

/** Exact legacy English sentences (byte-identical to the pre-catalog loader). */
export const englishVendorStrings: VendorStrings = {
  locale: "en",
  monthLabel: (ym) => {
    const [y, m] = ym.split("-").map(Number);
    const d = new Date(Date.UTC(y!, m! - 1, 1));
    return `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(y).slice(2)}`;
  },
  displayVendorName: (name) => name,
};

/** Catalog-backed bundle: every sentence renders in the request locale. */
export function vendorStrings(t: CatalogMessageFn, locale: string): VendorStrings {
  return {
    locale,
    monthLabel: catalogMonthLabel(t),
    displayVendorName: (name) => (name === "Unknown" ? t("vendor.labels.unknownVendor") : name),
  };
}
