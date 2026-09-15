/**
 * Shared helpers for the payroll run-to-year-end E2E workflow suite.
 *
 * Seeding rides the SAME product HTTP APIs the UI calls (Setup, payroll
 * settings/profiles/runs, flows, bank accounts), so the suite breaks when a
 * contract changes rather than rotting beside it. Two pieces of test
 * infrastructure cannot go through product APIs because none exist:
 *
 * - the second approver (no user-provisioning API): inserted with the `pg`
 *   driver using the same scrypt password format as engine/src/seed-user.ts.
 *   Fails loudly without OPENBOOKS_DB_URL — never a silent skip.
 * - the approval flow graphs: created through POST /api/admin/flows and
 *   PATCHed with the same trigger→gate shape as seedApprovalFlow.
 *
 * Country-agnostic by construction: no pack, province, or agency literal
 * lives here. Every jurisdiction-specific value (claim codes, regions,
 * account numbers) is passed in by the spec, which reads its expectations
 * back from the API responses it asserts.
 */
import { randomBytes, scryptSync } from "node:crypto";
import type { APIRequestContext, Browser } from "@playwright/test";
import { request } from "@playwright/test";
import { Client } from "pg";

/** Run-unique tag so retries and local re-runs never collide on natural keys. */
export const TAG = `W05-${Date.now().toString(36).toUpperCase().slice(-6)}`;

export function originOf(baseURL: string): string {
  return new URL(baseURL).origin;
}

/** POST/PUT/PATCH/DELETE through the product CSRF gate (Origin required). */
export async function api(
  request: APIRequestContext,
  baseURL: string,
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: unknown,
  headers?: Record<string, string>,
): Promise<{ status: number; json: unknown }> {
  const response = await request.fetch(`${originOf(baseURL)}${path}`, {
    method,
    headers: { "Content-Type": "application/json", Origin: originOf(baseURL), ...headers },
    data: body === undefined ? undefined : body,
  });
  const text = await response.text();
  let json: unknown = null;
  try {
    json = text ? (JSON.parse(text) as unknown) : null;
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: response.status(), json };
}

export function ok(
  res: { status: number; json: unknown },
  path: string,
): Record<string, unknown> {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`${path} → HTTP ${res.status}: ${JSON.stringify(res.json).slice(0, 600)}`);
  }
  return res.json as Record<string, unknown>;
}

export function field(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value === "") {
    throw new Error(`expected string field ${key}, got ${JSON.stringify(value)?.slice(0, 120)}`);
  }
  return value;
}

/**
 * Provision the second user the segregation-of-duties leg needs. The product
 * has no user-creation API; this mirrors engine/src/seed-user.ts exactly
 * (scrypt hash, approver role, active only once a role is assigned, since
 * the storage guard refuses a role-less active user).
 */
export async function ensureSecondApprover(tag: string): Promise<{
  id: string;
  email: string;
  password: string;
}> {
  const dbUrl = process.env.OPENBOOKS_DB_URL;
  if (!dbUrl) {
    throw new Error(
      "OPENBOOKS_DB_URL is required: the second approver has no product API and cannot be silently skipped",
    );
  }
  // Never provision against production (same guard as the shared e2e seed
  // script): a second actor must only ever exist in ephemeral tenants.
  if (/10\.0\.0\.85/.test(dbUrl)) throw new Error("refusing to provision: production database");
  const email = `${tag.toLowerCase()}-approver@openbooks.test`;
  const password = `approver-${Date.now().toString(36)}-pw`;
  const salt = randomBytes(16);
  const hash = `${salt.toString("hex")}:${scryptSync(password, salt, 64).toString("hex")}`;
  const client = new Client({ connectionString: dbUrl });
  await client.connect();
  try {
    const org = await client.query<{ id: string }>(
      "select id from orgs where env_kind = 'production' order by created_at, id limit 1",
    );
    const orgId = org.rows[0]?.id;
    if (!orgId) throw new Error("no production organization found for approver provisioning");
    const role = await client.query<{ id: string }>(
      "select id from app_roles where org_id = $1 and key = 'approver' limit 1",
      [orgId],
    );
    const roleId = role.rows[0]?.id;
    if (!roleId) throw new Error("approver role not found for approver provisioning");
    // Inactive first: the active-user role guard fires per row, so the
    // assignment must exist before activation. Each statement is
    // idempotent for suite retries.
    const user = await client.query<{ id: string }>(
      `insert into users (org_id, email, name, password_hash, is_active)
       values ($1, $2, $3, $4, false)
       on conflict (org_id, email) do update set password_hash = excluded.password_hash
       returning id`,
      [orgId, email, `${tag} Approver`, hash],
    );
    const userId = user.rows[0]?.id;
    if (!userId) throw new Error("approver upsert returned no id");
    await client.query(
      `insert into role_assignments (org_id, user_id, role_id)
       values ($1, $2, $3)
       on conflict (org_id, user_id, role_id) do nothing`,
      [orgId, userId, roleId],
    );
    await client.query(
      "update users set is_active = true where org_id = $1 and id = $2",
      [orgId, userId],
    );
    return { id: userId, email, password };
  } finally {
    await client.end();
  }
}

