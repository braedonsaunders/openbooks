import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import nodeTest from "node:test";
import { NextResponse } from "next/server";
import { pathToFileURL } from "node:url";

/**
 * F3-38 (security): Send, Remind, Void and Legal-hold refuse a read-only
 * role before any service runs. Module doubles cover only the network
 * boundary (authz) and the engine service/delivery (DB- and
 * transport-owned); the zod bodies and the error mapper run as-is. The
 * mock answers 403 for permissions the role does not hold, like the real
 * gate — and the positive send proves the double can also let the manage
 * grant through, so the refusals are not vacuous.
 */

interface RouteState {
  perms: string[];
  calls: Array<{ fn: string; args: unknown }>;
}

const stateKey = Symbol.for("openbooks.hrm-documents-actions-test");
type TestFn = typeof nodeTest;
const test: TestFn = nodeTest;

const routeState: RouteState = {
  perms: ["hrm.documents.read", "hrm.documents.manage"],
  calls: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const root = pathToFileURL(process.cwd() + "/").href;

const mockSources = new Map<string, string>([
  [
    "mock:authz",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-documents-actions-test')]
      export async function guardPermission(permission) {
        if (permission !== 'hrm.documents.manage') {
          throw new Error('unexpected permission ' + permission)
        }
        // The real gate answers 403 without the grant; the route decides.
        if (!state.perms.includes(permission)) {
          const NextResponse = globalThis.openbooksHrmDocumentsActionsNextResponse
          return NextResponse.json({ error: 'missing permission: ' + permission }, { status: 403 })
        }
        return { user: { id: 'user-1', orgId: 'org-1' } }
      }
    `,
  ],
  [
    "mock:service",
    `
      const state = globalThis[Symbol.for('openbooks.hrm-documents-actions-test')]
      export async function sendDocument(args) {
        state.calls.push({ fn: 'send', args })
        return { document: { title: 'Offer letter' }, deliveries: [] }
      }
      export async function remindDocument(args) {
        state.calls.push({ fn: 'remind', args })
        return { document: { title: 'Offer letter' }, deliveries: [] }
      }
      export async function voidDocument(args) {
        state.calls.push({ fn: 'void', args })
        return { id: args.documentId }
      }
      export async function setLegalHold(args) {
        state.calls.push({ fn: 'hold', args })
        return { id: args.documentId }
      }
    `,
  ],
  [
    "mock:delivery",
    `
      export async function deliverSignatureInvitations() {
        return []
      }
    `,
  ],
  [
    "mock:collection",
    `
      export async function gateDocuments() {
        return null
      }
      export function resolveAppBaseUrl() {
        return 'http://openbooks.test'
      }
    `,
  ],
]);

(globalThis as typeof globalThis & Record<string, unknown>).openbooksHrmDocumentsActionsNextResponse = NextResponse;

const hooks = registerHooks({
  resolve(specifier, _context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(root + "web/" + specifier.slice(2));
    }
    if (specifier === "../../../../../../lib/authz") return { url: "mock:authz", shortCircuit: true };
    if (specifier === "@openbooks/engine/src/hrm/documents/documents.ts") return { url: "mock:service", shortCircuit: true };
    if (specifier === "../../../../../../lib/hrm/document-delivery") return { url: "mock:delivery", shortCircuit: true };
    if (specifier === "../../route") return { url: "mock:collection", shortCircuit: true };
    return nextResolve(specifier);
  },
  load(url, _context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined) return { format: "module", source, shortCircuit: true };
    return nextLoad(url);
  },
});
const sendRoute = (await import("./send/route.ts")) as typeof import("./send/route.ts");
const remindRoute = (await import("./remind/route.ts")) as typeof import("./remind/route.ts");
const voidRoute = (await import("./void/route.ts")) as typeof import("./void/route.ts");
const holdRoute = (await import("./hold/route.ts")) as typeof import("./hold/route.ts");
hooks.deregister();

const UUID = "00000000-0000-4000-8000-000000000001";
const ctx = { params: Promise.resolve({ id: UUID }) };

function reset(): void {
  routeState.perms = ["hrm.documents.read", "hrm.documents.manage"];
  routeState.calls = [];
}

function post(url: string, body: unknown): Request {
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

test("send, remind, void and hold refuse a read-only role before the service runs", async () => {
  reset();
  routeState.perms = ["hrm.documents.read"];
  assert.equal((await sendRoute.POST(post("http://openbooks.test/x", {}), ctx)).status, 403);
  assert.equal((await remindRoute.POST(post("http://openbooks.test/x", {}), ctx)).status, 403);
  assert.equal(
    (await voidRoute.POST(post("http://openbooks.test/x", { reason: "duplicate" }), ctx)).status,
    403,
  );
  assert.equal((await holdRoute.POST(post("http://openbooks.test/x", { hold: true }), ctx)).status, 403);
  assert.deepEqual(routeState.calls, [], "no write reached the service without the manage grant");
});

test("send with the manage grant reaches the service", async () => {
  reset();
  const res = await sendRoute.POST(post("http://openbooks.test/x", {}), ctx);
  assert.equal(res.status, 200);
  assert.deepEqual(routeState.calls, [
    { fn: "send", args: { orgId: "org-1", actorId: "user-1", documentId: UUID } },
  ]);
});
