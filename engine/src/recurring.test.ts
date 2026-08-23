import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { advanceCadence, scheduleClaimRollback } from "./recurring.ts";

test("weekly and biweekly step by exact day counts", () => {
  assert.equal(advanceCadence("2026-07-21", "weekly"), "2026-07-28");
  assert.equal(advanceCadence("2026-07-21", "biweekly"), "2026-08-04");
});

test("monthly clamps a month-end anchor to shorter months", () => {
  assert.equal(advanceCadence("2026-01-31", "monthly"), "2026-02-28");
  assert.equal(advanceCadence("2028-01-31", "monthly"), "2028-02-29"); // leap year
  assert.equal(advanceCadence("2026-01-15", "monthly"), "2026-02-15");
});

test("monthly rolls the year over at December", () => {
  assert.equal(advanceCadence("2026-12-10", "monthly"), "2027-01-10");
});

test("quarterly and annually advance by 3 and 12 months", () => {
  assert.equal(advanceCadence("2026-07-21", "quarterly"), "2026-10-21");
  assert.equal(advanceCadence("2026-11-30", "quarterly"), "2027-02-28");
  assert.equal(advanceCadence("2026-02-29" /* not real, still clamps */, "annually"), "2027-02-28");
  assert.equal(advanceCadence("2026-07-21", "annually"), "2027-07-21");
});

test("a malformed custom cron falls back to a monthly step instead of looping", () => {
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "not a cron"), "2026-08-21");
});

test("scheduleClaimRollback puts the pre-claim occurrence back so the next tick retries", () => {
  const prior = { nextRunOn: "2026-06-01", lastRunAt: new Date("2026-05-15T09:30:00Z") };
  const rollback = scheduleClaimRollback(prior, "2026-07-01");
  // The restore targets the ORIGINAL occurrence, never the claimed (advanced)
  // one, and reactivates — the due scan only ever claims active schedules.
  assert.deepEqual(rollback, {
    expectedNextRunOn: "2026-07-01", // guard: only while the row still holds the claim
    nextRunOn: "2026-06-01",
    isActive: true,
    lastRunAt: prior.lastRunAt,
  });
});

test("scheduleClaimRollback yields nothing when a concurrent writer moved the schedule", () => {
  const prior = { nextRunOn: "2026-06-01", lastRunAt: null };
  // The row moved past our claim — the rollback must not clobber it.
  assert.equal(scheduleClaimRollback(prior, "2026-07-01", "2026-07-15"), null);
  assert.equal(scheduleClaimRollback(prior, "2026-07-01", "2026-06-01"), null);
  // Live value unknown → still build the payload; the SQL WHERE decides atomically.
  assert.ok(scheduleClaimRollback(prior, "2026-07-01"));
});

test("a failed generation tick rolls its claim back instead of losing the occurrence", () => {
  // The runner claims by advancing next_run_on before generateFromTemplate
  // runs; if generation throws, the catch must restore the pre-claim
  // occurrence — pinned structurally, like fx-revaluation does.
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueRecurringSchedules");
  const claim = source.indexOf("set next_run_on = ${advanced}", run);
  const catchBlock = source.indexOf("} catch (e) {", claim);
  const rollbackCall = source.indexOf("scheduleClaimRollback(s, advanced)", catchBlock);
  const restore = source.indexOf("next_run_on = ${rollback.nextRunOn}", rollbackCall);
  const restoreGuard = source.indexOf(
    "next_run_on = ${rollback.expectedNextRunOn}",
    rollbackCall,
  );
  const lastError = source.indexOf("last_error = ${message}", rollbackCall);
  assert.ok(claim > run, "the occurrence is claimed by advancing next_run_on");
  assert.ok(catchBlock > claim, "generation failures are caught after the claim");
  assert.ok(rollbackCall > catchBlock, "the catch builds a claim rollback");
  assert.ok(restore > rollbackCall, "the failed attempt restores the pre-claim next_run_on");
  assert.ok(restoreGuard > restore, "the restore is guarded on the claimed value");
  assert.ok(lastError > restoreGuard, "last_error is still written for observability");
  // The claim itself stays compare-and-swap: only one tick can win an
  // occurrence, and the claim is org-scoped like every other schedule write.
  const claimSql = source.slice(claim, source.indexOf("returning id", claim));
  assert.match(
    claimSql,
    /where id = \$\{s\.id\} and org_id = \$\{s\.orgId\} and next_run_on = \$\{occurrenceDate\}/,
  );
});

