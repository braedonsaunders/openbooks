import assert from "node:assert/strict";
import { stubModules } from "../../../../../testing/stub-modules";
import test from "node:test";

const stateKey = Symbol.for("openbooks.records-route-test");
interface AuditEvent {
  orgId: string;
  keyId: string;
  method: string;
  path: string;
  statusCode: number;
  error: string | null;
}
interface RouteState {
  auth: {
    user: { orgId: string };
    keyId: string;
    audit: {
      method: string;
      path: string;
      ipAddress: string | null;
      userAgent: string | null;
      startedAt: number;
    };
  };
  events: AuditEvent[];
  creates: Array<{ typeKey: string; body: Record<string, unknown>; idempotencyKey: string }>;
  /** When set, the application writer throws this message instead of succeeding. */
  failWith: string | null;
}

const routeState: RouteState = {
  auth: {
    user: { orgId: "org-1" },
    keyId: "key-1",
    audit: {
      method: "POST",
      path: "/api/v1/records/parties",
      ipAddress: "203.0.113.9",
      userAgent: "records-route-test/1",
      startedAt: Date.now(),
    },
  },
  events: [],
  creates: [],
  failWith: null,
};
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

stubModules({
  navigation: false,
  intl: false,
  authz: false,
  features: false,
  extra: {
    "../../../../../lib/api-auth": `
      const state = globalThis[Symbol.for('openbooks.records-route-test')]
      export async function resolveApiKeyAuth() { return state.auth }
      export async function guardApiKeyFeature() { return null }
      export async function enforceRateLimit() { return null }
    `,
    "../../../../../lib/application/api-key-audit": `
      const state = globalThis[Symbol.for('openbooks.records-route-test')]
      export async function insertApiKeyEvent(event) { state.events.push(event) }
      export function takeClaimedCommandEvidence() { return false }
      export function transportEvent(trail, identity, status) {
        return {
          orgId: identity.orgId,
          keyId: identity.keyId,
          method: trail.method,
          path: trail.path,
          statusCode: status.statusCode,
          error: status.error ?? null,
        }
      }
    `,
    "../../../../../lib/application/context": `export function applicationContextFromApiKey(auth) { return { authz: { user: auth.user } } }`,
    "../../../../../lib/application/errors": `
      export class ApplicationError extends Error {
        constructor(code, message, status, details) {
          super(message)
          this.code = code
          this.status = status
          this.details = details
        }
      }
    `,
    "../../../../../lib/application/records": `
      const state = globalThis[Symbol.for('openbooks.records-route-test')]
      export async function createApplicationRecord(_context, input) {
        if (state.failWith) throw new Error(state.failWith)
        state.creates.push(input)
        return { replayed: false, status: 201, result: { id: 'record-1' } }
      }
      export async function listRecords() { return { records: [], total: 0, page: 1, perPage: 25 } }
    `,
    "../../../../../lib/list-params": `export function clamp(value, min, max) { return Math.min(Math.max(value, min), max) }`,
  },
});

const routeUrl = "./route.ts?records-route-audit-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");

function reset(): void {
  routeState.events.length = 0;
  routeState.creates.length = 0;
  routeState.failWith = null;
  routeState.auth.audit.startedAt = Date.now();
}

function post(body: string, idempotencyKey = "records-route-test-1"): Promise<Response> {
  return POST(
    new Request("http://openbooks.test/api/v1/records/parties", {
      method: "POST",
      headers: {
        authorization: "Bearer test-key",
        "content-type": "application/json",
        "idempotency-key": idempotencyKey,
      },
      body,
    }),
    { params: Promise.resolve({ typeKey: "parties" }) },
  );
}

test("malformed authenticated commands retain execution audit evidence", async () => {
  reset();

  const malformedResponse = await post("{not-json");

  assert.equal(malformedResponse.status, 400);
  assert.deepEqual(await malformedResponse.json(), { error: "invalid request body" });
  assert.deepEqual(routeState.events, [
    {
      orgId: "org-1",
      keyId: "key-1",
      method: "POST",
      path: "/api/v1/records/parties",
      statusCode: 400,
      error: "invalid_input",
    },
  ]);
  assert.equal(routeState.creates.length, 0, "malformed input never reaches the application writer");

  reset();

  const validResponse = await post(JSON.stringify({ kind: "customer", display_name: "Acme" }), "records-route-test-2");

  assert.equal(validResponse.status, 201);
  assert.deepEqual(await validResponse.json(), { id: "record-1" });
  assert.equal(routeState.creates.length, 1);
  assert.deepEqual(routeState.events[0]?.statusCode, 201);
  assert.equal(routeState.events[0]?.error, null);
});

test("unexpected writer failures stay generic and never echo the thrown message", async () => {
  reset();
  const probe = "sanitizer-probe-9c1e-unique-violation";
  routeState.failWith = `duplicate key value violates unique constraint "custom_records_pkey" (${probe})`;

  const response = await post(JSON.stringify({ kind: "customer", display_name: "Acme" }), "records-route-test-3");

  assert.equal(response.status, 500);
  const body = await response.text();
  assert.ok(!body.includes(probe), "the 500 body must stay generic instead of carrying the database error text");
});
