import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

// Same module-graph shim as the other assistant DB tests: the title module is
// server-only and transitively imported app modules use the `@/` alias.
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
const { db } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const {
  markTitleRenamed,
  readTitleState,
  shouldAttemptAutoTitle,
  writeAutoTitle,
} = await import("./conversation-title");
const { createConversation } = await import("../ai-conversations");

const DB_ONLY = { skip: !process.env.OPENBOOKS_DB_URL };

function userAuthz(orgId: string, userId: string): Authz {
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Title harness",
    email: `title-${userId.slice(0, 8)}@scratch.test`,
    roles: [{ key: "title-user", name: "Title user" }],
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
    values (${orgId}, ${`title-${userId.slice(0, 8)}`}, 'Title User', false, '[]'::jsonb)
    returning id
  `)).rows[0]!.id;
  await db.execute(sql`
    insert into users (id, org_id, email, name, password_hash, is_active)
    values (${userId}, ${orgId}, ${`title-${userId.slice(0, 8)}@scratch.test`}, 'Title User', 'x', false)
  `);
  await db.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${orgId}, ${userId}, ${roleId})
  `);
  await db.execute(sql`update users set is_active = true where id = ${userId}`);
}

test("auto title round-trips and stays owner-scoped", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    const strangerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    await seedUser(org.orgId, strangerId);
    const owner = userAuthz(org.orgId, ownerId);
    const stranger = userAuthz(org.orgId, strangerId);
    const conversationId = await createConversation(
      owner,
      "assistant",
      "Which vendors do we owe the most right now?",
    );

    // Placeholder first: no source recorded yet, so the first turn may title it.
    assert.deepEqual(await readTitleState(owner, conversationId), {
      title: "Which vendors do we owe the most right now?",
      source: null,
    });
    assert.equal(shouldAttemptAutoTitle(await readTitleState(owner, conversationId), 1), true);

    assert.equal(await writeAutoTitle(owner, conversationId, "Overdue vendor bills"), true);
    assert.deepEqual(await readTitleState(owner, conversationId), {
      title: "Overdue vendor bills",
      source: "auto",
    });

    // Another user in the same org reads nothing and writes nothing.
    assert.equal(await readTitleState(stranger, conversationId), null);
    assert.equal(await writeAutoTitle(stranger, conversationId, "hijack"), false);
    assert.equal((await readTitleState(owner, conversationId))?.title, "Overdue vendor bills");

    // Unrelated metadata keys survive the title merge.
    await db.execute(sql`
      update ai_conversations set metadata = '{"pinned_tab":"inbox"}' where id = ${conversationId}
    `);
    assert.equal(await writeAutoTitle(owner, conversationId, "Vendor aging follow-up"), true);
    const raw = await db.execute<{ metadata: unknown }>(sql`
      select metadata from ai_conversations where id = ${conversationId}
    `);
    const metadata = raw.rows[0]!.metadata as { pinned_tab?: string; title?: { source?: string } };
    assert.equal(metadata.pinned_tab, "inbox");
    assert.equal(metadata.title?.source, "auto");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a user rename is never overwritten by an auto title", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    const owner = userAuthz(org.orgId, ownerId);
    const conversationId = await createConversation(owner, "assistant", "How did we do last month?");

    await markTitleRenamed(owner, conversationId);
    assert.deepEqual(await readTitleState(owner, conversationId), {
      title: "How did we do last month?",
      source: "user",
    });
    // Even the first-turn predicate refuses once the user has renamed.
    assert.equal(shouldAttemptAutoTitle(await readTitleState(owner, conversationId), 1), false);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("auto title writes fail closed on foreign or blank input", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    const owner = userAuthz(org.orgId, ownerId);
    const conversationId = await createConversation(owner, "assistant", "placeholder");

    assert.equal(await writeAutoTitle(owner, conversationId, "   "), false);
    assert.equal(await writeAutoTitle(owner, randomUUID(), "Some title"), false);
    assert.equal(await readTitleState(owner, randomUUID()), null);
    assert.equal((await readTitleState(owner, conversationId))?.source, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
