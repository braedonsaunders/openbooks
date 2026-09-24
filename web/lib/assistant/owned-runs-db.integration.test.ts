import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { registerHooks } from "node:module";
import test from "node:test";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "server-only") {
      return { shortCircuit: true, format: "module", url: "data:text/javascript,export {}" };
    }
    return nextResolve(specifier, context);
  },
});

const { db, withBypass, env } = await import("@openbooks/engine/src/platform/db.ts");
const { createScratchOrg, dropScratchOrg, seedFlowActors } = await import(
  "@openbooks/engine/src/testing/fixtures.ts"
);
const { createConversation, deleteConversation } = await import("../ai-conversations.ts");
const { createDbOwnedRunStore } = await import("./owned-runs-db.ts");
import type { Authz } from "../authz.ts";
import { isUuid } from "@/lib/list-params";

const DB = !!env.OPENBOOKS_DB_URL;
void db;

type Fx = {
  orgId: string;
  actorId: string;
};

async function makeFixture(): Promise<Fx> {
  return withBypass(async () => {
    const created = await createScratchOrg();
    const actors = await seedFlowActors(created.orgId);
    return { orgId: created.orgId, actorId: actors.adminId };
  });
}

function authzFor(fx: Fx): Authz {
  return {
    user: {
      id: fx.actorId,
      email: `owned-runs-${fx.actorId.slice(0, 8)}@scratch.test`,
      name: "Owned Runs Caller",
      roles: [],
      orgId: fx.orgId,
      envKind: "production",
      productionOrgId: fx.orgId,
      isSuperAdmin: false,
      homeUserId: fx.actorId,
      homeOrgId: fx.orgId,
    },
    permissions: new Set(["assistant.use"]),
    allowedSubsidiaryIds: null,
  };
}

test(
  "owned runs persist progress to the run row and reattach by conversation",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const authz = authzFor(fx);
      const store = createDbOwnedRunStore(authz);
      const conversationId = await createConversation(authz, "assistant", "owned run probe");

      const { runId } = await store.startRun(conversationId, "probe prompt");
      assert.ok(isUuid(runId), "expected a real UUID run id");

      assert.equal(await store.writeProgress(runId, [{ type: "text", text: "half" }], 1), true);
      const mid = await store.readRun(runId);
      assert.ok(mid);
      assert.equal(mid.status, "running");
      assert.deepEqual(mid.parts, [{ type: "text", text: "half" }]);
      assert.equal(mid.revision, 1);

      const active = await store.activeRun(conversationId);
      assert.equal(active?.runId, runId);

      assert.equal(await store.abortRequested(runId), false);
      assert.equal(await store.requestAbort(runId), true);
      assert.equal(await store.abortRequested(runId), true);

      const finished = await store.finishRun(runId, {
        status: "stopped",
        parts: [{ type: "text", text: "half" }],
        content: "Response stopped.",
        usage: {},
        finishReason: "abort",
      });
      assert.equal(finished, true);
      assert.equal((await store.readRun(runId))?.status, "stopped");
      assert.equal(await store.activeRun(conversationId), null);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);

test(
  "owned runs are owner-isolated and die with their conversation",
  { skip: !DB },
  async () => {
    const fx = await makeFixture();
    try {
      const authz = authzFor(fx);
      const store = createDbOwnedRunStore(authz);
      const conversationId = await createConversation(authz, "assistant", "isolation probe");
      const { runId } = await store.startRun(conversationId, "probe");

      const stranger = authzFor({ orgId: fx.orgId, actorId: randomUUID() });
      const strangerStore = createDbOwnedRunStore(stranger);
      assert.equal(await strangerStore.readRun(runId), null);
      assert.equal(await strangerStore.activeRun(conversationId), null);
      assert.equal(await strangerStore.requestAbort(runId), false);

      assert.equal(await deleteConversation(authz, conversationId, "assistant"), true);
      assert.equal(await store.readRun(runId), null);
      assert.equal(await store.writeProgress(runId, [], 9), false);
    } finally {
      await dropScratchOrg(fx.orgId);
    }
  },
);