/** API login as another user (used for the second approver's decisions). */
export async function loginApiContext(
  browser: Browser,
  baseURL: string,
  email: string,
  password: string,
): Promise<APIRequestContext> {
  const ctx = await request.newContext({ baseURL: originOf(baseURL) });
  const res = await ctx.post("/api/login", {
    data: { email, password },
    headers: { Origin: originOf(baseURL) },
  });
  if (!res.ok()) {
    throw new Error(`approver login failed: ${res.status()} ${(await res.text()).slice(0, 300)}`);
  }
  return ctx;
}

/** Sum decimal strings exactly (ten-thousandths as bigint, no floats). */
export function sumExact(values: string[]): string {
  let total = 0n;
  for (const value of values) {
    const parts = match(value);
    const whole = BigInt(parts[1] ?? "0");
    const frac = (parts[2] ?? "").padEnd(4, "0");
    total += whole * 10000n + (whole < 0n ? -BigInt(frac) : BigInt(frac));
  }
  const negative = total < 0n;
  const abs = negative ? -total : total;
  const str = abs.toString().padStart(5, "0");
  return `${negative ? "-" : ""}${str.slice(0, -4)}.${str.slice(-4)}`;
}

/** Exact negation of a decimal string (no floats). */
export function neg(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith("-")) return trimmed.slice(1);
  return `-${trimmed}`;
}

const DECIMAL = /^(-?\d+)(?:\.(\d{1,4}))?$/;

function match(value: string): RegExpExecArray {
  const match = DECIMAL.exec(value.trim());
  if (!match) throw new Error(`not a decimal: ${JSON.stringify(value)}`);
  return match;
}

export interface StubLine {
  kind: string;
  component_code: string | null;
  description: string;
  hours: string | null;
  rate: string | null;
  amount: string;
}

export interface Stub {
  id: string;
  employee_party_id: string;
  employee_name: string;
  province: string;
  gross: string;
  net_pay: string;
  employer_cost: string;
  lines: StubLine[];
}

export function asStubs(json: unknown): Stub[] {
  const record = json as Record<string, unknown>;
  const stubs = record["stubs"];
  if (!Array.isArray(stubs)) throw new Error("expected stubs array");
  return stubs.map((stub) => {
    const row = stub as Record<string, unknown>;
    const lines = Array.isArray(row["lines"]) ? row["lines"] : [];
    return {
      id: String(row["id"]),
      employee_party_id: String(row["employee_party_id"]),
      employee_name: String(row["employee_name"]),
      province: String(row["province"] ?? ""),
      gross: String(row["gross"]),
      net_pay: String(row["net_pay"]),
      employer_cost: String(row["employer_cost"]),
      lines: lines.map((line) => {
        const item = line as Record<string, unknown>;
        return {
          kind: String(item["kind"]),
          component_code: item["component_code"] == null ? null : String(item["component_code"]),
          description: String(item["description"] ?? ""),
          hours: item["hours"] == null ? null : String(item["hours"]),
          rate: item["rate"] == null ? null : String(item["rate"]),
          amount: String(item["amount"]),
        };
      }),
    };
  });
}
