import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import type { AutomationGraph } from "@openbooks/forms-core";
import { db } from "../db.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedDraftDocument,
  seedFlowActors,
  type FlowActors,
  type ScratchOrg,
} from "../test-fixtures.ts";
import {
  FLOW_OCCURRENCE_STALE_MS,
  lastCronOccurrenceBetween,
  recoverLostScheduledFlows,
  runDueScheduledFlows,
} from "./scheduled.ts";

/**
 * Durability and recovery proofs for the scheduled-flow runner
 * (runDueScheduledFlows + recoverLostScheduledFlows). One occurrence = one
 * due fire time of one scheduled trigger node.
 *
 * The claim must commit the durable flow_scheduled_occurrences row TOGETHER
 * with the cursor advance (never a cursor advance with nothing behind it), a
 * crash after the claim must be recoverable by the tick's recovery pass
 * (claimed-but-unfinished work becomes visible again instead of skipped),
 * concurrent scanners must produce exactly one occurrence delivered once,
 * fan-out resumes after a mid-firing crash without ever double-delivering,
 * terminal loss is visible instead of silent, and a normal occurrence still
 * runs exactly once while the cursor advances past it.
 *
 * Determinism: the cron ('0 12 * * *'), the flow anchor, and every `now`
 * argument are pinned constants, so occurrences are computed from explicit
 * inputs — no sleeps or timing-dependent waits. Crash points are driven
 * explicitly with org-scoped database fault triggers (the same technique as
 * payment-scheduler.integration.test.ts): the trigger aborts one firing
 * transaction, reproducing exactly the durable state a killed process leaves
 * behind. Recovery staleness is crossed by calling recoverLostScheduledFlows
 * with an explicit now past FLOW_OCCURRENCE_STALE_MS — the same function the
 * scheduler tick invokes (engine/src/scheduler.ts), never a private shortcut.
 */

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Daily-noon cron used across scenarios. */
const NOON = "0 12 * * *";
/** A concrete noon firing everything is asserted against. */
const NOW = new Date("2026-07-16T12:00:00Z");
/**
 * Recovery invocation that unambiguously crosses the staleness window:
 * recovery gates on each claim's updated_at (real wall clock), so an
 * explicitly passed now in the far future of THIS process makes freshly
 * claimed rows eligible without any sleeping.
 */
const recoverAt = (): Date => new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 60_000);

type OrgFixture = {
  org: ScratchOrg;
  actors: FlowActors;
};

async function withOrgFixture(fn: (fx: OrgFixture) => Promise<void>): Promise<void> {
  const org = await createScratchOrg();
  try {
    const actors = await seedFlowActors(org.orgId);
    await fn({ org, actors });
  } finally {
    await dropScratchOrg(org.orgId);
  }
}

function scheduledNotifyGraph(
  userId: string,
  opts?: { select?: boolean },
): AutomationGraph {
  const nodes: AutomationGraph["nodes"] = [
    {
      id: "trig",
      position: { x: 0, y: 0 },
      data: {
        kind: "trigger",
        trigger: opts?.select
          ? { trigger: "scheduled", cron: NOON, select: {} }
          : { trigger: "scheduled", cron: NOON },
      },
    },
    {
      id: "notify_1",
      position: { x: 0, y: 1 },
      data: {
        kind: "action",
        action: { action: "notify", to: [{ type: "user", userId }], title: "Scheduled probe" },
      },
    },
  ];
  return { schemaVersion: 1, nodes, edges: [{ id: "e1", source: "trig", target: "notify_1" }] };
}

async function seedFlow(orgId: string, graph: AutomationGraph): Promise<string> {
  const flowId = crypto.randomUUID();
  await db.execute(sql`
    insert into flows (id, org_id, name, subject_kind, enabled, graph, created_at)
    values (${flowId}, ${orgId}, 'Durable schedule probe', 'vendor_bill', true,
            ${JSON.stringify(graph)}::jsonb, ${new Date("2026-07-10T00:00:00Z")})
  `);
  return flowId;
}

