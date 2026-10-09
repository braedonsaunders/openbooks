// Portions derived from OpenConstructionERP (https://github.com/datadrivenconstruction/OpenConstructionERP),
// Copyright (C) 2026 Artem Boiko / DataDrivenConstruction, licensed under AGPL-3.0-or-later.
import { isValidBic, isValidIban } from "../payments-core/rail-settings.ts";

// Known country lengths from the SWIFT ISO 13616 registry. An unlisted country
// still receives the native shape/check-digit validation as registries expand.
// https://www.swift.com/sites/default/files/files/SWIFT_IBAN_Registry.pdf
const IBAN_LENGTHS: Readonly<Record<string, number>> = {
  AD: 24, AE: 23, AL: 28, AT: 20, AZ: 28, BA: 20, BE: 16, BG: 22,
  BH: 22, BR: 29, BY: 28, CH: 21, CR: 22, CY: 28, CZ: 24, DE: 22,
  DK: 18, DO: 28, EE: 20, EG: 29, ES: 24, FI: 18, FO: 18, FR: 27,
  GB: 22, GE: 22, GI: 23, GL: 18, GR: 27, GT: 28, HR: 21, HU: 28,
  IE: 22, IL: 23, IQ: 23, IS: 26, IT: 27, JO: 30, KW: 30, KZ: 20,
  LB: 28, LC: 32, LI: 21, LT: 20, LU: 20, LV: 21, LY: 25, MC: 27,
  MD: 24, ME: 22, MK: 19, MR: 27, MT: 31, MU: 30, NL: 18, NO: 15,
  PK: 24, PL: 28, PS: 29, PT: 25, QA: 29, RO: 24, RS: 22, SA: 24,
  SC: 31, SD: 18, SE: 24, SI: 19, SK: 24, SM: 27, ST: 25, SV: 28,
  TL: 23, TN: 24, TR: 26, UA: 29, VA: 22, VG: 24, XK: 20,
};

export function validPaymentIban(value: string): boolean {
  const account = compactPaymentIdentifier(value);
  const length = IBAN_LENGTHS[account.slice(0, 2)];
  return isValidIban(account) && (length === undefined || account.length === length);
}

/** BT-84 and BT-86 also admit domestic identifiers outside IBAN/BIC rails. */
export function compactPaymentIdentifier(value: string): string {
  return value.replace(/[\s-]/g, "").toUpperCase();
}

export function paymentAccountRefusal(value: string, meansCode?: string): string | null {
  const account = compactPaymentIdentifier(value);
  if (/^[A-Z]{2}\d{2}/.test(account) || meansCode === "58" || meansCode === "59") {
    if (!validPaymentIban(account)) return "Enter a valid IBAN with matching check digits for this payment account.";
  } else if (!/^[A-Z0-9]{4,34}$/.test(account)) {
    return "Enter a payment account identifier containing 4 to 34 letters or digits; spaces and hyphens are accepted.";
  }
  return null;
}

export function paymentProviderRefusal(value: string): string | null {
  const provider = compactPaymentIdentifier(value);
  if (isValidBic(provider)) return null;
  return /^[A-Z0-9]{4,35}$/.test(provider) ? null : "Enter a valid BIC or domestic payment provider identifier containing 4 to 35 letters or digits.";
}
