/**
 * Australian Business Register — ABN Lookup client.
 *
 * Endpoint (stable):
 *   details: https://abr.business.gov.au/json/AbnDetails.aspx?abn={11 digits}&guid={guid}
 *            answers JSONP `callback({...})` with AbnStatus Active/Cancelled.
 *
 * The caller supplies the ABR GUID (sealed on the tax authority connection;
 * never stored here). Only an explicit Active status for the requested ABN is
 * valid; every other status is invalid, and every transport, HTTP or parse
 * failure throws VatValidationError so the caller keeps the ID unverified.
 */

import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";
import {
  normalizeVatId,
  VatValidationError,
  type VatAuthorityVerdict,
} from "./vat-validation.ts";

const DETAILS_URL = "https://abr.business.gov.au/json/AbnDetails.aspx";

export interface AbnCheckRequest {
  value: string;
  guid?: string | null;
}

function abnFetch(url: string | URL, init: RequestInit = {}, transport: typeof fetch = guardedFetch): Promise<Response> {
  return fetchWithConnectorRetry(url, { ...init, redirect: "error" }, { describe: "ABN Lookup", transport });
}

function parseJsonp(body: string, abn: string): Record<string, unknown> {
  const trimmed = body.trim().replace(/^[^({]*\(/, "").replace(/\);?\s*$/, "");
  try {
    const parsed = JSON.parse(trimmed) as Record<string, unknown>;
    if (parsed && typeof parsed === "object") return parsed;
  } catch (error) {
    throw new VatValidationError(`ABR answered an unreadable body for ${abn}: retry validation later`, {
      cause: error,
    });
  }
  throw new VatValidationError(`ABR answered an unreadable body for ${abn}: retry validation later`);
}

/** Ask the ABR whether the ABN is currently Active. Throws on any service failure. */
export async function checkAbn(
  request: AbnCheckRequest,
  transport: typeof fetch = guardedFetch,
): Promise<VatAuthorityVerdict> {
  const abn = normalizeVatId("abn", request.value);
  if (!request.guid) {
    throw new VatValidationError(
      "enter the ABR lookup GUID in Tax setup before validating Australian numbers; the number stays unverified",
    );
  }
  const url = new URL(DETAILS_URL);
  url.searchParams.set("abn", abn);
  url.searchParams.set("guid", request.guid);
  url.searchParams.set("callback", "callback");
  let res: Response;
  try {
    res = await abnFetch(url, { headers: { Accept: "application/javascript" } }, transport);
  } catch (error) {
    throw new VatValidationError(`ABR is unreachable for ${abn}: retry validation later`, { cause: error });
  }
  if (!res.ok) {
    throw new VatValidationError(`ABR answered HTTP ${res.status} for ${abn}: retry validation later`);
  }
  const body = parseJsonp(await res.text(), abn);
  const answered = typeof body.Abn === "string" ? body.Abn.replace(/\s/g, "") : "";
  if (answered !== abn) {
    throw new VatValidationError(`ABR answered for a different ABN than ${abn}: retry validation later`);
  }
  return {
    valid: body.AbnStatus === "Active",
    consultationNumber: null,
    traderName: typeof body.EntityTypeName === "string" && body.EntityTypeName ? body.EntityTypeName : null,
    traderAddress: null,
  };
}
