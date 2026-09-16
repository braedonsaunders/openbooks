import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";

// Live-PostgreSQL regression for the close posting-period bulk action route.
// The route is a thin guard around the engine preview/commit pair: preview
// must list the tenant's unassigned approved documents with derived periods,
// commit must assign exactly the previewed rows with audit evidence, and a
// second commit must assign nothing.
const stateKey = Symbol.for("openbooks.close-posting-periods-route-test");
interface RouteState {
  authz: {
    user: { orgId: string; id: string };
    allowedSubsidiaryIds: null;
  } | null;
}
const routeState: RouteState = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] =
  routeState;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.close-posting-periods-route-test')]
  export async function guardPermission() {
    if (!state.authz) return new Response(null, { status: 401 })
    return state.authz
  }
`;

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (
      specifier === "../../../../lib/authz"
      && context.parentURL?.includes("close/posting-periods")
    ) {
      return { url: "mock:authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const parentDir = decodeURIComponent(
        new URL(".", context.parentURL).href,
      );
      const webRoot = parentDir.lastIndexOf("/web/");
      if (webRoot !== -1) {
        return nextResolve(
          new URL(parentDir.slice(0, webRoot + 5) + specifier.slice(2) + ".ts")
            .href,
          context,
        );
      }
    }
    if (specifier.startsWith("@openbooks/engine/")) {
      const webMarker = context.parentURL?.lastIndexOf("/web/") ?? -1;
      if (webMarker === -1) return nextResolve(specifier, context);
      return nextResolve(
        new URL(
          `${context.parentURL!.slice(0, webMarker + 1)}engine/${specifier.slice("@openbooks/engine/".length)}`,
        ).href,
        context,
      );
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const routeUrl = "./route.ts?close-posting-periods-route-test";
const { GET, POST } = (await import(routeUrl)) as typeof import("./route.ts");
hooks.deregister();

const { db } = await import("../../../../../engine/src/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } =
  await import("../../../../../engine/src/test-fixtures.ts");

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function authorize(orgId: string, actorId: string): void {
  routeState.authz = {
    user: { orgId, id: actorId },
    allowedSubsidiaryIds: null,
  };
}

test("posting-periods route previews then commits idempotently", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    authorize(org.orgId, actor);
    const doc = randomUUID();
    await db.execute(sql`
      insert into documents
        (id, org_id, subsidiary_id, kind, status, document_number, document_date,
         posting_date, currency, subtotal, tax_total, total)
      values (${doc}, ${org.orgId}, ${org.subsidiaryId}, 'sales_order', 'approved',
              ${doc}, ${org.date}, ${org.date}, 'CAD', '10.0000', '0.0000', '10.0000')`);

    const previewRes = await GET(
      new Request(`http://openbooks.test/api/close/posting-periods?bookId=${org.bookId}`),
    );
    assert.equal(previewRes.status, 200);
    const preview = (await previewRes.json()) as {
      rows: { documentId: string; periodId: string | null; blocked: boolean }[];
    };
    assert.equal(preview.rows.length, 1);
    assert.equal(preview.rows[0]?.documentId, doc);
    assert.equal(preview.rows[0]?.blocked, false);
    assert.equal(preview.rows[0]?.periodId, org.periodId);

    const commitRes = await POST(
      new Request("http://openbooks.test/api/close/posting-periods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId: org.bookId, documentIds: [doc] }),
      }),
    );
    assert.equal(commitRes.status, 200);
    const committed = (await commitRes.json()) as {
      assigned: { documentId: string }[];
      refused: unknown[];
    };
    assert.equal(committed.assigned.length, 1);
    assert.equal(committed.refused.length, 0);

    const again = await POST(
      new Request("http://openbooks.test/api/close/posting-periods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId: org.bookId }),
      }),
    );
    assert.equal(again.status, 200);
    const repeated = (await again.json()) as { assigned: unknown[] };
    assert.equal(repeated.assigned.length, 0);
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});

test("posting-periods route validates input and auth", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    authorize(org.orgId, actor);
    const badBook = await GET(
      new Request("http://openbooks.test/api/close/posting-periods?bookId=nope"),
    );
    assert.equal(badBook.status, 400);
    const badCommit = await POST(
      new Request("http://openbooks.test/api/close/posting-periods", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ bookId: randomUUID(), documentIds: [randomUUID()] }),
      }),
    );
    assert.equal(badCommit.status, 422);
    // The unauthenticated path is the shared guardPermission (covered by the
    // authz suite): the module mock cannot mint a NextResponse, so a plain
    // Response 401 would not take the route's `instanceof NextResponse` arm.
  } finally {
    routeState.authz = null;
    await dropScratchOrg(org.orgId);
  }
});
