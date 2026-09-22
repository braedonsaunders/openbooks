import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// The route boundary for cash-free credit settlement. The engine behaviour is
// proven against a real database in
// engine/src/payments/credit-settlement.integration.test.ts; what is doubled
// here is the database, authz and the engine, so the assertions are about the
// route's OWN decisions: which permission each side is gated on, that the
// party stays in subsidiary scope, and — the security-relevant one — that a
// caller cannot release an AP settlement by naming the AR side.
//
// Body validation runs REAL: parseJsonBody and its zod schema are the shared
// boundary, never a stub.
const stateKey = Symbol.for("openbooks.credit-applications-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000e001";
const USER_ID = "00000000-0000-4000-8000-00000000e002";
const PARTY_ID = "00000000-0000-4000-8000-00000000e003";
const FROM_LINE = "00000000-0000-4000-8000-00000000e004";
const TO_LINE = "00000000-0000-4000-8000-00000000e005";
const CREDIT_DOC = "00000000-0000-4000-8000-00000000e006";
const APPLICATION_ID = "00000000-0000-4000-8000-00000000e007";

interface RouteState {
  permissions: string[];
  guardedWith: string | null;
  scopeDenied: boolean;
  partyRow: { subsidiaryId: string | null } | null;
  settlementRow: { kind: string | null; partyId: string | null } | null;
  documentRow: { partyId: string | null } | null;
  stateCalls: string[];
  applied: unknown[];
  released: string[];
}

const state: RouteState = {
  permissions: [],
  guardedWith: null,
  scopeDenied: false,
  partyRow: { subsidiaryId: null },
  settlementRow: { kind: "customer_credit", partyId: PARTY_ID },
  documentRow: { partyId: PARTY_ID },
  stateCalls: [],
  applied: [],
  released: [],
};
(globalThis as Record<symbol, unknown>)[stateKey] = state;

function reset(overrides: Partial<RouteState> = {}): void {
  Object.assign(state, {
    permissions: ["ap.pay", "ar.pay", "ap.read", "ar.read"],
    guardedWith: null,
    scopeDenied: false,
    partyRow: { subsidiaryId: null },
    settlementRow: { kind: "customer_credit", partyId: PARTY_ID },
    documentRow: { partyId: PARTY_ID },
    stateCalls: [],
    applied: [],
    released: [],
  }, overrides);
}

const module_ = (source: string): { shortCircuit: true; format: "module"; url: string } => ({
  shortCircuit: true,
  format: "module",
  url: `data:text/javascript,${encodeURIComponent(source)}`,
});

registerHooks({
  resolve(specifier, context, nextResolve) {
    // The db double re-exports the real module by its absolute URL. Without
    // this the hook matches that URL too, the double imports itself, and every
    // name it was meant to pass through disappears.
    if (specifier.startsWith("file:")) return nextResolve(specifier, context);
    if (specifier === "server-only") return module_("export {}");
    if (specifier.endsWith("/lib/authz") || specifier.endsWith("lib/authz")) {
      const real = nextResolve(specifier, context).url;
      // A data: URL has no parent to resolve bare specifiers against, so the
      // double imports next/server by the URL the loader resolves for it.
      const nextServer = nextResolve("next/server", context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const s = globalThis[Symbol.for("openbooks.credit-applications-route-test")];
        const { NextResponse } = await import(${JSON.stringify(nextServer)});
        export async function guardPermission(permission) {
          s.guardedWith = permission;
          if (!s.permissions.includes(permission)) {
            return NextResponse.json({ error: "missing permission: " + permission }, { status: 403 });
          }
          return { user: { orgId: ${JSON.stringify(ORG_ID)}, id: ${JSON.stringify(USER_ID)} }, permissions: new Set(s.permissions), allowedSubsidiaryIds: null };
        }
        export function guardSubsidiaryScope() {
          return s.scopeDenied ? NextResponse.json({ error: "forbidden" }, { status: 403 }) : null;
        }
      `);
    }
    if (specifier.includes("platform/db.ts")) {
      // Re-export the real module and override only `db`. Listing the other
      // exports by hand would be a list that can only omit: every transitive
      // importer that needs one more name fails at load with a SyntaxError
      // rather than anything this test is about.
      const real = nextResolve(specifier, context).url;
      return module_(`
        export * from ${JSON.stringify(real)};
        const s = globalThis[Symbol.for("openbooks.credit-applications-route-test")];
        export const db = {
          async execute(query) {
            const text = String(query?.queryChunks?.map?.((c) => (typeof c === "string" ? c : c?.value ?? "")).join("") ?? "");
            if (text.includes("from parties")) return { rows: s.partyRow ? [s.partyRow] : [] };
            if (text.includes("from documents")) return { rows: s.documentRow ? [s.documentRow] : [] };
            return { rows: s.settlementRow ? [s.settlementRow] : [] };
          },
          async transaction(fn) { return fn(db); },
        };
      `);
    }
    if (specifier.includes("credit-settlement.ts")) {
      return module_(`
        const s = globalThis[Symbol.for("openbooks.credit-applications-route-test")];
        export async function applyStandaloneCredits(orgId, userId, input) {
          s.applied.push({ orgId, userId, input });
          return { applicationIds: [${JSON.stringify(APPLICATION_ID)}], amount: "100.0000" };
        }
        export async function creditSettlementState(orgId, documentId) {
          s.stateCalls.push(documentId);
          return { lineId: "line", amount: "100.0000", applied: "0.0000", open: "100.0000", currency: "CAD", settlements: [] };
        }
        export async function unapplyCreditSettlement(orgId, userId, applicationId) {
          s.released.push(applicationId);
          return { amount: "100.0000" };
        }
      `);
    }
    return nextResolve(specifier, context);
  },
});

const { GET, POST, DELETE } = await import("./route.ts");

const applyRequest = (body: unknown): Request =>
  new Request("http://localhost/api/payments/credit-applications", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const releaseRequest = (body: unknown): Request =>
  new Request("http://localhost/api/payments/credit-applications", {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

const validCredits = [
  { fromLineId: FROM_LINE, toLineId: TO_LINE, amount: "100", sourceDocumentId: CREDIT_DOC },
];

test("an AR settlement is gated on ar.pay and reaches the engine intact", async () => {
  reset();
  const res = await POST(
    applyRequest({ partyId: PARTY_ID, side: "ar", appliedOn: "2026-07-15", credits: validCredits }),
  );
  assert.equal(res.status, 200);
  assert.equal(state.guardedWith, "ar.pay");
  assert.equal(state.applied.length, 1);
  // The shared money boundary canonicalizes on the way in, so the engine
  // receives "100.0000" and never has to re-decide what "100" meant.
  assert.deepEqual((state.applied[0] as { input: unknown }).input, {
    partyId: PARTY_ID,
    side: "ar",
    appliedOn: "2026-07-15",
    credits: [{ ...validCredits[0]!, amount: "100.0000" }],
  });
});

test("an AP settlement is gated on ap.pay", async () => {
  reset({ permissions: ["ap.pay"] });
  const res = await POST(
    applyRequest({ partyId: PARTY_ID, side: "ap", appliedOn: "2026-07-15", credits: validCredits }),
  );
  assert.equal(res.status, 200);
  assert.equal(state.guardedWith, "ap.pay");
});

test("a reader without the side's pay permission is refused before any write", async () => {
  reset({ permissions: ["ar.pay"] });
  const res = await POST(
    applyRequest({ partyId: PARTY_ID, side: "ap", appliedOn: "2026-07-15", credits: validCredits }),
  );
  assert.equal(res.status, 403);
  assert.equal(state.applied.length, 0);
});

test("an out-of-scope party is refused before any write", async () => {
  reset({ scopeDenied: true });
  const res = await POST(
    applyRequest({ partyId: PARTY_ID, side: "ar", appliedOn: "2026-07-15", credits: validCredits }),
  );
  assert.equal(res.status, 403);
  assert.equal(state.applied.length, 0);
});

test("an empty or malformed settlement never reaches the engine", async () => {
  for (const body of [
    { partyId: PARTY_ID, side: "ar", appliedOn: "2026-07-15", credits: [] },
    { partyId: PARTY_ID, side: "ar", appliedOn: "15/07/2026", credits: validCredits },
    { partyId: "not-a-uuid", side: "ar", appliedOn: "2026-07-15", credits: validCredits },
    { partyId: PARTY_ID, side: "gl", appliedOn: "2026-07-15", credits: validCredits },
    {
      partyId: PARTY_ID, side: "ar", appliedOn: "2026-07-15",
      credits: [{ ...validCredits[0]!, amount: "1,234" }],
    },
  ]) {
    reset();
    const res = await POST(applyRequest(body));
    assert.equal(res.status, 400, `expected 400 for ${JSON.stringify(body)}`);
    assert.equal(state.applied.length, 0);
  }
});

test("releasing a settlement reaches the engine when the side matches", async () => {
  reset();
  const res = await DELETE(releaseRequest({ applicationId: APPLICATION_ID, side: "ar" }));
  assert.equal(res.status, 200);
  assert.equal(state.guardedWith, "ar.pay");
  assert.deepEqual(state.released, [APPLICATION_ID]);
});

test("an AR-gated caller cannot release an AP settlement", async () => {
  // The whole point of taking `side` in the body: the permission is chosen
  // before any tenant read, so the settlement's real side must be checked
  // against it afterwards or ar.pay alone would release vendor credits.
  reset({ permissions: ["ar.pay"], settlementRow: { kind: "vendor_credit", partyId: PARTY_ID } });
  const res = await DELETE(releaseRequest({ applicationId: APPLICATION_ID, side: "ar" }));
  assert.equal(res.status, 404);
  assert.deepEqual(state.released, []);
  // And the refusal must not disclose that an AP settlement exists there.
  assert.deepEqual(await res.json(), { error: "not found" });
});

test("a cash application id is not releasable through this route", async () => {
  reset({ settlementRow: { kind: "customer_payment", partyId: PARTY_ID } });
  const res = await DELETE(releaseRequest({ applicationId: APPLICATION_ID, side: "ar" }));
  assert.equal(res.status, 404);
  assert.deepEqual(state.released, []);
});

test("an unknown settlement id is a tenant-opaque 404", async () => {
  reset({ settlementRow: null });
  const res = await DELETE(releaseRequest({ applicationId: APPLICATION_ID, side: "ar" }));
  assert.equal(res.status, 404);
  assert.deepEqual(state.released, []);
});

const stateRequest = (query: string): Request =>
  new Request(`http://localhost/api/payments/credit-applications?${query}`);

test("reading a credit's settlement state is gated on the side's read permission", async () => {
  reset({ permissions: ["ar.read"] });
  const res = await GET(stateRequest(`side=ar&documentId=${APPLICATION_ID}`));
  assert.equal(res.status, 200);
  assert.equal(state.guardedWith, "ar.read");
  assert.deepEqual(state.stateCalls, [APPLICATION_ID]);
});

test("a credit whose kind does not match the named side is a 404", async () => {
  // The document lookup binds id AND kind, so an AR reader naming a vendor
  // credit finds nothing rather than learning what it settled.
  reset({ documentRow: null });
  const res = await GET(stateRequest(`side=ar&documentId=${APPLICATION_ID}`));
  assert.equal(res.status, 404);
  assert.deepEqual(state.stateCalls, []);
});

test("state reads refuse a malformed side or document id before any read", async () => {
  for (const query of [
    `side=gl&documentId=${APPLICATION_ID}`,
    "side=ar&documentId=not-a-uuid",
    "side=ar",
  ]) {
    reset();
    const res = await GET(stateRequest(query));
    assert.equal(res.status, 400, `expected 400 for ${query}`);
    assert.deepEqual(state.stateCalls, []);
  }
});

test("an out-of-scope party hides the credit's settlement state", async () => {
  reset({ scopeDenied: true });
  const res = await GET(stateRequest(`side=ar&documentId=${APPLICATION_ID}`));
  assert.equal(res.status, 403);
  assert.deepEqual(state.stateCalls, []);
});
