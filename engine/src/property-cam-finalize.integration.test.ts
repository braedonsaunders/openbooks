import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool } from "./db.ts";
import { PropertyManagementError, createCamPool, finalizeCamPool } from "./property-management.ts";
import {
  createScratchOrg,
  dropScratchOrg,
  dropScratchOrgReporting,
  seedFlowActors,
  type ScratchOrg,
} from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/** Drizzle wraps driver errors in `cause`; unwrap before matching messages. */
const errorText = (error: unknown): string => {
  const cause = (error as { cause?: unknown })?.cause;
  return String(
    (cause instanceof Error ? cause.message : undefined)
      ?? (error instanceof Error ? error.message : error),
  );
};

interface CamFixture {
  org: ScratchOrg;
  actorId: string;
  propertyId: string;
  poolId: string;
  /** The managed property's accounting location dimension. */
  locationId: string;
}

/** Org spine plus one active property on the fixture location and one
 * pro-rata CAM lease overlapping July 2026 — everything one finalizeCamPool
 * call reads. The scratch spine opens exactly July 2026 on the primary book,
 * so the covered advisory scope is one (period, book) pair. */
async function seedCamFixture(): Promise<CamFixture> {
  const org = await createScratchOrg();
  try {
    const { adminId } = await seedFlowActors(org.orgId);
    await db.execute(sql`
      update orgs set settings = jsonb_set(coalesce(settings,'{}'::jsonb), '{features}',
        coalesce(settings->'features','{}'::jsonb) || '{"propertyManagement": true}'::jsonb)
       where id = ${org.orgId}`);
    const propertyId = randomUUID();
    await db.execute(sql`
      insert into managed_properties
        (id, org_id, subsidiary_id, location_id, code, name, property_type, status, currency)
      values (${propertyId}, ${org.orgId}, ${org.subsidiaryId}, ${org.locationId}, 'PRP-CAM',
              'Fence Tower', 'commercial', 'active', 'CAD')`);
    const leaseId = randomUUID();
    await db.execute(sql`
      insert into property_leases
        (id, org_id, property_id, tenant_id, lease_number, status, starts_on, cam_method, cam_share_percent)
      values (${leaseId}, ${org.orgId}, ${propertyId}, ${org.customerId}, 'LSE-CAM', 'active',
              '2026-06-01', 'pro_rata', '100')`);
    const created = await createCamPool({
      orgId: org.orgId,
      actorId: adminId,
      propertyId,
      name: "2026",
      fiscalYear: 2026,
      periodStartsOn: "2026-07-01",
      periodEndsOn: "2026-07-31",
      allocationBasis: "equal",
      budgetAmount: "4000",
      expenseAccountIds: [org.accounts.freight],
    });
    return { org, actorId: adminId, propertyId, poolId: created.id, locationId: org.locationId };
  } catch (error) {
    await dropScratchOrgReporting(org.orgId);
    throw error;
  }
}

/** One balanced freight expense posted through the kernel's guarded ledger
 * writes (draft insert, then the trigger-checked draft→posted flip). */
async function seedPostedCamExpense(org: ScratchOrg, amount: string): Promise<string> {
  const entryId = randomUUID();
  await db.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
    values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
            ${`CAM-${entryId.slice(0, 8)}`}, '2026-07-15', ${org.periodId}, 'draft', 'manual')`);
  await db.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, location_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.freight}, ${org.subsidiaryId}, ${org.locationId},
       ${amount}, 'CAD', ${amount}, '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null,
       ${`-${amount}`}, 'CAD', ${`-${amount}`}, '1')`);
  await db.execute(sql`update journal_entries set status='posted', posted_at=now() where id=${entryId}`);
  return entryId;
}

/** Draft half of a legitimate expense posting, issued inside an explicit
 * second session; the caller parks the kernel-checked draft→posted flip by
 * holding its promise open (and the session's transaction uncommitted). */
async function draftCamExpenseInSession(client: PoolClient, org: ScratchOrg): Promise<string> {
  const entryId = randomUUID();
  await client.query(
    `insert into journal_entries (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, status, origin)
     values ($1, $2, $3, $4, $5, '2026-07-17', $6, 'draft', 'manual')`,
    [entryId, org.orgId, org.bookId, org.subsidiaryId, `CAM-${entryId.slice(0, 8)}`, org.periodId],
  );
  await client.query(
    `insert into journal_lines (org_id, entry_id, line_number, account_id, subsidiary_id, location_id, amount, currency, txn_amount, fx_rate)
     values
       ($1, $2, 1, $3, $4, $5, 300, 'CAD', 300, '1'),
       ($1, $2, 2, $6, $4, null, -300, 'CAD', -300, '1')`,
    [org.orgId, entryId, org.accounts.freight, org.subsidiaryId, org.locationId, org.accounts.ap],
  );
  return entryId;
}

