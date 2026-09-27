import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import type { Authz } from "./authz";
import type { SessionUser } from "./auth";

// Same module-graph shim as the other assistant DB tests.
const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
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


const consolidatedRows = [
  { label: "ai conversations pagination", register: async () => {
        // Same module-graph shim as the other assistant DB tests.
        const { sql } = await import("drizzle-orm");
        const { db } = await import("@openbooks/engine/src/platform/db.ts");
        const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
        const { appendMessage, createConversation, recentMessages, olderMessages } =
          await import("./ai-conversations");
        
        const DB_ONLY = { skip: !process.env.OPENBOOKS_DB_URL };
        
        function userAuthz(orgId: string, userId: string): Authz {
          const user: SessionUser = {
            id: userId,
            orgId,
            name: "Paging harness",
            email: `paging-${userId.slice(0, 8)}@scratch.test`,
            roles: [{ key: "paging-user", name: "Paging user" }],
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
            values (${orgId}, ${`paging-${userId.slice(0, 8)}`}, 'Paging User', false, '[]'::jsonb)
            returning id
          `)).rows[0]!.id;
          await db.execute(sql`
            insert into users (id, org_id, email, name, password_hash, is_active)
            values (${userId}, ${orgId}, ${`paging-${userId.slice(0, 8)}@scratch.test`}, 'Paging User', 'x', false)
          `);
          await db.execute(sql`
            insert into role_assignments (org_id, user_id, role_id)
            values (${orgId}, ${userId}, ${roleId})
          `);
          await db.execute(sql`update users set is_active = true where id = ${userId}`);
        }
        
        /** Seed a long thread: alternating user/assistant turns, oldest first. */
        async function seedThread(authz: Authz, conversationId: string, turns: number): Promise<void> {
          for (let i = 0; i < turns; i += 1) {
            await appendMessage(authz, { conversationId, role: "user", content: `question ${i}` });
            await appendMessage(authz, { conversationId, role: "assistant", content: `answer ${i}` });
          }
        }
        
        test("long history pages oldest-first with a hasOlder flag", DB_ONLY, async () => {
          const org = await createScratchOrg();
          try {
            const ownerId = randomUUID();
            await seedUser(org.orgId, ownerId);
            const owner = userAuthz(org.orgId, ownerId);
            const conversationId = await createConversation(owner, "assistant", "paging");
            await seedThread(owner, conversationId, 18);
        
            // 36 messages total; the recent window holds the newest 30. (Exact row
            // order is not asserted: same-millisecond inserts share a created_at and
            // uuid-v7 sub-ms bits are unordered, so only paging integrity is pinned.)
            const recent = await recentMessages(owner, conversationId);
            assert.equal(recent.length, 30);
        
            // One page back from the window head completes the thread: 36 distinct
            // rows across window + page, no gaps, no overlaps, nothing older left.
            const first = await olderMessages(owner, conversationId, recent[0]!.id, 30);
            assert.equal(first.hasOlder, false);
            const combined = [...first.messages, ...recent];
            assert.equal(new Set(combined.map((m) => m.id)).size, 36);
            const expected = Array.from({ length: 18 }, (_, i) => [`question ${i}`, `answer ${i}`]).flat().sort();
            assert.deepEqual(combined.map((m) => m.content).sort(), expected);
        
            // Mid-thread cursors report more history above them.
            const mid = await recentMessages(owner, conversationId);
            const page = await olderMessages(owner, conversationId, mid[20]!.id, 10);
            assert.equal(page.messages.length, 10);
            assert.equal(page.hasOlder, true);
            // Pages chain without gaps or overlaps.
            assert.equal(page.messages[page.messages.length - 1]!.id, mid[19]!.id);
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });
        
        test("history paging fails closed for strangers and unknown cursors", DB_ONLY, async () => {
          const org = await createScratchOrg();
          try {
            const ownerId = randomUUID();
            const strangerId = randomUUID();
            await seedUser(org.orgId, ownerId);
            await seedUser(org.orgId, strangerId);
            const owner = userAuthz(org.orgId, ownerId);
            const stranger = userAuthz(org.orgId, strangerId);
            const conversationId = await createConversation(owner, "assistant", "paging");
            await seedThread(owner, conversationId, 2);
        
            const recent = await recentMessages(owner, conversationId);
            assert.deepEqual(await olderMessages(stranger, conversationId, recent[0]!.id, 30), {
              messages: [],
              hasOlder: false,
            });
            assert.deepEqual(await olderMessages(owner, conversationId, randomUUID(), 30), {
              messages: [],
              hasOlder: false,
            });
            assert.deepEqual(await olderMessages(owner, randomUUID(), recent[0]!.id, 30), {
              messages: [],
              hasOlder: false,
            });
          } finally {
            await dropScratchOrg(org.orgId);
          }
        });
  } },
] as const;

for (const row of consolidatedRows) await row.register();
