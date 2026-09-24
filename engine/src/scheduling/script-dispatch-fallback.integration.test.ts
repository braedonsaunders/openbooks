import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { after } from "node:test";
import { sql } from "drizzle-orm";
import { closeJobConnections } from "@openbooks/jobs";
import { db, withBypass } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";
import { runDueScripts } from "./scheduler.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

after(() => closeJobConnections());

/**
 * Force the queue outage this test asserts on: close any cached producer so
 * the enqueue attempt really fails, and strip Redis URLs so a release host
 * that exposes one for unrelated suites cannot silently succeed the enqueue
 * (a successful enqueue would leave the occurrence queued with no worker and
 * the fallback assertions would never fire).
 */
async function runDueScriptsInline(): Promise<void> {
  await closeJobConnections();
  const redisEnv = {
    OPENBOOKS_REDIS_URL: process.env.OPENBOOKS_REDIS_URL,
    REDIS_URL: process.env.REDIS_URL,
  };
  delete process.env.OPENBOOKS_REDIS_URL;
  delete process.env.REDIS_URL;
  try {
    await runDueScripts();
  } finally {
    for (const [key, value] of Object.entries(redisEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

type OccurrenceRow = {
  status: string;
  logs: Array<{ event: string; error?: string; job?: string; attempt?: number }>;
};

test("a queue outage during dispatch is logged, counted on the ledger, and still runs inline", { skip: !DB }, async () => {
  // This environment has no Redis, so the enqueue always fails here — the
  // same shape as a queue outage in production. E07: the fallback must be
  // explicit (named log + dispatch_failed ledger event before inline runs),
  // and the occurrence must still execute exactly once under its own
  // identity instead of stalling silently or being stamped lost.
  const org = await withBypass(() => createScratchOrg());
  try {
    await withBypass(() => createScratchUser(org.orgId, "Scheduler admin", "admin"));
    await db.execute(sql`
      update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true')
       where id = ${org.orgId}
    `);
    const scriptId = randomUUID();
    await db.execute(sql`
      insert into user_scripts (id, org_id, name, trigger_point, source, timeout_ms,
                                is_active, cron, next_run_at)
      values (${scriptId}, ${org.orgId}, 'inline-fallback-probe', 'scheduled',
              'function main() { return "inline-probe"; }',
              2000, true, '*/5 * * * *', ${new Date(Date.now() - 120_000)})
    `);

    const logged: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    };
    try {
      await runDueScriptsInline();
    } finally {
      console.error = originalError;
    }

    assert.ok(
      logged.some((line) => line.includes("[scheduler]") && line.includes("inline")),
      `expected a named inline-fallback log line, got: ${JSON.stringify(logged)}`,
    );

    const rows = (await db.execute<OccurrenceRow>(sql`
      select status, logs from script_runs
       where script_id = ${scriptId} and target_kind = 'scheduled_occurrence'
       order by at desc limit 1
    `)).rows;
    assert.equal(rows.length, 1, "the due occurrence must have exactly one ledger row");
    const [row] = rows as [OccurrenceRow];
    assert.equal(row.status, "ok", "the occurrence still ran inline under its own identity");
    const events = row.logs.map((event) => event.event);
    assert.ok(events.includes("dispatch_failed"), `ledger must show the queue failure first: ${JSON.stringify(events)}`);
    assert.ok(events.includes("ran_inline"), `ledger must show the inline execution: ${JSON.stringify(events)}`);
    assert.ok(
      events.indexOf("dispatch_failed") < events.indexOf("ran_inline"),
      "the outage must be recorded before the fallback runs",
    );
  } finally {
    await withBypass(() => dropScratchOrg(org.orgId));
  }
});