/** The parked draft→posted flip; this statement is where the kernel takes
 * the shared posting fence and re-checks GL module state. */
const flipToPosted = async (client: PoolClient, entryId: string): Promise<void> => {
  await client.query(`update journal_entries set status='posted', posted_at=now() where id=$1`, [entryId]);
};

/** Engine-side close of the covered GL module (the sanctioned direct-seed
 * pattern of the kernel-constraints / journal-posting-atomic suites). */
async function closeGlModule(f: CamFixture): Promise<void> {
  await db.execute(sql`
    insert into period_locks
      (org_id, period_id, book_id, subsidiary_id, module, state, locked_at, locked_by, reason, created_by, updated_by)
    values (${f.org.orgId}, ${f.org.periodId}, ${f.org.bookId}, ${f.org.subsidiaryId}, 'gl', 'closed', now(),
            ${f.actorId}, 'CAM finalization requires frozen source periods', ${f.actorId}, ${f.actorId})`);
}

/** Poll until some backend is parked waiting for a lock held by the given
 * backend (consolidation suite's pg_blocking_pids observation idiom). */
async function waitForBlockedBy(blockerPid: number, hint: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await pool.query(
      "select 1 as blocked from pg_stat_activity where pg_blocking_pids(pid) @> array[$1::int]::int[] and pid <> $1 limit 1",
      [blockerPid],
    );
    if (state.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`timed out waiting for a backend blocked by ${blockerPid} (${hint})`);
}

/** Poll until finalizeCamPool reaches its source-GL read (the distinctive
 * totals statement), which proves it already holds every exclusive fence. */
async function waitForFinalizeInsideFence(): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const state = await pool.query(
      `select 1 as active from pg_stat_activity
        where wait_event_type is null and query ilike '%max(greatest(je.posted_at,je.updated_at))%'
        limit 1`,
    );
    if (state.rows[0]) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out observing finalize reach its fenced source read");
}

