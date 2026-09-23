import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "../testing/fixtures.ts";
import { scriptOccurrenceKey } from "../scheduling/scheduler.ts";
import { processScriptJobData, scheduledScopeFromJob } from "./scripts-worker.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

// SCHED1: a recovered scheduled-script job must never post the same governed
// journal twice. The scheduler mints one immutable occurrence key per tick;
// the worker forwards it as the run's journal idempotency scope, so a retry
// of the same occurrence replays the first execution's document.

function postingSource(date: string): string {
  return `function main(ctx) {
    return ob.journal.create({
      documentDate: ${JSON.stringify(date)},
      memo: "sched1 occurrence probe",
      lines: [
        { accountCode: "5100", amount: 25 },
        { accountCode: "2000", amount: -25 },
      ],
    });
  }`;
}

async function seedPostingScript(orgId: string, date: string): Promise<string> {
  const scriptId = randomUUID();
  await db.execute(sql`
    update orgs
       set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,scripts}', 'true'::jsonb)
     where id = ${orgId}
  `);
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, source, cron, next_run_at, timeout_ms, is_active)
    values (${scriptId}, ${orgId}, ${`Scratch occurrence ${scriptId.slice(0, 8)}`}, 'scheduled',
            ${postingSource(date)}, '*/5 * * * *', ${new Date(Date.now() + 3_600_000)}, 2000, true)
  `);
  return scriptId;
}

async function journalDocCount(orgId: string): Promise<number> {
  return (
    await db.execute<{ n: number }>(sql`
      select count(*)::int as n from documents where org_id = ${orgId} and kind = 'journal'
    `)
  ).rows[0]!.n;
}

test("the same occurrence run twice across a clock gap posts exactly one journal", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedPostingScript(org.orgId, org.date);
    // One immutable tick identity, executed twice the way a lost first
    // dispatch + recovery retry would — far apart in wall-clock terms, but
    // the scope never derives from the clock.
    const scheduledFor = new Date(Date.now() - 30 * 60_000);
    const occurrenceKey = scriptOccurrenceKey(scriptId, scheduledFor);

    const first = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "scheduled",
      occurrenceKey,
    });
    assert.equal(first.status, "ok", `first run errored: ${first.abortReason}`);
    const firstId = (first.returned as { id: string } | undefined)?.id;
    assert.ok(firstId, "first run returns the created document");
    assert.equal(await journalDocCount(org.orgId), 1);

    const retried = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "scheduled",
      occurrenceKey,
    });
    assert.equal(retried.status, "ok", `retry errored: ${retried.abortReason}`);
    assert.equal(
      (retried.returned as { id: string } | undefined)?.id,
      firstId,
      "the retry replays the first execution's document",
    );
    assert.equal(await journalDocCount(org.orgId), 1, "no duplicate journal across the retry");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the worker links its run row to the occurrence ledger row", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedPostingScript(org.orgId, org.date);
    const occurrenceRunId = randomUUID();
    const outcome = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "scheduled",
      occurrenceKey: scriptOccurrenceKey(scriptId, new Date(Date.now() - 30 * 60_000)),
      occurrenceRunId,
    });
    assert.equal(outcome.status, "ok", `run errored: ${outcome.abortReason}`);
    const run = (
      await db.execute<{ targetId: string | null }>(sql`
        select target_id as "targetId" from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled'
      `)
    ).rows[0];
    assert.equal(run?.targetId, occurrenceRunId, "recovery matches evidence on this identity");

    // Manual runs belong to no occurrence and must never absorb one.
    const manual = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "scheduled",
    });
    assert.equal(manual.status, "ok", `manual run errored: ${manual.abortReason}`);
    const unattributed = (
      await db.execute<{ n: number }>(sql`
        select count(*)::int as n from script_runs
         where script_id = ${scriptId} and target_kind = 'scheduled' and target_id is null
      `)
    ).rows[0]!.n;
    assert.equal(unattributed, 1, "exactly the manual run stays unattributed");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("two different occurrences still post two journals", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const scriptId = await seedPostingScript(org.orgId, org.date);
    for (const minutesAgo of [30, 25]) {
      const outcome = await processScriptJobData({
        orgId: org.orgId,
        scriptId,
        kind: "scheduled",
        occurrenceKey: scriptOccurrenceKey(scriptId, new Date(Date.now() - minutesAgo * 60_000)),
      });
      assert.equal(outcome.status, "ok", `run errored: ${outcome.abortReason}`);
    }
    assert.equal(await journalDocCount(org.orgId), 2, "distinct ticks must not collapse onto one journal");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("scheduledScopeFromJob prefers the payload key and adopts scheduler-minted job ids", () => {
  const key = "sched|script-id|2026-01-01T00:00:00.000Z";
  assert.equal(
    scheduledScopeFromJob("scheduled", { occurrenceKey: key }, "sched|other|2026-01-01T00:05:00.000Z"),
    key,
    "payload key wins over the job id",
  );
  assert.equal(
    scheduledScopeFromJob("scheduled", {}, key),
    key,
    "a pre-key job's attempt-1 id is the occurrence key",
  );
  assert.equal(
    scheduledScopeFromJob("scheduled", {}, `${key}:r2`),
    key,
    "a recovery retry id strips to the occurrence key",
  );
  assert.equal(
    scheduledScopeFromJob("scheduled", {}, undefined),
    undefined,
    "no identity anywhere falls back to the minute bucket",
  );
  assert.equal(
    scheduledScopeFromJob("scheduled", {}, "17"),
    undefined,
    "a BullMQ auto-increment id is never an occurrence scope (it restarts after a Redis reset)",
  );
  assert.equal(
    scheduledScopeFromJob("bulk", {}, key),
    undefined,
    "bulk runs keep their per-run namespace even when a job id looks stable",
  );
});
