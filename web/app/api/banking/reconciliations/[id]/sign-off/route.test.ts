import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";

interface SignOffState {
  calls: string[];
  mode: { kind: "ok" } | { kind: "refuse"; message: string } | { kind: "boom" };
}

const stateKey = Symbol.for("openbooks.signoff-route-test");
const isVitest = process.env.VITEST === "true";
type TestFn = typeof nodeTest;
const vitestPackage = "vitest";
const test: TestFn = isVitest
  ? ((await import(vitestPackage)) as unknown as { test: TestFn }).test
  : nodeTest;
const signOffState: SignOffState = { calls: [], mode: { kind: "ok" } };
(
  globalThis as typeof globalThis & Record<symbol, unknown>
)[stateKey] = signOffState;

const mockSources = new Map<string, string>([
  [
    "mock:feature-gates",
    `
      export async function guardFeaturePermission() {
        return { user: { orgId: 'org-1', id: 'user-1' } }
      }
    `,
  ],
  [
    "mock:list-params",
    `
      export function isUuid(value) {
        return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value ?? '')
      }
    `,
  ],
  [
    "mock:banking",
    `
      const state = globalThis[Symbol.for('openbooks.signoff-route-test')]
      export class BankingError extends Error {
        constructor(message) { super(message); this.name = 'BankingError'; this.status = 422 }
      }
      export async function markReconciled(id) {
        state.calls.push(id)
        if (state.mode.kind === 'refuse') throw new BankingError(state.mode.message)
        if (state.mode.kind === 'boom') throw new Error('db exploded')
        return { journalLinesReconciled: 4 }
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../../../lib/feature-gates", "mock:feature-gates"],
  ["../../../../../../lib/list-params", "mock:list-params"],
  ["@openbooks/engine/src/banking.ts", "mock:banking"],
]);

let postRoute: typeof import("./route.ts").POST | undefined;
if (!isVitest) {
  const hooks = registerHooks({
    resolve(specifier, _context, nextResolve) {
      const mocked = mockUrls.get(specifier);
      if (mocked) return { url: mocked, shortCircuit: true };
      return nextResolve(specifier);
    },
    load(url, _context, nextLoad) {
      const source = mockSources.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      return nextLoad(url);
    },
  });

  const routeUrl = "./route.ts?signoff-typed-body";
  postRoute = (await import(routeUrl) as typeof import("./route.ts")).POST;
  hooks.deregister();
}

const RECON_ID = "01a0ad1a-5e43-768c-a165-c7c2ff7ba17a";

function post(id: string) {
  return postRoute!(
    new Request("http://localhost:4800/api/banking/reconciliations/sign-off", { method: "POST" }),
    { params: Promise.resolve({ id }) },
  );
}

/** F-t05-018 (typed-body side): the unmatched-lines refusal must answer a
 * typed 422 carrying the engine message the workspace now surfaces. */
test("a refused sign-off answers a typed 422 with the engine reason", async () => {
  signOffState.calls = [];
  signOffState.mode = { kind: "refuse", message: "Cannot sign off: 3 statement line(s) through the cutoff remain unmatched" };
  const res = (await post(RECON_ID)) as NextResponse;
  assert.equal(res.status, 422);
  const body = (await res.json()) as { error?: string };
  assert.match(body.error ?? "", /3 statement line\(s\).*unmatched/);
  assert.deepEqual(signOffState.calls, [RECON_ID]);
});

test("a sign-off crash stays a typed 500, never an empty body", async () => {
  signOffState.calls = [];
  signOffState.mode = { kind: "boom" };
  const res = (await post(RECON_ID)) as NextResponse;
  assert.equal(res.status, 500);
  const body = (await res.json()) as { error?: string };
  assert.equal(body.error, "Internal error");
});

test("sign-off refuses a malformed id without touching the engine", async () => {
  signOffState.calls = [];
  signOffState.mode = { kind: "ok" };
  const res = (await post("nope")) as NextResponse;
  assert.equal(res.status, 404);
  assert.deepEqual(signOffState.calls, []);
});
