import assert from "node:assert/strict";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import { closePeriodAllModules, setPeriodLockState, type CloseModule } from "./period-locks.ts";
import { CLOSE_MODULES } from "./period-policy.ts";
import { db } from "../platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../testing/fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

// One "Close period" action across every module: a single reason closes all
// six through the native per-module command (GL last, each transition
// audited), per-module reasons override the shared one, and a failure stops
// the run with every module's outcome explicit.

async function lockStates(orgId: string, periodId: string, bookId: string): Promise<Record<string, string>> {
  const rows = (await db.execute<{ module: string; state: string }>(sql`
    select module, state from period_locks
     where org_id = ${orgId} and period_id = ${periodId} and book_id = ${bookId}
       and subsidiary_id is null
  `)).rows;
  return Object.fromEntries(rows.map((row) => [row.module, row.state]));
}

async function lockReasons(orgId: string, periodId: string, bookId: string): Promise<Record<string, string | null>> {
  const rows = (await db.execute<{ module: string; reason: string | null }>(sql`
    select module, reason from period_locks
     where org_id = ${orgId} and period_id = ${periodId} and book_id = ${bookId}
       and subsidiary_id is null
  `)).rows;
  return Object.fromEntries(rows.map((row) => [row.module, row.reason]));
}

test("one reason closes every module with GL last and audits each transition", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close All Controller", "admin");

    const { results } = await closePeriodAllModules({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId,
      reason: "Month-end close control",
    });

    assert.deepEqual(
      results.map((result) => result.module),
      [...CLOSE_MODULES],
      "every module reports in GL-last order",
    );
    assert.ok(results.every((result) => result.ok), "every module closes");
    assert.deepEqual(await lockStates(org.orgId, org.periodId, org.bookId), {
      ar: "closed",
      ap: "closed",
      banking: "closed",
      assets: "closed",
      tax: "closed",
      gl: "closed",
    });
    const audits = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from audit_log
       where org_id = ${org.orgId} and table_name = 'period_locks' and action = 'insert'
    `)).rows[0];
    assert.equal(Number(audits?.n ?? 0), 6, "each module close is audited");
    const events = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n from close_events
       where org_id = ${org.orgId} and event_type = 'period.lock_changed'
    `)).rows[0];
    assert.equal(Number(events?.n ?? 0), 6, "each module close emits its event");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a per-module reason overrides the shared one for that module only", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Override Controller", "admin");

    const { results } = await closePeriodAllModules({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId,
      reason: "Month-end close control",
      moduleReasons: { ap: "AP held for the late vendor batch" },
    });

    assert.ok(results.every((result) => result.ok));
    const reasons = await lockReasons(org.orgId, org.periodId, org.bookId);
    assert.equal(reasons.ap, "AP held for the late vendor batch");
    for (const module of CLOSE_MODULES.filter((candidate) => candidate !== "ap")) {
      assert.equal(reasons[module], "Month-end close control", `${module} keeps the shared reason`);
    }
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("module order is enforced GL-last regardless of input order", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Order Controller", "admin");

    const { results } = await closePeriodAllModules({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId,
      reason: "Month-end close control",
      modules: ["gl", "ar"],
    });

    assert.deepEqual(results.map((result) => result.module), ["ar", "gl"]);
    assert.ok(results.every((result) => result.ok), "reordered input still closes GL last");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a mid-run failure keeps applied closes and reports every module", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Partial Controller", "admin");
    // AP is held soft-closed for review: GL refuses ahead of a subledger
    // lock that is not closed, after AR has already closed.
    await setPeriodLockState({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      module: "ap",
      state: "soft_closed",
      actorId,
      reason: "AP held for vendor statement review",
    });

    const { results } = await closePeriodAllModules({
      orgId: org.orgId,
      periodId: org.periodId,
      bookId: org.bookId,
      actorId,
      reason: "Month-end close control",
      modules: ["ar", "gl"],
    });

    assert.equal(results.length, 2, "no module is silently skipped");
    assert.deepEqual(results[0], { module: "ar", ok: true });
    assert.equal(results[1]?.module, "gl");
    assert.equal(results[1]?.ok, false);
    assert.match(results[1]?.error ?? "", /before GL/, "GL names the open subledger remedy");
    assert.match(results[1]?.error ?? "", /AP/, "GL names the subledger still open");
    assert.deepEqual(await lockStates(org.orgId, org.periodId, org.bookId), {
      ar: "closed",
      ap: "soft_closed",
    }, "the applied close stays; nothing half-wrote");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("a blank reason fails fast with nothing written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Refusal Controller", "admin");

    await assert.rejects(
      closePeriodAllModules({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
        reason: "   ",
      }),
      /lock-state reason is required/,
    );
    assert.deepEqual(await lockStates(org.orgId, org.periodId, org.bookId), {});
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("unknown modules fail fast with nothing written", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = await createScratchUser(org.orgId, "Close Scope Controller", "admin");

    await assert.rejects(
      closePeriodAllModules({
        orgId: org.orgId,
        periodId: org.periodId,
        bookId: org.bookId,
        actorId,
        reason: "Month-end close control",
        modules: ["ar", "payroll" as CloseModule],
      }),
      /unknown close modules: payroll/,
    );
    assert.deepEqual(await lockStates(org.orgId, org.periodId, org.bookId), {});
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
