import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// The inbox module carries no permission key, so the loader and the
// mark-read API are the entire authorization boundary: every query must
// filter on the session user AND their org. The co-located scope test pins
// the source text; this file proves the behavior — seeded under bypass,
// read as the user under an org context, with a second user's rows and a
// second org's rows present to be leaked.
const stateKey = Symbol.for("openbooks.notifications-inbox-scope-test");
const state: { authz: unknown } = { authz: null };
(globalThis as typeof globalThis & Record<symbol, unknown>)[stateKey] = state;

const mockAuthz = `
  const state = globalThis[Symbol.for('openbooks.notifications-inbox-scope-test')]
  export async function getAuthz() { return state.authz }
`;
const mockIntl = `
  export async function getTranslations() { return (key) => key }
  export async function getFormatter() { return { dateTime: (d) => d.toISOString() } }
  export async function getLocale() { return 'en' }
`;
const mockNavigation = `
  export function redirect() { throw new Error('redirect') }
`;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    if (specifier === "next-intl/server") {
      return { url: "mock:notifications-scope-intl", shortCircuit: true };
    }
    if (specifier === "next/navigation" && context.parentURL?.includes("/notifications")) {
      return { url: "mock:notifications-scope-navigation", shortCircuit: true };
    }
    if (
      specifier === "../../../lib/authz" &&
      (context.parentURL?.includes("/notifications/") || context.parentURL?.includes("/api/notifications/"))
    ) {
      return { url: "mock:notifications-scope-authz", shortCircuit: true };
    }
    if (specifier.startsWith("@/")) {
      const webRoot = import.meta.url.slice(0, import.meta.url.indexOf("/web/") + 5);
      return nextResolve(new URL(`${specifier.slice(2)}.ts`, webRoot).href, context);
    }
    // node_modules is shared with the main checkout: pin bare self-imports
    // to this checkout so the loader and the test share one db context.
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
    if (url === "mock:notifications-scope-intl") {
      return { format: "module", source: mockIntl, shortCircuit: true };
    }
    if (url === "mock:notifications-scope-navigation") {
      return { format: "module", source: mockNavigation, shortCircuit: true };
    }
    return nextLoad(url, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypass, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import(
  "@openbooks/engine/src/test-fixtures.ts"
);
const { loadNotifications } = await import("./view.ts");
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
  read: boolean,
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`insert into notifications (id, org_id, user_id, kind, title, body, href, read_at)
    values (${id}, ${orgId}, ${userId}, 'approval', ${title}, null, null,
      ${read ? sql`now()` : null})`);
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

test("inbox shows the reader their own rows and nobody else's", { skip: !DB }, async () => {
  const orgA = await withBypass(() => createScratchOrg());
  const orgB = await withBypass(() => createScratchOrg());
  try {
    const alice = await withBypass(() => createScratchUser(orgA.orgId, "Inbox Alice", "clerk"));
    const mallory = await withBypass(() => createScratchUser(orgA.orgId, "Inbox Mallory", "clerk"));
    const bob = await withBypass(() => createScratchUser(orgB.orgId, "Inbox Bob", "clerk"));
    await withBypass(async () => {
      await seedNotification(orgA.orgId, alice, "alice unread approval", false);
      await seedNotification(orgA.orgId, alice, "alice read flow", true);
      await seedNotification(orgA.orgId, mallory, "mallory unread approval", false);
      await seedNotification(orgB.orgId, bob, "bob unread approval", false);
    });

    // Default tab is unread: one row, and the counts agree with the rows.
    state.authz = authzFor(orgA.orgId, alice, "Inbox Alice");
    const unread = await withOrgContext(orgA.orgId, () => loadNotifications({}));
    assert.equal(unread.rows.length, 1);
    assert.equal(unread.rows[0]!.title, "alice unread approval");
    assert.equal(unread.rows[0]!.read, false);
    assert.equal(unread.unread, 1);
    assert.equal(unread.total, 1);

    // Everything tab adds the read row — still nobody else's.
    const all = await withOrgContext(orgA.orgId, () => loadNotifications({ scope: "all" }));
    assert.deepEqual(
      all.rows.map((row) => row.title).sort(),
      ["alice read flow", "alice unread approval"],
    );
    assert.equal(all.total, 2);
    assert.equal(all.unread, 1);

    // The other org's reader sees only their own row.
    state.authz = authzFor(orgB.orgId, bob, "Inbox Bob");
    const bobView = await withOrgContext(orgB.orgId, () => loadNotifications({ scope: "all" }));
    assert.deepEqual(bobView.rows.map((row) => row.title), ["bob unread approval"]);

    // The RLS backstop: Alice's session under Bob's org sees nothing, even
    // though her user predicate alone would match her rows.
    state.authz = authzFor(orgA.orgId, alice, "Inbox Alice");
    const wrongOrg = await withOrgContext(orgB.orgId, () => loadNotifications({ scope: "all" }));
    assert.equal(wrongOrg.rows.length, 0);
    assert.equal(wrongOrg.total, 0);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(orgA.orgId));
    await withBypass(() => dropScratchOrg(orgB.orgId));
  }
});

