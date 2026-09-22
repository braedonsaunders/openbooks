import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Unsaved-create contract for POST /api/payments: opening the drawer writes
// nothing and allocates no number; the drawer's explicit Save lands here
// exactly once — one idempotent, audited insert with the PAY-/RCPT- number
// allocated inside the locked save transaction. The kind is fixed by the
// entry surface and gates ap.pay / ar.pay respectively. A replay of the same
// request is a success, while reusing the key for a changed payment (or a
// key minted in another org) is a conflict.
//
// The double covers the database, the clock, open-item reads, and authz.
// Request shaping, money math, and settlement-evidence validation run REAL —
// only the rows they read come from the double.
const stateKey = Symbol.for("openbooks.payments-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000d001";
const USER_ID = "00000000-0000-4000-8000-00000000d002";
const SUB_ID = "00000000-0000-4000-8000-00000000d003";
const VENDOR_ID = "00000000-0000-4000-8000-00000000d004";
const BANK_ID = "00000000-0000-4000-8000-00000000d005";
const LINE_ID = "00000000-0000-4000-8000-00000000d006";

interface RouteState {
  requestKey: string | null;
  clockDate: string;
  inserted: boolean;
  orgMatch: boolean;
  authenticated: boolean;
  permissions: string[];
  scopeDenied: boolean;
  partyRow: { id: string; subsidiaryId: string | null } | null;
  roleExists: boolean;
  bankExists: boolean;
  openItems: {
    lineId: string;
    transactionOpen: string;
    currency: string;
    documentNumber: string | null;
    entryNumber: string;
  }[];
  openLineScope: { id: string; subsidiaryId: string | null }[];
  auditAfter: unknown;
  sequenceAllocations: number;
  auditInserts: number;
  transactionQueries: string[];
}

const state: RouteState = {
  requestKey: null,
  clockDate: "2026-09-22",
  inserted: false,
  orgMatch: true,
  authenticated: true,
  permissions: ["ap.pay", "ar.pay"],
  scopeDenied: false,
  partyRow: { id: VENDOR_ID, subsidiaryId: SUB_ID },
  roleExists: true,
  bankExists: true,
  openItems: [],
  openLineScope: [],
  auditAfter: null,
  sequenceAllocations: 0,
  auditInserts: 0,
  transactionQueries: [],
};
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

function sqlText(query: unknown): string {
  const chunks = (query as { queryChunks?: unknown[] })?.queryChunks;
  if (!Array.isArray(chunks)) return "";
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      const value = (chunk as { value?: unknown[] })?.value;
      if (Array.isArray(value)) return value.map(String).join("");
      return (chunk as { queryChunks?: unknown[] })?.queryChunks
        ? sqlText(chunk)
        : "";
    })
    .join("");
}

