import { randomUUID } from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import {
  recoverLostScheduledFlows,
  runDueScheduledFlows,
  FLOW_OCCURRENCE_STALE_MS,
} from "./flows/scheduled.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

/**
 * Live-PostgreSQL durability proofs for scheduled flows
 * (engine/src/flows/scheduled.ts, migration 0052). One occurrence = one due
 * cron tick of one scheduled trigger node.
 *
 * The old runner advanced flows.last_scheduled_run_at and only then created
 * the flow_runs evidence / enqueued emails — the audit explicitly accepted
 * losing an occurrence to a crash in that gap. These tests force a crash at
 * exactly that boundary (the same scoped poison-trigger technique as
 * payment-scheduler.integration.test.ts) and prove the opposite contract:
 *
 *   • the cursor advance commits together with a durable per-node claim;
 *   • recovery re-fires the claim EXACTLY once — flow_runs adopts one row per
 *     (occurrence × subject) through flow_runs.occurrence_key, so effect
 *     checkpoints and scheduler_outbox email keys dedupe instead of resending;
 *   • retries are bounded: after the budget is spent the loss is stamped
 *     terminal and visible, never retried forever;
 *   • a concurrent second scanner claims nothing.
 *
 * Every scan runs against one PINNED instant (`now`), so repeated calls share
 * the same quantized occurrence and no test can flake across a real minute
 * boundary.
 */

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

interface FlowFixture {
  flowId: string;
  /** The single scheduled trigger node id inside the graph. */
  nodeId: string;
}

interface Probe {
  org: ScratchOrg;
  fixture: FlowFixture;
  /** The single pinned instant every scan of this probe uses. */
  now: Date;
  /** The occurrence the pinned instant resolves to: `${now}` floored to UTC minute. */
  occurredAt: string;
}

async function seedScheduledProbe(now: Date, options?: { disabled?: boolean }): Promise<Probe> {
  const org = await withBypass(() => createScratchOrg());
  const recipientId = await createScratchUser(org.orgId, "Flow recipient", "accountant");
  const flowId = randomUUID();
  const nodeId = "sched_trig";
  // Anchor = created_at, five minutes back: always inside lastCronOccurrence-
  // Between's bounded walk, yet guaranteed to contain whole-minute occurrences.
  const createdAt = new Date(now.getTime() - 5 * 60_000);
  const graph = {
    schemaVersion: 1,
    nodes: [
      {
        id: nodeId,
        position: { x: 0, y: 0 },
        data: { kind: "trigger", trigger: { trigger: "scheduled", cron: "* * * * *", tz: "UTC" } },
      },
      {
        id: "email_1",
        position: { x: 220, y: 0 },
        data: {
          kind: "action",
          action: {
            action: "send_email",
            to: [{ type: "user", userId: recipientId }],
            subject: "Scheduled flow fired",
            body: "One occurrence, one email.",
          },
        },
      },
      {
        id: "notify_1",
        position: { x: 440, y: 0 },
        data: {
          kind: "action",
          action: {
            action: "notify",
            to: [{ type: "user", userId: recipientId }],
            title: "Scheduled flow fired",
          },
        },
      },
    ],
    edges: [
      { id: "e1", source: nodeId, target: "email_1", sourceHandle: "next" },
      { id: "e2", source: "email_1", target: "notify_1", sourceHandle: "next" },
    ],
  };
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph, created_at)
    values (${flowId}, ${org.orgId}, ${`Durability probe ${flowId.slice(0, 8)}`},
            'vendor_bill', ${!options?.disabled}, ${JSON.stringify(graph)}::jsonb,
            ${createdAt.toISOString()}::timestamptz)`);
  return { org, fixture: { flowId, nodeId }, now, occurredAt: occurredAtOf(now) };
}

/** The cron-minutized occurrence the runner claims for a pinned `now`. */
function occurredAtOf(now: Date): string {
  return new Date(Math.floor(now.getTime() / 60_000) * 60_000).toISOString();
}

async function occurrences(flowId: string): Promise<Array<{
  id: string;
  status: string;
  attempt_count: number;
  result: Record<string, unknown> | null;
}>> {
  return (
    await db.execute<{ id: string; status: string; attempt_count: number; result: Record<string, unknown> | null }>(sql`
      select o.id, o.status, o.attempt_count, o.result
        from flow_scheduled_occurrences o
       where o.flow_id = ${flowId}
       order by o.occurred_at, o.node_id
    `)
  ).rows.map((row) => ({ ...row, result: row.result ?? null }));
}

const runCount = async (orgId: string): Promise<number> =>
  Number(
    (
      await db.execute<{ n: number }>(
        sql`select count(*) as n from flow_runs where org_id = ${orgId}`,
      )
    ).rows[0]!.n,
  );

const outboxCount = async (orgId: string): Promise<number> =>
  Number(
    (
      await db.execute<{ n: number }>(
        sql`select count(*) as n from scheduler_outbox where org_id = ${orgId}`,
      )
    ).rows[0]!.n,
  );

const notificationCount = async (orgId: string): Promise<number> =>
  Number(
    (
      await db.execute<{ n: number }>(
        sql`select count(*) as n from notifications where org_id = ${orgId}`,
      )
    ).rows[0]!.n,
  );

/** The committed cron cursor of the flow (null while never fired). */
const cursorOf = async (flowId: string): Promise<Date | null> => {
  const r = await db.execute<{ c: Date | string | null }>(
    sql`select last_scheduled_run_at as c from flows where id = ${flowId}`,
  );
  const raw = r.rows[0]?.c;
  return raw == null ? null : raw instanceof Date ? raw : new Date(raw);
};

/**
 * Scoped forced-failure trigger — raises on the first effectful statement of
 * a firing (the flow_runs row insert) for this org. The claim/CAS steps have
 * already committed, nothing of the firing ever commits — a deterministic
 * reproduction of a hard kill between claiming and fanning out.
 */
async function failFlowRunInserts(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_flowrun_${suffix}`;
  const trigger = `openbooks_test_fail_flowrun_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'forced flow-run failure';
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before insert on public.flow_runs
    for each row when (new.org_id = '${orgId}'::uuid)
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.flow_runs`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

