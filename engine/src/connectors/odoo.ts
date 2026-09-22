/**
 * Odoo JSON-RPC client (external API). Auth is username + API key (an Odoo
 * API key is accepted anywhere a password is), per-tenant from the sealed
 * connection row — nothing global, nothing in env.
 *
 * Endpoint: POST {url}/jsonrpc with service "common" (authenticate) and
 * "object" (execute_kw). Works identically for Community and Enterprise,
 * self-hosted or odoo.sh/online (any version with the external API, 14+).
 */

import { guardedFetch } from "./ssrf-guard.ts";

export interface OdooCreds {
  url: string; // e.g. https://mycompany.odoo.com (must resolve to public addresses)
  database: string;
  username: string;
  apiKey: string; // API key or password
}

interface JsonRpcResponse<T> {
  jsonrpc: string;
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: { name?: string; message?: string; debug?: string } };
}

/** Odoo credentials must never cross an HTTP redirect boundary. Every JSON-RPC
 *  call carries the tenant database, username, and API key (or password) in its
 *  POST body; following even one 3xx could repost them to a host that was never
 *  configured as the tenant's Odoo origin. */
export class OdooClient {
  private uid: number | null = null;
  private seq = 0;

  /**
   * `transport` defaults to the shared SSRF-guarded fetch: the saved-time
   * URL check goes stale when DNS rebinds, so every request re-resolves the
   * origin, requires public unicast, pins the socket to a checked address,
   * and refuses redirects. Tests inject a recording transport to exercise
   * the protocol against loopback servers the guard would refuse.
   */
  constructor(
    private creds: OdooCreds,
    private transport: typeof fetch = guardedFetch,
  ) {}

  private async rpc<T>(service: string, method: string, args: unknown[]): Promise<T> {
    const res = await this.transport(`${this.creds.url.replace(/\/$/, "")}/jsonrpc`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        method: "call",
        id: ++this.seq,
        params: { service, method, args },
      }),
      redirect: "error",
    });
    // Status only: echoing the raw response body would reflect whatever an
    // untrusted host returns into operator-visible errors. The structured
    // JSON-RPC error below stays — it is the protocol's error channel, not
    // the raw body, and names why the call failed.
    if (!res.ok) throw new Error(`Odoo HTTP ${res.status}`);
    const data = (await res.json()) as JsonRpcResponse<T>;
    if (data.error) {
      const detail = data.error.data?.message ?? data.error.message;
      throw new Error(`Odoo RPC error: ${String(detail).slice(0, 400)}`);
    }
    return data.result as T;
  }

  async authenticate(): Promise<number> {
    if (this.uid) return this.uid;
    const uid = await this.rpc<number | false>("common", "authenticate", [
      this.creds.database,
      this.creds.username,
      this.creds.apiKey,
      {},
    ]);
    if (!uid) throw new Error("Odoo authentication failed — check database, username and API key");
    this.uid = uid;
    return uid;
  }

  async executeKw<T>(model: string, method: string, args: unknown[], kwargs: Record<string, unknown> = {}): Promise<T> {
    const uid = await this.authenticate();
    return this.rpc<T>("object", "execute_kw", [
      this.creds.database,
      uid,
      this.creds.apiKey,
      model,
      method,
      args,
      kwargs,
    ]);
  }

  /** search_read with pagination — returns every matching record. */
  async searchReadAll<T = Record<string, unknown>>(
    model: string,
    domain: unknown[],
    fields: string[],
    order?: string,
  ): Promise<T[]> {
    const out: T[] = [];
    const limit = 500;
    for (let offset = 0; ; offset += limit) {
      const page = await this.executeKw<T[]>(model, "search_read", [domain], {
        fields,
        offset,
        limit,
        ...(order ? { order } : {}),
      });
      out.push(...page);
      if (page.length < limit) return out;
    }
  }
}

/** Odoo many2one comes back as `[id, "display name"] | false`. */
export const m2oId = (v: unknown): string | null =>
  Array.isArray(v) && v.length > 0 ? String(v[0]) : null;
