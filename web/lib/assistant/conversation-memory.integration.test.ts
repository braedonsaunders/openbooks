import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import test from "node:test";
import { pathToFileURL } from "node:url";
import type { Authz } from "../authz";
import type { SessionUser } from "../auth";

// Same module-graph shim as the other assistant DB tests: the memory module
// is server-only and transitively imported app modules use the `@/` alias.
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
const { countConversationAssistantTurns, readConversationSummary, writeConversationSummary } =
  await import("./conversation-memory");
const { appendMessage } = await import("../ai-conversations");

const DB_ONLY = { skip: !process.env.OPENBOOKS_DB_URL };

function userAuthz(orgId: string, userId: string): Authz {
  const user: SessionUser = {
    id: userId,
    orgId,
    name: "Memory harness",
    email: `memory-${userId.slice(0, 8)}@scratch.test`,
    roles: [{ key: "memory-user", name: "Memory user" }],
    isSuperAdmin: false,
    envKind: "production",
    productionOrgId: orgId,
    homeOrgId: orgId,
    homeUserId: userId,
  };
  return { user, permissions: new Set(["assistant.use"]), allowedSubsidiaryIds: null };
}

async function seedUser(orgId: string, userId: string): Promise<void> {
  // Users activate only once they hold a role (enforce_user_active_role_assignment).
  const roleId = (await db.execute<{ id: string }>(sql`
    insert into app_roles (org_id, key, name, is_built_in, permissions)
    values (${orgId}, ${`memory-${userId.slice(0, 8)}`}, 'Memory User', false, '[]'::jsonb)
    returning id
  `)).rows[0]!.id;
  await db.execute(sql`
    insert into users (id, org_id, email, name, password_hash, is_active)
    values (${userId}, ${orgId}, ${`memory-${userId.slice(0, 8)}@scratch.test`}, 'Memory User', 'x', false)
  `);
  await db.execute(sql`
    insert into role_assignments (org_id, user_id, role_id)
    values (${orgId}, ${userId}, ${roleId})
  `);
  await db.execute(sql`update users set is_active = true where id = ${userId}`);
}

async function seedConversation(orgId: string, userId: string): Promise<string> {
  const r = await db.execute<{ id: string }>(sql`
    insert into ai_conversations (org_id, user_id, scope, title, created_by, updated_by)
    values (${orgId}, ${userId}, 'assistant', 'Memory test', ${userId}, ${userId})
    returning id
  `);
  return r.rows[0]!.id;
}

test("conversation memory round-trips and stays owner-scoped", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    const strangerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    await seedUser(org.orgId, strangerId);
    const conversationId = await seedConversation(org.orgId, ownerId);
    const owner = userAuthz(org.orgId, ownerId);
    const stranger = userAuthz(org.orgId, strangerId);

    assert.equal(await readConversationSummary(owner, conversationId), null);

    const written = await writeConversationSummary(owner, conversationId, {
      text: "Discussed overdue bills for Customer A.",
      entities: [{ kind: "party", id: "11111111-1111-4111-8111-111111111111", label: "Customer A" }],
      turnsCovered: 8,
    });
    assert.equal(written, true);

    const summary = await readConversationSummary(owner, conversationId);
    assert.equal(summary?.text, "Discussed overdue bills for Customer A.");
    assert.deepEqual(summary?.entities, [
      { kind: "party", id: "11111111-1111-4111-8111-111111111111", label: "Customer A" },
    ]);
    assert.equal(summary?.turnsCovered, 8);
    assert.ok(summary?.updatedAt, "updatedAt missing");

    // Another user in the same org sees nothing and writes nothing.
    assert.equal(await readConversationSummary(stranger, conversationId), null);
    assert.equal(
      await writeConversationSummary(stranger, conversationId, {
        text: "hijack",
        entities: [],
        turnsCovered: 99,
      }),
      false,
    );
    assert.equal((await readConversationSummary(owner, conversationId))?.turnsCovered, 8);

    // A second write wins; unrelated metadata keys survive the merge.
    await db.execute(sql`
      update ai_conversations set metadata = '{"pinned_tab":"inbox"}' where id = ${conversationId}
    `);
    assert.equal(
      await writeConversationSummary(owner, conversationId, {
        text: "Moved on to payroll.",
        entities: [],
        turnsCovered: 16,
      }),
      true,
    );
    const second = await readConversationSummary(owner, conversationId);
    assert.equal(second?.text, "Moved on to payroll.");
    assert.equal(second?.turnsCovered, 16);
    const raw = await db.execute<{ metadata: unknown }>(sql`
      select metadata from ai_conversations where id = ${conversationId}
    `);
    assert.equal((raw.rows[0]!.metadata as { pinned_tab: string }).pinned_tab, "inbox");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("conversation memory counts assistant turns owner-scoped", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    const conversationId = await seedConversation(org.orgId, ownerId);
    const owner = userAuthz(org.orgId, ownerId);
    assert.equal(await countConversationAssistantTurns(owner, conversationId), 0);
    await appendMessage(owner, { conversationId, role: "user", content: "hi" });
    await appendMessage(owner, { conversationId, role: "assistant", content: "hello" });
    await appendMessage(owner, { conversationId, role: "assistant", content: "again" });
    assert.equal(await countConversationAssistantTurns(owner, conversationId), 2);
    const stranger = userAuthz(org.orgId, randomUUID());
    assert.equal(await countConversationAssistantTurns(stranger, conversationId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("conversation memory reads fail closed on corrupt payloads", DB_ONLY, async () => {
  const org = await createScratchOrg();
  try {
    const ownerId = randomUUID();
    await seedUser(org.orgId, ownerId);
    const conversationId = await seedConversation(org.orgId, ownerId);
    const owner = userAuthz(org.orgId, ownerId);
    await db.execute(sql`
      update ai_conversations set metadata = '{"summary":{"text":"","entities":"junk"}}'
       where id = ${conversationId}
    `);
    assert.equal(await readConversationSummary(owner, conversationId), null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
