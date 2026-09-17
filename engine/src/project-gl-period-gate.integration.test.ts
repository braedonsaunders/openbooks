import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import { db } from "./db.ts";
import { setPeriodLockState } from "./close.ts";
import {
  postProjectGlEntry,
  reverseProjectGlEntry,
} from "./project-recognition.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

/**
 * One period gate for project GL (fleet 8, P7): postProjectGlEntry and its
 * reversal route through assertPeriodModulesOpen instead of raw
 * period_module_is_closed SQL. Policy is preserved — project journals and
 * their reversals are new local activity, not historical replay, so a
 * source-owned imported lock refuses exactly like a user lock. Each path
 * below pins both lock flavors.
 */
const DB = !!process.env.OPENBOOKS_DB_URL;

const IMPORTED_REASON = "close.importedPeriodLockReason";

/** User-owned close, through the same lock writer the close flow uses. */
async function closeGlForUser(org: ScratchOrg, actorId: string): Promise<void> {
  await setPeriodLockState({
    orgId: org.orgId,
    periodId: org.periodId,
    bookId: org.bookId,
    module: "gl",
    state: "closed",
    actorId,
    reason: "fleet8 f2: user-owned GL close",
  });
}

/**
 * Source-owned close, mirroring exactly what the migration mirror lands
 * (engine/src/sync/migrate.ts): every module locked with the imported reason.
 */
async function closeAllImported(org: ScratchOrg): Promise<void> {
  for (const module of ["ar", "ap", "banking", "assets", "tax", "gl"] as const) {
    await db.execute(sql`
      insert into period_locks
        (org_id, period_id, book_id, module, state, locked_at, reason)
      values (${org.orgId}, ${org.periodId}, ${org.bookId}, ${module},
              'closed', now(), ${IMPORTED_REASON})
      on conflict (org_id, period_id, book_id, subsidiary_id, module)
      do update set state = excluded.state,
        locked_at = excluded.locked_at,
        reason = excluded.reason,
        reopen_expires_at = null,
        version = period_locks.version + 1,
        updated_at = now()`);
  }
}

async function journalCount(orgId: string): Promise<number> {
  const r = (await db.execute<{ n: number }>(sql`
    select count(*)::int as n from journal_entries where org_id = ${orgId}`));
  return r.rows[0]!.n;
}

function postArgs(
  org: ScratchOrg,
  actorId: string,
  entryNumber: string,
): Parameters<typeof postProjectGlEntry>[0] {
  return {
    orgId: org.orgId,
    actorId,
    origin: "manual",
    entryNumber,
    postingDate: org.date,
    memo: "Gate probe project journal",
    subsidiaryId: org.subsidiaryId,
    currency: "CAD",
    lines: [
      { accountId: org.accounts.adjustment, amount: "10" },
      { accountId: org.accounts.clearing, amount: "-10" },
    ],
  };
}

test("open period: project GL still posts (setup can post, refusal is load-bearing)", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-OPEN"));
    assert.ok(entryId, "expected a posted entry id");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL posting refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await closeGlForUser(org, actorId);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-USER")),
      /the GL period covering .* is closed/,
      "a project journal into a user-closed period must be refused",
    );
    assert.equal(await journalCount(org.orgId), before, "refused posting left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL posting refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    await closeAllImported(org);
    const before = await journalCount(org.orgId);
    await assert.rejects(
      postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-IMPORTED")),
      /the GL period covering .* is closed/,
      "a project journal into an imported lock must be refused: it is new activity, not replay",
    );
    assert.equal(await journalCount(org.orgId), before, "refused posting left GL residue");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL reversal refuses a user-closed period", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-REV-USER"));
    assert.ok(entryId);
    await closeGlForUser(org, actorId);
    await assert.rejects(
      reverseProjectGlEntry(org.orgId, actorId, entryId!, "Gate probe reversal of a closed-period entry", org.date),
      /the GL period covering .* is closed/,
      "a reversal into a user-closed period must be refused",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("project GL reversal refuses a source-owned imported lock", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actorId = (await seedFlowActors(org.orgId)).adminId;
    const entryId = await postProjectGlEntry(postArgs(org, actorId, "F2-PROJ-REV-IMPORTED"));
    assert.ok(entryId);
    await closeAllImported(org);
    await assert.rejects(
      reverseProjectGlEntry(org.orgId, actorId, entryId!, "Gate probe reversal into an imported lock", org.date),
      /the GL period covering .* is closed/,
      "a reversal into an imported lock must be refused: reversals are not replay",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
