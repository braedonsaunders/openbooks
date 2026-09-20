/**
 * The GB pack's filing declaration: the filing-account program types and the
 * year-end filings.
 *
 * The employer enrols for PAYE with HMRC and receives an employer PAYE
 * reference and an Accounts Office reference; every Full Payment Submission
 * and Employer Payment Summary rides those references, so the program type is
 * declared here. Year-end filings (P60, P11D, the final FPS/EPS of the year)
 * are NOT declared yet: a filing declaration without its population behind it
 * would list returns the product cannot produce. An empty `yearEnd` says
 * "none transcribed", which the year-end enumeration reports by name.
 */

import type { PayrollPackFilings } from "../filing-registry.ts";

/** Lazy, like caPackFilings/usPackFilings: the filings modules sit in an
 * import cycle with the year-end builders, so the declaration must not be
 * dereferenced at module-evaluation time. */
let cached: PayrollPackFilings | null = null;

export function gbPackFilings(): PayrollPackFilings {
  cached ??= {
    country: "GB",
    programTypes: [
      {
        key: "gb_paye",
        label: "Employer PAYE reference",
      },
    ],
    yearEnd: [],
  };
  return cached;
}