(
  globalThis as typeof globalThis & Record<string, unknown>
).openbooksPaymentsSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.payments-route-test')]
      const sqlText = globalThis.openbooksPaymentsSqlText
      // The shared claim helper reads through sql.identifier, whose chunk
      // shape this double does not render — match the claim by its
      // same-org by-id predicate instead, excluding every owned-table read.
      function isPriorRead(text) {
        if (!text.includes('where id =') || !text.includes('and org_id =')) return false
        const owned = ['from parties', 'from subsidiaries', 'from accounts', 'from departments',
          'from projects', '_roles', 'from orgs', 'audit_log', 'is_open_item']
        return !owned.some((fragment) => text.includes(fragment))
      }
      function respond(query) {
        const text = sqlText(query)
        if (text.includes('pg_advisory_xact_lock')) return { rows: [{}] }
        if (text.includes('insert into number_sequences')) {
          state.sequenceAllocations++
          return { rows: [{ prefix: 'PAY-', next_number: 3, padding: 6 }] }
        }
        if (text.includes('insert into documents')) {
          if (state.inserted) return { rows: [] }
          state.inserted = true
          return { rows: [{ id: state.requestKey }] }
        }
        if (text.includes('insert into document_lines')) return { rows: [] }
        if (text.includes('insert into audit_log')) {
          state.auditInserts++
          return { rows: [] }
        }
        if (isPriorRead(text)) {
          return { rows: state.inserted && state.orgMatch ? [{ id: state.requestKey }] : [] }
        }
        if (text.includes('from audit_log')) return { rows: state.auditAfter ? [{ after: state.auditAfter }] : [] }
        if (text.includes('is_open_item')) return { rows: state.openLineScope }
        if (text.includes('from vendor_roles') || text.includes('from customer_roles')) {
          return { rows: state.roleExists ? [{ id: state.partyRow?.id ?? '' }] : [] }
        }
        if (text.includes('from parties')) return { rows: state.partyRow ? [state.partyRow] : [] }
        if (text.includes('from accounts')) return { rows: state.bankExists ? [{ id: '${BANK_ID}' }] : [] }
        if (text.includes('from subsidiaries')) return { rows: [{ id: '${SUB_ID}' }] }
        if (text.includes('from orgs')) return { rows: [{ baseCurrency: 'USD' }] }
        return { rows: [] }
      }
      export const db = {
        execute: async (query) => respond(query),
        transaction: async (work) => work({
          execute: async (query) => {
            state.transactionQueries.push(sqlText(query))
            return respond(query)
          },
        }),
      }
    `,
  ],
  [
    // Authenticate-first is observable here: the double reports whether any
    // session existed before the route parsed the body.
    "mock:authz",
    `const state = globalThis[Symbol.for('openbooks.payments-route-test')]
     export async function getAuthz() {
       if (!state.authenticated) return null
       return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, allowedSubsidiaryIds: null }
     }
     export function can(_authz, perm) { return state.permissions.includes(perm) }
     export function guardSubsidiaryScope(_authz, _subsidiaryId) {
       if (state.scopeDenied) return new Response(JSON.stringify({ error: 'not found' }), { status: 404 })
       return null
     }
     export function subsidiariesInScope() { return true }`,
  ],
  [
    "mock:payment-queries",
    `const state = globalThis[Symbol.for('openbooks.payments-route-test')]
     export async function openItemsForParty() { return state.openItems }
     export async function loadPaymentDocument(id, kind, orgId) {
       if (!state.inserted || id !== state.requestKey) return null
       return { doc: { id, kind, org_id: orgId, document_number: 'PAY-000003' }, bankAccountId: null, allocations: [], applied: [] }
     }`,
  ],
  [
    "mock:clock",
    `export async function businessToday() { return globalThis[Symbol.for('openbooks.payments-route-test')].clockDate }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../../lib/authz", "mock:authz"],
  ["@/lib/authz", "mock:authz"],
  ["@openbooks/engine/src/payments/payment-queries.ts", "mock:payment-queries"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:clock"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    const mocked = mockUrls.get(specifier);
    if (mocked) return { url: mocked, shortCircuit: true };
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    const source = mockSources.get(url);
    if (source !== undefined)
      return { format: "module", source, shortCircuit: true };
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?payments-create-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.requestKey = null;
  state.clockDate = "2026-09-22";
  state.inserted = false;
  state.orgMatch = true;
  state.authenticated = true;
  state.permissions = ["ap.pay", "ar.pay"];
  state.scopeDenied = false;
  state.partyRow = { id: VENDOR_ID, subsidiaryId: SUB_ID };
  state.roleExists = true;
  state.bankExists = true;
  state.openItems = [];
  state.openLineScope = [];
  state.auditAfter = null;
  state.sequenceAllocations = 0;
  state.auditInserts = 0;
  state.transactionQueries.length = 0;
}

const SIMPLE = {
  kind: "vendor_payment",
  partyId: VENDOR_ID,
  bankAccountId: BANK_ID,
  documentDate: "2026-09-22",
  referenceNumber: "EFT-1",
  memo: "rent",
};

const APPLIED = {
  ...SIMPLE,
  allocations: [
    {
      openLineId: LINE_ID,
      sourceTransactionAmount: "50.00",
      targetTransactionAmount: "50.00",
      settlementRate: "1",
      settlementRateSource: "same_currency",
      settlementRateReference: "same transaction currency",
    },
  ],
};

function withOpenBill(): void {
  state.openItems = [
    {
      lineId: LINE_ID,
      transactionOpen: "50.00",
      currency: "USD",
      documentNumber: "BILL-1",
      entryNumber: "3",
    },
  ];
  state.openLineScope = [{ id: LINE_ID, subsidiaryId: SUB_ID }];
}

function post(
  key: string | null,
  body: Record<string, unknown>,
  { authenticated = true }: { authenticated?: boolean } = {},
): Promise<Response> {
  state.requestKey = key;
  state.authenticated = authenticated;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["Idempotency-Key"] = key;
  return POST(
    new Request("http://openbooks.test/api/payments", {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    }),
  );
}

/** The audit INSERT carries the immutable create snapshot; capture it so a
 *  replay can be compared against exactly what the route wrote. */
function captureAuditAfter(): void {
  const insert = state.transactionQueries.find((q) => q.includes("insert into audit_log"));
  assert.ok(insert, "the create must write one audit row");
  const start = insert.indexOf('{"before":null,"after":');
  assert.ok(start >= 0, "the audit row must carry the before/after image");
  const raw = insert.slice(start);
  let depth = 0;
  let end = -1;
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] === "{") depth++;
    else if (raw[i] === "}") {
      depth--;
      if (depth === 0) {
        end = i + 1;
        break;
      }
    }
  }
  assert.ok(end > 0, "the audit image must be balanced JSON");
  const image = JSON.parse(raw.slice(0, end)) as { after: unknown };
  assert.ok(
    String(JSON.stringify(image.after)).includes(state.requestKey ?? "never"),
    "the audit image must carry the request correlation",
  );
  state.auditAfter = image.after;
}

