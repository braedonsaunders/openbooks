import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { processScriptJobData } from "../worker/scripts-worker.ts";
import {
  bulkRunClientKey,
  claimBulkRunKey,
  completeBulkRunKey,
  readBulkRunClaim,
} from "./bulk-run-claim.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

test("a bulk run claim admits one claimant and replays its outcome", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Run Now admin", "admin"));
    const scriptId = randomUUID();
    const key = bulkRunClientKey(randomUUID());
    const scope = { orgId: org.orgId, actorId, scriptId, key };

    assert.deepEqual(await claimBulkRunKey(scope), { status: "claimed" });
    // A double-click with the same key is in flight, never a second run.
    assert.deepEqual(await claimBulkRunKey(scope), { status: "inflight" });
    // The same key for a different script is a key reuse, not a run.
    assert.deepEqual(
      await claimBulkRunKey({ ...scope, scriptId: randomUUID() }),
      { status: "mismatched" },
    );

    const response = { queued: false, scriptId, name: "probe", status: "ok", durationMs: 7 };
    assert.equal(await completeBulkRunKey({ ...scope, response }), true);
    // Completion is idempotent: a replayed completion never overwrites.
    assert.equal(await completeBulkRunKey({ ...scope, response: { other: true } }), false);
    const done = await claimBulkRunKey(scope);
    assert.equal(done.status, "completed");
    assert.deepEqual((done as { response: unknown }).response, response);
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});

test("a redelivered bulk job reconciles onto the recorded outcome without running", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() => createScratchUser(org.orgId, "Run Now admin", "admin"));
    // No such script exists: reaching the runner would throw "script not
    // found", so returning proves the claim short-circuited the execution.
    const scriptId = randomUUID();
    const key = bulkRunClientKey(randomUUID());
    const recorded = {
      scriptId,
      name: "probe",
      status: "ok",
      logs: [],
      durationMs: 7,
    };
    assert.deepEqual(await claimBulkRunKey({ orgId: org.orgId, actorId, scriptId, key }), {
      status: "claimed",
    });
    assert.equal(
      await completeBulkRunKey({ orgId: org.orgId, actorId, scriptId, key, response: recorded }),
      true,
    );
    const outcome = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "bulk",
      actorId,
      idempotencyKey: key,
    });
    assert.deepEqual(outcome, recorded);
    assert.equal(await readBulkRunClaim({ orgId: org.orgId, actorId, scriptId, key }).then((c) => c.status), "completed");
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
