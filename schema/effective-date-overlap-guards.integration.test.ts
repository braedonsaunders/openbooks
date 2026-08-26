import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient, QueryResult } from "pg";
import { db, pool } from "../engine/src/db.ts";
import { createScratchOrg, dropScratchOrgReporting } from "../engine/src/test-fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

/**
 * Regression coverage for the nine effective-date overlap guards that were
 * BEFORE-trigger SELECT EXISTS checks (fair_value_prices, field_ticket_
 * policies, item_rate_book_assignments, item_rate_versions, labor_cost_rates,
 * overhead_rates, subsidiary_ownership_interests, tax_registrations, and
 * project_financial_profile_versions). Under READ COMMITTED those triggers
 * could not see a concurrent writer's uncommitted row, so two overlapping
 * authoritative rows could both commit. Migration 0051 replaces them with
 * GiST exclusion constraints, which arbitrate the race in the index.
 *
 * Every guard gets a controlled two-session proof: the second writer must
 * WAIT on the storage guard while the first transaction is open (the exact
 * serialization the old triggers never provided) and be rejected once the
 * first commits — for both a create/create and an update/create race — plus
 * an adjacent non-overlapping two-session commit that must succeed.
 */
interface Statement {
  text: string;
  params?: unknown[];
}

type StatementResult = PromiseSettledResult<QueryResult>;

interface Session {
  client: PoolClient;
  pid: number;
}

async function openSession(): Promise<Session> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const backend = await client.query<{ pid: number }>(
      "select pg_backend_pid() as pid",
    );
    return { client, pid: Number(backend.rows[0]!.pid) };
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

const settle = (promise: Promise<QueryResult>): Promise<StatementResult> =>
  promise.then(
    (value): StatementResult => ({ status: "fulfilled", value }),
    (reason): StatementResult => ({ status: "rejected", reason }),
  );

/**
 * Run the first statement inside an open transaction, then start the second
 * in a second session. The second writer must block on the first (the
 * exclusion constraint waits on the conflicting uncommitted tuple), and the
 * first transaction commits so the loser's outcome is decided. The loser's
 * transaction is always rolled back: a rejected write has nothing to keep,
 * and keeping a would-be winner would pollute the next scenario.
 */
async function raceConflict(
  first: Statement,
  second: Statement,
  firstPrep: Statement[] = [],
): Promise<{ blocked: boolean; second: StatementResult }> {
  const sessionA = await openSession();
  const sessionB = await openSession();
  let openA = true;
  let openB = true;
  try {
    for (const prep of firstPrep) {
      await sessionA.client.query(prep.text, prep.params ?? []);
    }
    await sessionA.client.query(first.text, first.params ?? []);
    let settled: StatementResult | undefined;
    const secondPromise = settle(
      sessionB.client.query(second.text, second.params ?? []),
    );
    void secondPromise.then((value) => {
      settled = value;
    });
    let blocked = false;
    for (
      let attempt = 0;
      attempt < 500 && settled === undefined && !blocked;
      attempt += 1
    ) {
      const state = await pool.query<{ blocked: boolean }>(
        "select $1::int = any(pg_blocking_pids($2::int)) as blocked",
        [sessionA.pid, sessionB.pid],
      );
      if (state.rows[0]?.blocked) blocked = true;
      else await new Promise((resolve) => setTimeout(resolve, 10));
    }
    if (!blocked && settled === undefined) {
      throw new Error(
        `conflict race never reached a decision (blocker ${sessionA.pid}, waiter ${sessionB.pid})`,
      );
    }
    await sessionA.client.query("commit");
    openA = false;
    const result = settled ?? (await secondPromise);
    await sessionB.client.query("rollback").catch(() => undefined);
    openB = false;
    return { blocked, second: result };
  } finally {
    if (openA) await sessionA.client.query("rollback").catch(() => undefined);
    if (openB) await sessionB.client.query("rollback").catch(() => undefined);
    sessionA.client.release();
    sessionB.client.release();
  }
}

/** Two sessions writing adjacent, non-overlapping windows: both commit. */
async function adjacentBothCommit(
  first: Statement,
  second: Statement,
): Promise<void> {
  const sessionA = await openSession();
  const sessionB = await openSession();
  let openA = true;
  let openB = true;
  try {
    await sessionA.client.query(first.text, first.params ?? []);
    await sessionB.client.query(second.text, second.params ?? []);
    await sessionA.client.query("commit");
    openA = false;
    await sessionB.client.query("commit");
    openB = false;
  } finally {
    if (openA) await sessionA.client.query("rollback").catch(() => undefined);
    if (openB) await sessionB.client.query("rollback").catch(() => undefined);
    sessionA.client.release();
    sessionB.client.release();
  }
}

