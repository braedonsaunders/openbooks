/**
 * EU VAT Information Exchange System (VIES) client — the REST check API.
 *
 * Endpoint (stable):
 *   check : https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number
 *           POST { countryCode, vatNumber } → { valid, consultationNumber?, name?, address? }
 *
 * No credentials: the API is public. Only an explicit boolean `valid` in a
 * 200 answer is a verdict; every other shape and every transport or HTTP
 * failure throws VatValidationError so the caller keeps the ID unverified.
 */

import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";
import {
  normalizeVatId,
  VatValidationError,
  type VatAuthorityVerdict,
} from "./vat-validation.ts";

const CHECK_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api/check-vat-number";

export interface ViesCheckRequest {
  /** Full normalized or raw VIES number, e.g. DE123456789. */
  value: string;
}

function viesFetch(url: string | URL, init: RequestInit = {}, transport: typeof fetch = guardedFetch): Promise<Response> {
  // Deadline plus bounded retry (429 honoring Retry-After, 5xx, network)
  // through the shared connector helper, with a named refusal after
  // exhaustion. redirect: "error" stays on every attempt and redirect
  // refusals are never retried — still exactly one request per call.
  return fetchWithConnectorRetry(url, { ...init, redirect: "error" }, { describe: "VIES", transport });
}

/** Ask VIES whether the number is currently valid. Throws on any service failure. */
export async function checkViesVatId(
  request: ViesCheckRequest,
  transport: typeof fetch = guardedFetch,
): Promise<VatAuthorityVerdict> {
  const value = normalizeVatId("vies", request.value);
  let res: Response;
  try {
    res = await viesFetch(
      CHECK_URL,
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ countryCode: value.slice(0, 2), vatNumber: value.slice(2) }),
      },
      transport,
    );
  } catch (error) {
    throw new VatValidationError(`VIES is unreachable for ${value}: retry validation later`, { cause: error });
  }
  if (!res.ok) {
    throw new VatValidationError(
      `VIES answered HTTP ${res.status} for ${value}: retry validation later`,
    );
  }
  let body: Record<string, unknown>;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    throw new VatValidationError(`VIES answered an unreadable body for ${value}: retry validation later`, {
      cause: error,
    });
  }
  if (typeof body.valid !== "boolean") {
    throw new VatValidationError(
      `VIES answered without a validity verdict for ${value}: retry validation later`,
    );
  }
  const consultation =
    typeof body.consultationNumber === "string" && body.consultationNumber
      ? body.consultationNumber
      : typeof body.requestIdentifier === "string" && body.requestIdentifier
        ? body.requestIdentifier
        : null;
  return {
    valid: body.valid,
    consultationNumber: consultation,
    traderName: typeof body.name === "string" && body.name ? body.name : null,
    traderAddress: typeof body.address === "string" && body.address ? body.address : null,
  };
}
