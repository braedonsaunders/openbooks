import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { sql } from "drizzle-orm";
import { closeApprovedRun, publishCloseRun } from "./run-completion.ts";
import { decidePeriodReopen, recloseApprovedReopen, requestPeriodReopen } from "./reopening.ts";
import { startCloseRun } from "./run-start.ts";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors } from "../testing/fixtures.ts";

/**
 * A corrected package must reach its recipients. publishCloseRun enqueues one
 * close-delivery job per publication; when the fixed jobId repeats a prior
 * publication's id, BullMQ's addJob keeps the FIRST job and reports the new
 * one as `duplicated` (bullmq@5.80.5 handleDuplicatedJob.lua returns the
 * existing id instead of queueing) — so a reopen → re-close → re-publish
 * cycle silently delivers nothing and the corrected statements never go out.
 *
 * The stub below replays exactly that rule (ids docked per add are unique;
 * a repeated jobId is swallowed), so the test proves deliverability of every
 * publication without needing a live Redis.
 */
type CapturedEnqueue = { data: unknown; options: unknown; swallowed: boolean };

const seenJobIds = new Set<string>();
const enqueues: CapturedEnqueue[] = [];
(globalThis as Record<string, unknown>).__p06closeDelivery = async (
  data: unknown,
  options?: { jobId?: string },
) => {
  const jobId = options?.jobId;
  const swallowed = jobId !== undefined && seenJobIds.has(jobId);
  if (jobId !== undefined) seenJobIds.add(jobId);
  enqueues.push({ data, options, swallowed });
};

const hooks = registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@openbooks/jobs") {
      return {
        shortCircuit: true,
        format: "module",
        url: "data:text/javascript,export const enqueueCloseDelivery = globalThis.__p06closeDelivery",
      };
    }
    return nextResolve(specifier, context);
  },
});

const DB = !!process.env.OPENBOOKS_DB_URL;

test("re-publishing after a controlled reopen enqueues a deliverable package", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await db.execute(sql`update orgs set settings = jsonb_set(settings, '{features}',
      coalesce(settings->'features', '{}'::jsonb) || '{"advancedClose": true}'::jsonb)
      where id = ${org.orgId}`);
    const runId = await startCloseRun({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId: actors.adminId,
    });
    const approveAndClose = async () => {
      await db.execute(sql`
        update close_runs set status = 'approved', current_stage = 'lock',
               approved_at = now(), approved_by = ${actors.adminId},
               updated_at = now(), updated_by = ${actors.adminId}
         where id = ${runId} and org_id = ${org.orgId}`);
      await closeApprovedRun(org.orgId, runId, actors.approver1Id);
    };
    await approveAndClose();
    await publishCloseRun(org.orgId, runId, actors.adminId, "first publication");
    assert.equal(enqueues.length, 1, "first publish must enqueue delivery");
    assert.equal(enqueues[0]!.swallowed, false);

    // Controlled correction cycle: reopen GL with a reason, then re-close it.
    const requestId = await requestPeriodReopen({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      modules: ["gl"],
      reason: "Correct a misclassified adjusting entry before re-issue",
      actorId: actors.adminId,
    });
    await decidePeriodReopen({
      orgId: org.orgId,
      requestId,
      actorId: actors.approver1Id,
      approve: true,
      hours: 2,
    });
    await recloseApprovedReopen({
      orgId: org.orgId,
      requestId,
      actorId: actors.approver1Id,
      reason: "Correction posted and reviewed; window closed for re-issue",
    });
    await approveAndClose();
    await publishCloseRun(org.orgId, runId, actors.adminId, "corrected re-publication");
    assert.equal(enqueues.length, 2, "re-publication must enqueue delivery again");
    assert.equal(
      enqueues[1]!.swallowed,
      false,
      "the corrected package was swallowed as a duplicate job and would never deliver",
    );
  } finally {
    hooks.deregister();
    await dropScratchOrg(org.orgId);
  }
});