function assertConflictRejected(
  scenario: string,
  outcome: { blocked: boolean; second: StatementResult },
): void {
  assert.equal(
    outcome.blocked,
    true,
    `${scenario}: the conflicting write must wait on the storage guard`,
  );
  assert.equal(
    outcome.second.status,
    "rejected",
    `${scenario}: the conflicting write must be rejected once the blocker commits`,
  );
  if (outcome.second.status === "rejected") {
    assert.match(
      String(outcome.second.reason),
      /exclusion constraint/,
      `${scenario}: rejection must come from an exclusion constraint`,
    );
  }
}

/** Drizzle wraps driver errors, so the PostgreSQL message lives on `cause`. */
function pgMessage(error: unknown): string {
  const cause = (error as { cause?: { message?: string } })?.cause;
  return String(cause?.message ?? error);
}

async function assertRejectsWith(
  query: Promise<unknown>,
  pattern: RegExp,
  scenario: string,
): Promise<void> {
  try {
    await query;
  } catch (error) {
    assert.match(pgMessage(error), pattern, scenario);
    return;
  }
  assert.fail(`${scenario}: expected a rejection matching ${pattern}`);
}

test("fair-value price windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const base = await db.execute<{ id: string }>(sql`
      insert into fair_value_prices (org_id, item_id, currency, unit_price, effective_from, effective_to)
      values (${org.orgId}, ${org.items.fifo}, 'CAD', '100.0000', '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const priceInsert = (from: string, to: string) => ({
      text: `insert into fair_value_prices (org_id, item_id, currency, unit_price, effective_from, effective_to)
             values ($1, $2, 'CAD', '110.0000', $3, $4)`,
      params: [org.orgId, org.items.fifo, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update fair_value_prices set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      priceInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("fair_value_prices update/create", updateCreate);

    const createCreate = await raceConflict(
      priceInsert("2026-10-01", "2026-11-30"),
      priceInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("fair_value_prices create/create", createCreate);

    await adjacentBothCommit(priceInsert("2027-01-01", "2027-02-28"), priceInsert("2027-03-01", "2027-04-30"));

    // Pricing identity includes the currency: another currency never competes.
    await db.execute(sql`
      insert into fair_value_prices (org_id, item_id, currency, unit_price, effective_from, effective_to)
      values (${org.orgId}, ${org.items.fifo}, 'USD', '90.0000', '2026-02-01', '2026-03-31')`);

    // A NULL effective_from means -infinity and therefore overlaps every
    // other active window for the same item and currency.
    await assertRejectsWith(
      db.execute(sql`
        insert into fair_value_prices (org_id, item_id, currency, unit_price, effective_to)
        values (${org.orgId}, ${org.items.fifo}, 'CAD', '160.0000', '2027-06-30')`),
      /exclusion constraint/,
      "fair_value_prices NULL effective_from must overlap every window",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("field ticket policy windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  const otherOrg = await createScratchOrg();
  try {
    const base = await db.execute<{ id: string }>(sql`
      insert into field_ticket_policies (org_id, scope, period, effective_from, effective_to)
      values (${org.orgId}, 'organization', 'daily', '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const policyInsert = (from: string, to: string) => ({
      text: `insert into field_ticket_policies (org_id, scope, period, effective_from, effective_to)
             values ($1, 'organization', 'daily', $2, $3)`,
      params: [org.orgId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update field_ticket_policies set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      policyInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("field_ticket_policies update/create", updateCreate);

    const createCreate = await raceConflict(
      policyInsert("2026-10-01", "2026-11-30"),
      policyInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("field_ticket_policies create/create", createCreate);

    await adjacentBothCommit(policyInsert("2027-01-01", "2027-02-28"), policyInsert("2027-03-01", "2027-04-30"));

    // Policy identity includes the scope: an overlapping customer-scope
    // window is a different resolution lane and commits.
    await db.execute(sql`
      insert into field_ticket_policies (org_id, scope, customer_party_id, period, effective_from, effective_to)
      values (${org.orgId}, 'customer', ${org.customerId}, 'daily', '2026-02-01', '2026-03-31')`);

    // The replaced trigger's tenant-integrity duty survives: a customer
    // policy may not point at another organization's party.
    const foreignParty = randomUUID();
    await db.execute(sql`
      insert into parties (id, org_id, kind, display_name)
      values (${foreignParty}, ${otherOrg.orgId}, 'customer', 'Foreign customer')`);
    await assertRejectsWith(
      db.execute(sql`
        insert into field_ticket_policies (org_id, scope, customer_party_id, period, effective_from)
        values (${org.orgId}, 'customer', ${foreignParty}, 'daily', '2026-02-01')`),
      /field ticket customer policy must belong to the same organization/,
      "field_ticket_policies tenant integrity must survive the guard replacement",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
    await dropScratchOrgReporting(otherOrg.orgId);
  }
});

test("rate-book assignment windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const bookId = randomUUID();
    await db.execute(sql`
      insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
      values (${bookId}, ${org.orgId}, ${"RB-" + randomUUID().slice(0, 8)}, 'Overlap book', 'CAD', false, true)`);
    const base = await db.execute<{ id: string }>(sql`
      insert into item_rate_book_assignments (org_id, rate_book_id, effective_from, effective_to)
      values (${org.orgId}, ${bookId}, '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const assignmentInsert = (from: string, to: string) => ({
      text: `insert into item_rate_book_assignments (org_id, rate_book_id, effective_from, effective_to)
             values ($1, $2, $3, $4)`,
      params: [org.orgId, bookId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update item_rate_book_assignments set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      assignmentInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("item_rate_book_assignments update/create", updateCreate);

    const createCreate = await raceConflict(
      assignmentInsert("2026-10-01", "2026-11-30"),
      assignmentInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("item_rate_book_assignments create/create", createCreate);

    await adjacentBothCommit(
      assignmentInsert("2027-01-01", "2027-02-28"),
      assignmentInsert("2027-03-01", "2027-04-30"),
    );

    // Assignment identity includes the rate book: another book may hold an
    // overlapping window for the same organization-wide scope.
    const otherBookId = randomUUID();
    await db.execute(sql`
      insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
      values (${otherBookId}, ${org.orgId}, ${"RB-" + randomUUID().slice(0, 8)}, 'Second book', 'CAD', false, true)`);
    await db.execute(sql`
      insert into item_rate_book_assignments (org_id, rate_book_id, effective_from, effective_to)
      values (${org.orgId}, ${otherBookId}, '2026-02-01', '2026-03-31')`);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("active item rate version windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const bookId = randomUUID();
    await db.execute(sql`
      insert into item_rate_books (id, org_id, code, name, currency, is_default, is_active)
      values (${bookId}, ${org.orgId}, ${"RB-" + randomUUID().slice(0, 8)}, 'Overlap book', 'CAD', false, true)`);
    // A committed active window plus a draft gap-filler: the update/create
    // race activates the draft (drafts are freely mutable — the immutability
    // guard only pins activated versions), which is exactly the concurrent
    // transition the old trigger could not see.
    await db.execute(sql`
      insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status)
      values (${org.orgId}, ${bookId}, '2026-10-01', '2026-11-30', 'active')`);
    const draftGap = await db.execute<{ id: string }>(sql`
      insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status)
      values (${org.orgId}, ${bookId}, '2026-01-01', '2026-06-30', 'draft')
      returning id`);
    const versionInsert = (from: string, to: string) => ({
      text: `insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status)
             values ($1, $2, $3, $4, 'active')`,
      params: [org.orgId, bookId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      {
        text: "update item_rate_versions set status = 'active' where id = $1",
        params: [String(draftGap.rows[0]!.id)],
      },
      versionInsert("2026-02-01", "2026-03-31"),
    );
    assertConflictRejected("item_rate_versions update/create", updateCreate);

    const createCreate = await raceConflict(
      versionInsert("2026-12-01", "2027-01-31"),
      versionInsert("2027-01-15", "2027-02-28"),
    );
    assertConflictRejected("item_rate_versions create/create", createCreate);

    await adjacentBothCommit(versionInsert("2027-03-01", "2027-04-30"), versionInsert("2027-05-01", "2027-06-30"));

    // Only active versions resolve: a draft may overlap an active window,
    // and the constraint re-checks the moment that draft is activated.
    const draft = await db.execute<{ id: string }>(sql`
      insert into item_rate_versions (org_id, rate_book_id, effective_from, effective_to, status)
      values (${org.orgId}, ${bookId}, '2026-05-01', '2026-05-31', 'draft')
      returning id`);
    await assertRejectsWith(
      db.execute(sql`update item_rate_versions set status = 'active' where id = ${draft.rows[0]!.id}`),
      /exclusion constraint/,
      "item_rate_versions draft activation must re-check the exclusion",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("labor cost rate windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const base = await db.execute<{ id: string }>(sql`
      insert into labor_cost_rates (org_id, currency, rate, basis, effective_from, effective_to)
      values (${org.orgId}, 'CAD', '50.0000', 'hour', '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const rateInsert = (from: string, to: string) => ({
      text: `insert into labor_cost_rates (org_id, currency, rate, basis, effective_from, effective_to)
             values ($1, 'CAD', '55.0000', 'hour', $2, $3)`,
      params: [org.orgId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update labor_cost_rates set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      rateInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("labor_cost_rates update/create", updateCreate);

    const createCreate = await raceConflict(
      rateInsert("2026-10-01", "2026-11-30"),
      rateInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("labor_cost_rates create/create", createCreate);

    await adjacentBothCommit(rateInsert("2027-01-01", "2027-02-28"), rateInsert("2027-03-01", "2027-04-30"));

    // Wage identity is the full scope: a job-title rate may overlap the
    // organization-default window because it resolves independently.
    await db.execute(sql`
      insert into labor_cost_rates (org_id, job_title, currency, rate, basis, effective_from, effective_to)
      values (${org.orgId}, 'Electrician', 'CAD', '60.0000', 'hour', '2026-02-01', '2026-03-31')`);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("overhead rate windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const base = await db.execute<{ id: string }>(sql`
      insert into overhead_rates (org_id, category, method, rate_kind, rate_percent, effective_from, effective_to)
      values (${org.orgId}, 'Published', 'standard', 'per_hour', '10.0000', '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const overheadInsert = (from: string, to: string) => ({
      text: `insert into overhead_rates (org_id, category, method, rate_kind, rate_percent, effective_from, effective_to)
             values ($1, 'Published', 'standard', 'per_hour', '11.0000', $2, $3)`,
      params: [org.orgId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update overhead_rates set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      overheadInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("overhead_rates update/create", updateCreate);

    const createCreate = await raceConflict(
      overheadInsert("2026-10-01", "2026-11-30"),
      overheadInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("overhead_rates create/create", createCreate);

    await adjacentBothCommit(overheadInsert("2027-01-01", "2027-02-28"), overheadInsert("2027-03-01", "2027-04-30"));

    // Rate identity includes the method: a live-method row never competes
    // with the published standard card.
    await db.execute(sql`
      insert into overhead_rates (org_id, category, method, rate_kind, rate_percent, effective_from, effective_to)
      values (${org.orgId}, 'Published', 'live', 'per_hour', '12.0000', '2026-02-01', '2026-03-31')`);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("subsidiary ownership policy windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const childId = randomUUID();
    await db.execute(sql`
      insert into subsidiaries (id, org_id, parent_id, name, base_currency, country, tax_ids, is_elimination, is_active, custom)
      values (${childId}, ${org.orgId}, ${org.subsidiaryId}, 'Owned Co', 'CAD', 'CA', '{}'::jsonb, false, true, '{}'::jsonb)`);
    const base = await db.execute<{ id: string }>(sql`
      insert into subsidiary_ownership_interests
        (org_id, parent_subsidiary_id, subsidiary_id, effective_from, effective_to,
         ownership_percent, method, acquisition_date,
         investment_account_id, equity_income_account_id)
      values (${org.orgId}, ${org.subsidiaryId}, ${childId}, '2026-01-01', '2026-06-30',
              '100', 'equity', '2025-12-31', ${org.accounts.bank}, ${org.accounts.revenue})
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const interestInsert = (from: string, to: string) => ({
      text: `insert into subsidiary_ownership_interests
               (org_id, parent_subsidiary_id, subsidiary_id, effective_from, effective_to,
                ownership_percent, method, acquisition_date,
                investment_account_id, equity_income_account_id)
             values ($1, $2, $3, $4, $5, '100', 'equity', '2025-12-31', $6, $7)`,
      params: [org.orgId, org.subsidiaryId, childId, from, to, org.accounts.bank, org.accounts.revenue] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update subsidiary_ownership_interests set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      interestInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("subsidiary_ownership_interests update/create", updateCreate);

    const createCreate = await raceConflict(
      interestInsert("2026-10-01", "2026-11-30"),
      interestInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("subsidiary_ownership_interests create/create", createCreate);

    await adjacentBothCommit(interestInsert("2027-01-01", "2027-02-28"), interestInsert("2027-03-01", "2027-04-30"));

    // The replaced trigger's hierarchy duty survives: ownership must follow
    // the active tenant consolidation hierarchy.
    await assertRejectsWith(
      db.execute(sql`
        insert into subsidiary_ownership_interests
          (org_id, parent_subsidiary_id, subsidiary_id, effective_from,
           ownership_percent, method, acquisition_date,
           investment_account_id, equity_income_account_id)
        values (${org.orgId}, ${childId}, ${childId}, '2027-05-01',
                '100', 'equity', '2025-12-31', ${org.accounts.bank}, ${org.accounts.revenue})`),
      /ownership interest must follow the active tenant consolidation hierarchy/,
      "subsidiary_ownership_interests hierarchy duty must survive the guard replacement",
    );

    // The replaced trigger's used-policy immutability duty survives: once a
    // consolidation run references the policy it can no longer change.
    const runId = randomUUID();
    await db.execute(sql`
      insert into ownership_consolidation_runs (id, org_id, period_id, status)
      values (${runId}, ${org.orgId}, ${org.periodId}, 'posted')`);
    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin)
      values (${entryId}, ${org.orgId}, ${org.bookId}, ${org.subsidiaryId},
              ${"OBI-" + randomUUID().slice(0, 8)}, ${org.date}, ${org.periodId}, 'used-policy proof', 'draft', 'manual')`);
    await db.execute(sql`
      insert into ownership_consolidation_entries (org_id, run_id, interest_id, kind, journal_entry_id)
      values (${org.orgId}, ${runId}, ${baseId}, 'acquisition', ${entryId})`);
    await assertRejectsWith(
      db.execute(sql`update subsidiary_ownership_interests set ownership_percent = '90' where id = ${baseId}`),
      /used ownership policy is immutable/,
      "subsidiary_ownership_interests used-policy immutability must survive the guard replacement",
    );

    // A used policy still cannot be shadowed by an overlapping successor.
    await assertRejectsWith(
      db.execute(sql`
        insert into subsidiary_ownership_interests
          (org_id, parent_subsidiary_id, subsidiary_id, effective_from, effective_to,
           ownership_percent, method, acquisition_date,
           investment_account_id, equity_income_account_id)
        values (${org.orgId}, ${org.subsidiaryId}, ${childId}, '2027-02-01', '2027-02-15',
                '100', 'equity', '2025-12-31', ${org.accounts.bank}, ${org.accounts.revenue})`),
      /exclusion constraint/,
      "subsidiary_ownership_interests used policy must still exclude overlapping successors",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("tax registration windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const jurisdictionId = randomUUID();
    await db.execute(sql`
      insert into tax_jurisdictions (id, org_id, code, name, country, level, tax_type)
      values (${jurisdictionId}, ${org.orgId}, ${"OV-" + randomUUID().slice(0, 8)}, 'Overlap Province', 'CA', 'country', 'gst')`);
    const base = await db.execute<{ id: string }>(sql`
      insert into tax_registrations (org_id, jurisdiction_id, effective_from, effective_to)
      values (${org.orgId}, ${jurisdictionId}, '2026-01-01', '2026-06-30')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const registrationInsert = (from: string, to: string) => ({
      text: `insert into tax_registrations (org_id, jurisdiction_id, effective_from, effective_to)
             values ($1, $2, $3, $4)`,
      params: [org.orgId, jurisdictionId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      { text: "update tax_registrations set effective_to = $1 where id = $2", params: ["2026-09-30", baseId] },
      registrationInsert("2026-08-01", "2026-10-31"),
    );
    assertConflictRejected("tax_registrations update/create", updateCreate);

    const createCreate = await raceConflict(
      registrationInsert("2026-10-01", "2026-11-30"),
      registrationInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("tax_registrations create/create", createCreate);

    await adjacentBothCommit(
      registrationInsert("2027-01-01", "2027-02-28"),
      registrationInsert("2027-03-01", "2027-04-30"),
    );

    // Registration identity includes the return form: another form's window
    // resolves independently and may overlap.
    await db.execute(sql`
      insert into tax_registrations (org_id, jurisdiction_id, return_form_code, effective_from, effective_to)
      values (${org.orgId}, ${jurisdictionId}, 'CA-GST', '2026-02-01', '2026-03-31')`);

    // A NULL effective_from means -infinity and therefore overlaps every
    // other active registration for the same jurisdiction and return form.
    await assertRejectsWith(
      db.execute(sql`
        insert into tax_registrations (org_id, jurisdiction_id, effective_to)
        values (${org.orgId}, ${jurisdictionId}, '2027-06-30')`),
      /exclusion constraint/,
      "tax_registrations NULL effective_from must overlap every window",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("project financial profile windows exclude concurrent overlaps at storage", { skip: !DB }, async () => {
  const org = await createScratchOrg();
  try {
    const typeId = randomUUID();
    await db.execute(sql`
      insert into project_types (id, org_id, key, name, billing_method, invoicing_profile, backup_profile)
      values (${typeId}, ${org.orgId}, ${"OV-" + randomUUID().slice(0, 8)}, 'Overlap type', 'time_and_materials',
              '{"billingProcedure":"standard"}'::jsonb, '{}'::jsonb)`);
    const base = await db.execute<{ id: string }>(sql`
      insert into project_financial_profile_versions
        (org_id, project_type_id, effective_from, effective_to, financial_profile, reason)
      values (${org.orgId}, ${typeId}, '2026-01-01', '2026-06-30', '{}'::jsonb, 'Overlap guard base fixture')
      returning id`);
    const baseId = String(base.rows[0]!.id);
    const versionInsert = (from: string, to: string) => ({
      text: `insert into project_financial_profile_versions
               (org_id, project_type_id, effective_from, effective_to, financial_profile, reason)
             values ($1, $2, $3, $4, '{}'::jsonb, 'Overlap guard race fixture')`,
      params: [org.orgId, typeId, from, to] as unknown[],
    });

    const updateCreate = await raceConflict(
      {
        text: "update project_financial_profile_versions set effective_to = $1 where id = $2",
        params: ["2026-09-30", baseId],
      },
      versionInsert("2026-08-01", "2026-10-31"),
      [{ text: "select set_config('openbooks.publish_project_profile', 'on', true)" }],
    );
    assertConflictRejected("project_financial_profile_versions update/create", updateCreate);

    const createCreate = await raceConflict(
      versionInsert("2026-10-01", "2026-11-30"),
      versionInsert("2026-11-15", "2026-12-31"),
    );
    assertConflictRejected("project_financial_profile_versions create/create", createCreate);

    await adjacentBothCommit(versionInsert("2027-01-01", "2027-02-28"), versionInsert("2027-03-01", "2027-04-30"));

    // The replaced trigger's governed-window contracts survive: published
    // versions stay immutable outside the publish and correct switches.
    await assertRejectsWith(
      db.execute(sql`
        update project_financial_profile_versions
           set financial_profile = '{"overhead":{"method":"none"}}'::jsonb
         where id = ${baseId}`),
      /published project financial profile versions are immutable/,
      "project_financial_profile_versions JSON immutability must survive the guard replacement",
    );
    await assertRejectsWith(
      db.execute(sql`update project_financial_profile_versions set effective_to = '2027-01-01' where id = ${baseId}`),
      /published project financial profile versions are immutable/,
      "project_financial_profile_versions window immutability must survive the guard replacement",
    );
    await assertRejectsWith(
      db.execute(sql`delete from project_financial_profile_versions where id = ${baseId}`),
      /published project financial profile versions are immutable/,
      "project_financial_profile_versions delete immutability must survive the guard replacement",
    );
    await assertRejectsWith(
      db.transaction(async (tx) => {
        await tx.execute(sql`select set_config('openbooks.correct_project_profile', 'on', true)`);
        await tx.execute(sql`
          update project_financial_profile_versions
             set financial_profile = '{"overhead":{"method":"none"}}'::jsonb
           where id = ${baseId}`);
      }),
      /may change only policy JSON and requires a reason/,
      "project_financial_profile_versions correction mode must still demand a reason",
    );
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