async function countRows(query: ReturnType<typeof sql>): Promise<number> {
  const r = await db.execute<{ n: number }>(query);
  return Number(r.rows[0]!.n);
}

async function countNotifications(orgId: string): Promise<number> {
  return countRows(sql`
    select count(*)::int as n from notifications where org_id = ${orgId} and kind = 'flow'
  `);
}

async function countRuns(orgId: string): Promise<number> {
  return countRows(sql`
    select count(*)::int as n from flow_runs where org_id = ${orgId} and trigger = 'scheduled'
  `);
}

async function loadOccurrences(orgId: string) {
  return (
    await db.execute<{
      id: string;
      status: string;
      attempt_count: number;
      result: Record<string, unknown> | null;
    }>(sql`
      select id::text as id, status, attempt_count::int as attempt_count, result
        from flow_scheduled_occurrences
       where org_id = ${orgId}
       order by node_id
    `)
  ).rows;
}

async function flowCursor(orgId: string, flowId: string): Promise<Date | null> {
  const row = (
    await db.execute<{ last: Date | string | null }>(sql`
      select last_scheduled_run_at as "last" from flows where id = ${flowId} and org_id = ${orgId}
    `)
  ).rows[0]!;
  return row.last === null ? null : new Date(row.last);
}

/**
 * Org-scoped fault triggers mirroring payment-scheduler.integration.test.ts:
 * raise inside the database at one exact stage so the committed state after
 * the pass equals the state a killed process would leave behind.
 */
