/**
 * Shared VAT/TIN authority validation: number normalization per scheme, the
 * service-failure error, and the bounded authority excerpt stored as evidence.
 *
 * A failed authority call is never a verdict — clients throw
 * VatValidationError and the caller keeps the previous status as unverified
 * for the operator to decide. Only an explicit valid/invalid answer from the
 * authority changes a verdict.
 */

export type VatAuthorityScheme = "vies" | "hmrc" | "abn" | "gst";

export class VatValidationError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "VatValidationError";
  }
}

export interface VatAuthorityVerdict {
  valid: boolean;
  consultationNumber: string | null;
  traderName: string | null;
  traderAddress: string | null;
}

export interface AuthorityExcerpt {
  valid: boolean;
  consultationNumber: string | null;
  traderName: string | null;
  traderAddress: string | null;
}

/**
 * Normalize a customer-supplied tax ID to the canonical form its authority
 * expects. Malformed input is refused with the expected shape — the operator
 * corrects the number; nothing here guesses what was meant.
 */
export function normalizeVatId(scheme: VatAuthorityScheme, raw: string): string {
  const compact = raw.replace(/[\s.\-_/]/g, "").toUpperCase();
  if (scheme === "vies") {
    if (!/^[A-Z]{2}[A-Z0-9]{2,12}$/.test(compact)) {
      throw new VatValidationError(
        `VIES numbers start with the two-letter country code followed by the national number (for example DE123456789); correct "${raw}" on the customer record before validating`,
      );
    }
    return compact;
  }
  if (scheme === "hmrc") {
    const vrn = compact.startsWith("GB") ? compact : `GB${compact}`;
    if (!/^GB\d{9}(\d{3})?$/.test(vrn)) {
      throw new VatValidationError(
        `HMRC numbers are GB followed by 9 digits (optionally a 3-digit branch); correct "${raw}" on the customer record before validating`,
      );
    }
    return vrn;
  }
  if (scheme === "abn") {
    if (!/^\d{11}$/.test(compact)) {
      throw new VatValidationError(
        `Australian Business Numbers are 11 digits; correct "${raw}" on the customer record before validating`,
      );
    }
    return compact;
  }
  if (!compact || compact.length > 20) {
    throw new VatValidationError(
      `provide the GST registration number before validating; correct the number on the customer record`,
    );
  }
  return compact;
}

/**
 * Bound the stored authority excerpt: the verdict, the authority's
 * consultation reference, and truncated trader detail. Full responses stay
 * with the authority; sandboxes additionally null this column.
 */
export function boundAuthorityExcerpt(verdict: VatAuthorityVerdict): AuthorityExcerpt {
  return {
    valid: verdict.valid,
    consultationNumber: verdict.consultationNumber?.slice(0, 40) ?? null,
    traderName: verdict.traderName?.slice(0, 120) ?? null,
    traderAddress: verdict.traderAddress?.slice(0, 200) ?? null,
  };
}
