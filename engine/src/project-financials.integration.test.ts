import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { sql } from "drizzle-orm";
import pg from "pg";
import { BUILTIN_PROJECT_TYPES, type FinancialProfile } from "@openbooks/schema";
import { resolveProjectFinancials } from "./project-financials.ts";
import { applyOverheadForTime } from "./overhead-apply.ts";
import { db, pool, type SqlExecutor } from "./db.ts";
import { sum } from "./money.ts";
import { createScratchOrg, dropScratchOrg, seedFlowActors, type ScratchOrg } from "./test-fixtures.ts";

const DB = !!process.env.OPENBOOKS_DB_URL;

/**
 * Project profitability is a many-statement read graph; this suite pins its
 * transactional contract: the whole graph resolves as ONE generation of the
 * ledger (REPEATABLE READ snapshot, or the caller's own transaction), so a
 * commit landing mid-report can never tear headline measures away from their
 * detail breakdowns. The interleave below is deterministic — the staged
 * poster commits between the seeded GL-cost read and the cost-by-account
 * detail read, enforced by the gate around the report's own statements, with
 * no sleeps.
 */

/** The T&M built-in profile: GL cost in headline + detail, no overhead split. */
const profile = BUILTIN_PROJECT_TYPES.find((t) => t.key === "time_and_materials")!
  .financialProfile;

