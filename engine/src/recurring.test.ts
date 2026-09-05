import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { advanceCadence } from "./recurring.ts";

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
  assert.equal(advanceCadence("2028-02-29", "annually"), "2029-02-28");
  assert.equal(advanceCadence("2026-07-21", "annually"), "2027-07-21");
});

test("invalid dates, cadences, and cron rules fail closed", () => {
  assert.throws(() => advanceCadence("2026-07-21", "custom_cron", "not a cron"));
  assert.throws(() => advanceCadence("2026-02-29", "annually"));
  assert.throws(() => advanceCadence("9999-12-31", "monthly"));
  assert.throws(() => advanceCadence("2026-07-21", "unknown" as never));
  assert.equal(advanceCadence("0001-02-28", "monthly"), "0001-03-28");
  assert.equal(advanceCadence("0099-12-28", "weekly"), "0100-01-04");
});

test("midnight cron includes tomorrow and never skips an extra day", () => {
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 0 * * *"), "2026-07-22");
  assert.equal(advanceCadence("2026-07-21", "custom_cron", "0 12 * * *"), "2026-07-22");
});

test("the claim and the generation share one transaction, closing the crash-skip window", () => {
  // The defect: the tick claimed by committing next_run_on advancement in its
  // own transaction BEFORE generating; a process killed between the two
  // commits stranded an advanced next_run_on with no document — permanently
  // skipping the occurrence. The fix: claim INSIDE the generation transaction
  // so either both commit or neither does.
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueRecurringSchedules");
  const loopStart = source.indexOf("for (const s of due.rows)", run);
  const orgTxn = source.indexOf("gen = await withOrg(s.orgId, async () => {", run);
  const claim = source.indexOf("set next_run_on = ${advanced}", orgTxn);
  const generateCall = source.indexOf("generateFromTemplate(s.orgId, current.templateId", claim);
  assert.ok(orgTxn > loopStart, "generation runs in one pinned org transaction");
  assert.ok(claim > orgTxn, "the occurrence is claimed inside that same transaction");
  assert.ok(generateCall > claim, "generation follows the claim within it");
  // Nothing between the claim and generateFromTemplate may end a transaction,
  // and no separate committed claim step may exist before the org transaction:
  // any commit boundary there is exactly the crash window this closes.
  const inside = source.slice(orgTxn, source.indexOf("});", generateCall));
  assert.doesNotMatch(inside.slice(source.indexOf("returning id")), /withBypass|withOrg\(/,
    "the claimed unit is not broken by another transaction boundary");
  const before = source.slice(loopStart, orgTxn);
  assert.doesNotMatch(before, /update recurring_schedules/,
    "nothing may claim (write the schedule) outside the generation transaction");
  const claimSql = source.slice(claim, source.indexOf("returning id", claim));
  assert.match(
    claimSql,
    /where id = \$\{s\.id\} and org_id = \$\{s\.orgId\} and next_run_on = \$\{occurrenceDate\}/,
    "the claim stays compare-and-swap and org-scoped: one tick wins an occurrence",
  );
  assert.equal(source.indexOf("scheduleClaimRollback"), -1,
    "the in-process rollback machinery is gone — atomicity replaced it");
});

test("a failed generation leaves the occurrence due and records why — restoring nothing", () => {
  // Atomicity makes "rolled back" and "never claimed" indistinguishable from
  // outside, so the failure path must contain NO next_run_on writer at all:
  // only last_error observability. (The success-bookkeeping path below it is
  // pinned separately to never touch next_run_on either.)
  const source = readFileSync(new URL("./recurring.ts", import.meta.url), "utf8");
  const run = source.indexOf("export async function runDueRecurringSchedules");
  const claim = source.indexOf("set next_run_on = ${advanced}", run);
  const catchBlock = source.indexOf("} catch (e) {", claim);
  const catchEnd = source.indexOf("if (!gen) continue", catchBlock);
  const bookkeeping = source.indexOf("set run_count = run_count + 1", catchBlock);
  assert.ok(catchBlock > claim && catchEnd > catchBlock && bookkeeping > catchEnd,
    "the failure path sits between the claim and the bookkeeping");
  const failurePath = source.slice(catchBlock, catchEnd);
  assert.match(failurePath, /last_error = \$\{message\}/, "failures surface through last_error");
  assert.doesNotMatch(failurePath, /next_run_on/, "the failure path never writes next_run_on");
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
    "findOccurrenceDocument(orgId, context.scheduleId, context.occurrenceOn)",
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
