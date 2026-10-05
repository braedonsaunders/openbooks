import { fetchWithConnectorRetry } from "./http-retry.ts";
import { guardedFetch } from "./ssrf-guard.ts";

/**
 * Zuora client (https://www.zuora.com/developer/api-reference).
 *
 * Auth is OAuth client-credentials: one token call mints a Bearer token that
 * every later call carries, and every credential-bearing request refuses
 * redirects instead of following them. Small pulls page through REST
 * (`nextPage`); bulk history runs a Data Query (AQuA) job and polls it to
 * completion. Money is major-unit decimal text with an explicit currency.
 */

export interface ZuoraSite {
  clientId: string;
  clientSecret: string;
  /** `production` or `sandbox` — selects the REST host, never a pasted URL. */
  environment: "production" | "sandbox";
}

export type ConnectorTransport = typeof fetch;

function restBase(environment: ZuoraSite["environment"]): string {
  return environment === "production"
    ? "https://rest.zuora.com"
    : "https://rest.sandbox.eu.zuora.com";
}

async function mintToken(site: ZuoraSite, transport: ConnectorTransport): Promise<string> {
  const res = await fetchWithConnectorRetry(`${restBase(site.environment)}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: site.clientId,
      client_secret: site.clientSecret,
    }),
    redirect: "error",
  }, { describe: "Zuora", transport });
  if (!res.ok) {
    throw new Error(`Zuora token request refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const payload = (await res.json()) as { access_token?: string };
  if (!payload.access_token) {
    throw new Error("Zuora token request answered without an access token — check the client ID and secret, then try again.");
  }
  return payload.access_token;
}

async function zuoraGet(
  token: string,
  environment: ZuoraSite["environment"],
  path: string,
  params: Record<string, string>,
  transport: ConnectorTransport,
): Promise<Record<string, unknown>> {
  const query = new URLSearchParams(params);
  const suffix = query.toString();
  const res = await fetchWithConnectorRetry(`${restBase(environment)}${path}${suffix ? `?${suffix}` : ""}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    redirect: "error",
  }, { describe: "Zuora", transport });
  if (!res.ok) {
    throw new Error(`Zuora ${path} refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return (await res.json()) as Record<string, unknown>;
}

/** Pull every REST page of a Zuora object collection (accounts, subscriptions, amendments, invoices, payments, usages). */
export async function listAllZuora(
  site: ZuoraSite,
  path: string,
  params: Record<string, string> = {},
  transport: ConnectorTransport = guardedFetch,
  maxPages = 500,
): Promise<Array<Record<string, unknown>>> {
  const token = await mintToken(site, transport);
  const out: Array<Record<string, unknown>> = [];
  let page: string | undefined;
  for (let count = 0; count < maxPages; count++) {
    const payload = await zuoraGet(token, site.environment, path, page ? { ...params, cursor: page } : params, transport);
    if (payload.success === false) {
      throw new Error(`Zuora ${path} refused: ${JSON.stringify(payload).slice(0, 300)}`);
    }
    const records = Array.isArray(payload[path.split("/").pop() ?? ""]) ? payload[path.split("/").pop() ?? ""] as Array<Record<string, unknown>>
      : Array.isArray(payload.records) ? payload.records as Array<Record<string, unknown>>
      : [];
    out.push(...records);
    const next = typeof payload.nextPage === "string" ? payload.nextPage as string : null;
    if (!next) return out;
    page = next;
  }
  throw new Error(`Zuora ${path} exceeded ${maxPages} pages — run a Data Query job for this volume instead.`);
}

export interface ZuoraQueryJob {
  id: string;
  queryString: string;
}

/** Submit a Data Query (AQuA) job for bulk history objects the REST lists cannot carry. */
export async function submitZuoraQuery(
  site: ZuoraSite,
  queryString: string,
  transport: ConnectorTransport = guardedFetch,
): Promise<ZuoraQueryJob> {
  const token = await mintToken(site, transport);
  const res = await fetchWithConnectorRetry(`${restBase(site.environment)}/v1/batch-query/jobs`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ queryString, output: { target: "S3" }, outputFormat: "JSON" }),
    redirect: "error",
  }, { describe: "Zuora", transport });
  if (!res.ok) {
    throw new Error(`Zuora Data Query submit refused HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const payload = (await res.json()) as { success?: boolean; id?: string; reasons?: unknown };
  if (payload.success === false || !payload.id) {
    throw new Error(`Zuora Data Query submit refused: ${JSON.stringify(payload).slice(0, 300)}`);
  }
  return { id: payload.id, queryString };
}

/** Poll a Data Query job until it completes, then return its result file URLs. */
export async function pollZuoraQuery(
  site: ZuoraSite,
  jobId: string,
  transport: ConnectorTransport = guardedFetch,
  maxAttempts = 60,
): Promise<string[]> {
  const token = await mintToken(site, transport);
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const payload = await zuoraGet(token, site.environment, `/v1/batch-query/jobs/${encodeURIComponent(jobId)}`, {}, transport);
    const status = typeof payload.status === "string" ? payload.status : "";
    if (status === "completed") {
      const batches = Array.isArray(payload.batches) ? payload.batches as Array<{ fileId?: string }> : [];
      const files = batches.map((batch) => batch.fileId).filter((file): file is string => typeof file === "string");
      if (!files.length) throw new Error(`Zuora Data Query job ${jobId} completed with no result files.`);
      return files.map((file) => `${restBase(site.environment)}/v1/batch-query/file/${encodeURIComponent(file)}`);
    }
    if (status === "failed" || status === "cancelled") {
      throw new Error(`Zuora Data Query job ${jobId} ended ${status} — narrow the query and submit again.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5000));
  }
  throw new Error(`Zuora Data Query job ${jobId} did not complete in time — poll it again from the import run.`);
}
