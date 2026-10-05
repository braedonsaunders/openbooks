import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";
import type { SessionUser } from "./auth";

const session: { user: SessionUser | null } = { user: null };
Object.assign(globalThis, { __channelScopeSession: session });
registerHooks({ resolve(specifier, context, next) {
  if (specifier === "./auth" && context.parentURL?.endsWith("/web/lib/authz.ts")) {
    return { shortCircuit: true, url: "data:text/javascript,export async function currentUser(){return globalThis.__channelScopeSession.user}" };
  }
  return next(specifier, context);
} });
const { sql } = await import("drizzle-orm");
const { db, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrgReporting } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { createChannel, ensureShopifyAdapterRegistered } = await import("@openbooks/engine/commerce");
ensureShopifyAdapterRegistered();
const channelsRoute = await import("../app/api/channels/route");
const channelRoute = await import("../app/api/channels/[id]/route");

test("a subsidiary-restricted channel manager sees and changes only channels of their own entities", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  const org = await createScratchOrg();
  try {
    const childId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country)
      select ${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Child entity', base_currency, country
        from subsidiaries where id = ${org.subsidiaryId} and org_id = ${org.orgId}`);
    const actor = await createScratchUser(org.orgId, "Channel manager", "channels");
    await db.execute(sql`
      update app_roles set permissions = '["channels.read","channels.manage"]'::jsonb,
             subsidiary_restriction = ${JSON.stringify({ mode: "list", subsidiaryIds: [childId] })}::jsonb
       where org_id = ${org.orgId} and key = 'channels'`);
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features,salesChannels}', 'true'::jsonb, true) where id = ${org.orgId}`);
    const rootChannel = await withOrgContext(org.orgId, () => createChannel(org.orgId, actor, {
      kind: "shopify", name: "Root store", subsidiaryId: org.subsidiaryId, currency: "USD", externalAccount: "root.example",
    }));
    const childChannel = await withOrgContext(org.orgId, () => createChannel(org.orgId, actor, {
      kind: "shopify", name: "Child store", subsidiaryId: childId, currency: "USD", externalAccount: "child.example",
    }));
    session.user = { id: actor, orgId: org.orgId, name: "Channel manager", email: "channels@scratch.test", roles: [], isSuperAdmin: false,
      envKind: "production", productionOrgId: org.orgId, homeOrgId: org.orgId, homeUserId: actor };
    const call = <T extends (...args: never[]) => Promise<Response>>(handler: T, ...args: Parameters<T>) =>
      withOrgContext(org.orgId, () => handler(...args));
    const params = (id: string) => ({ params: Promise.resolve({ id }) });

    const listed = await call(channelsRoute.GET as never, new Request("http://scope.local/api/channels") as never);
    assert.equal(listed.status, 200);
    assert.deepEqual((await listed.json()).channels.map((channel: { name: string }) => channel.name), ["Child store"]);

    // Another entity's channel answers exactly like a missing one, for reads and writes.
    const read = await call(channelRoute.GET as never, new Request("http://scope.local") as never, params(rootChannel.channel.id) as never);
    assert.equal(read.status, 404);
    const patched = await call(channelRoute.PATCH as never, new Request("http://scope.local", {
      method: "PATCH", body: JSON.stringify({ name: "Renamed" }),
    }) as never, params(rootChannel.channel.id) as never);
    assert.equal(patched.status, 404);

    // A visible channel cannot be moved, and a new one cannot be created, into an entity outside the scope.
    const moved = await call(channelRoute.PATCH as never, new Request("http://scope.local", {
      method: "PATCH", body: JSON.stringify({ subsidiaryId: org.subsidiaryId }),
    }) as never, params(childChannel.channel.id) as never);
    assert.equal(moved.status, 403);
    assert.match((await moved.json()).error, /subsidiary your role can access/);
    for (const subsidiaryId of [org.subsidiaryId, null]) {
      const createdOutside = await call(channelsRoute.POST as never, new Request("http://scope.local/api/channels", {
        method: "POST", body: JSON.stringify({ kind: "shopify", name: "Elsewhere", subsidiaryId, currency: "USD", externalAccount: `x-${randomUUID()}` }),
      }) as never);
      assert.equal(createdOutside.status, 403);
    }
    const stored = await db.execute<{ name: string; subsidiary_id: string }>(sql`
      select name, subsidiary_id::text from sales_channels where org_id = ${org.orgId} order by name`);
    assert.deepEqual(stored.rows, [
      { name: "Child store", subsidiary_id: childId },
      { name: "Root store", subsidiary_id: org.subsidiaryId },
    ]);
  } finally {
    session.user = null;
    await dropScratchOrgReporting(org.orgId);
  }
});
