import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";

// Unsaved-create contract for POST /api/journals: opening the drawer writes
// nothing and allocates no number; the drawer's explicit Save lands here
// exactly once — one idempotent, audited insert with the JE- number
// allocated inside the locked save transaction. A replay of the same request
// is a success, while reusing the key for a changed journal (or a key minted
// in another org) is a conflict and must never return the older journal as
// though it matched.
//
// The double covers the database, the clock, and authz. Request shaping,
// money parsing, custom-field and segment validation run REAL — only the
// rows they read come from the double.
const stateKey = Symbol.for("openbooks.journals-route-test");
const ORG_ID = "00000000-0000-4000-8000-00000000c001";
const USER_ID = "00000000-0000-4000-8000-00000000c002";
const SUB_ID = "00000000-0000-4000-8000-00000000c003";
const ACC_DEBIT = "00000000-0000-4000-8000-00000000c004";
const ACC_CREDIT = "00000000-0000-4000-8000-00000000c005";
const PARTY_ID = "00000000-0000-4000-8000-00000000c006";

interface RouteState {
  requestKey: string | null;
  clockDate: string;
  inserted: boolean;
  orgMatch: boolean;
  subsidiaryRows: { id: string; base_currency: string }[];
  accountRows: { id: string }[];
  refRows: { id: string }[];
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
  subsidiaryRows: [{ id: SUB_ID, base_currency: "USD" }],
  accountRows: [{ id: ACC_DEBIT }, { id: ACC_CREDIT }],
  refRows: [{ id: PARTY_ID }],
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
).openbooksJournalsSqlText = sqlText;

const mockSources = new Map<string, string>([
  [
    "mock:db",
    `
      const state = globalThis[Symbol.for('openbooks.journals-route-test')]
      const sqlText = globalThis.openbooksJournalsSqlText
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
          return { rows: [{ prefix: 'JE-', next_number: 7, padding: 6 }] }
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
        if (text.includes('from subsidiaries')) return { rows: state.subsidiaryRows }
        if (text.includes('from accounts')) return { rows: state.accountRows }
        if (text.includes('from departments') || text.includes('from projects') || text.includes('from parties')) {
          return { rows: state.refRows }
        }
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
      // Modules the route pulls in transitively (subsidiaries, segments)
      // import the tenant-context helpers from this same module; the double
      // stands in for the whole module, so it must offer them too.
      export function ambientTenantOrgId() { return '${ORG_ID}' }
      export function withBypassContext(fn) { return fn() }
      export function withOrgContext(_orgId, fn) { return fn() }
    `,
  ],
  [
    "mock:authz",
    `export async function guardPermission() {
       return { user: { orgId: '${ORG_ID}', id: '${USER_ID}' }, allowedSubsidiaryIds: null }
     }
     export function subsidiariesInScope() { return true }`,
  ],
  [
    "mock:journals-lib",
    `const state = globalThis[Symbol.for('openbooks.journals-route-test')]
     export async function loadJournalDoc(id, orgId) {
       if (!state.inserted || id !== state.requestKey) return null
       return { doc: { id, org_id: orgId, kind: 'journal', document_number: 'JE-000007' }, lines: [] }
     }`,
  ],
  [
    "mock:clock",
    `export async function businessToday() { return globalThis[Symbol.for('openbooks.journals-route-test')].clockDate }
     // Custom-field validation runs REAL and reads its date predicate from
     // this same module, so the double carries the real rule rather than a
     // stub that would let any string through.
     export function isIsoCalendarDate(value) {
       if (typeof value !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}$/.test(value)) return false
       const [y, m, d] = value.split('-').map(Number)
       const date = new Date(Date.UTC(y, m - 1, d))
       return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d
     }`,
  ],
]);

const mockUrls = new Map<string, string>([
  ["@openbooks/engine/src/platform/db.ts", "mock:db"],
  ["../../../lib/authz", "mock:authz"],
  ["../../../lib/journals", "mock:journals-lib"],
  ["./journals", "mock:journals-lib"],
  ["@openbooks/engine/src/platform/business-date.ts", "mock:clock"],
]);

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    // Server-module guard: the route's transitive imports mark themselves
    // server-only, which throws outside a Next render. The repo's route
    // tests neutralize it the same way.
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
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

