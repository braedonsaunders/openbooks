import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Collection POST used to coerce isDefault with !! — a truthy non-boolean
// (including the string "false") cleared sibling defaults and stored true.
// The handler must refuse that by name and never enter the write transaction.

const stateKey = Symbol.for("openbooks.form-layout-post-bool-unit");
interface DbState {
  txCalls: number;
}
const dbState: DbState = { txCalls: 0 };
;(globalThis as Record<symbol, unknown>)[stateKey] = dbState;

const mockAuthz = `
  export async function guardPermission() {
    return { user: { orgId: 'org-1', id: 'user-1' }, permissions: new Set(['*']) }
  }
  export function can() { return true }
`;
const mockGates = `
  export async function refuseDisabledRecordType() { return null }
`;
const mockCustomization = `
  export const RECORD_TYPE_BY_KEY = { vendor_bill: { key: 'vendor_bill' } }
  export function parseFormLayout(input) { return { success: true, data: input, issues: [] } }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    const parent = context.parentURL ?? "";
    if (specifier === "@openbooks/engine/src/platform/db.ts" && parent.includes("customization/form-layouts/route")) {
      return {
        shortCircuit: true,
        format: "module",
        url: 'data:text/javascript,export const db = { execute: async () => ({ rows: [] }), transaction: async (fn) => { globalThis[Symbol.for("openbooks.form-layout-post-bool-unit")].txCalls++; return fn({ execute: async () => ({ rows: [{ id: "form-1", name: "n" }] }) }) } }',
      };
    }
    if (specifier === "../../../../lib/authz" && parent.includes("customization/form-layouts/route")) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.endsWith("lib/customization/gates") && parent.includes("customization/form-layouts/route")) {
      return { url: "mock:gates", shortCircuit: true };
    }
    if (specifier === "@openbooks/customization" && parent.includes("customization/form-layouts/route")) {
      return { url: "mock:customization", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") return { format: "module", source: mockAuthz, shortCircuit: true };
    if (url === "mock:gates") return { format: "module", source: mockGates, shortCircuit: true };
    if (url === "mock:customization") return { format: "module", source: mockCustomization, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const form_layout_post_bool_unitUrl = './route.ts?form-layout-post-bool-unit'
const { POST } = (await import(form_layout_post_bool_unitUrl)) as typeof import('./route.ts');
hooks.deregister();

const layout = { schemaVersion: 1, recordType: "vendor_bill" };

function postRequest(body: unknown): Request {
  return new Request("http://localhost/api/customization/form-layouts", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("POST refuses a non-boolean isDefault by name and writes nothing", async () => {
  for (const value of ["false", "yes", 1, {}] as const) {
    dbState.txCalls = 0;
    const res = await POST(
      postRequest({ recordType: "vendor_bill", name: "Custom", layout, isDefault: value }),
    );
    assert.equal(res.status, 400, `status for ${JSON.stringify(value)}`);
    assert.equal((await res.json()).error, "isDefault must be a boolean");
    assert.equal(dbState.txCalls, 0, "rejected create must not enter the write transaction");
  }
});

test("POST still accepts an omitted or real-boolean isDefault", async () => {
  for (const value of [undefined, false, true] as const) {
    dbState.txCalls = 0;
    const body =
      value === undefined
        ? { recordType: "vendor_bill", name: "Custom", layout }
        : { recordType: "vendor_bill", name: "Custom", layout, isDefault: value };
    const res = await POST(postRequest(body));
    assert.equal(res.status, 200, `status for ${String(value)}`);
    assert.equal(dbState.txCalls, 1);
  }
});
