import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, pool } from "../db.ts";
import { tick, withTickClaim } from "./scheduler.ts";
import { createScratchOrg, dropScratchOrg } from "../test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

const TICK_LOCK_KEY = "openbooks:report-scheduler-tick";

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
          [TICK_LOCK_KEY],
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

        await replica.query("select pg_advisory_unlock(hashtextextended($1, 0))", [TICK_LOCK_KEY]);
        released = true;
      } finally {
        replica.release();
        assert.ok(released, "test released the simulated replica lock");
      }

      // With the foreign claimant gone, the claim mechanism itself works.
      const winner = await withTickClaim(async () => "ran");
      assert.equal(winner, "ran");
    } finally {
      await dropScratchOrg(org.orgId);
    }
  },
);

test("the tick claim excludes concurrent entrants and never leaks across errors", { skip: !DB }, async () => {
  // A nested claimant uses a different pooled session, so it must lose exactly
  // like a second process would.
  const nested = await withTickClaim(async () => withTickClaim(async () => "inner"));
  assert.equal(nested, null);

  // A throwing body still releases the lock: the next claimant proceeds.
  await assert.rejects(
    withTickClaim(async () => {
      throw new Error("tick body exploded");
    }),
    /tick body exploded/,
  );
  const afterError = await withTickClaim(async () => "reacquired");
  assert.equal(afterError, "reacquired");
});
