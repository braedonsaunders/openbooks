import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { checkAbn } from "../connectors/abn-lookup.ts";
import { checkHmrcVatId } from "../connectors/hmrc-vat.ts";
import { fetchWithConnectorRetry } from "../connectors/http-retry.ts";
import { guardedFetch } from "../connectors/ssrf-guard.ts";
import { sealJson, unsealJson } from "../platform/secrets.ts";
import type { SqlExecutor } from "../platform/db.ts";
import { CrossBorderTaxError } from "./cross-border-place-of-supply.ts";
import type { TaxIdCredentials } from "./vat-id-validation.ts";

/**
 * Sealed tax-authority connections: the HMRC VAT API OAuth client and the
 * ABN Lookup GUID, one row per organization and authority. Secrets are
 * sealed JSON at rest and are unsealed only inside the transaction that
 * calls the authority; every read surface (status lists, setup screens,
 * audit views) sees connection state, never credential material.
 */

export type TaxAuthority = "hmrc" | "abn";

export const TAX_AUTHORITY_PURPOSE = (authority: TaxAuthority): string => `tax.authority.${authority}`;

const HMRC_TOKEN_URL = "https://api.service.hmrc.gov.uk/oauth/token";

export interface HmrcClientCredentials {
  clientId: string;
  clientSecret: string;
  /** OAuth scope from the HMRC developer hub, e.g. the scope the app was granted. */
  scope: string;
}

export interface AbnCredentials {
  guid: string;
}

export interface AuthorityConnectionStatus {
  authority: TaxAuthority;
  status: "missing" | "ready" | "error" | "expired";
  hasCredentials: boolean;
  tokenExpiresAt: string | null;
  lastError: string | null;
  lastVerifiedAt: string | null;
}

type ConnectionRow = {
  id: string;
  sealed_credentials: string | null;
  status: string;
  token_expires_at: string | null;
  last_error: string | null;
  last_verified_at: string | null;
};

function demandAuthority(authority: string): asserts authority is TaxAuthority {
  if (authority !== "hmrc" && authority !== "abn") {
    throw new CrossBorderTaxError(
      `unknown tax authority "${authority}"; connect "hmrc" for GB numbers or "abn" for Australian numbers`,
    );
  }
}

function demandNonEmpty(value: string | null | undefined, field: string, authority: TaxAuthority): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed) {
    throw new CrossBorderTaxError(
      `enter the ${field} in Tax setup before connecting ${authority === "hmrc" ? "the HMRC VAT API" : "ABN Lookup"}; the connection stays unconfigured`,
    );
  }
  return trimmed;
}

async function readConnection(
  runner: SqlExecutor,
  orgId: string,
  authority: TaxAuthority,
): Promise<ConnectionRow | null> {
  const rows = (
    await runner.execute<ConnectionRow>(sql`
      select id, sealed_credentials, status,
             token_expires_at::text as token_expires_at,
             last_error, last_verified_at::text as last_verified_at
        from tax_authority_connections
       where org_id = ${orgId} and authority = ${authority}
       limit 1`)
  ).rows;
  return rows[0] ?? null;
}

/**
 * Save (or replace) an authority's credentials, sealed at rest. Replacing
 * is the expected path — rotating a GUID or client secret converges on the
 * new value — so the write upserts and the conflict needs no further
 * justification. Saving clears the previous failure; the connection reads
 * `ready` (credentials present, not yet authority-verified) until the first
 * live use verifies or fails it.
 */
export async function saveAuthorityCredentials(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  authority: TaxAuthority,
  credentials: HmrcClientCredentials | AbnCredentials,
): Promise<AuthorityConnectionStatus> {
  demandAuthority(authority);
  const stored =
    authority === "hmrc"
      ? {
          clientId: demandNonEmpty(
            (credentials as HmrcClientCredentials).clientId,
            "HMRC client ID",
            authority,
          ),
          clientSecret: demandNonEmpty(
            (credentials as HmrcClientCredentials).clientSecret,
            "HMRC client secret",
            authority,
          ),
          scope: demandNonEmpty((credentials as HmrcClientCredentials).scope, "HMRC OAuth scope", authority),
          accessToken: null as string | null,
          tokenExpiresAt: null as string | null,
        }
      : { guid: demandNonEmpty((credentials as AbnCredentials).guid, "ABR lookup GUID", authority) };
  const sealed = sealJson(stored, { orgId, purpose: TAX_AUTHORITY_PURPOSE(authority) });
  const rows = (
    await runner.execute<{ id: string }>(sql`
      insert into tax_authority_connections
        (id, org_id, authority, sealed_credentials, status, token_expires_at,
         last_error, last_verified_at, created_by, updated_by)
      values (${randomUUID()}, ${orgId}, ${authority}, ${sealed}, 'ready', null,
              null, null, ${actorId}, ${actorId})
      on conflict (org_id, authority) do update
         set sealed_credentials = excluded.sealed_credentials,
             status = 'ready',
             token_expires_at = null,
             last_error = null,
             last_verified_at = null,
             updated_by = excluded.updated_by,
             updated_at = now()
      returning id`)
  ).rows;
  // Under row-level security an unscoped write silently matches nothing: a
  // saved credential no read can observe was not saved.
  if (rows.length !== 1) {
    throw new CrossBorderTaxError(
      `the ${authority === "hmrc" ? "HMRC VAT API" : "ABN Lookup"} credential was not saved; reload Tax setup and try again`,
    );
  }
  return readAuthorityConnectionStatus(runner, orgId, authority);
}