test("generation is guarded per occurrence before anything is created", () => {
  // The dedupe guard (recurring_occurrence_documents) must be consulted BEFORE
  // the clone begins and written INSIDE the generation transaction that creates
  // the document — so a retried tick replays the committed document instead of
  // re-posting the occurrence.
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const gen = source.indexOf("async function generateFromTemplate");
  const lock = source.indexOf("for update", gen);
  const replay = source.indexOf(
    "findOccurrenceDocument(orgId, occurrence.scheduleId, occurrence.occurrenceOn)",
    gen,
  );
  const tplLoad = source.indexOf("select * from documents where id = ${templateId}", gen);
  const guardInsert = source.indexOf("insert into recurring_occurrence_documents", gen);
  assert.ok(gen >= 0, "generateFromTemplate exists");
  assert.ok(lock > gen && lock < tplLoad, "the schedule row lock serializes same-schedule attempts first");
  assert.ok(replay > lock && replay < tplLoad, "the committed occurrence document is replayed before any creation");
  assert.ok(guardInsert > tplLoad && guardInsert < source.indexOf("return { documentId: newId", gen),
    "the guard row naming the new document commits inside the same transaction");
});

test("both entry points pass their occurrence date to the guard", () => {
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueRecurringSchedules");
  const nowFn = source.indexOf("export async function runScheduleNow");
  assert.ok(source.indexOf("occurrenceOn: occurrenceDate", run) > run,
    "a scheduled tick guards its claimed occurrence date");
  assert.ok(source.indexOf("occurrenceOn: today", nowFn) > nowFn,
    "run now also guards by its document date so a double-click cannot double-post");
});

test("success bookkeeping can never roll the claim back after a document exists", () => {
  // The rollback catch restores next_run_on ONLY when generation itself threw;
  // it must hand control back (continue) before the success-bookkeeping block,
  // whose failure path touches last_error alone — never next_run_on.
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueRecurringSchedules");
  const claim = source.indexOf("set next_run_on = ${advanced}", run);
  const rollbackCatch = source.indexOf("} catch (e) {", claim);
  const skipBookkeeping = source.indexOf("continue;", rollbackCatch);
  const bookkeeping = source.indexOf("set run_count = run_count + 1", skipBookkeeping);
  const bookkeepingCatch = source.indexOf("} catch (e) {", bookkeeping);
  const loopEnd = source.indexOf("return result;", run);
  assert.ok(skipBookkeeping > rollbackCatch, "the rollback catch skips success bookkeeping");
  assert.ok(bookkeeping > skipBookkeeping && bookkeeping < loopEnd,
    "bookkeeping runs in its own scope after the rollback catch");
  const bookkeepingFailurePath = source.slice(bookkeepingCatch, loopEnd);
  assert.match(bookkeepingFailurePath, /last_error/,
    "a bookkeeping failure still surfaces through last_error");
  assert.doesNotMatch(bookkeepingFailurePath, /next_run_on/,
    "a bookkeeping failure never restores next_run_on once a document was produced");
});

test("the occurrence-guard table enforces one document per occurrence at the schema level", () => {
  const migration = readFileSync(
    new URL("../../schema/migrations/generated/0006_recurring_occurrence_guard.sql", import.meta.url),
    "utf8",
  );
  assert.match(migration, /CREATE UNIQUE INDEX IF NOT EXISTS recurring_occurrence_once\s*\n?\s*ON public\.recurring_occurrence_documents USING btree \(org_id, schedule_id, occurrence_on\)/);
  assert.match(migration, /FORCE ROW LEVEL SECURITY/);
  assert.match(migration, /CREATE POLICY org_isolation ON public\.recurring_occurrence_documents/);
  assert.match(migration, /BEFORE DELETE OR UPDATE ON public\.recurring_occurrence_documents/,
    "guard lineage is append-only, like subscription_period_invoices");
});
