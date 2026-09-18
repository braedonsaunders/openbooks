import { CA_OPENING_YTD_FIELDS } from "./canada/opening-ytd.ts";
import { US_OPENING_YTD_FIELDS } from "./us/opening-ytd.ts";
import type { PayrollOpeningYtdField } from "./packs.ts";

/**
 * Country-pack declarations collected without importing the pack registry.
 * `packs.ts` imports both statutory engines, and those engines import the
 * generic opening-balance reader; consulting PAYROLL_COUNTRY_PACKS while that
 * cycle is initializing would hit its temporal dead zone. This neutral
 * registry keeps the generic layer declarative while leaving each pack's
 * fields next to its own statutory code.
 */
export const PACK_OPENING_BALANCE_FIELDS: readonly (
  PayrollOpeningYtdField & { packs: readonly string[] }
)[] = [
  ...CA_OPENING_YTD_FIELDS.map((field) => ({ ...field, packs: ["CA"] as const })),
  ...US_OPENING_YTD_FIELDS.map((field) => ({ ...field, packs: ["US"] as const })),
];