/** Connection state for setup screens and validation paths: never credential material. */
export async function readAuthorityConnectionStatus(
  runner: SqlExecutor,
  orgId: string,
  authority: TaxAuthority,
): Promise<AuthorityConnectionStatus> {
  demandAuthority(authority);
  const row = await readConnection(runner, orgId, authority);
  if (!row || !row.sealed_credentials) {
    return {
      authority,
      status: "missing",
      hasCredentials: false,
      tokenExpiresAt: null,
      lastError: null,
      lastVerifiedAt: null,
    };
  }
  const status = row.status as AuthorityConnectionStatus["status"];
  return {
    authority,
    status: status === "ready" || status === "error" || status === "expired" ? status : "ready",
    hasCredentials: true,
    tokenExpiresAt: row.token_expires_at,
    lastError: row.last_error,
    lastVerifiedAt: row.last_verified_at,
  };
}

/** Unseal one authority's credentials for the calling transaction. */
export function unsealAuthorityCredentials<T extends HmrcClientCredentials | AbnCredentials>(
  stored: string,
  orgId: string,
  authority: TaxAuthority,
): T {
  return unsealJson<T>(stored, { orgId, purpose: TAX_AUTHORITY_PURPOSE(authority) });
}

async function markConnection(
  runner: SqlExecutor,
  orgId: string,
  authority: TaxAuthority,
  status: AuthorityConnectionStatus["status"],
  error: string | null,
  verified: boolean,
): Promise<void> {
  const updated = (
    await runner.execute<{ id: string }>(sql`
      update tax_authority_connections
         set status = ${status},
             last_error = ${error},
             last_verified_at = ${verified ? sql`now()` : sql`last_verified_at`},
             updated_at = now()
       where org_id = ${orgId} and authority = ${authority}
      returning id`)
  ).rows;
  if (updated.length !== 1) {
    throw new CrossBorderTaxError(
      `the ${authority === "hmrc" ? "HMRC VAT API" : "ABN Lookup"} connection is gone; reconnect it in Tax setup before validating`,
    );
  }
}

/**
 * Exchange HMRC OAuth client credentials for an access token (OAuth2 client
 * credentials grant against the HMRC token endpoint). The transport is
 * injectable so tests prove the exchange without touching HMRC.
 */
export async function fetchHmrcAccessToken(
  credentials: HmrcClientCredentials,
  transport: typeof fetch = guardedFetch,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    scope: credentials.scope,
  });
  let res: Response;
  try {
    res = await fetchWithConnectorRetry(
      HMRC_TOKEN_URL,
      {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", Accept: "application/json" },
        body: body.toString(),
        redirect: "error",
      },
      { describe: "HMRC OAuth", transport },
    );
  } catch (error) {
    throw new CrossBorderTaxError(`HMRC OAuth is unreachable: refresh the HMRC token in Tax setup later`, {
      cause: error,
    });
  }
  if (!res.ok) {
    throw new CrossBorderTaxError(
      `HMRC refused the OAuth exchange (HTTP ${res.status}); check the client ID, secret and scope in Tax setup, then refresh the token`,
    );
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = (await res.json()) as Record<string, unknown>;
  } catch (error) {
    throw new CrossBorderTaxError(`HMRC answered the OAuth exchange with an unreadable body; refresh the token in Tax setup later`, {
      cause: error,
    });
  }
  const accessToken = typeof parsed.access_token === "string" ? parsed.access_token : "";
  const expiresIn = Number(parsed.expires_in ?? 0);
  if (!accessToken || !Number.isFinite(expiresIn) || expiresIn <= 0) {
    throw new CrossBorderTaxError(
      `HMRC answered the OAuth exchange without a usable token; check the client ID, secret and scope in Tax setup, then refresh the token`,
    );
  }
  return { accessToken, expiresInSeconds: Math.floor(expiresIn) };
}

/**
 * Refresh and store the HMRC access token from the sealed client
 * credentials. Marks the connection ready with the token expiry, or error
 * with the failure — the setup screen and the validation path read that
 * state instead of discovering a dead token at validation time.
 */