const routeUrl = "./route.ts?journals-create-test";
const { POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

function reset(): void {
  state.requestKey = null;
  state.clockDate = "2026-09-22";
  state.inserted = false;
  state.orgMatch = true;
  state.subsidiaryRows = [{ id: SUB_ID, base_currency: "USD" }];
  state.accountRows = [{ id: ACC_DEBIT }, { id: ACC_CREDIT }];
  state.refRows = [{ id: PARTY_ID }];
  state.auditAfter = null;
  state.sequenceAllocations = 0;
  state.auditInserts = 0;
  state.transactionQueries.length = 0;
}

const BALANCED = {
  documentDate: "2026-09-22",
  referenceNumber: "REF-1",
  memo: "opening",
  partyId: PARTY_ID,
  subsidiaryId: SUB_ID,
  lines: [
    { accountId: ACC_DEBIT, description: "cash", amount: "100.00" },
    { accountId: ACC_CREDIT, description: "revenue", amount: "-100.00" },
  ],
};

function post(key: string | null, body: Record<string, unknown>): Promise<Response> {
  state.requestKey = key;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["Idempotency-Key"] = key;
  return POST(
    new Request("http://openbooks.test/api/journals", {
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

test("journal creation replays only the exact request for an idempotency key", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c010";

  const created = await post(key, BALANCED);
  assert.equal(created.status, 201);
  assert.deepEqual(await created.json(), {
    doc: { id: key, org_id: ORG_ID, kind: "journal", document_number: "JE-000007" },
    lines: [],
  });
  captureAuditAfter();
  assert.equal(state.auditInserts, 1);

  const replay = await post(key, BALANCED);
  assert.equal(replay.status, 200);
  assert.deepEqual(await replay.json(), {
    doc: { id: key, org_id: ORG_ID, kind: "journal", document_number: "JE-000007" },
    lines: [],
  });

  const changed = await post(key, { ...BALANCED, memo: "renamed" });
  assert.equal(changed.status, 409);
  assert.deepEqual(await changed.json(), { error: "invalid_idempotency_key" });
});

test("serial retries of the same key allocate the number exactly once", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c011";

  const first = await post(key, BALANCED);
  assert.equal(first.status, 201);
  captureAuditAfter();
  const second = await post(key, BALANCED);
  assert.equal(second.status, 200);
  // The advisory lock serializes same-key requests and the pre-read finds
  // the committed row: the second save replays without touching the
  // sequence, and writes no second audit row.
  assert.equal(state.sequenceAllocations, 1);
  assert.equal(state.auditInserts, 1);
});

test("an identical retry without a date replays 200 even after the business date changes", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c020";
  // The drawer sends no date until the operator picks one
  // (documentDate: ... || undefined): the server defaults it from the clock.
  const dateless = {
    referenceNumber: "REF-1",
    memo: "opening",
    partyId: PARTY_ID,
    subsidiaryId: SUB_ID,
    lines: [
      { accountId: ACC_DEBIT, description: "cash", amount: "100.00" },
      { accountId: ACC_CREDIT, description: "revenue", amount: "-100.00" },
    ],
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
  assert.deepEqual(await replay.json(), {
    doc: { id: key, org_id: ORG_ID, kind: "journal", document_number: "JE-000007" },
    lines: [],
  });
  assert.equal(state.sequenceAllocations, 1, "the retry must not allocate a second number");
  assert.equal(state.auditInserts, 1, "the retry must not write a second audit row");
});

test("a key minted in another org cannot claim the row", async () => {
  reset();
  const key = "00000000-0000-4000-8000-00000000c012";
  state.inserted = true;
  state.orgMatch = false;
  state.auditAfter = null;
  const claimed = await post(key, BALANCED);
  assert.equal(claimed.status, 409);
  assert.deepEqual(await claimed.json(), { error: "invalid_idempotency_key" });
});

test("creation without or with a malformed key is refused before any write", async () => {
  for (const key of [null, "", "not-a-uuid"]) {
    reset();
    const response = await post(key, BALANCED);
    assert.equal(response.status, 400, JSON.stringify(key));
    assert.deepEqual(await response.json(), { error: "invalid_idempotency_key" });
    assert.ok(
      !state.transactionQueries.some((q) => q.includes("insert into documents")),
      "no journal may be written without a valid key",
    );
    assert.equal(state.sequenceAllocations, 0, "no number may be allocated without a valid key");
  }
});

test("unbalanced and empty journals are refused before any write", async () => {
  reset();
  const lopsided = await post("00000000-0000-4000-8000-00000000c013", {
    ...BALANCED,
    lines: [
      { accountId: ACC_DEBIT, amount: "100.00" },
      { accountId: ACC_CREDIT, amount: "-40.00" },
    ],
  });
  assert.equal(lopsided.status, 422);
  assert.deepEqual(await lopsided.json(), {
    error: "journal lines must balance with a non-zero total",
    field: "lines",
  });

  reset();
  const empty = await post("00000000-0000-4000-8000-00000000c014", { ...BALANCED, lines: [] });
  assert.equal(empty.status, 422);
  assert.ok(
    !state.transactionQueries.some((q) => q.includes("insert into documents")),
    "no journal may be written for refused lines",
  );
});

test("a foreign account is refused with a tenant-opaque 404", async () => {
  reset();
  state.accountRows = [{ id: ACC_DEBIT }];
  const response = await post("00000000-0000-4000-8000-00000000c015", BALANCED);
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "account not found in this organization" });
  assert.ok(
    !state.transactionQueries.some((q) => q.includes("insert into documents")),
    "no journal may be written with a foreign account",
  );
});
