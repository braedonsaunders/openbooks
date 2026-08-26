import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db, withBypass } from "./db.ts";
import { claimDueScriptOccurrence } from "./scheduler.ts";
import { ScriptActorError, runBulkScript, runScheduledScript } from "./scripting.ts";
import { processScriptJobData } from "./worker/scripts-worker.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Live-PG proof for the script-run attribution contract (audit finding #56):
 *
 *   1. Interactive "Run now" persists its authenticated actor through EVERY
 *      entry path — queued bulk payloads, the Redis-down inline fallback, and
 *      manual scheduled runs — into script_runs.created_by and ctx.user, so
 *      sandboxed ob.journal.create drafts carry documents.created_by instead
 *      of system provenance.
 *   2. TRUE cron ticks stay explicitly system-attributed: created_by NULL on
 *      the run and any journal draft (which instead carries the durable
 *      system-provenance markers), and the occurrence ledger keeps its
 *      scheduler source evidence with a null actor.
 *   3. An actor that no active user of the owning org backs refuses execution
 *      BEFORE anything is written — user-actor columns never receive a UUID
 *      from another domain, even one that exists elsewhere in the catalog.
 *   4. A forced posting failure rolls its whole unit back and strands no
 *      draft, while the failing run itself remains attributed evidence.
 */

const PROBE_DATE = "2026-07-15";

/** Turn the scripts feature on for an org whose fixtures did not open it. */
async function enableScriptsFeature(orgId: string): Promise<void> {
  await db.execute(sql`
    update orgs set settings = jsonb_set(settings, '{features,scripts}', 'true')
     where id = ${orgId}`);
}

/**
 * Attributed callers re-resolve gl.post live before any ob.journal.create
 * succeeds — grant it to an actor's named role so a probe can exercise the
 * write path it is testing.
 */
async function grantGlPost(orgId: string, roleKey: string): Promise<void> {
  await db.execute(sql`
    update app_roles set permissions = ${JSON.stringify(["gl.post"])}::jsonb
     where org_id = ${orgId} and key = ${roleKey}`);
}

async function seedScript(
  org: ScratchOrg,
  triggerPoint: "bulk" | "scheduled",
  source: string,
  opts: { cron?: string; nextRunAt?: Date } = {},
): Promise<string> {
  const id = randomUUID();
  await db.execute(sql`
    insert into user_scripts (id, org_id, name, trigger_point, source, timeout_ms,
                              is_active, cron, next_run_at)
    values (${id}, ${org.orgId}, ${"probe-" + id.slice(0, 8)}, ${triggerPoint}, ${source},
            2000, true, ${opts.cron ?? null}, ${opts.nextRunAt ?? null})`);
  return id;
}

/** Attribution evidence of the newest script_runs row for one script. */
async function latestRun(
  scriptId: string,
): Promise<{ createdBy: string | null; status: string; errorMessage: string | null }> {
  const r = await db.execute<{ createdBy: string | null; status: string; errorMessage: string | null }>(sql`
    select created_by as "createdBy", status, error_message as "errorMessage"
      from script_runs
     where script_id = ${scriptId}
     order by at desc, id desc
     limit 1`);
  return r.rows[0]!;
}

