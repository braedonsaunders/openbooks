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
import type { APIRequestContext, Browser } from "@playwright/test";
import { request } from "@playwright/test";

/**
 * Run-unique tag so retries and local re-runs never collide on natural keys.
 * Time alone cycles every few seconds (proven: two runs started ~50s apart
 * minted the same last-4-millis digits and 422'd on account numbers), so the
 * process id rides along — unique per attempt process, stable within one.
 * Kept at the historical 10 characters: fixed-width bank formats (NACHA
 * individual name) truncate longer tags and break byte assertions.
 */
export const TAG = `W05-${Date.now().toString(36).toUpperCase().slice(-4)}${process.pid.toString(36).toUpperCase().slice(-2)}`;

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
 * Credentials for the second user the segregation-of-duties leg needs: the
 * approver the browser job seeds before the specs run
 * (e2e/workflows/support/seed-e2e-approver.ts, same env contract). Provisioning
 * here used to insert the user with direct SQL, but the specs run under the
 * constrained runtime role, whose RLS posture hides the org row the lookup
 * needs — so it failed on every pristine tenant. Reusing the seeded approver
 * is exact for what the suite asserts (a distinct approver-role login).
 */
export function seededApprover(): {
  email: string;
  password: string;
} {
  return {
    email: process.env.E2E_APPROVER_EMAIL ?? "approver@openbooks.test",
    password: process.env.E2E_APPROVER_PASSWORD ?? "approver-test-password-123",
  };
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
