/**
 * ISO 4217 currency codes for currency pickers that can't easily thread the
 * org's `currencies` table (e.g. client-only drawers). Server surfaces that
 * already load `select code, name from currencies` should pass those instead —
 * this is the client-safe fallback so a currency field is NEVER free text.
 */
import { SUPPORTED_CURRENCIES } from "@openbooks/engine/src/currencies.ts";

export interface IsoCurrency {
  code: string;
  name: string;
}

export const ISO_CURRENCIES: IsoCurrency[] = SUPPORTED_CURRENCIES.map(
  ({ code, name }) => ({ code, name }),
);
