/**
 * HMRC VAT API v2 client — the check-vat-number lookup.
 *
 * Endpoint (stable):
 *   lookup: https://api.service.hmrc.gov.uk/organisations/vat/check-vat-number/lookup/{vrn}
 *
 * The caller supplies a Hello-API OAuth access token (sealed on the tax
 * authority connection; never stored here). 200 with a target is valid; 404
 * NOT_FOUND is an invalid number, not an outage. Everything else throws
 * VatValidationError so the caller keeps the ID unverified.
 */

import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";
import {
  normalizeVatId,
  VatValidationError,
  type VatAuthorityVerdict,
} from "./vat-validation.ts";

const LOOKUP_BASE = "https://api.service.hmrc.gov.uk/organisations/vat/check-vat-number/lookup";

export interface HmrcCheckRequest {
  /** Full or bare VRN; the GB prefix is added when missing. */
  value: string;
  accessToken?: string | null;
}

function hmrcFetch(url: string | URL, init: RequestInit = {}, transport: typeof fetch = guardedFetch): Promise<Response> {
  return fetchWithConnectorRetry(url, { ...init, redirect: "error" }, { describe: "HMRC VAT", transport });
}

/** Ask HMRC whether the VRN is currently known. Throws on any service failure. */
export async function checkHmrcVatId(
  request: HmrcCheckRequest,
  transport: typeof fetch = guardedFetch,
): Promise<VatAuthorityVerdict> {
  const value = normalizeVatId("hmrc", request.value);
  if (!request.accessToken) {
    throw new VatValidationError(
      "connect the HMRC VAT API credentials in Tax setup before validating GB numbers; the number stays unverified",
    );
  }
  let res: Response;
  try {
    res = await hmrcFetch(
      `${LOOKUP_BASE}/${value.slice(2)}`,
      { headers: { Authorization: `Bearer ${request.accessToken}`, Accept: "application/vnd.hmrc.2.0+json" } },
      transport,
    );
  } catch (error) {
    throw new VatValidationError(`HMRC is unreachable for ${value}: retry validation later`, { cause: error });
  }
  if (res.status === 404) return { valid: false, consultationNumber: null, traderName: null, traderAddress: null };
  if (!res.ok) {
    throw new VatValidationError(`HMRC answered HTTP ${res.status} for ${value}: retry validation later`);
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    throw new VatValidationError(`HMRC answered an unreadable body for ${value}: retry validation later`, {
      cause: error,
    });
  }
  const target = body.target as Record<string, unknown> | undefined;
  const address = target?.address as Record<string, unknown> | undefined;
  const addressLines = ["line1", "line2", "line3", "line4", "postcode", "countryCode"]
    .map((key) => (typeof address?.[key] === "string" ? (address[key] as string) : ""))
    .filter(Boolean)
    .join(", ");
  return {
    valid: true,
    consultationNumber:
      typeof body.consultationNumber === "string" && body.consultationNumber ? body.consultationNumber : null,
    traderName: typeof target?.name === "string" && target.name ? target.name : null,
    traderAddress: addressLines || null,
  };
}