async function countRuns(scriptId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from script_runs where script_id = ${scriptId}`);
  return Number(r.rows[0]!.n);
}

async function countDocuments(orgId: string): Promise<number> {
  const r = await db.execute<{ n: string }>(sql`
    select count(*)::text as n from documents where org_id = ${orgId}`);
  return Number(r.rows[0]!.n);
}

type JournalRow = { createdBy: string | null; custom: Record<string, unknown> };

async function journalRow(orgId: string, documentNumber: string): Promise<JournalRow> {
  const r = await db.execute<{ createdBy: string | null; custom: Record<string, unknown> }>(sql`
    select created_by as "createdBy", custom
      from documents
     where org_id = ${orgId} and kind = 'journal'
       and document_number = ${documentNumber}`);
  return r.rows[0]!;
}

const PROBE_SOURCE = `function main(ctx) {
  return ctx.user ? { id: ctx.user.id, runtime: ob.runtime.user && ob.runtime.user.id } : { id: null };
}`;

const JOURNAL_DRAFT_SOURCE = `function main(ctx) {
  return ob.journal.create({
    documentDate: "${PROBE_DATE}",
    memo: "attribution probe draft",
    lines: [
      { accountCode: "1000", amount: 5 },
      { accountCode: "5000", amount: -5 },
    ],
  });
}`;

const JOURNAL_POST_SOURCE = `function main(ctx) {
  return ob.journal.create({
    documentDate: "${PROBE_DATE}",
    memo: "attribution probe post",
    lines: [
      { accountCode: "1000", amount: 5 },
      { accountCode: "5000", amount: -5 },
    ],
  }, { post: true });
}`;

test("manual scheduled Run Now persists its authenticated actor", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Run Now admin", "admin"),
    );
    await enableScriptsFeature(org.orgId);

    // The exact call web/app/api/admin/scripts/[id]/run/route.ts makes today.
    // The runner re-validates the stored schedule like the real boundary does.
    const scriptId = await seedScript(org, "scheduled", PROBE_SOURCE, { cron: "* * * * *" });
    const outcome = await runScheduledScript(scriptId, org.orgId, { actorId });

    assert.equal(outcome.status, "ok", outcome.abortReason ?? JSON.stringify(outcome.logs));
    // ctx.user reached the sandbox as the real identity, including ob.runtime.
    assert.equal((outcome.returned as { id?: string }).id, actorId);
    assert.equal((outcome.returned as { runtime?: string }).runtime, actorId);
    const run = await latestRun(scriptId);
    assert.equal(run.createdBy, actorId);
    assert.equal(run.status, "ok");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("queued bulk Run Now keeps its actor through job data into runs and journals", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Queued bulk admin", "admin"),
    );
    await grantGlPost(org.orgId, "admin");
    await enableScriptsFeature(org.orgId);

    // Exactly what scripts-worker consumes for a queued interactive bulk job.
    const probeId = await seedScript(org, "bulk", PROBE_SOURCE);
    const result = await processScriptJobData({
      orgId: org.orgId,
      scriptId: probeId,
      kind: "bulk",
      actorId,
    });
    assert.equal(result.status, "ok", result.abortReason ?? JSON.stringify(result.logs));
    assert.equal((await latestRun(probeId)).createdBy, actorId);

    const journalId = await seedScript(org, "bulk", JOURNAL_DRAFT_SOURCE);
    const journalOutcome = await processScriptJobData({
      orgId: org.orgId,
      scriptId: journalId,
      kind: "bulk",
      actorId,
    });
    assert.equal(journalOutcome.status, "ok", journalOutcome.abortReason ?? JSON.stringify(journalOutcome.logs));
    const returned = journalOutcome.returned as { documentNumber: string };
    const doc = await journalRow(org.orgId, returned.documentNumber);
    assert.equal(doc.createdBy, actorId);
    // Interactive provenance carries NO system marker — created_by says who.
    assert.deepEqual(doc.custom, {});
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("inline bulk fallback attributes the same authenticated actor", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Inline bulk admin", "admin"),
    );
    await grantGlPost(org.orgId, "admin");
    await enableScriptsFeature(org.orgId);

    const probeId = await seedScript(org, "bulk", PROBE_SOURCE);
    const outcome = await runBulkScript(probeId, org.orgId, { actorId });

    assert.equal(outcome.status, "ok", outcome.abortReason ?? JSON.stringify(outcome.logs));
    assert.equal((outcome.returned as { id?: string }).id, actorId);
    assert.equal((await latestRun(probeId)).createdBy, actorId);

    const journalId = await seedScript(org, "bulk", JOURNAL_DRAFT_SOURCE);
    const journalOutcome = await runBulkScript(journalId, org.orgId, { actorId });
    assert.equal(journalOutcome.status, "ok", journalOutcome.abortReason ?? JSON.stringify(journalOutcome.logs));
    const returned = journalOutcome.returned as { documentNumber: string };
    const doc = await journalRow(org.orgId, returned.documentNumber);
    assert.equal(doc.createdBy, actorId);
    assert.deepEqual(doc.custom, {});
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("true cron ticks stay explicitly system-attributed with durable scheduler source", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await enableScriptsFeature(org.orgId);
    const duePast = new Date(Date.now() - 60_000);
    const scriptId = await seedScript(org, "scheduled", JOURNAL_DRAFT_SOURCE, {
      cron: "* * * * *",
      nextRunAt: duePast,
    });

    // No options object is exactly how engine/src/scheduler.ts invokes the
    // runner for a real tick — both for its inline dispatch and in the queue
    // payload it enqueues (no actorId field at all).
    const outcome = await runScheduledScript(scriptId, org.orgId);
    assert.equal(outcome.status, "ok", outcome.abortReason ?? JSON.stringify(outcome.logs));

    // ctx.user was never fabricated for automation: the probe's journal went
    // to the ledger under explicit system provenance — created_by NULL plus
    // the durable markers — instead of a guessed author.
    const returned = outcome.returned as { documentNumber: string };
    const doc = await journalRow(org.orgId, returned.documentNumber);
    assert.equal(doc.createdBy, null);
    assert.equal(doc.custom.actorKind, "system");
    assert.equal(doc.custom.actorReason, "sandboxed script");

    const run = await latestRun(scriptId);
    assert.equal(run.createdBy, null);

    const occ = await withBypass(() =>
      claimDueScriptOccurrence({
        id: scriptId,
        orgId: org.orgId,
        cron: "* * * * *",
        nextRunAt: duePast,
      }),
    );
    assert.ok(occ, "the tick must win its one-occurrence claim");
    const ledger = await db.execute<{
      createdBy: string | null;
      logs: { event: string; occurrence?: string }[];
    }>(sql`
      select created_by as "createdBy", logs
        from script_runs
       where id = ${occ.id}`);
    assert.equal(ledger.rows[0]!.createdBy, null);
    const claimed = ledger.rows[0]!.logs.find((e) => e.event === "claimed");
    assert.ok(claimed, "the occurrence ledger records its durable scheduler source");
    assert.match(String(claimed!.occurrence), new RegExp(`^sched\\|${scriptId}\\|`));
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("system-attributed cron journals carry provenance markers instead of an actor", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    await enableScriptsFeature(org.orgId);
    const scriptId = await seedScript(org, "bulk", JOURNAL_DRAFT_SOURCE);

    // A worker pickup whose payload has no actorId (cron-shaped) writes a
    // system journal: created_by NULL, durable custom markers, no actor guess.
    const result = await processScriptJobData({
      orgId: org.orgId,
      scriptId,
      kind: "bulk",
    });
    assert.equal(result.status, "ok", result.abortReason ?? JSON.stringify(result.logs));
    const returned = result.returned as { documentNumber?: string };
    assert.ok(returned.documentNumber, "the probe records which journal it made");
    const doc = await journalRow(org.orgId, returned.documentNumber!);
    assert.equal(doc.createdBy, null);
    assert.equal(doc.custom.actorKind, "system");
    assert.equal(doc.custom.actorReason, "sandboxed script");
    assert.equal(await countRuns(scriptId), 1);
    assert.equal((await latestRun(scriptId)).createdBy, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("an actor from another domain or deactivation is refused before anything is written", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Refused actor admin", "admin"),
    );
    await enableScriptsFeature(org.orgId);

    // Foreign-domain UUIDs can be perfectly valid identifiers — here the
    // script's own id, exactly like a subscription/template row would be.
    // The users-table round-trip makes them impossible to stamp as actors.
    const probeId = await seedScript(org, "bulk", JOURNAL_DRAFT_SOURCE);
    await assert.rejects(
      runBulkScript(probeId, org.orgId, { actorId: probeId }),
      ScriptActorError,
    );

    // Same refusal for an id that exists nowhere at all.
    await assert.rejects(
      runBulkScript(probeId, org.orgId, { actorId: randomUUID() }),
      ScriptActorError,
    );

    // A real actor who was deactivated between enqueue and pickup fails
    // closed too — the run is refused rather than silently downgraded to
    // unattributed system execution.
    await db.execute(sql`update users set is_active = false where id = ${actorId}`);
    await assert.rejects(
      runBulkScript(probeId, org.orgId, { actorId }),
      ScriptActorError,
    );

    assert.equal(await countRuns(probeId), 0, "no run evidence forged for refused actors");
    assert.equal(await countDocuments(org.orgId), 0, "no journals created past the refusal");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a forced posting failure rolls back atomically and the failed run stays attributed", { skip: !DB }, async () => {
  const org = await withBypass(() => createScratchOrg());
  try {
    const actorId = await withBypass(() =>
      createScratchUser(org.orgId, "Failing poster", "poster"),
    );
    await grantGlPost(org.orgId, "poster");
    await enableScriptsFeature(org.orgId);
    const scriptId = await seedScript(org, "bulk", JOURNAL_POST_SOURCE);

    // Close the GL period so postDocument refuses AFTER the draft rows were
    // inserted inside the same transaction — the exact orphan-draft trap.
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, subsidiary_id, module, state,
         locked_at, locked_by, reason, created_by, updated_by)
      values (
        ${org.orgId}, ${org.periodId}, ${org.bookId}, ${org.subsidiaryId},
        'gl', 'closed', now(), ${actorId}, 'Attribution rollback probe',
        ${actorId}, ${actorId})`);

    const outcome = await runBulkScript(scriptId, org.orgId, { actorId });

    assert.equal(outcome.status, "error");
    assert.match(outcome.abortReason ?? "", /journal\.create failed:/i);
    // The failing run is still attributed, terminal evidence.
    const run = await latestRun(scriptId);
    assert.equal(run.createdBy, actorId);
    assert.equal(run.status, "error");
    // ...and nothing was stranded: zero documents, zero lines.
    assert.equal(await countDocuments(org.orgId), 0);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