test("a reader with no notifications gets an honest empty inbox", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const carol = await withBypass(() => createScratchUser(org.orgId, "Inbox Carol", "clerk"));
    state.authz = authzFor(org.orgId, carol, "Inbox Carol");
    const data = await withOrgContext(org.orgId, () => loadNotifications({}));
    assert.equal(data.rows.length, 0);
    assert.equal(data.isEmpty, true);
    assert.equal(data.hasRows, false);
    assert.equal(data.total, 0);
    assert.equal(data.unread, 0);
    assert.ok(data.emptyTitle.length > 0);
    assert.ok(data.emptyDescription.length > 0);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(org.orgId));
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
      alice: await seedNotification(orgA.orgId, alice, "alice patchable", false),
      mallory: await seedNotification(orgA.orgId, mallory, "mallory patchable", false),
      bob: await seedNotification(orgB.orgId, bob, "bob patchable", false),
    }));

    // Mallory names Alice's row and Bob's row: both stay unread.
    state.authz = authzFor(orgA.orgId, mallory, "Patch Mallory");
    const forbidden = await withOrgContext(orgA.orgId, () =>
      PATCH(patchRequest({ ids: [ids.alice, ids.bob] })),
    );
    assert.equal(forbidden.status, 200);
    assert.equal(await withBypass(() => readAt(ids.alice)), null);
    assert.equal(await withBypass(() => readAt(ids.bob)), null);

    // Alice marks her own row: read. Mallory's row is untouched.
    state.authz = authzFor(orgA.orgId, alice, "Patch Alice");
    const own = await withOrgContext(orgA.orgId, () => PATCH(patchRequest({ ids: [ids.alice] })));
    assert.equal(own.status, 200);
    assert.notEqual(await withBypass(() => readAt(ids.alice)), null);
    assert.equal(await withBypass(() => readAt(ids.mallory)), null);

    // Mark-all-read clears Alice's remaining rows and nothing else.
    const second = await withBypass(() =>
      seedNotification(orgA.orgId, alice, "alice second", false),
    );
    const cleared = await withOrgContext(orgA.orgId, () => PATCH(patchRequest({ all: true })));
    assert.equal(cleared.status, 200);
    assert.notEqual(await withBypass(() => readAt(second)), null);
    assert.equal(await withBypass(() => readAt(ids.mallory)), null);
    assert.equal(await withBypass(() => readAt(ids.bob)), null);

    // The bell's old GET contract still serves the page's sibling: latest
    // rows for the caller plus their unread count, nobody else's.
    state.authz = authzFor(orgA.orgId, mallory, "Patch Mallory");
    const bell = await withOrgContext(orgA.orgId, () => GET());
    assert.equal(bell.status, 200);
    const payload = (await bell.json()) as { items: { title: string }[]; unread: number };
    assert.deepEqual(payload.items.map((item) => item.title), ["mallory patchable"]);
    assert.equal(payload.unread, 1);
  } finally {
    state.authz = null;
    await withBypass(() => dropScratchOrg(orgA.orgId));
    await withBypass(() => dropScratchOrg(orgB.orgId));
  }
});