export async function refreshHmrcToken(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  transport?: typeof fetch,
): Promise<AuthorityConnectionStatus> {
  const row = await readConnection(runner, orgId, "hmrc");
  if (!row?.sealed_credentials) {
    throw new CrossBorderTaxError(
      "connect the HMRC VAT API credentials in Tax setup before refreshing the token; the number stays unverified",
    );
  }
  let stored: HmrcClientCredentials;
  try {
    stored = unsealAuthorityCredentials<HmrcClientCredentials>(row.sealed_credentials, orgId, "hmrc");
  } catch (error) {
    await markConnection(runner, orgId, "hmrc", "error", error instanceof Error ? error.message : String(error), false);
    throw error;
  }
  let token: { accessToken: string; expiresInSeconds: number };
  try {
    token = await fetchHmrcAccessToken(stored, transport);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await markConnection(runner, orgId, "hmrc", "error", message, false);
    throw error;
  }
  const expiresAt = new Date(Date.now() + token.expiresInSeconds * 1000).toISOString();
  const resealed = sealJson({ ...stored, accessToken: token.accessToken, tokenExpiresAt: expiresAt }, {
    orgId,
    purpose: TAX_AUTHORITY_PURPOSE("hmrc"),
  });
  const updated = (
    await runner.execute<{ id: string }>(sql`
      update tax_authority_connections
         set sealed_credentials = ${resealed},
             status = 'ready',
             token_expires_at = ${expiresAt}::timestamptz,
             last_error = null,
             last_verified_at = now(),
             updated_by = ${actorId},
             updated_at = now()
       where org_id = ${orgId} and authority = 'hmrc'
      returning id`)
  ).rows;
  if (updated.length !== 1) {
    throw new CrossBorderTaxError("the HMRC token was fetched but not stored; refresh the token in Tax setup again");
  }
  return readAuthorityConnectionStatus(runner, orgId, "hmrc");
}

/**
 * Live-verify a connection without validating a customer number: HMRC
 * performs a token exchange, ABN Lookup confirms the GUID is accepted by
 * checking the configured format handshake. Records the outcome on the row.
 */
export async function verifyAuthorityConnection(
  runner: SqlExecutor,
  orgId: string,
  actorId: string | null,
  authority: TaxAuthority,
  transport?: typeof fetch,
): Promise<AuthorityConnectionStatus> {
  demandAuthority(authority);
  if (authority === "hmrc") return refreshHmrcToken(runner, orgId, actorId, transport);
  const row = await readConnection(runner, orgId, "abn");
  if (!row?.sealed_credentials) {
    throw new CrossBorderTaxError(
      "enter the ABR lookup GUID in Tax setup before verifying the connection; the number stays unverified",
    );
  }
  try {
    const stored = unsealAuthorityCredentials<AbnCredentials>(row.sealed_credentials, orgId, "abn");
    demandNonEmpty(stored.guid, "ABR lookup GUID", "abn");
    await markConnection(runner, orgId, "abn", "ready", null, true);
  } catch (error) {
    await markConnection(
      runner,
      orgId,
      "abn",
      "error",
      error instanceof Error ? error.message : String(error),
      false,
    );
    throw error;
  }
  return readAuthorityConnectionStatus(runner, orgId, "abn");
}

/**
 * Stored credentials for the tax-ID validation path: the ABN GUID and the
 * unexpired HMRC access token. An expired or missing token contributes
 * nothing — the authority client refuses by name with the Tax-setup remedy
 * instead of validating against a dead token.
 */
export async function authorityCredentialsForOrg(
  runner: SqlExecutor,
  orgId: string,
): Promise<TaxIdCredentials> {
  const credentials: TaxIdCredentials = {};
  const abn = await readConnection(runner, orgId, "abn");
  if (abn?.sealed_credentials) {
    try {
      const stored = unsealAuthorityCredentials<AbnCredentials>(abn.sealed_credentials, orgId, "abn");
      if (stored.guid?.trim()) credentials.abnGuid = stored.guid.trim();
    } catch {
      // A corrupt sealed blob must not flip verdicts: the authority client
      // refuses without a GUID and the connection row already says error.
    }
  }
  const hmrc = await readConnection(runner, orgId, "hmrc");
  if (hmrc?.sealed_credentials) {
    try {
      const stored = unsealAuthorityCredentials<HmrcClientCredentials>(hmrc.sealed_credentials, orgId, "hmrc");
      const expiry = hmrc.token_expires_at ? Date.parse(hmrc.token_expires_at) : NaN;
      if (stored.accessToken && Number.isFinite(expiry) && expiry > Date.now()) {
        credentials.hmrcAccessToken = stored.accessToken;
      }
    } catch {
      // Same doctrine as above: no token, no validation, named refusal.
    }
  }
  return credentials;
}

/** Convenience wrappers proving the sealed round-trip without network. */
export async function checkHmrcWithStoredCredentials(
  runner: SqlExecutor,
  orgId: string,
  value: string,
  transport?: typeof fetch,
): Promise<Awaited<ReturnType<typeof checkHmrcVatId>>> {
  const credentials = await authorityCredentialsForOrg(runner, orgId);
  return checkHmrcVatId({ value, accessToken: credentials.hmrcAccessToken }, transport);
}

export async function checkAbnWithStoredCredentials(
  runner: SqlExecutor,
  orgId: string,
  value: string,
  transport?: typeof fetch,
): Promise<Awaited<ReturnType<typeof checkAbn>>> {
  const credentials = await authorityCredentialsForOrg(runner, orgId);
  return checkAbn({ value, guid: credentials.abnGuid }, transport);
}