test("CAM finalize refuses open GL periods, then freezes audited actuals under closed ones", { skip: !DB }, async () => {
  const f = await seedCamFixture();
  try {
    await seedPostedCamExpense(f.org, "500");

    // Gate: the covered period is still open for GL.
    await assert.rejects(
      finalizeCamPool(f.org.orgId, f.actorId, f.poolId),
      (error: unknown) =>
        error instanceof PropertyManagementError &&
        /Close the GL module/.test(error.message),
    );
    const untouched = await db.execute<{ status: string }>(
      sql`select status from cam_pools where org_id=${f.org.orgId} and id=${f.poolId}`,
    );
    assert.equal(untouched.rows[0]!.status, "open");

    await closeGlModule(f);

    const result = await finalizeCamPool(f.org.orgId, f.actorId, f.poolId);
    assert.deepEqual(result, { actualAmount: "500.0000", allocations: 1 });
    const finalized = await db.execute<{ status: string; actual_amount: string }>(sql`
      select status,actual_amount::text as actual_amount from cam_pools where org_id=${f.org.orgId} and id=${f.poolId}`);
    assert.equal(finalized.rows[0]!.status, "finalized");
    assert.equal(finalized.rows[0]!.actual_amount, "500.0000");

    // Finalization audit carries the source fingerprint and selected scope.
    const auditRow = await db.execute<{ changes: Record<string, unknown> }>(sql`
      select changes from audit_log where org_id=${f.org.orgId} and table_name='cam_pools'
        and row_id=${f.poolId} and action='finalize'`);
    const changes = auditRow.rows[0]!.changes as {
      sourceFingerprint: { total: string; lines: number; lastChange?: string };
      coveredScopes: { periodId: string; bookId: string }[];
      locationId: string;
      expenseAccountIds: string[];
    };
    // total + lines pin the exact committed scope; lastChange only needs to be
    // present as forensic evidence (it is a wall-clock wall).
    assert.equal(changes.sourceFingerprint.total, "500.0000");
    assert.equal(changes.sourceFingerprint.lines, 1);
    assert.ok(typeof changes.sourceFingerprint.lastChange === "string" && changes.sourceFingerprint.lastChange.length > 0);
    assert.deepEqual(changes.coveredScopes, [{ periodId: f.org.periodId, bookId: f.org.bookId }]);
    assert.equal(changes.locationId, f.locationId);
    assert.deepEqual(changes.expenseAccountIds, [f.org.accounts.freight]);
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

/**
 * THE defect case, two sessions, live PG, deterministic interleave:
 *
 *  1. Session B inserts a legitimate draft expense, then flips it to posted.
 *     With the module still open the kernel check passes and B holds the
 *     SHARED posting fence until commit.
 *  2. Session A (finalizeCamPool) must take the EXCLUSIVE side of that exact
 *     advisory key before touching any source data — observe it parked there.
 *  3. B commits its +300 expense.
 *  4. A resumes only after B landed, and must fail its closed-period gate
 *     rather than freeze stale 500 (exactly one side fails).
 *  5. With the module closed through the controlled path, finalize reruns
 *     and INCLUDES B's late expense: 800, equal to the committed ledger sum.
 */
test("a source expense posting during CAM finalize is included-or-blocked, never frozen out", { skip: !DB }, async () => {
  const f = await seedCamFixture();
  try {
    await seedPostedCamExpense(f.org, "500");

    const b = await pool.connect();
    try {
      await b.query("begin");
      const backend = await b.query<{ pid: number }>("select pg_backend_pid() as pid");
      const bPid = Number(backend.rows[0]!.pid);

      const parkedEntryId = await draftCamExpenseInSession(b, f.org);
      // Module open at B's kernel check → passes; B now holds the shared fence.
      await flipToPosted(b, parkedEntryId);

      const finalizeAttempt = finalizeCamPool(f.org.orgId, f.actorId, f.poolId)
        .then((value) => ({ ok: true as const, value }))
        .catch((error: unknown) => ({ ok: false as const, error }));

      await waitForBlockedBy(bPid, "finalize parking on B's posting fence");
      await b.query("commit");

      const outcome = await finalizeAttempt;
      assert.equal(outcome.ok, false, "finalize must refuse once an uncovered late posting exists");
      if (!outcome.ok) {
        assert.match(errorText(outcome.error), /Close the GL module/);
      }

      await closeGlModule(f);
      const result = await finalizeCamPool(f.org.orgId, f.actorId, f.poolId);
      assert.equal(result.actualAmount, "800.0000");

      const committed = await db.execute<{ amount: string }>(sql`
        select coalesce(sum(jl.amount),0)::text as amount from journal_lines jl join journal_entries je on je.id=jl.entry_id and je.org_id=jl.org_id
         where jl.org_id=${f.org.orgId} and je.status='posted' and je.posting_date between '2026-07-01' and '2026-07-31'
           and jl.location_id=${f.locationId}
           and jl.account_id::text in(select jsonb_array_elements_text(expense_account_ids::text::jsonb) from cam_pools where org_id=${f.org.orgId} and id=${f.poolId})`);
      assert.equal(committed.rows[0]!.amount, result.actualAmount);
    } finally {
      // B has committed by this point in the happy path; ending the tx
      // explicitly keeps the recycled pool client clean for teardown.
      await b.query("rollback").catch(() => undefined);
      b.release();
    }
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});

/**
 * The reverse branch: once finalize holds the exclusive fence (proven by
 * observing it inside its fenced source read), a concurrently queued poster
 * cannot commit while finalization runs — after finalize releases the fence
 * with immutable 500 committed, the kernel's own closed-module check rejects
 * the late flip and nothing of the +100 ever lands in the ledger.
 */
test("a queued posting cannot slip into the window while finalize holds the fence", { skip: !DB }, async () => {
  const f = await seedCamFixture();
  try {
    await seedPostedCamExpense(f.org, "500");
    await closeGlModule(f);

    const b = await pool.connect();
    try {
      await b.query("begin");
      const parkedEntryId = await draftCamExpenseInSession(b, f.org);

      const finalizeAttempt = finalizeCamPool(f.org.orgId, f.actorId, f.poolId);
      await waitForFinalizeInsideFence();

      const parkedFlip = flipToPosted(b, parkedEntryId)
        .then((): { landed: true } => ({ landed: true }))
        .catch((error: unknown): { landed: boolean; error?: unknown } => ({ landed: false, error }));

      const result = await finalizeAttempt;
      assert.deepEqual(result, { actualAmount: "500.0000", allocations: 1 });

      const settled = await parkedFlip;
      assert.equal(settled.landed, false, "kernel must reject the queued expense once finalize releases the fence");
      if (!settled.landed) {
        assert.match(errorText(settled.error), /period is closed for GL posting/);
      }

      const lines = await db.execute<{ n: number }>(sql`
        select count(*)::int as n from journal_lines where org_id=${f.org.orgId}`);
      assert.equal(Number(lines.rows[0]!.n), 2, "no +100 expense line may exist anywhere in the ledger");
    } finally {
      // B's transaction is rejected-but-open here; ending it explicitly keeps
      // the recycled pool client clean for teardown.
      await b.query("rollback").catch(() => undefined);
      b.release();
    }
  } finally {
    await dropScratchOrg(f.org.orgId);
  }
});
