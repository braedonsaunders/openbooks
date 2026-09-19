import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { EMAIL_TOKEN_TTL_MS } from "@openbooks/engine/src/flows/email-tokens.ts";

interface EmailActionState {
  token: string;
  claims: { gateId: string; decision: "approved" | "rejected"; assigneeUserId: string; expiresAt: number } | null;
  summary: {
    id: string;
    orgId: string;
    title: string;
    status: string;
    subject_kind: string;
    decided_by_name: string | null;
    document_number: string | null;
    doc_kind: string | null;
    total: string | null;
    currency: string | null;
    document_date: string | null;
    party_name: string | null;
  };
  decideResult:
    | { ok: true; resumed: string; runStatus: string }
    | { ok: false; decision: string; resumed: string; runId: string; runStatus: string; decisionRecorded: true; error: string };
  decideCalls: Array<Record<string, unknown>>;
}

const stateKey = Symbol.for("openbooks.email-action-route-test");
const routeState: EmailActionState = {
  token: "test-token",
  claims: null,
  summary: {
    id: "gate-1",
    orgId: "org-1",
    title: "Approval",
    status: "pending",
    subject_kind: "vendor_bill",
    decided_by_name: null,
    document_number: "BILL-0042",
    doc_kind: "vendor_bill",
    total: "100.00",
    currency: "CAD",
    document_date: "2026-07-15",
    party_name: "Acme",
  },
  decideResult: { ok: true, resumed: "approve", runStatus: "completed" },
  decideCalls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.email-action-route-test')]
      export const db = {
        execute: async () => ({ rows: [{ ...state.summary }] }),
      }
      export function withBypassContext(fn) { return fn() }
      export function withOrgContext(orgId, fn) { return fn() }
    `,
  ],
  [
    "mock:flows",
    `
      const state = globalThis[Symbol.for('openbooks.email-action-route-test')]
      export const EMAIL_TOKEN_TTL_MS = ${EMAIL_TOKEN_TTL_MS}
      export class GateError extends Error {}
      export function verifyEmailActionToken(token) {
        return token === state.token ? state.claims : null
      }
      export async function decideGate(args) {
        state.decideCalls.push(args)
        return state.decideResult
      }
    `,
  ],
  [
    "mock:features",
    `
      export async function isFeatureEnabled() { return true }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/db.ts", "mock:db"],
  ["@openbooks/engine/src/flows/index.ts", "mock:flows"],
  ["../../../../lib/features", "mock:features"],
]);

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, _context);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url, _context);
  },
});

const { GET, POST } = (await import("./route.ts?email-action-refusal")) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  routeState.claims = {
    gateId: "gate-1",
    decision: "approved",
    assigneeUserId: "user-1",
    expiresAt: Date.now() + 3_600_000,
  };
  routeState.summary.status = "pending";
  routeState.decideResult = { ok: true, resumed: "approve", runStatus: "completed" };
  routeState.decideCalls.length = 0;
}

function postForm(token: string, reason?: string): Request {
  const form = new FormData();
  form.append("token", token);
  if (reason !== undefined) form.append("reason", reason);
  return new Request("http://localhost/api/flows/email-action", { method: "POST", body: form });
}

// The invalid-link page must state the approval link's real lifetime, derived
// from the configured token TTL — never a hardcoded duration that can drift
// from it (it once claimed 7 days while tokens died after 72 hours). The
// invalid-token path touches no database, so no further mocks are needed.
test("an invalid approval link states the configured token lifetime", async () => {
  const res = await GET(new Request("http://localhost/api/flows/email-action?token=not-a-token"));
  assert.equal(res.status, 400);
  const html = await res.text();
  const hours = EMAIL_TOKEN_TTL_MS / 3_600_000;
  const expected =
    Number.isInteger(hours) && hours % 24 === 0 ? `${hours / 24} days` : `${hours} hours`;
  assert.ok(
    html.includes(`expire after ${expected}`),
    `expected TTL-derived copy ("expire after ${expected}"), got: ${html.slice(0, 300)}`,
  );
  assert.ok(!html.includes("7 days"), "stale hardcoded expiry must not appear");
});

test("a recorded-but-incomplete one-click decision never renders as Approved", async () => {
  reset();
  routeState.decideResult = {
    ok: false,
    decision: "approved",
    resumed: "approve",
    runId: "00000000-0000-4000-8000-000000000041",
    runStatus: "failed",
    decisionRecorded: true,
    error: "decision approved recorded but release failed: boom. Run 00000000-0000-4000-8000-000000000041 is marked failed; fix the cause, then retry the failed run via retryFlowRun.",
  };

  const res = await POST(postForm(routeState.token));

  assert.equal(res.status, 500);
  const html = await res.text();
  assert.ok(html.includes("Approval needs attention"), "failure page title, not Approved");
  assert.ok(html.includes("was recorded"), "the page admits the decision was recorded");
  assert.ok(html.includes("boom"), "the refusal cause reaches the approver");
  assert.ok(html.includes("Approvals"), "the page points at the retry path");
  assert.ok(
    !html.includes("Your decision was recorded. You can close this page."),
    "success copy must not render for a refusal",
  );
});

test("a completed one-click decision still renders its confirmation", async () => {
  reset();

  const res = await POST(postForm(routeState.token));

  assert.equal(res.status, 200);
  const html = await res.text();
  assert.ok(html.includes("Approved"), "success copy still renders for ok:true");
  assert.deepEqual(routeState.decideCalls, [
    { gateId: "gate-1", decision: "approved", userId: "user-1", comment: null },
  ]);
});