async function failFirstScheduledRunInsert(orgId: string): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_sfr_${suffix}`;
  const trigger = `openbooks_test_fail_sfr_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      raise exception 'forced first scheduled-run insert failure';
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before insert on public.flow_runs
    for each row when (new.org_id = '${orgId}'::uuid and new.trigger = 'scheduled')
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.flow_runs`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

async function failRunInsertForDoc(
  orgId: string,
  subjectId: string,
): Promise<() => Promise<void>> {
  const suffix = orgId.replaceAll("-", "").slice(0, 12);
  const fn = `openbooks_test_fail_doc_${suffix}`;
  const trigger = `openbooks_test_fail_doc_${suffix}`;
  await db.execute(sql.raw(`
    create function public.${fn}() returns trigger
    language plpgsql as $$
    begin
      if new.subject_id = '${subjectId}'::uuid then
        raise exception 'forced fan-out failure for probed subject';
      end if;
      return new;
    end
    $$
  `));
  await db.execute(sql.raw(`
    create trigger ${trigger}
    before insert on public.flow_runs
    for each row when (new.org_id = '${orgId}'::uuid and new.trigger = 'scheduled')
    execute function public.${fn}()
  `));
  return async () => {
    await db.execute(sql.raw(`drop trigger if exists ${trigger} on public.flow_runs`));
    await db.execute(sql.raw(`drop function if exists public.${fn}()`));
  };
}

test("the noon cron fires exactly once at its pinned instant (determinism pin)", { skip: !DB }, () => {
  assert.equal(lastCronOccurrenceBetween(NOON, new Date("2026-07-10T00:00:00Z"), NOW)?.toISOString(), NOW.toISOString());
});

test("a normal scheduled occurrence runs exactly once and advances the cursor", { skip: !DB }, async () => {
  await withOrgFixture(async ({ org, actors }) => {
    const flowId = await seedFlow(org.orgId, scheduledNotifyGraph(actors.approver1Id));

    const result = await runDueScheduledFlows(NOW);
    assert.equal(result.fired, 1);

    // The ledger recorded the occurrence and closed it fired.
    const occs = await loadOccurrences(org.orgId);
    assert.equal(occs.length, 1);
    assert.equal(occs[0]!.status, "fired");

    // Exactly one run delivered exactly one notification.
    assert.equal(await countRuns(org.orgId), 1);
    assert.equal(await countNotifications(org.orgId), 1);

    // The cursor advanced to the pinned fire time — not beyond it.
    const cursor = await flowCursor(org.orgId, flowId);
    assert.equal(cursor?.toISOString(), NOW.toISOString());

    // A repeated identical tick adds nothing: never twice.
    await runDueScheduledFlows(NOW);
    assert.equal(await countRuns(org.orgId), 1);
    assert.equal(await countNotifications(org.orgId), 1);
  });
});

test("concurrent scanners produce one claimed occurrence delivered once", { skip: !DB }, async () => {
  await withOrgFixture(async ({ org, actors }) => {
    await seedFlow(org.orgId, scheduledNotifyGraph(actors.approver1Id));

    const results = await Promise.allSettled([
      runDueScheduledFlows(NOW),
      runDueScheduledFlows(NOW),
    ]);
    for (const r of results) assert.equal(r.status, "fulfilled");

    const occs = await loadOccurrences(org.orgId);
    assert.equal(occs.length, 1, "one ledger row per occurrence");
    assert.equal(occs[0]!.status, "fired");
    assert.equal(await countRuns(org.orgId), 1, "one run");
    assert.equal(await countNotifications(org.orgId), 1, "one delivery");
  });
});

test("a crash after the claim is recovered exactly once with an advanced, non-skipping cursor", { skip: !DB }, async () => {
  await withOrgFixture(async ({ org, actors }) => {
    const flowId = await seedFlow(org.orgId, scheduledNotifyGraph(actors.approver1Id));

    // PASS 1: commit the claim, then crash before any run commits. The fault
    // trigger raises inside the firing's own transaction, leaving the exact
    // durable state a process death would leave behind.
    const disarm = await failFirstScheduledRunInsert(org.orgId);
    try {
      const outcome = await runDueScheduledFlows(NOW);
      assert.equal(outcome.errors, 1, "the crashed firing surfaces as an error");
    } finally {
      await disarm();
    }

    // Committed state after the crash: cursor ADVANCED to the fire time, the
    // claim stuck 'firing' with its attempt consumed, zero runs delivered.
    // Nothing lost, nothing skipped. (The failure text itself went to the
    // operator log; below the retry budget the row carries no result yet.)
    assert.equal((await flowCursor(org.orgId, flowId))?.toISOString(), NOW.toISOString());
    const crashed = (await loadOccurrences(org.orgId))[0]!;
    assert.equal(crashed.status, "firing");
    assert.ok(Number(crashed.attempt_count) >= 1, "the failed firing consumed an attempt");
    assert.equal(await countRuns(org.orgId), 0);
    assert.equal(await countNotifications(org.orgId), 0);

    // PASS 2 (restart): the tick's recovery pass resumes the SAME occurrence.
    await recoverLostScheduledFlows(recoverAt());
    const resumed = (await loadOccurrences(org.orgId))[0]!;
    assert.equal(resumed.id, crashed.id, "recovery reused the same occurrence identity");
    assert.equal(resumed.status, "fired");

    // Delivered EXACTLY once — not zero, not two.
    assert.equal(await countRuns(org.orgId), 1);
    assert.equal(await countNotifications(org.orgId), 1);

    // PASS 3: later ticks are stable — no re-delivery, no re-arm.
    await recoverLostScheduledFlows(new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 120_000));
    await runDueScheduledFlows(new Date(NOW.getTime() + 120_000));
    assert.equal(await countRuns(org.orgId), 1);
    assert.equal(await countNotifications(org.orgId), 1);

    // The cursor was NEVER rewound to re-fire the missed tick: it stays put
    // and later crons continue from it (next noon, deterministically).
    const nextNoon = new Date(Date.UTC(2026, 6, 17, 12));
    await runDueScheduledFlows(nextNoon);
    const occs3 = await loadOccurrences(org.orgId);
    assert.equal(occs3.length, 2, "exactly one fresh occurrence for the next cron day");
    assert.equal(occs3[0]!.status, "fired");
    assert.equal(await countRuns(org.orgId), 2);
  });
});

test("fan-out crashes atomically per node and recovers every subject exactly once", { skip: !DB }, async () => {
  await withOrgFixture(async ({ org, actors }) => {
    // Three candidates; findCandidateIds is newest-created-first, so delivery
    // order is doc0 → doc1 → doc2. The fault fires hard on the SECOND.
    const docIds: string[] = [];
    for (let i = 0; i < 3; i++) {
      const id = await seedDraftDocument(org.orgId, {
        kind: "vendor_bill",
        createdBy: actors.submitterId,
        number: `SCHEDFAN-${i}`,
      });
      await db.execute(sql`
        update documents set created_at = ${new Date(Date.UTC(2026, 6, 15, 10 - i))}
         where id = ${id}
      `);
      docIds.push(id);
    }
    await seedFlow(org.orgId, scheduledNotifyGraph(actors.approver1Id, { select: true }));

    // PASS 1: the firing aborts inside the second subject's run insert. One
    // node = one atomic firing unit: nothing from this occurrence committed —
    // no partial notifications, no orphan runs — but the CLAIM does survive.
    const disarm = await failRunInsertForDoc(org.orgId, docIds[1]!);
    try {
      const outcome = await runDueScheduledFlows(NOW);
      assert.equal(outcome.errors, 1);
    } finally {
      await disarm();
    }

    const crashed = (await loadOccurrences(org.orgId))[0]!;
    assert.equal(crashed.status, "firing");
    assert.equal(await countRuns(org.orgId), 0);
    assert.equal(await countNotifications(org.orgId), 0);

    // PASS 2: recovery re-fires the WHOLE node; run-row adoption under the
    // deterministic occurrence key plus effect checkpoints make that replay
    // deliver each subject exactly once — all three, none repeated.
    await recoverLostScheduledFlows(recoverAt());

    const resumed = (await loadOccurrences(org.orgId))[0]!;
    assert.equal(resumed.id, crashed.id);
    assert.equal(resumed.status, "fired");
    assert.equal(await countRuns(org.orgId), 3, "one run per record");
    assert.equal(await countNotifications(org.orgId), 3, "each subject notified exactly once");

    // Stability: further ticks/recoveries never duplicate any delivery.
    await recoverLostScheduledFlows(new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 120_000));
    await runDueScheduledFlows(new Date(NOW.getTime() + 120_000));
    assert.equal(await countRuns(org.orgId), 3);
    assert.equal(await countNotifications(org.orgId), 3);
  });
});

test("an exhausted occurrence becomes terminally lost and stops consuming attempts", { skip: !DB }, async () => {
  await withOrgFixture(async ({ org, actors }) => {
    await seedFlow(org.orgId, scheduledNotifyGraph(actors.approver1Id));

    // Permanent execution failure for this org: the runner never delivers.
    const disarm = await failFirstScheduledRunInsert(org.orgId);
    try {
      // Pass 1: initial firing fails ('firing', attempt 1).
      await runDueScheduledFlows(NOW);
      const first = (await loadOccurrences(org.orgId))[0]!;
      assert.equal(first.status, "firing");

      // Recovery pass: consumes attempt 2, fails again, and stamps the
      // occurrence visibly LOST immediately (the retry budget is spent).
      await recoverLostScheduledFlows(recoverAt());
      const lost = (await loadOccurrences(org.orgId))[0]!;
      assert.equal(lost.id, first.id);
      assert.equal(lost.status, "lost", "terminal state reached under the retry budget");
      assert.match(String(lost.result?.["error"]), /lost/i, "the ceiling is stamped");
      assert.match(
        String(lost.result?.["error"]),
        /forced/,
        "the underlying fault stays auditable",
      );

      // Terminal rows are inert: more recovery and more ticks change nothing.
      await recoverLostScheduledFlows(new Date(Date.now() + FLOW_OCCURRENCE_STALE_MS + 120_000));
      await runDueScheduledFlows(new Date(NOW.getTime() + 600_000));
      const after = (await loadOccurrences(org.orgId))[0]!;
      assert.equal(after.id, first.id);
      assert.equal(after.status, "lost");
      assert.equal(Number(after.attempt_count), Number(lost.attempt_count), "no further attempts consumed");
      assert.equal(await countRuns(org.orgId), 0);
      assert.equal(await countNotifications(org.orgId), 0);
    } finally {
      await disarm();
    }
  });
});