test("payment creation replays only the exact request for an idempotency key", async () => {
  reset();
  withOpenBill();
  const key = "00000000-0000-4000-8000-00000000d010";

  const created = await post(key, APPLIED);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    doc: { id: key, kind: "vendor_payment", org_id: ORG_ID, document_number: "PAY-000003" },
    bankAccountId: null,
    allocations: [],
    applied: [],
  });
  captureAuditAfter();
  assert.equal(state.auditInserts, 1);

  const replay = await post(key, APPLIED);
  assert.equal(replay.status, 200);

  const changed = await post(key, { ...APPLIED, memo: "renamed" });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });
});

test("serial retries of the same key allocate the number exactly once", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000d011";

  const first = await post(key, SIMPLE);
  assert.equal(first.status, 201);
  captureAuditAfter();
  const second = await post(key, SIMPLE);
  assert.equal(second.status, 200);
  assert.equal(state.sequenceAllocations, 1);
  assert.equal(state.auditInserts, 1);
});

test("unauthenticated callers are refused before any schema is evaluated", async () => {
  reset();
  const response = await post("00000000-0000-4000-8000-00000000d012", { kind: "bogus" }, { authenticated: false });
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: "unauthorized" });
  assert.equal(state.transactionQueries.length, 0, "no database work may precede authentication");
});

test("a kind without its permission is refused", async () => {
  reset();
  state.permissions = ["ap.pay"];
  const response = await post("00000000-0000-4000-8000-00000000d013", { ...SIMPLE, kind: "customer_payment" });
  assert.equal(response.status, 403);
  assert.deepEqual(await response.json(), { error: "missing permission: ar.pay" });
});

test("creation without or with a malformed key is refused before any write", async () => {
  for (const key of [null, "", "not-a-uuid"]) {
    reset();
    const response = await post(key, SIMPLE);
    assert.equal(response.status, 400, JSON.stringify(key));
    assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
    assert.equal(state.sequenceAllocations, 0, "no number may be allocated without a valid key");
  }
});

test("a foreign party and a foreign bank account are refused", async () => {
  reset();
  state.partyRow = null;
  const foreignParty = await post("00000000-0000-4000-8000-00000000d014", SIMPLE);
  assert.equal(foreignParty.status, 404);
  assert.deepEqual(await foreignParty.json(), { error: "party not found in this organization" });

  reset();
  state.bankExists = false;
  const foreignBank = await post("00000000-0000-4000-8000-00000000d015", SIMPLE);
  assert.equal(foreignBank.status, 404);
  assert.deepEqual(await foreignBank.json(), { error: "bank account not found in this organization" });

  assert.equal(state.sequenceAllocations, 0, "no number may be allocated for refused references");
});

test("allocating beyond the open balance is refused with the remedy", async () => {
  reset();
  withOpenBill();
  const over = await post("00000000-0000-4000-8000-00000000d016", {
    ...SIMPLE,
    allocations: [
      {
        openLineId: LINE_ID,
        sourceTransactionAmount: "60.00",
        targetTransactionAmount: "60.00",
        settlementRate: "1",
        settlementRateSource: "same_currency",
        settlementRateReference: "same transaction currency",
      },
    ],
  });
  assert.equal(over.status, 422);
  const body = (await over.json()) as { error: string };
  assert.match(body.error, /exceeds the open transaction balance 50\.00/);
});

test("an identical retry without a date replays 200 even after the business date changes", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000d020";
  // The drawer sends no date until the operator picks one
  // (documentDate: ... || undefined): the server defaults it from the clock.
  const dateless = {
    kind: "vendor_payment",
    partyId: VENDOR_ID,
    bankAccountId: BANK_ID,
    referenceNumber: "EFT-1",
    memo: "rent",
  };

  const first = await post(key, dateless);
  assert.equal(first.status, 201);
  captureAuditAfter();
  assert.match(
    JSON.stringify(state.auditAfter),
    /"document_date":"2026-09-22"/,
    "the persisted snapshot keeps the server-derived date",
  );

  // The clock moves before the retry arrives — the persisted date is now
  // stale, but the request is identical, so it must still replay.
  state.clockDate = "2026-09-23";
  const replay = await post(key, dateless);
  assert.equal(replay.status, 200);
  assert.equal(state.sequenceAllocations, 1, "the retry must not allocate a second number");
  assert.equal(state.auditInserts, 1, "the retry must not write a second audit row");
});

test("a key minted in another org cannot claim the row", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000d017";
  state.inserted = true;
  state.orgMatch = false;
  state.auditAfter = null;
  const claimed = await post(key, SIMPLE);
  assert.equal(claimed.status, 409);
  assert.deepEqual(await claimed.json(), { error: "invalid_idempotency_key" });
});