/** Seed a project carrying exactly one posted, balanced, project-tagged cost. */
async function seedProjectWithPostedCost(
  exec: SqlExecutor,
  org: ScratchOrg,
  entryNumber: string,
  lineAmount: string,
): Promise<string> {
  const projectId = randomUUID();
  const entryId = randomUUID();
  await exec.execute(sql`
    insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
    values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-SNAP',
            'Snapshot generation job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
  await exec.execute(sql`
    insert into journal_entries
      (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
    values
      (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId}, ${entryNumber},
       ${org.date}, ${org.periodId}, ${entryNumber}, 'draft', 'manual')`);
  await exec.execute(sql`
    insert into journal_lines
      (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
    values
      (${org.orgId}, ${entryId}, 1, ${org.accounts.cogs}, ${org.subsidiaryId}, ${projectId}, ${lineAmount}, 'CAD', ${lineAmount}, '1'),
      (${org.orgId}, ${entryId}, 2, ${org.accounts.ap}, ${org.subsidiaryId}, null, ${`-${lineAmount}`}, 'CAD', ${`-${lineAmount}`}, '1')`);
  await exec.execute(sql`
    update journal_entries set status = 'posted', posted_at = now() where id = ${entryId}`);
  return projectId;
}

/**
 * Stage a second project-tagged posting on its OWN connection inside an open
 * transaction — invisible until that transaction commits, which happens only
 * when the gate decides the report is mid-flight.
 */
async function stageUncommittedPosting(
  writer: { query(text: string, values?: unknown[]): Promise<unknown> },
  org: ScratchOrg,
  projectId: string,
  entryNumber: string,
  lineAmount: string,
): Promise<void> {
  const entryId = randomUUID();
  await writer.query("begin");
  await writer.query(
    `insert into journal_entries
       (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
     values ($1,$2,$3,$4,$5,$6,$7,$8,'draft','manual')`,
    [entryId, org.orgId, org.bookId, org.subsidiaryId, entryNumber, org.date, org.periodId, entryNumber],
  );
  await writer.query(
    `insert into journal_lines
       (org_id, entry_id, line_number, account_id, subsidiary_id, project_id, amount, currency, txn_amount, fx_rate)
     values ($1,$2,1,$3,$4,$5,$6,'CAD',$6,'1'), ($1,$2,2,$7,$4,null,$8,'CAD',$8,'1')`,
    [org.orgId, entryId, org.accounts.cogs, org.subsidiaryId, projectId, lineAmount, org.accounts.ap, `-${lineAmount}`],
  );
  await writer.query(`update journal_entries set status = 'posted', posted_at = now() where id = $1`, [entryId]);
}

/** Distinctive fragments of the report's read graph, in execution order. */
const HEADER_READ = "from projects p";
const COST_READ = "from journal_lines l";
const COST_DETAIL_READ = "as account_id";

/**
 * Wrap the surfaces the report's statements travel on (pooled `pool.query`
 * before pinning; the dedicated snapshot client's `query` once pinned) and
 * commit the staged poster exactly once: after the GL-cost headline read has
 * fully returned, but before the cost-by-account detail read executes. Both
 * orderings are enforced by awaiting the report's own statements — no sleeps.
 */
function midReportCommitGate(
  writer: { query(text: string): Promise<unknown> },
) {
  let headerSeen = false;
  let costReadDone: Promise<unknown> | undefined;
  let committed = false;

  const commitStagedPosterOnce = async () => {
    if (!committed) {
      committed = true;
      await writer.query("commit");
    }
  };

  const driveGenerationBoundary = async (
    run: () => Promise<unknown>,
    text: string,
  ): Promise<unknown> => {
    if (text.includes(COST_DETAIL_READ)) {
      if (!headerSeen || !costReadDone) {
        throw new Error("mid-report gate mis-sequenced: header or GL-cost read was never observed");
      }
      await costReadDone;
      await commitStagedPosterOnce();
      return run();
    }
    if (!costReadDone && text.includes(COST_READ)) {
      const result = run();
      costReadDone = result;
      return result;
    }
    if (!headerSeen && text.includes(HEADER_READ)) headerSeen = true;
    return run();
  };

  const textOf = (q: unknown): string =>
    typeof q === "string" ? q : String((q as { text?: unknown }).text ?? "");

  const originalQuery = pool.query;
  const pooledQuery = originalQuery.bind(pool) as unknown as (
    text: unknown,
    values?: unknown[],
  ) => Promise<unknown>;
  const originalConnect = pool.connect;
  const pooledConnect = originalConnect.bind(pool) as unknown as () => Promise<
    import("pg").PoolClient
  >;

  return {
    /** True once the staged poster actually committed mid-report. */
    get midReportCommitHappened() {
      return committed;
    },
    install() {
      (pool as unknown as { query: unknown }).query = (
        text: unknown,
        values?: unknown[],
      ) => driveGenerationBoundary(() => pooledQuery(text, values), textOf(text));
      (pool as unknown as { connect: unknown }).connect = async () => {
        const client = await pooledConnect();
        const clientQuery = client.query.bind(client) as unknown as (
          text: unknown,
          values?: unknown[],
        ) => Promise<unknown>;
        (client as unknown as { query: unknown }).query = (
          text: unknown,
          values?: unknown[],
        ) => driveGenerationBoundary(() => clientQuery(text, values), textOf(text));
        return client;
      };
    },
    restore() {
      (pool as unknown as { query: unknown }).query = originalQuery;
      (pool as unknown as { connect: unknown }).connect = originalConnect;
    },
  };
}

test("a project posting committing mid-report stays out of the resolved generation and lands in the next", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  let writer: pg.Client | undefined;
  try {
    const projectId = await seedProjectWithPostedCost(db, org, "SNAP-SEED", "800.0000");

    const stagedWriter = new pg.Client({
      connectionString: process.env.OPENBOOKS_DB_URL,
    });
    await stagedWriter.connect();
    writer = stagedWriter;
    await stageUncommittedPosting(stagedWriter, org, projectId, "SNAP-LATE", "5000.0000");

    const gate = midReportCommitGate(stagedWriter);
    gate.install();
    let report: Awaited<ReturnType<typeof resolveProjectFinancials>>;
    try {
      report = await resolveProjectFinancials(org.orgId, projectId, profile);
    } finally {
      gate.restore();
    }

    // The interleave genuinely happened: the staged poster committed while the
    // report was still resolving, between its headline and detail cost reads.
    assert.ok(gate.midReportCommitHappened, "the staged poster must commit mid-report");
    const lateRows = (await db.execute<{ n: number }>(sql`
      select count(*)::int as n from journal_entries
       where org_id = ${org.orgId} and entry_number = 'SNAP-LATE' and status = 'posted'`));
    assert.equal(lateRows.rows[0]?.n, 1, "the staged posting is durably committed");

    // One coherent generation: the report observed EITHER side of the commit —
    // here, wholly before it — so headline cost, total cost and the
    // cost-by-account detail all agree and exclude the late poster wholesale.
    assert.equal(report.measures.actual_cost, "800.0000");
    assert.equal(report.measures.total_cost, "800.0000");
    assert.equal(
      sum(report.costByAccount.map((row) => row.amount)),
      report.measures.actual_cost,
      "headline actual_cost must reconcile with its own account detail",
    );

    // The next generation absorbs the concurrent posting completely.
    const second = await resolveProjectFinancials(org.orgId, projectId, profile);
    assert.equal(second.measures.actual_cost, "5800.0000");
    assert.equal(
      sum(second.costByAccount.map((row) => row.amount)),
      second.measures.actual_cost,
    );
  } finally {
    if (writer) {
      await writer.query("rollback").catch(() => undefined);
      await writer.end();
    }
    await dropScratchOrg(org.orgId);
  }
});

test("the profitability report reconciles headline cost with its account detail in one stable generation", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const projectId = await seedProjectWithPostedCost(db, org, "SNAP-CALM", "800.0000");

    const report = await resolveProjectFinancials(org.orgId, projectId, profile);

    assert.equal(report.projectType, "time_and_materials");
    assert.equal(report.contractValue, "0.0000");
    assert.equal(report.measures.actual_cost, "800.0000");
    assert.equal(report.measures.total_cost, "800.0000");
    assert.equal(report.measures.gross_profit, "-800.0000");
    assert.deepEqual(report.costByAccount, [
      {
        accountId: org.accounts.cogs,
        number: "5000",
        name: "Cost of Goods Sold",
        amount: "800.0000",
      },
    ]);
    assert.equal(
      sum(report.costByAccount.map((row) => row.amount)),
      report.measures.actual_cost,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

/**
 * rate_engine overhead must resolve the published rate card exactly the way the
 * posting engine does: an org-wide (department-less) rate applies to every
 * entry, a department's own rate overrides the org-wide rows for that
 * department, and stacked org-wide rows sum. Anything else silently drops
 * overhead from total_cost / gross_profit for department-less time.
 */
test("rate-engine overhead matches org-wide rates and the posted net-zero pair", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const actor = (await seedFlowActors(org.orgId)).adminId;
    const projectId = randomUUID();
    const employeeId = randomUUID();
    const departmentId = randomUUID();
    const orgWideEntry = randomUUID();
    const departmentEntry = randomUUID();
    await db.execute(sql`
      insert into projects (id, org_id, subsidiary_id, code, name, customer_id, status, is_active, custom)
      values (${projectId}, ${org.orgId}, ${org.subsidiaryId}, 'JOB-OH', 'Overhead parity job', ${org.customerId}, 'active', true, '{}'::jsonb)`);
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name, subsidiary_id, is_active, custom)
      values (${employeeId}, ${org.orgId}, 'employee', 'Overhead worker', ${org.subsidiaryId}, true, '{}'::jsonb)`);
    await db.execute(sql`insert into departments (id, org_id, name) values (${departmentId}, ${org.orgId}, 'Field crew')`);
    // Two stacked org-wide category rows (10 + 2) and one department row (15).
    await db.execute(sql`
      insert into overhead_rates (id, org_id, department_id, category, method, rate_kind, rate_percent, effective_from)
      values (${randomUUID()}, ${org.orgId}, null, 'Equipment', 'standard', 'per_hour', '10.0000', '2026-01-01'),
             (${randomUUID()}, ${org.orgId}, null, 'Consumables', 'standard', 'per_hour', '2.0000', '2026-01-01'),
             (${randomUUID()}, ${org.orgId}, ${departmentId}, 'Equipment', 'standard', 'per_hour', '15.0000', '2026-01-01')`);
    await db.execute(sql`
      insert into time_entries (id, org_id, employee_party_id, worked_on, hours, project_id, department_id, status, costing_basis, is_billable, custom, created_by, updated_by)
      values (${orgWideEntry}, ${org.orgId}, ${employeeId}, ${org.date}, '4.0000', ${projectId}, null, 'approved', 'actual', false, '{}'::jsonb, ${actor}, ${actor}),
             (${departmentEntry}, ${org.orgId}, ${employeeId}, ${org.date}, '4.0000', ${projectId}, ${departmentId}, 'approved', 'actual', false, '{}'::jsonb, ${actor}, ${actor})`);

    const rateEngineProfile = {
      ...profile,
      overhead: { method: "rate_engine" as const, rateEngine: { rateSource: "standard" as const, hoursBasis: "total_hours" as const, dimension: "overhead", scope: "department" as const } },
      totalCost: { components: ["actual_cost", "committed_cost", "overhead"] as FinancialProfile["totalCost"]["components"] },
    };
    const report = await resolveProjectFinancials(org.orgId, projectId, rateEngineProfile);
    // 4h × (10 + 2) org-wide + 4h × 15 department-specific = 108.
    assert.equal(report.measures.calculated_overhead, "108.0000");
    assert.equal(report.measures.overhead, "108.0000");
    assert.equal(report.measures.total_cost, "108.0000");
    assert.equal(report.measures.gross_profit, "-108.0000");

    // The statistical measure and the posted net-zero pair are ONE rule.
    await db.execute(sql`
      update orgs set settings = settings || ${JSON.stringify({ overheadApplication: { mode: "net_zero_pair", accountId: org.accounts.adjustment } })}::jsonb
       where id = ${org.orgId}`);
    const applied = await applyOverheadForTime(org.orgId, actor, [orgWideEntry, departmentEntry]);
    assert.equal(applied.entries, 2);
    assert.equal(applied.total, report.measures.calculated_overhead);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});
