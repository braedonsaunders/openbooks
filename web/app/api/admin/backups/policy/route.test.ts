import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

const ORG_ID = "00000000-0000-4000-8000-000000000071";
const USER_ID = "00000000-0000-4000-8000-000000000072";
interface PolicyState {
  calls: string[];
  auditWasTransactional: boolean[];
  transactionDepth: number;
  auditGate?: Promise<void>;
}
const state: PolicyState = { calls: [], auditWasTransactional: [], transactionDepth: 0 };
const stateKey = Symbol.for("openbooks.backup-policy-route-test");
(globalThis as Record<symbol, unknown>)[stateKey] = state;
(globalThis as Record<string, unknown>).backupPolicySqlText = (query: unknown): string => {
  const flatten = (part: unknown): string => {
    if (typeof part === "string") return part;
    const value = (part as { value?: unknown[] })?.value;
    if (Array.isArray(value)) return value.map(String).join("");
    const chunks = (part as { queryChunks?: unknown[] })?.queryChunks;
    return Array.isArray(chunks) ? chunks.map(flatten).join("") : "";
  };
  return flatten(query);
};

const mockSources = new Map<string, string>([
  ["mock:authz", `export async function guardPermission(){return {user:{id:'${USER_ID}',orgId:'${ORG_ID}'}}}`],
  ["mock:db", `
    const state = globalThis[Symbol.for('openbooks.backup-policy-route-test')]
    const sqlText = globalThis.backupPolicySqlText
    export const env = {}
    export const orgContext = { getStore: () => null }
    export const longPool = {}
    export const db = { async execute(query) {
      const text = sqlText(query)
      state.calls.push(text)
      if (text.includes('insert into audit_log')) state.auditWasTransactional.push(state.transactionDepth > 0)
      if (state.auditGate && text.includes('insert into audit_log')) await state.auditGate
      // The route re-reads the upserted row and refuses on a zero-row
      // match, so the double answers the policy read with the stored row.
      if (text.includes('from backup_policies')) {
        return { rows: [{ enabled: true, frequency: 'weekly', hour_utc: 3, day_of_week: 2, day_of_month: 15, max_keep: 4 }] }
      }
      return { rows: [] }
    } }
    export async function withOrgTransaction(_orgId, fn) {
      state.transactionDepth += 1
      try { return await fn() } finally { state.transactionDepth -= 1 }
    }
    export async function withOrgContext(_orgId, fn) { return fn() }
    export async function withBypassContext(fn) { return fn() }
  `],
]);
const jsonUrl = new URL("../../../../../lib/api/json.ts", import.meta.url).href;
const backupUrl = new URL("../../../../../../engine/src/backup/backup.ts", import.meta.url).href;
const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@/lib/api/json") return nextResolve(jsonUrl, context);
    if (specifier === "@openbooks/engine/src/backup/backup.ts") return nextResolve(backupUrl, context);
    if (specifier === "@openbooks/engine/src/platform/db.ts" || specifier.endsWith("/platform/db.ts")) {
      return { url: "mock:db", shortCircuit: true };
    }
    if (specifier === "../../../../../lib/authz") return { url: "mock:authz", shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});
const backupPolicyRouteUrl: string = "./route.ts?backup-policy-test";
const { PUT } = await import(backupPolicyRouteUrl) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.calls = [];
  state.auditWasTransactional = [];
  state.transactionDepth = 0;
  state.auditGate = undefined;
}

function putRequest(): Request {
  return new Request("http://openbooks.test/api/admin/backups/policy", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ enabled: true, frequency: "weekly", hourUtc: 3, dayOfWeek: 2, dayOfMonth: 15, maxKeep: 4 }),
  });
}

test("backup policy updates commit and await audit evidence in the organization transaction", async () => {
  reset();
  let releaseAudit!: () => void;
  state.auditGate = new Promise<void>((resolve) => { releaseAudit = resolve; });
  let settled = false;
  const responsePromise = PUT(putRequest()).then((response) => {
    settled = true;
    return response;
  });
  try {
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.ok(state.calls.some((text) => text.includes("insert into backup_policies")));
    assert.ok(state.calls.some((text) => text.includes("insert into audit_log")));
    assert.deepEqual(state.auditWasTransactional, [true]);
    assert.equal(settled, false, "the policy change is not acknowledged before audit evidence commits");
  } finally {
    releaseAudit();
  }
  const response = await responsePromise;
  assert.equal(response.status, 200);
  const body = await response.json() as { ok: boolean; nextRunAt: string };
  assert.equal(body.ok, true);
  assert.ok(Date.parse(body.nextRunAt) > Date.now());
});
