import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { tick as webTick } from "../scheduler.ts";
import { WEB_TICK_LOCK_KEY, WORKER_TICK_LOCK_KEY, withTickClaim } from "../scheduler-lock.ts";
import { tick } from "./scheduler.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

test(
  "a second concurrent claimant skips the whole tick instead of double-dispatching",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      const definitionId = randomUUID();
      const scheduleId = randomUUID();
      const dueAt = new Date(Date.now() - 60_000);
      await db.execute(sql`
        insert into report_definitions
          (id, org_id, kind, report_type, slug, name, query, created_by, updated_by)
        values (${definitionId}, ${org.orgId}, 'custom', 'query', 'tick-claim',
                'Tick claim', '{}'::jsonb, null, null)
      `);
      await db.execute(sql`
        insert into report_schedules
          (id, org_id, definition_id, cadence, hour, minute, timezone, recipient_emails,
           next_run_at, active)
        values (${scheduleId}, ${org.orgId}, ${definitionId}, 'daily', 7, 0, 'UTC',
                '["audit@example.com"]'::jsonb, ${dueAt}, true)
      `);

      // Another replica holds the tick claim on its own connection.
      const replica = await pool.connect();
      let released = false;
      try {
        const held = await replica.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [WORKER_TICK_LOCK_KEY],
        );
        assert.equal(held.rows[0]?.locked, true);

        await tick();

        // The losing replica must not materialize the due occurrence: no run
        // row appears and the schedule stays due for whoever wins the claim.
        const skipped = (await db.execute<{ runs: number; next_run_at: Date }>(sql`
          select count(r.id)::int as runs, s.next_run_at
            from report_schedules s
            left join report_runs r on r.schedule_id = s.id
           where s.id = ${scheduleId}
           group by s.id, s.next_run_at
        `));
        assert.equal(skipped.rows[0]?.runs, 0);
        assert.equal(new Date(skipped.rows[0]!.next_run_at).toISOString(), dueAt.toISOString());

        await replica.query("select pg_advisory_unlock(hashtextextended($1, 0))", [WORKER_TICK_LOCK_KEY]);
        released = true;
      } finally {
        replica.release();
        assert.ok(released, "test released the simulated replica lock");
      }

      // With the foreign claimant gone, the claim mechanism itself works.
      const winner = await withTickClaim(WORKER_TICK_LOCK_KEY, async () => "ran");
      assert.equal(winner, "ran");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("the tick claim excludes concurrent entrants and never leaks across errors", { skip: !DB }, async () => {
  // A nested claimant uses a different pooled session, so it must lose exactly
  // like a second process would.
  const nested = await withTickClaim(
    WORKER_TICK_LOCK_KEY,
    async () => withTickClaim(WORKER_TICK_LOCK_KEY, async () => "inner"),
  );
  assert.equal(nested, null);

  // A throwing body still releases the lock: the next claimant proceeds.
  await assert.rejects(
    withTickClaim(WORKER_TICK_LOCK_KEY, async () => {
      throw new Error("tick body exploded");
    }),
    /tick body exploded/,
  );
  const afterError = await withTickClaim(WORKER_TICK_LOCK_KEY, async () => "reacquired");
  assert.equal(afterError, "reacquired");
});

test(
  "a web replica whose tick claim is held elsewhere skips every global scan",
  { skip: !DB },
  async () => {
    const org = await createScratchOrg();
    try {
      await db.execute(sql`
        update orgs
           set settings = jsonb_set(coalesce(settings, '{}'::jsonb), '{features,scripts}', 'true'::jsonb)
         where id = ${org.orgId}
      `);
      const scriptId = randomUUID();
      const dueAt = new Date(Date.now() - 60_000);
      await db.execute(sql`
        insert into user_scripts
          (id, org_id, name, trigger_point, source, cron, next_run_at, timeout_ms, is_active)
        values (${scriptId}, ${org.orgId}, ${`Scratch web tick ${scriptId.slice(0, 8)}`}, 'scheduled',
                'function main(ctx) { return "unused"; }', '*/5 * * * *', ${dueAt}, 2000, true)
      `);
      const occurrenceState = () =>
        db.execute<{ occurrences: number; nextRunAt: Date | string | null }>(sql`
          select count(r.id)::int as occurrences, s.next_run_at as "nextRunAt"
            from user_scripts s
            left join script_runs r
              on r.script_id = s.id and r.target_kind = 'scheduled_occurrence'
           where s.id = ${scriptId}
           group by s.id, s.next_run_at
        `);

      // Another web replica holds the web tick claim on its own connection —
      // the same session-level lock the whole scan set now runs under.
      const replica = await pool.connect();
      let released = false;
      try {
        const held = await replica.query<{ locked: boolean }>(
          "select pg_try_advisory_lock(hashtextextended($1, 0)) as locked",
          [WEB_TICK_LOCK_KEY],
        );
        assert.equal(held.rows[0]?.locked, true);

        await webTick();

        // The losing replica must not touch any global scan: the occurrence
        // stays due and no durable ledger row appears for it.
        const skipped = await occurrenceState();
        assert.equal(skipped.rows[0]?.occurrences, 0);
        assert.equal(new Date(skipped.rows[0]!.nextRunAt!).toISOString(), dueAt.toISOString());

        await replica.query("select pg_advisory_unlock(hashtextextended($1, 0))", [WEB_TICK_LOCK_KEY]);
        released = true;
      } finally {
        replica.release();
        assert.ok(released, "test released the simulated web replica lock");
      }

      // Control: once the claim is free a normal web tick owns the scans again
      // and claims the due occurrence exactly once (cursor advanced, one ledger row).
      await webTick();
      const claimed = await occurrenceState();
      assert.equal(claimed.rows[0]?.occurrences, 1);
      const advancedTo = claimed.rows[0]!.nextRunAt!;
      assert.notEqual(new Date(advancedTo).toISOString(), dueAt.toISOString());
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);
