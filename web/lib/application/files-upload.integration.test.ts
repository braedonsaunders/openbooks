import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

// Covering upload_file end to end: the application tool must write through
// the same createFile storage the files route uses, honour the destination
// folder's grants (a viewer without an editor grant is refused), stay inside
// the caller's org, and replay an idempotent retry without a second file.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, url: "data:text/javascript,export {}" };
    }
    if (specifier.startsWith("@/")) {
      return nextResolve(new URL(`../../${specifier.slice(2)}`, import.meta.url).href, context);
    }
    return nextResolve(specifier, context);
  },
});

const { sql } = await import("drizzle-orm");
const { db, withBypassContext, withOrgContext } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, createScratchUser, dropScratchOrg } = await import("@openbooks/engine/src/testing/fixtures.ts");
const { applicationTool, executeApplicationTool } = await import("./tool-catalog.ts");
type ApplicationContext = import("./context.ts").ApplicationContext;

const DB = !!process.env.OPENBOOKS_DB_URL;

function ctxFor(orgId: string, userId: string, permissions: string[]): ApplicationContext {
  return {
    authz: {
      user: {
        id: userId, email: `${userId}@test`, name: "Test", orgId,
        roles: [], envKind: "production", productionOrgId: orgId, isSuperAdmin: false,
        homeUserId: userId, homeOrgId: orgId,
      },
      permissions: new Set(permissions),
      allowedSubsidiaryIds: null,
    },
    source: "api",
    requestId: randomUUID(),
    apiKeyId: null,
  };
}

const contentBase64 = Buffer.from("cabinet probe").toString("base64");

test("upload_file writes through cabinet storage, replays idempotently, and enforces folder grants", { skip: !DB }, async () => {
  const org = await withBypassContext(() => createScratchOrg());
  // Real user rows: the idempotency ledger requires the actor to belong to
  // the org. Permissions ride the fabricated context, as in the unit gates.
  const userId = await withBypassContext(() => createScratchUser(org.orgId, "Upload prober", "upload_prober"));
  const viewerId = await withBypassContext(() => createScratchUser(org.orgId, "Upload viewer", "upload_viewer"));
  const folderId = randomUUID();
  const definition = applicationTool("upload_file");
  assert.ok(definition, "upload_file must be registered");
  try {
    await withOrgContext(org.orgId, async () => {
      await db.execute(sql`insert into folders (id, org_id, name) values (${folderId}, ${org.orgId}, 'Probe Cabinet')`);
      const manager = ctxFor(org.orgId, userId, ["documents.manage"]);
      const input = {
        folderId,
        filename: "probe.txt",
        contentType: "text/plain",
        contentBase64,
        idempotencyKey: `probe-${randomUUID()}`,
      };
      const first = await executeApplicationTool(definition, manager, input);
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.replayed, false);
      assert.ok(typeof first.id === "string", JSON.stringify(first));
      const stored = await db.execute<{ name: string; content_type: string; size_bytes: number }>(sql`
        select name, content_type, size_bytes from files where id = ${String(first.id)} and org_id = ${org.orgId}`);
      assert.equal(stored.rows.length, 1);
      assert.equal(stored.rows[0]!.name, "probe.txt");
      const replay = await executeApplicationTool(definition, manager, input);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal(replay.replayed, true);
      assert.equal(replay.id, first.id);
      const count = await db.execute<{ n: string }>(sql`
        select count(*) as n from files where folder_id = ${folderId} and org_id = ${org.orgId}`);
      assert.equal(Number(count.rows[0]!.n), 1, "idempotent replay must not store a second file");

      const viewer = ctxFor(org.orgId, viewerId, ["documents.read"]);
      const denied = await executeApplicationTool(definition, viewer, {
        ...input,
        filename: "viewer.txt",
        idempotencyKey: `probe-${randomUUID()}`,
      }).then(
        (value) => ({ threw: false, value }),
        (error) => ({ threw: true, error }),
      );
      assert.equal(denied.threw, true, "a viewer without an editor grant must be refused");
      assert.match(String((denied as { error: unknown }).error), /forbidden/);

    });
    // A folder id from another org must not resolve, even for a manager.
    const orgB = await withBypassContext(() => createScratchOrg());
    try {
      const userB = await withBypassContext(() => createScratchUser(orgB.orgId, "Upload outsider", "upload_outsider"));
      await withOrgContext(orgB.orgId, async () => {
        const outsider = ctxFor(orgB.orgId, userB, ["documents.manage"]);
        await assert.rejects(
          executeApplicationTool(definition, outsider, {
            folderId,
            filename: "cross.txt",
            contentType: "text/plain",
            contentBase64,
            idempotencyKey: `probe-${randomUUID()}`,
          }),
          /folder/,
          "a folder id from another org must not resolve",
        );
      });
    } finally {
      await dropScratchOrg(orgB.orgId);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
