/**
 * ERPNext (Frappe) REST client. Auth is an Administrator-scoped API key +
 * secret (`Authorization: token key:secret`), per-tenant from the sealed
 * connection row. Works on any ERPNext v13+ (self-hosted or Frappe Cloud).
 *
 *   list:   GET /api/resource/{doctype}?fields=[...]&filters=[...]&limit_start=N
 *   getDoc: GET /api/resource/{doctype}/{name}   (full doc incl. child tables)
 */

export interface ErpNextCreds {
  url: string; // e.g. http://localhost:8080 or https://mycompany.erpnext.com
  apiKey: string;
  apiSecret: string;
}

/** ERPNext credentials must never cross an HTTP redirect boundary. Even a
 *  trusted tenant origin can otherwise redirect a request — carrying its
 *  `Authorization: token key:secret` header — to a host the operator never
 *  configured, where Frappe would happily accept the Administrator key. */
function erpNextFetch(url: string | URL, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, redirect: "error" });
}

export class ErpNextClient {
  constructor(private creds: ErpNextCreds) {}

  private async req<T>(path: string): Promise<T> {
    const res = await erpNextFetch(`${this.creds.url.replace(/\/$/, "")}${path}`, {
      headers: {
        Authorization: `token ${this.creds.apiKey}:${this.creds.apiSecret}`,
        Accept: "application/json",
      },
    });
    if (!res.ok) {
      throw new Error(`ERPNext HTTP ${res.status} ${path.slice(0, 80)}: ${(await res.text()).slice(0, 300)}`);
    }
    return (await res.json()) as T;
  }

  /** Paginated list of a doctype — returns every matching record. */
  async listAll<T = Record<string, unknown>>(
    doctype: string,
    fields: string[],
    filters: unknown[] = [],
    orderBy = "name asc",
  ): Promise<T[]> {
    const out: T[] = [];
    const page = 200;
    for (let start = 0; ; start += page) {
      const qs = new URLSearchParams({
        fields: JSON.stringify(fields),
        filters: JSON.stringify(filters),
        limit_start: String(start),
        limit_page_length: String(page),
        order_by: orderBy,
      });
      const data = await this.req<{ data: T[] }>(`/api/resource/${encodeURIComponent(doctype)}?${qs}`);
      out.push(...data.data);
      if (data.data.length < page) return out;
    }
  }

  /** One full document including child tables (items, taxes, references…). */
  async getDoc<T = Record<string, unknown>>(doctype: string, name: string): Promise<T> {
    const data = await this.req<{ data: T }>(
      `/api/resource/${encodeURIComponent(doctype)}/${encodeURIComponent(name)}`,
    );
    return data.data;
  }

  /** Cheap probe: whoami. */
  async ping(): Promise<string> {
    const data = await this.req<{ message: string }>("/api/method/frappe.auth.get_logged_user");
    return data.message;
  }
}
