import type { ErpNextConfig } from "./types.ts";

type FrappeEnvelope<T> = { data?: T; message?: T; exc?: string; exception?: string };

export class ErpNextParityClient {
  constructor(private readonly config: ErpNextConfig) {}

  private async request<T>(
    path: string,
    init: RequestInit = {},
    query?: Record<string, string>,
  ): Promise<T> {
    const url = new URL(path, this.config.url.replace(/\/?$/, "/"));
    for (const [key, value] of Object.entries(query ?? {})) url.searchParams.set(key, value);
    const response = await fetch(url, {
      ...init,
      headers: {
        Accept: "application/json",
        Authorization: `token ${this.config.apiKey}:${this.config.apiSecret}`,
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
    const text = await response.text();
    let body: FrappeEnvelope<T>;
    try {
      body = JSON.parse(text) as FrappeEnvelope<T>;
    } catch {
      throw new Error(`ERPNext ${response.status} ${path}: ${text.slice(0, 500)}`);
    }
    if (!response.ok || body.exception || body.exc) {
      throw new Error(
        `ERPNext ${response.status} ${path}: ${body.exception ?? body.exc ?? text}`.slice(0, 2_000),
      );
    }
    return (body.data ?? body.message) as T;
  }

  get<T>(doctype: string, name: string): Promise<T> {
    return this.request<T>(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    );
  }

  list<T>(
    doctype: string,
    fields: string[],
    filters: unknown[] = [],
    orderBy = "name asc",
    limit = 500,
  ): Promise<T[]> {
    return this.request<T[]>(`/api/resource/${encodeURIComponent(doctype)}`, {}, {
      fields: JSON.stringify(fields),
      filters: JSON.stringify(filters),
      order_by: orderBy,
      limit_page_length: String(limit),
    });
  }

  create<T extends Record<string, unknown> = Record<string, unknown>>(
    doctype: string,
    doc: Record<string, unknown>,
  ): Promise<T & { name: string }> {
    return this.request<T & { name: string }>(
      `/api/resource/${encodeURIComponent(doctype)}`,
      { method: "POST", body: JSON.stringify({ doctype, ...doc }) },
    );
  }

  update<T extends Record<string, unknown>>(
    doctype: string,
    name: string,
    patch: T,
  ): Promise<T & { name: string }> {
    return this.request<T & { name: string }>(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
      { method: "PUT", body: JSON.stringify(patch) },
    );
  }

  call<T>(method: string, args: Record<string, unknown>): Promise<T> {
    return this.request<T>(
      `/api/method/${method}`,
      { method: "POST", body: JSON.stringify(args) },
    );
  }

  async submit<T extends Record<string, unknown>>(doctype: string, name: string): Promise<T> {
    const doc = await this.get<T>(doctype, name);
    return this.call<T>("frappe.client.submit", { doc });
  }

  async cancel<T extends Record<string, unknown>>(doctype: string, name: string): Promise<T> {
    return this.call<T>("frappe.client.cancel", { doctype, name });
  }
}
