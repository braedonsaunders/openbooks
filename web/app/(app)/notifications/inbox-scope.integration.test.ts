import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Behavioral proof for the notifications authorization boundary.
//
// The inbox module carries no permission key, so the API route is the
// entire boundary: every query must filter on the session user AND their
// org. There is no committed inbox page on main yet (its loader lives in
// another developer's in-flight work), so this file pins the route the
// header bell and any future page both share: seeded under bypass, read
// and written as the user under an org context, with a second user's rows
// and a second org's rows present to be leaked. When the page lands, its
// loader must earn its own assertions here — a permissionless module with
// only source-text pinning is how a dropped filter reads as a refactor.
const stateKey = Symbol.for("openbooks.notifications-inbox-scope-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.notifications-inbox-scope-test')]
  export async function getAuthz() { return state.authz }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (
      specifier === "../../../lib/authz" &&
      context.parentURL?.includes("/api/notifications/")
    ) {
      return { url: "mock:notifications-scope-authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    // node_modules is shared with the main checkout: pin bare self-imports
    // to this checkout so the route and the test share one db context.
    if (specifier.startsWith("@openbooks/engine/")) {
      const root = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 1);
      return nextResolve(
        new URL(`engine/${specifier.slice("@openbooks/engine/".length)}`, root).href,
        context,
      );
    }
    if (context.parentURL?.startsWith("mock:")) {
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === "mock:notifications-scope-authz") {
      return { format: "module", source: mockAuthz, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { GET, PATCH } = await import("../../api/notifications/route.ts");
type Authz = import("@/lib/authz.ts").Authz;

const DB = !!process.env.OPENBOOKS_DB_URL;

function authzFor(orgId: string, userId: string, name: string): Authz {
  return {
    user: {
      id: userId, email: `${userId}@scratch.test`, name, orgId,
      roles: [{ key: "clerk", name: "clerk" }],
      envKind: "sandbox", productionOrgId: orgId, isSuperAdmin: false,
      homeUserId: userId, homeOrgId: orgId,
    },
    permissions: new Set(),
    allowedSubsidiaryIds: null,
  };
}

async function seedNotification(
  orgId: string,
  userId: string,
  title: string,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into notifications (id, org_id, user_id, kind, title, body, href, read_at)
    values (${id}, ${orgId}, ${userId}, 'approval', ${title}, null, null, null)`);
  return id;
}

async function readAt(id: string): Promise<string | null> {
  const found = await db.execute<{ read_at: string | null }>(
    sql`select read_at from notifications where id = ${id}`,
  );
  return found.rows[0]?.read_at ?? null;
}

function patchRequest(body: unknown): Request {
  return new Request("http://localhost/api/notifications", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

interface BellPayload {
  items: {
    id: string;
    kind: string;
    title: string;
    body: string | null;
    href: string | null;
    readAt: string | null;
    createdAt: string;
  }[];
  unread: number;
}

async function bellView(orgId: string): Promise<BellPayload> {
  const res = await withOrgContext(orgId, () => GET());
  assert.equal(res.status, 200);
  return (await res.json()) as BellPayload;
}

test("the bell serves the reader their own rows and nobody else's", { skip: !DB }, async () => {
  const orgA = await withBypass(() => createScratchOrg());
  const orgB = await withBypass(() => createScratchOrg());
  try {
    const alice = await withBypass(() => createScratchUser(orgA.orgId, "Inbox Alice", "clerk"));
    const mallory = await withBypass(() => createScratchUser(orgA.orgId, "Inbox Mallory", "clerk"));
    const bob = await withBypass(() => createScratchUser(orgB.orgId, "Inbox Bob", "clerk"));
    await withBypass(async () => {
      await seedNotification(orgA.orgId, alice, "alice unread approval");
      await seedNotification(orgA.orgId, mallory, "mallory unread approval");
      await seedNotification(orgB.orgId, bob, "bob unread approval");
    });

    state.authz = authzFor(orgA.orgId, alice, "Inbox Alice");
    const aliceView = await bellView(orgA.orgId);
    assert.deepEqual(
      aliceView.items.map((item) => item.title),
      ["alice unread approval"],
    );
    assert.equal(aliceView.unread, 1);
    // The payload carries every field the bell renders or acts on.
    const row = aliceView.items[0]!;
    assert.ok(typeof row.id === "string");
    assert.equal(row.kind, "approval");
    assert.equal(row.body, null);
    assert.equal(row.href, null);
    assert.equal(row.readAt, null);
    assert.ok(typeof row.createdAt === "string");

    // The other org's reader sees only their own row.
    state.authz = authzFor(orgB.orgId, bob, "Inbox Bob");
    const bobView = await bellView(orgB.orgId);
    assert.deepEqual(
      bobView.items.map((item) => item.title),
      ["bob unread approval"],
    );
    assert.equal(bobView.unread, 1);

    // The RLS backstop: Alice's session under Bob's org sees nothing, even
    // though her user predicate alone would match her rows.
    state.authz = authzFor(orgA.orgId, alice, "Inbox Alice");
    const wrongOrg = await bellView(orgB.orgId);
    assert.equal(wrongOrg.items.length, 0);
    assert.equal(wrongOrg.unread, 0);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(orgA.orgId));
    await withBypass(() => dropScratchOrg(orgB.orgId));
  }
});

test("mark-read touches only the caller's own rows", { skip: !DB }, async () => {
  const orgA = await withBypass(() => createScratchOrg());
  const orgB = await withBypass(() => createScratchOrg());
  try {
    const alice = await withBypass(() => createScratchUser(orgA.orgId, "Patch Alice", "clerk"));
    const mallory = await withBypass(() => createScratchUser(orgA.orgId, "Patch Mallory", "clerk"));
    const bob = await withBypass(() => createScratchUser(orgB.orgId, "Patch Bob", "clerk"));
    const ids = await withBypass(async () => ({
      alice: await seedNotification(orgA.orgId, alice, "alice patchable"),
      mallory: await seedNotification(orgA.orgId, mallory, "mallory patchable"),
      bob: await seedNotification(orgB.orgId, bob, "bob patchable"),
    }));

    // Mallory names Alice's row and Bob's row: 404 with the named error,
    // and the ownership check runs before any write, so both stay unread.
    state.authz = authzFor(orgA.orgId, mallory, "Patch Mallory");
    const forbidden = await withOrgContext(orgA.orgId, () =>
      PATCH(patchRequest({ ids: [ids.alice, ids.bob] })),
    );
    assert.equal(forbidden.status, 404);
    assert.deepEqual(await forbidden.json(), {
      error: "some notifications are not yours — they may belong to someone else or no longer exist",
    });
    assert.equal(await withBypass(() => readAt(ids.alice)), null);
    assert.equal(await withBypass(() => readAt(ids.bob)), null);
    assert.equal(await withBypass(() => readAt(ids.mallory)), null);

    // Alice marks her own row: read. Mallory's row is untouched.
    state.authz = authzFor(orgA.orgId, alice, "Patch Alice");
    const own = await withOrgContext(orgA.orgId, () => PATCH(patchRequest({ ids: [ids.alice] })));
    assert.equal(own.status, 200);
    assert.notEqual(await withBypass(() => readAt(ids.alice)), null);
    assert.equal(await withBypass(() => readAt(ids.mallory)), null);

    // Mark-all-read clears Alice's remaining rows and nothing else.
    const second = await withBypass(() =>
      seedNotification(orgA.orgId, alice, "alice second"),
    );
    const cleared = await withOrgContext(orgA.orgId, () => PATCH(patchRequest({ all: true })));
    assert.equal(cleared.status, 200);
    assert.notEqual(await withBypass(() => readAt(second)), null);
    assert.equal(await withBypass(() => readAt(ids.mallory)), null);
    assert.equal(await withBypass(() => readAt(ids.bob)), null);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(orgA.orgId));
    await withBypass(() => dropScratchOrg(orgB.orgId));
  }
});