/**
 * Hold the first recovery take long enough for a second worker to read the
 * same stale row. The second UPDATE then proves it must lose the observed
 * attempt/timestamp fence after the first worker commits its take.
 */
async function pauseRecoveryTake(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_pause_scheduled_take_${suffix}`;
  const trigger = `openbooks_test_pause_scheduled_take_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      perform pg_sleep(0.25);
      return new;
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before update on public.flow_scheduled_occurrences
    for each row when (
      new.org_id = '${orgId}'::uuid
      and new.status = 'firing'
      and new.attempt_count = 2
    )
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.flow_scheduled_occurrences`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

/** A recovery pass whose stale window treats every existing claim as stale. */
function staleRecoveryNow(): Date {
  return new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 60_000);
}

test(
  "a crash between the claim and the fan-out resumes exactly once — no lost occurrence, no double-send",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org } = probe;
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      // Attempt 1: the claim + cursor advance commit in the CLAIM statement,
      // then the firing itself dies at its first effect — exactly the audit's
      // lost-occurrence window.
      dropFailureTrigger = await failFlowRunInserts(org.orgId);
      const crashed = await runDueScheduledFlows(probe.now);
      assert.equal(crashed.errors, 1, "the interrupted firing surfaces as an error");

      // Durable state after the crash: the occurrence is claimed (never
      // skipped), the cursor HAS advanced past it, and zero evidence exists.
      let occ = await occurrences(probe.fixture.flowId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "firing");
      assert.equal(occ[0]!.attempt_count, 1);
      assert.deepEqual((await cursorOf(probe.fixture.flowId))?.toISOString(), probe.occurredAt,
        "the cursor advanced atomically with the claim");
      assert.equal(await runCount(org.orgId), 0, "no run evidence committed yet");
      assert.equal(await outboxCount(org.orgId), 0);
      assert.equal(await notificationCount(org.orgId), 0);

      // Without recovery this occurrence would be gone forever (the cursor is
      // already past it) — a plain re-scan must therefore fire NOTHING new.
      const scan = await runDueScheduledFlows(probe.now);
      assert.deepEqual(scan, { fired: 0, errors: 0 });
      assert.equal((await occurrences(probe.fixture.flowId)).length, 1);

      // Recovery resumes the orphaned claim exactly once.
      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();
      await recoverLostScheduledFlows(staleRecoveryNow());

      occ = await occurrences(probe.fixture.flowId);
      assert.equal(occ.length, 1, "still exactly one occurrence");
      assert.equal(occ[0]!.status, "fired");
      assert.equal(await runCount(org.orgId), 1, "one run row adopted by the resume");
      const runs = (
        await db.execute<{ id: string; occurrenceKey: string | null; status: string; trigger: string }>(sql`
          select id, occurrence_key as "occurrenceKey", status, trigger
            from flow_runs where org_id = ${org.orgId}
        `)
      ).rows;
      assert.equal(runs.length, 1);
      assert.equal(runs[0]!.status, "completed");
      assert.equal(runs[0]!.trigger, "scheduled");
      assert.match(runs[0]!.occurrenceKey ?? "", /^sched\|/, "deterministic occurrence key present");
      assert.equal(await outboxCount(org.orgId), 1, "exactly one deferred email");
      assert.match(
        (
          await db.execute<{ k: string }>(sql`
            select occurrence_key as k from scheduler_outbox where org_id = ${org.orgId}
          `)
        ).rows[0]!.k,
        new RegExp(`^${runs[0]!.id}:email:`),
        "the email key is bound to the adopted run identity",
      );
      assert.equal(await notificationCount(org.orgId), 1, "exactly one inbox notification");

      // A further recovery/scan pair is a no-op: delivered stays delivered.
      await recoverLostScheduledFlows(staleRecoveryNow());
      await runDueScheduledFlows(probe.now);
      assert.equal((await occurrences(probe.fixture.flowId)).length, 1);
      assert.equal(await runCount(org.orgId), 1);
      assert.equal(await outboxCount(org.orgId), 1);
      assert.equal(await notificationCount(org.orgId), 1);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "a committed firing is never refired by recovery or the next scan",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org, fixture } = probe;
    try {
      const fired = await runDueScheduledFlows(probe.now);
      assert.deepEqual(fired, { fired: 1, errors: 0 });

      // Simulate the crash residue of an attempt that COMMITTED everything but
      // died before its claim close: reopen the ledger row only.
      await db.execute(sql`
        update flow_scheduled_occurrences
           set status = 'open', updated_at = now() - interval '30 minutes'
         where org_id = ${org.orgId} and flow_id = ${fixture.flowId}
      `);

      await recoverLostScheduledFlows(staleRecoveryNow());

      assert.equal(await runCount(org.orgId), 1, "no duplicate run row");
      const ids = (
        await db.execute<{ id: string }>(sql`select id from flow_runs where org_id = ${org.orgId}`)
      ).rows.map((r) => r.id);
      assert.equal(ids.length, 1);
      assert.equal(await outboxCount(org.orgId), 1, "the retry did not double-send");
      assert.equal(await notificationCount(org.orgId), 1, "the retry did not double-notify");
      assert.equal((await occurrences(fixture.flowId))[0]!.status, "fired");
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "retries are bounded: a persistently failing firing goes visibly terminal and stops consuming attempts",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org, fixture } = probe;
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      // Initial attempt fails...
      dropFailureTrigger = await failFlowRunInserts(org.orgId);
      assert.equal((await runDueScheduledFlows(probe.now)).errors, 1);
      assert.equal((await occurrences(fixture.flowId))[0]!.attempt_count, 1);
      assert.equal((await occurrences(fixture.flowId))[0]!.status, "firing");

      // ...and exactly one recovery retry fails too...
      await dropFailureTrigger();
      dropFailureTrigger = await failFlowRunInserts(org.orgId);
      await recoverLostScheduledFlows(staleRecoveryNow());

      // ...after which the occurrence is stamped lost IMMEDIATELY (the budget
      // was spent) with the failure reason attached.
      const occ = await occurrences(fixture.flowId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "lost", "terminal after initial attempt plus one retry");
      assert.ok(
        JSON.stringify(occ[0]!.result).includes("forced flow-run failure"),
        "the loss carries the operator-facing failure reason",
      );
      assert.equal(await runCount(org.orgId), 0);

      // Further passes neither resend nor resurrect the lost occurrence.
      await recoverLostScheduledFlows(new Date(Date.now() + 10 * FLOW_OCCURRENCE_STALE_MS));
      await runDueScheduledFlows(probe.now);
      assert.equal((await occurrences(fixture.flowId)).length, 1);
      assert.equal((await occurrences(fixture.flowId))[0]!.status, "lost");
      assert.equal(await runCount(org.orgId), 0);
      assert.equal(await outboxCount(org.orgId), 0);
      assert.equal(await notificationCount(org.orgId), 0);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "concurrent scanners claim-and-fire each occurrence exactly once",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org, fixture } = probe;
    try {
      // Both scanners target the same pinned instant — same quantized
      // occurrence, so the unique claim index decides the single winner.
      const results = await Promise.allSettled([
        runDueScheduledFlows(probe.now),
        runDueScheduledFlows(probe.now),
      ]);
      for (const r of results) assert.equal(r.status, "fulfilled");
      const totalFired = results.reduce(
        (n, r) =>
          n + ((r as PromiseFulfilledResult<Awaited<ReturnType<typeof runDueScheduledFlows>>>).value.fired),
        0,
      );
      assert.equal(totalFired, 1, "exactly one scanner won the claimed occurrence");
      const occ = await occurrences(fixture.flowId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "fired");
      assert.equal(await runCount(org.orgId), 1);
      assert.equal(await outboxCount(org.orgId), 1);
      assert.equal(await notificationCount(org.orgId), 1);
    } finally {
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "concurrent recovery workers take a stale occurrence only once",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org, fixture } = probe;
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    let dropPauseTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      // Leave one stale claim behind after its initial firing fails. Both
      // recovery workers will select this same row before either can finish
      // its deliberately paused take UPDATE.
      dropFailureTrigger = await failFlowRunInserts(org.orgId);
      assert.equal((await runDueScheduledFlows(probe.now)).errors, 1);
      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      dropPauseTrigger = await pauseRecoveryTake(org.orgId);
      const recoveries = await Promise.allSettled([
        recoverLostScheduledFlows(staleRecoveryNow()),
        recoverLostScheduledFlows(staleRecoveryNow()),
      ]);
      for (const recovery of recoveries) assert.equal(recovery.status, "fulfilled");

      const occ = await occurrences(fixture.flowId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "fired");
      assert.equal(occ[0]!.attempt_count, 2, "one initial take plus one recovery take");
      assert.equal(await runCount(org.orgId), 1, "one recovery firing");
      assert.equal(await outboxCount(org.orgId), 1, "one deferred email");
      assert.equal(await notificationCount(org.orgId), 1, "one notification");
    } finally {
      await dropPauseTrigger();
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);

test(
  "an occurrence whose flow was disabled since claiming is closed without ghost-firing",
  { skip: !DB },
  async () => {
    const probe = await seedScheduledProbe(new Date());
    const { org, fixture } = probe;
    let dropFailureTrigger: () => Promise<void> = () => Promise.resolve();
    try {
      dropFailureTrigger = await failFlowRunInserts(org.orgId);
      assert.equal((await runDueScheduledFlows(probe.now)).errors, 1);
      await dropFailureTrigger();
      dropFailureTrigger = () => Promise.resolve();

      await db.execute(sql`update flows set enabled = false where id = ${fixture.flowId}`);
      await recoverLostScheduledFlows(staleRecoveryNow());

      const occ = await occurrences(fixture.flowId);
      assert.equal(occ.length, 1);
      assert.equal(occ[0]!.status, "lost");
      assert.ok(
        JSON.stringify(occ[0]!.result).includes("disabled"),
        "the close records why the firing never happened",
      );
      assert.equal(await runCount(org.orgId), 0);
      assert.equal(await outboxCount(org.orgId), 0);
      assert.equal(await notificationCount(org.orgId), 0);
    } finally {
      await dropFailureTrigger();
      await withBypass(() => dropScratchOrg(org.orgId));
    }
  },
);
