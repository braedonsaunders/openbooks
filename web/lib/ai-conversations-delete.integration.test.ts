import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "./authz";
import type { SessionUser } from "./auth";

// Same module-graph shim as the other assistant DB tests.
const root = pathToFileURL(process.cwd() + "/").href;
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export {}",
      };
    }
    if (specifier.startsWith("@/")) {
      const path = root + "web/" + specifier.slice(2);
      for (const suffix of [".ts", ".tsx", "/index.ts", "/index.tsx"]) {
        if (existsSync(new URL(path + suffix))) return nextResolve(path + suffix, context);
      }
      return nextResolve(path, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/test-fixtures.ts");
const { appendMessage, createConversation, deleteConversation, listConversations, recentMessages } =
  await import("./ai-conversations");

const DB_ONLY = { skip: !process.env.OPENBOOKS_DB_URL };

function userAuthz(orgId: string, userId: string): Authz {
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Delete harness",
    email: `delete-${userId.slice(0, 8)}@scratch.test`,
    roles: [{ key: "delete-user", name: "Delete user" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(["assistant.use"]), allowedSubsidiaryIds: null };
}

async function seedUser(orgId: string, userId: string): Promise<void> {
  const roleId = (await db.execute<{ id: string }>(sql`
    insert into app_roles (org_id, key, name, is_built_in, permissions)
    values (${orgId}, ${`delete-${userId.slice(0, 8)}`}, 'Delete User', false, '[]'::jsonb)
    returning id
  `)).rows[0]!.id;
  await db.execute(sql`
    insert into users (id, org_id, email, name, password_hash, is_active)
    values (${userId}, ${orgId}, ${`delete-${userId.slice(0, 8)}@scratch.test`}, 'Delete User', 'x', false)
  `);
  await db.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${orgId}, ${userId}, ${roleId})
  `);
  await db.execute(sql`update users set is_active = true where id = ${userId}`);
}

/**
 * F-user-002 server half: deleting a conversation must persist — a list
 * refetch afterwards (the sidebar's switch-chat fetch) must not return it.
 */
test("delete persists: the thread is absent from the next list fetch", DB_ONLY, async () => {
  // Fixture seeding runs under bypass (exactly what the pooled fixture path
  // does); every exercised call below runs tenant-scoped like production.
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ownerId = randomUUID();
    await withBypassContext(() => seedUser(org.orgId, ownerId));
    const owner = userAuthz(org.orgId, ownerId);
    const { doomed, kept } = await withOrgContext(org.orgId, async () => {
      const doomedId = await createConversation(owner, "assistant", "delete me");
      const keptId = await createConversation(owner, "assistant", "keep me");
      await appendMessage(owner, { conversationId: doomedId, role: "user", content: "q" });
      await appendMessage(owner, { conversationId: doomedId, role: "assistant", content: "a" });
      return { doomed: doomedId, kept: keptId };
    });

    await withOrgContext(org.orgId, async () => {
      assert.ok((await listConversations(owner, "assistant")).some((c) => c.id === doomed));
      assert.equal(await deleteConversation(owner, doomed, "assistant"), true);

      // The sidebar refetch after switching chats: the deleted id stays gone.
      const listed = await listConversations(owner, "assistant");
      assert.ok(!listed.some((c) => c.id === doomed), "deleted thread must not reappear on refetch");
      assert.ok(listed.some((c) => c.id === kept), "the surviving thread must stay listed");
      // Its messages cascaded away with it.
      assert.deepEqual(await recentMessages(owner, doomed), []);
      // Deleting twice reports not-found, never throws.
      assert.equal(await deleteConversation(owner, doomed, "assistant"), false);
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("delete fails closed for strangers and other scopes", DB_ONLY, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  try {
    const ownerId = randomUUID();
    const strangerId = randomUUID();
    await withBypassContext(async () => {
      await seedUser(org.orgId, ownerId);
      await seedUser(org.orgId, strangerId);
    });
    const owner = userAuthz(org.orgId, ownerId);
    const stranger = userAuthz(org.orgId, strangerId);

    await withOrgContext(org.orgId, async () => {
      const conversationId = await createConversation(owner, "assistant", "mine");
      assert.equal(await deleteConversation(stranger, conversationId, "assistant"), false);
      assert.equal(await deleteConversation(owner, conversationId, "other-scope"), false);
      assert.ok(
        (await listConversations(owner, "assistant")).some((c) => c.id === conversationId),
        "a refused delete must leave the thread listed",
      );
    });
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
