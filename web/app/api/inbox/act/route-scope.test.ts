import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Route boundary suite: POST /api/inbox/act runs the real inbox context
// builder against scripted authz/feature/date fakes and a capturing inbox
// module. The decision must carry the session's subsidiary boundary — a
// restricted actor's scope rides into actOnInboxItem, where the adapters
// enforce it at the write authority.

const stateKey = Symbol.for("openbooks.inbox-act-route-test");

interface ActRouteState {
  allowedSubsidiaryIds: Set<string> | null;
  roles: Array<{ key: string }>;
  permissions: Set<string>;
  budgetsOn: boolean;
  seenCtx: Array<Record<string, unknown>>;
}

const routeState: ActRouteState = {
  allowedSubsidiaryIds: new Set(["sub-a"]),
  roles: [{ key: "approver" }],
  permissions: new Set(["flows.approve"]),
  budgetsOn: false,
  seenCtx: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.inbox-act-route-test')]
      export async function getAuthz() {
        return {
          user: { orgId: 'org-1', id: 'user-1', roles: state.roles },
          permissions: state.permissions,
          allowedSubsidiaryIds: state.allowedSubsidiaryIds,
        }
      }
      export function can(authz, permission) {
        return authz.permissions.has(permission)
      }
    `,
  ],
  [
    "mock:features",
    `
      const state = globalThis[Symbol.for('openbooks.inbox-act-route-test')]
      export async function isFeatureEnabled(_orgId, key) {
        return key === 'budgets' ? state.budgetsOn : true
      }
    `,
  ],
  [
    "mock:business-date",
    `
      export async function businessToday() { return '2026-08-24' }
    `,
  ],
  [
    "mock:inbox",
    `
      const state = globalThis[Symbol.for('openbooks.inbox-act-route-test')]
      export class InboxError extends Error {
        constructor(code, message) {
          super(message)
          this.code = code
        }
      }
      export async function actOnInboxItem(ctx, itemId, actionKey, reason) {
        state.seenCtx.push({ ctx, itemId, actionKey, reason: reason ?? null })
      }
    `,
  ],
]);

const mockUrls = new Map<string, string>([
  ["../../../../lib/authz", "mock:authz"],
  ["../../../../lib/features", "mock:features"],
  ["@openbooks/engine/src/inbox/index.ts", "mock:inbox"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:business-date"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    // The real context builder reaches authz through a sibling-relative
    // specifier; keep it on the same mock as the route's own import.
    if (
      context.parentURL?.endsWith("/lib/inbox-context.ts") &&
      (specifier === "./authz" || specifier === "./features")
    ) {
      return {
        url: specifier === "./authz" ? "mock:authz" : "mock:features",
        shortCircuit: true,
      };
    }
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) {
      return { format: "module", source, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?inbox-act-scope-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function act(body: Record<string, unknown>): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/inbox/act", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

test("POST carries the session subsidiary boundary into the decision", async () => {
  routeState.allowedSubsidiaryIds = new Set(["sub-a"]);
  routeState.roles = [{ key: "approver" }];
  routeState.permissions = new Set(["flows.approve"]);
  routeState.seenCtx = [];

  const response = await act({ itemId: "flows_approval:gate:1", actionKey: "approve" });

  assert.equal(response.status, 200);
  assert.equal(routeState.seenCtx.length, 1);
  const seen = routeState.seenCtx[0]!;
  assert.equal(seen.itemId, "flows_approval:gate:1");
  assert.equal(seen.actionKey, "approve");
  const scope = (seen.ctx as { scope?: { allowedSubsidiaryIds?: unknown; roles?: unknown } }).scope;
  assert.ok(scope, "the decision context carries a union scope");
  assert.deepEqual(scope.allowedSubsidiaryIds, ["sub-a"]);
  assert.deepEqual(scope.roles, ["approver"]);
});

test("POST preserves the unrestricted marker instead of an empty boundary", async () => {
  // null is unrestricted; an empty set would fail closed everywhere. The
  // route must not convert one into the other on the way through.
  routeState.allowedSubsidiaryIds = null;
  routeState.seenCtx = [];

  const response = await act({ itemId: "flows_approval:gate:1", actionKey: "approve" });

  assert.equal(response.status, 200);
  const scope = (
    routeState.seenCtx[0]!.ctx as { scope?: { allowedSubsidiaryIds?: unknown } }
  ).scope;
  assert.strictEqual(scope?.allowedSubsidiaryIds, null);
});
