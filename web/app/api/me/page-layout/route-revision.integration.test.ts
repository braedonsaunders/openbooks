import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-Postgres regression for /api/me/page-layout revision fencing.
// Rapid whole-layout saves used to commit in arrival order with no fence:
// hiding A then B could end with B silently reappearing when the delayed
// A-request committed last. Every PUT now carries the exact revision token
// from its last read; a stale token is a 409 carrying the current layout so
// the writer merges and retries instead of clobbering.

const stateKey = Symbol.for("openbooks.page-layout-revision-integration");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    permissions: Set<string>;
    allowedSubsidiaryIds: Set<string> | null;
  } | null;
}
const routeState: RouteState = { authz: null };
;(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.page-layout-revision-integration')]
  export async function getAuthz() {
    return state.authz
  }
  export function can() {
    return true
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/") && context.parentURL) {
      return nextResolve(new URL(`../../../../${specifier.slice(2)}.ts`, context.parentURL).href, context);
    }
    if (specifier === "../../../../lib/authz" && context.parentURL?.includes("me/page-layout/route")) {
      return { url: "mock:page-layout-authz", shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:page-layout-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?page-layout-revision-integration";
const { GET, PUT } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { mergePageLayouts } = await import("../../../../lib/page-layout-shared.ts");
const { createScratchOrg, createScratchUser } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);

const PAGE = "banking-accounts";

async function seed(): Promise<{ orgId: string; actorId: string }> {
  const org = await createScratchOrg();
  const actorId = await createScratchUser(org.orgId, "Layout User", "admin");
  routeState.authz = {
    user: { orgId: org.orgId, id: actorId },
    permissions: new Set(["*"]),
    allowedSubsidiaryIds: null,
  };
  return { orgId: org.orgId, actorId };
}

function putRequest(body: unknown): Request {
  return new Request("http://localhost/api/me/page-layout", {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(): Request {
  return new Request(`http://localhost/api/me/page-layout?page=${PAGE}`, { method: "GET" });
}

async function storedLayout(orgId: string, actorId: string): Promise<{ layout: unknown; revision: string }> {
  const r = await db.execute<{ layout: unknown; revision: string }>(sql`
    select layout,
           to_char(updated_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as revision
      from user_page_layouts
     where org_id = ${orgId} and user_id = ${actorId} and page = ${PAGE}
  `);
  assert.equal(r.rows.length, 1, "exactly one layout row must be stored");
  return { layout: r.rows[0]!.layout, revision: r.rows[0]!.revision };
}

test(
  "first save with a null revision creates the row and returns its token",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const res = await PUT(putRequest({ page: PAGE, layout: { hidden: ["a"] }, expectedRevision: null }));
    assert.equal(res.status, 200);
    const body = (await res.json()) as { revision: string };
    assert.match(body.revision, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);

    const get = await GET(getRequest());
    assert.equal(get.status, 200);
    assert.deepEqual(await get.json(), { layout: { hidden: ["a"] }, revision: body.revision });
    assert.deepEqual((await storedLayout(f.orgId, f.actorId)).layout, { hidden: ["a"] });
  },
);

test(
  "a stale revision is a 409 carrying current; the current one succeeds",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const first = (await (
      await PUT(putRequest({ page: PAGE, layout: { hidden: ["a"] }, expectedRevision: null }))
    ).json()) as { revision: string };

    // A save that read before the parallel commit must not silently win.
    const stale2 = await PUT(
      putRequest({ page: PAGE, layout: { hidden: ["b"] }, expectedRevision: "2000-01-01T00:00:00.000000Z" }),
    );
    assert.equal(stale2.status, 409);
    const conflict = (await stale2.json()) as {
      error: string;
      current: { layout: { hidden: string[] }; revision: string };
    };
    assert.match(conflict.error, /changed after you opened it/);
    assert.deepEqual(conflict.current.layout, { hidden: ["a"] });
    assert.equal(conflict.current.revision, first.revision);

    const fresh = await PUT(
      putRequest({ page: PAGE, layout: { hidden: ["a", "b"] }, expectedRevision: first.revision }),
    );
    assert.equal(fresh.status, 200);
    assert.notEqual(
      ((await fresh.json()) as { revision: string }).revision,
      first.revision,
      "a committed save must advance the revision token",
    );
    assert.deepEqual((await storedLayout(f.orgId, f.actorId)).layout, { hidden: ["a", "b"] });
  },
);

test(
  "a missing revision is a 409 naming the remedy, not a silent overwrite",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    await seed();
    const res = await PUT(putRequest({ page: PAGE, layout: { hidden: ["a"] } }));
    assert.equal(res.status, 409);
    assert.match(((await res.json()) as { error: string }).error, /revision is required/);
  },
);

test(
  "two writers on one base revision: the second 409s, then reconciles to the union",
  { skip: !process.env.OPENBOOKS_DB_URL },
  async () => {
    const f = await seed();
    const base = (await (
      await PUT(putRequest({ page: PAGE, layout: {}, expectedRevision: null }))
    ).json()) as { revision: string };

    // Writer A hides account A and commits.
    const writerA = await PUT(
      putRequest({ page: PAGE, layout: { hidden: ["a"] }, expectedRevision: base.revision }),
    );
    assert.equal(writerA.status, 200);
    const revisionA = ((await writerA.json()) as { revision: string }).revision;

    // Writer B hid account B from the same base — its whole-state write must
    // not resurrect pre-A state.
    const writerB = await PUT(
      putRequest({ page: PAGE, layout: { hidden: ["b"] }, expectedRevision: base.revision }),
    );
    assert.equal(writerB.status, 409);
    const conflict = (await writerB.json()) as {
      current: { layout: { hidden: string[] }; revision: string };
    };
    assert.deepEqual(conflict.current.layout, { hidden: ["a"] });

    // Reconcile to the union and retry once with the live token.
    const merged = mergePageLayouts(conflict.current.layout, { hidden: ["b"] });
    assert.deepEqual(merged, { hidden: ["a", "b"] });
    const retry = await PUT(
      putRequest({ page: PAGE, layout: merged, expectedRevision: conflict.current.revision }),
    );
    assert.equal(retry.status, 200);
    assert.notEqual(((await retry.json()) as { revision: string }).revision, revisionA);
    assert.deepEqual((await storedLayout(f.orgId, f.actorId)).layout, { hidden: ["a", "b"] });
  },
);
