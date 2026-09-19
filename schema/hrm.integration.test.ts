import assert from "node:assert/strict";
import test from "node:test";
import { sql } from "drizzle-orm";
import type { PoolClient } from "pg";
import { db, pool } from "../engine/src/db.ts";
import { applySourcePartyMerge } from "../engine/src/sync/party-merges.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrgReporting,
} from "../engine/src/test-fixtures.ts";

const skip = !process.env.OPENBOOKS_DB_URL;

/**
 * 0184 HRM employment foundation: storage-level proof for the bitemporal
 * version model, closure allowlists + deferred link-based evidence proof,
 * same-employment provenance, the all-paths manager-cycle walk with
 * graph-revision serialization, tenant RLS through a restricted role,
 * RESTRICT history preservation, and the live-catalog state after the
 * bootstrap RLS refresh (not SQL-file-only assertions).
 *
 * Recorded timestamps are read back as EXACT UTC text (never through JS
 * Date, which truncates the microseconds resolution depends on).
 */

function code(error: unknown): string | undefined {
  let value = error as { code?: unknown; cause?: unknown } | null;
  for (let depth = 0; depth < 5 && value; depth += 1) {
    if (typeof value.code === "string") return value.code;
    value = (value.cause ?? null) as typeof value;
  }
  return undefined;
}

async function session(bypass: boolean, orgId?: string): Promise<PoolClient> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', $1, true)", [bypass ? "on" : "off"]);
    if (orgId) await client.query("select set_config('app.current_org', $1, true)", [orgId]);
    return client;
  } catch (error) {
    client.release(error as Error);
    throw error;
  }
}

async function end(client: PoolClient, commit: boolean): Promise<void> {
  try {
    await client.query(commit ? "commit" : "rollback");
  } finally {
    client.release();
  }
}

// A refused statement aborts its Postgres transaction, so every immediate
// refusal under test runs inside a savepoint that is rolled back: the
// transaction stays healthy and later steps prove what commits. Deferred
// refusals (asserted on end/commit) need no savepoint.
async function refused(
  client: PoolClient,
  run: () => Promise<unknown>,
  match: RegExp,
): Promise<void>;
async function refused(
  client: PoolClient,
  run: () => Promise<unknown>,
  match: (error: unknown) => boolean,
): Promise<void>;
async function refused(
  client: PoolClient,
  run: () => Promise<unknown>,
  match: unknown,
): Promise<void> {
  await client.query("savepoint refused_probe");
  try {
    await assert.rejects(run(), match as RegExp);
  } finally {
    await client.query("rollback to savepoint refused_probe");
  }
}

interface Seed {
  orgId: string;
  subId: string;
  userId: string;
  partyId: string;
}

async function seed(orgId: string, subId: string, name: string): Promise<Seed> {
  const userId = await createScratchUser(orgId, `HRM ${name}`, `hrm_${name}`);
  const party = (
    await db.execute<{ id: string }>(sql`
      insert into parties (org_id, kind, display_name)
      values (${orgId}, 'person', ${`HRM worker ${name}`}) returning id`)
  ).rows[0]!.id;
  return { orgId, subId, userId, partyId: party };
}

async function mkParty(client: PoolClient, orgId: string, name: string): Promise<string> {
  return (
    await client.query(
      `insert into parties (org_id, kind, display_name) values ($1, 'person', $2) returning id`,
      [orgId, name],
    )
  ).rows[0]!.id as string;
}

async function mkEmployment(client: PoolClient, s: Seed, number: string | null): Promise<string> {
  return (
    await client.query(
      `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id, employment_number)
       values ($1, $2, $3, $4) returning id`,
      [s.orgId, s.partyId, s.subId, number],
    )
  ).rows[0]!.id as string;
}

async function mkVersion(
  client: PoolClient,
  s: Seed,
  employmentId: string,
  versionNo: number,
  status: string,
  from: string,
  to: string | null,
  recordedAt: string,
): Promise<string> {
  return (
    await client.query(
      `insert into worker_employment_versions
         (org_id, employment_id, version_no, status, effective_from, effective_to, recorded_at)
       values ($1, $2, $3, $4, $5::date, $6::date, $7::timestamptz) returning id`,
      [s.orgId, employmentId, versionNo, status, from, to, recordedAt],
    )
  ).rows[0]!.id as string;
}

interface ClosedEntry {
  table: string;
  identity: string;
  version: number;
  row: string;
}

// Full-row image for the evidence before element: to_jsonb of the live row,
// no column subtracted. Must equal to_jsonb(OLD) at the deferred forward
// check (UPDATE) — the closing transition only fires from a live row, so no
// exclusion is needed and none is claimed.
const HRM_CLOSE_TABLES = new Set([
  "worker_employment_versions",
  "employment_assignment_versions",
  "reporting_relationships",
]);

async function beforeImage(
  client: PoolClient,
  table: string,
  rowId: string,
): Promise<unknown> {
  assert.ok(HRM_CLOSE_TABLES.has(table), `close table allowlist: ${table}`);
  const rows = (
    await client.query(`select to_jsonb(v) as before from ${table} v where id = $1::uuid`, [rowId])
  ).rows as { before: unknown }[];
  assert.equal(rows.length, 1, `close row must be live: ${table} ${rowId}`);
  return rows[0]!.before;
}

async function mkEvidence(
  client: PoolClient,
  s: Seed,
  employmentId: string,
  revision: number,
  opts: {
    kind?: string;
    assignment?: string | null;
    supersedes?: string | null;
    actor?: "user" | "system";
    closed?: ClosedEntry[];
  } = {},
): Promise<string> {
  // Evidence is written BEFORE the close in these tests, so every named row
  // is still live: read its exact image now, which is what the deferred
  // guard compares against OLD at commit.
  const closed: Record<string, unknown>[] = [];
  for (const c of opts.closed ?? []) {
    closed.push({
      table: c.table,
      identity: c.identity,
      version_no: c.version,
      row_id: c.row,
      before: await beforeImage(client, c.table, c.row),
    });
  }
  return (
    await client.query(
      `insert into employment_changes
         (org_id, employment_id, assignment_id, revision, supersedes_id, change_kind,
          prior_snapshot, reason, recorded_source, recorded_by, recorded_source_ref,
          closed_versions)
       values ($1, $2, $3::uuid, $4, $5::uuid, $6, '{}', $11,
         $7, $8::uuid, $9, $10::jsonb) returning id`,
      [
        s.orgId,
        employmentId,
        opts.assignment ?? null,
        revision,
        opts.supersedes ?? null,
        opts.kind ?? "corrected",
        opts.actor ?? "user",
        opts.actor === "system" ? null : s.userId,
        opts.actor === "system" ? "hrm-test" : null,
        JSON.stringify(closed),
        `test evidence ${revision}`,
      ],
    )
  ).rows[0]!.id as string;
}

async function closeVersion(
  client: PoolClient,
  s: Seed,
  employmentId: string,
  versionNo: number,
  recordedUntil: string,
  changeId: string,
): Promise<void> {
  await client.query(
    `update worker_employment_versions
        set recorded_until = $1::timestamptz, superseded_by = $2,
            closed_by_change_id = $3::uuid, updated_at = now()
      where org_id = $4 and employment_id = $5 and version_no = $6`,
    [recordedUntil, versionNo + 1, changeId, s.orgId, employmentId, versionNo],
  );
}

function rel(): string {
  return `00000000-0000-4000-8000-${Math.floor(Math.random() * 0xffffffffffff)
    .toString(16)
    .padStart(12, "0")}`;
}

test("live catalog preserves RESTRICT composite scoping after bootstrap RLS refresh", { skip }, async () => {
  // Not a SQL-file assertion: the bootstrap RLS refresh rewrites FKs it
  // considers unsafe, so prove the LIVE catalog kept composite RESTRICT.
  const rows = (
    await db.execute<{
      child: string;
      name: string;
      cols: number;
      del: string;
      upd: string;
      defer: string;
    }>(sql`
      select c.relname as child, k.conname as name,
             array_length(k.conkey, 1) as cols,
             k.confdeltype as del, k.confupdtype as upd,
             k.condeferrable as defer
        from pg_constraint k join pg_class c on c.oid = k.conrelid
       where k.contype = 'f' and k.conname like '%_tenant_fkey'
         and c.relname in ('worker_employments', 'worker_employment_versions',
           'employment_assignments', 'employment_assignment_versions',
           'employment_changes', 'reporting_relationships')`)
  ).rows;
  assert.ok(rows.length >= 12, `expected tenant FKs, got ${rows.length}`);
  for (const fk of rows) {
    assert.equal(fk.cols, 2, `${fk.name} must stay composite (org + key)`);
    assert.equal(fk.del, "a", `${fk.name} must stay RESTRICT/NO ACTION, got ${fk.del}`);
    assert.equal(fk.upd, "a", `${fk.name} must stay NO ACTION on update, got ${fk.upd}`);
    assert.equal(fk.defer, true, `${fk.name} must stay deferrable`);
  }
  const rls = (
    await db.execute<{ tbl: string; force: boolean; policies: number }>(sql`
      select c.relname as tbl, c.relforcerowsecurity as force,
             count(p.polname)::int as policies
        from pg_class c left join pg_policy p on p.polrelid = c.oid
       where c.relname in ('worker_employments', 'worker_employment_versions',
           'employment_assignments', 'employment_assignment_versions',
           'employment_changes', 'reporting_relationships', 'hrm_graph_revisions')
       group by c.relname, c.relforcerowsecurity`)
  ).rows;
  assert.equal(rls.length, 7);
  for (const t of rls) {
    assert.equal(t.force, true, `${t.tbl} must keep FORCE RLS live`);
    assert.equal(t.policies, 1, `${t.tbl} must keep exactly the org_isolation policy`);
  }
});

test("bitemporal overlap rejected; disjoint effective slices sharing recorded time allowed", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "bitemp");
    // Same effective window, overlapping recorded window: ambiguous. The
    // exclusion is DEFERRABLE (close/insert/evidence commit in any order in
    // one transaction), so the overlap is tolerated mid-transaction and the
    // COMMIT refuses with 23P01. Separate transaction: the refusal poisons it.
    const bad = await session(true);
    try {
      const e = await mkEmployment(bad, s, "E1");
      await mkVersion(bad, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await mkVersion(bad, s, e, 2, "active", "2024-01-01", null, "2024-06-01T00:00:00Z");
      await assert.rejects(
        end(bad, true),
        (error: unknown) => code(error) === "23P01",
      );
    } catch (error) {
      await end(bad, false);
      throw error;
    }
    // Disjoint effective slices may share recorded windows: allowed.
    const c = await session(true);
    try {
      const e2 = await mkEmployment(c, s, "E2");
      await mkVersion(c, s, e2, 1, "active", "2024-01-01", "2024-06-01", "2024-01-01T00:00:00Z");
      await mkVersion(c, s, e2, 2, "on_leave", "2024-06-01", null, "2024-01-02T00:00:00Z");
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("legitimate correction: close + successor + linked evidence commits in one transaction", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "correct");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await mkEvidence(c, s, e, 1, { kind: "created" });
      // Narrow the effective window. The event is written FIRST with the
      // closure named (row id already known), then the close links it, then
      // the successor opens: any order commits; recorded handoff is seamless.
      const change = await mkEvidence(c, s, e, 2, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e, 2, "active", "2024-03-01", null, "2024-03-01T00:00:00Z");
      await end(c, true);
      const check = await session(true);
      try {
        // EXACT UTC text: ::text would render in the session TimeZone, so
        // convert explicitly (JS Date would also truncate microseconds).
        const rows = (
          await check.query(
            `select (recorded_at at time zone 'UTC')::text as ra,
                    (recorded_until at time zone 'UTC')::text as ru
             from worker_employment_versions where employment_id = $1 order by version_no`,
            [e],
          )
        ).rows as { ra: string; ru: string | null }[];
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.ru, "2024-03-01 00:00:00");
        assert.equal(rows[1]!.ra, "2024-03-01 00:00:00");
        await end(check, true);
      } catch (error) {
        await end(check, false);
        throw error;
      }
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("one aggregate change closes several versions under a single event", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "multi");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const a = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'primary') returning id`,
          [s.orgId, e],
        )
      ).rows[0]!.id as string;
      const av1 = (
        await c.query(
          `insert into employment_assignment_versions
             (org_id, assignment_id, employment_id, version_no, is_primary, effective_from, recorded_at)
           values ($1, $2, $3, 1, true, '2024-01-01'::date, '2024-01-01T00:00:00Z') returning id`,
          [s.orgId, a, e],
        )
      ).rows[0]!.id as string;
      await mkEvidence(c, s, e, 1, { kind: "created" });
      // Status correction + assignment correction in ONE operation, ONE event.
      const change = await mkEvidence(c, s, e, 2, {
        closed: [
          { table: "worker_employment_versions", identity: e, version: 1, row: v1 },
          { table: "employment_assignment_versions", identity: a, version: 1, row: av1 },
        ],
      });
      await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e, 2, "on_leave", "2024-01-01", null, "2024-03-01T00:00:00Z");
      await c.query(
        `update employment_assignment_versions
            set recorded_until = '2024-03-01T00:00:00Z', superseded_by = 2,
                closed_by_change_id = $1::uuid, updated_at = now()
          where assignment_id = $2 and version_no = 1`,
        [change, a],
      );
      await c.query(
        `insert into employment_assignment_versions
           (org_id, assignment_id, employment_id, version_no, is_primary, job_title,
            effective_from, recorded_at)
         values ($1, $2, $3, 2, true, 'Lead', '2024-01-01'::date, '2024-03-01T00:00:00Z')`,
        [s.orgId, a, e],
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("closure without linked same-transaction evidence is refused at commit", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "noev");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const other = await mkEvidence(c, s, e, 2, { kind: "corrected" });
      // Link points at an event that does not name this closure: refused.
      await c.query(
        `update worker_employment_versions
            set recorded_until = '2024-03-01T00:00:00Z', superseded_by = 2,
                closed_by_change_id = $1::uuid
          where employment_id = $2 and version_no = 1`,
        [other, e],
      );
      await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
      await assert.rejects(end(c, true), (error: unknown) => code(error) === "23514");
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("adversarial closures: self, gapped successor, foreign evidence, stale event refused", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const attempt = async (
      label: string,
      build: (c: PoolClient, s: Seed, tag: string) => Promise<void>,
    ): Promise<void> => {
      const s = await seed(org.orgId, org.subsidiaryId, label);
      const c = await session(true);
      try {
        await build(c, s, label);
        await assert.rejects(end(c, true), (error: unknown) => code(error) === "23514", label);
      } catch (error) {
        await end(c, false);
        throw error;
      }
    };
    // Self-supersession.
    await attempt("self", async (c, s, tag) => {
      const e = await mkEmployment(c, s, tag);
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e, 2, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await c.query(
        `update worker_employment_versions
            set recorded_until = '2024-03-01T00:00:00Z', superseded_by = 1,
                closed_by_change_id = $1::uuid
          where employment_id = $2 and version_no = 1`,
        [change, e],
      );
    });
    // Non-adjacent successor (gap between close and successor start).
    await attempt("gap", async (c, s, tag) => {
      const e = await mkEmployment(c, s, tag);
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e, 2, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-04-01T00:00:00Z");
    });
    // Evidence bound to another identity's row.
    await attempt("foreign", async (c, s, tag) => {
      const e1 = await mkEmployment(c, s, `${tag}-1`);
      const e2 = await mkEmployment(c, s, `${tag}-2`);
      const v1 = await mkVersion(c, s, e1, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await mkVersion(c, s, e2, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e1, 2, {
        closed: [{ table: "worker_employment_versions", identity: e2, version: 1, row: v1 }],
      });
      await closeVersion(c, s, e1, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e1, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
    });
    // Stale-transaction evidence: tx1 commits a COMPLETE valid closure
    // (evidence and close in the same transaction, as the reverse proof
    // demands — pre-committing evidence for a future close is itself
    // refused). tx2 then closes the successor row while linking tx1's event:
    // same employment, but a foreign transaction, so the commit refuses.
    const s = await seed(org.orgId, org.subsidiaryId, "stale");
    const setup = await session(true);
    let e = "";
    let change = "";
    try {
      e = await mkEmployment(setup, s, "stale-1");
      const v1 = await mkVersion(
        setup,
        s,
        e,
        1,
        "active",
        "2024-01-01",
        null,
        "2024-01-01T00:00:00Z",
      );
      change = await mkEvidence(setup, s, e, 1, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await closeVersion(setup, s, e, 1, "2024-02-01T00:00:00Z", change);
      await mkVersion(setup, s, e, 2, "active", "2024-01-01", null, "2024-02-01T00:00:00Z");
      await end(setup, true);
    } catch (error) {
      await end(setup, false);
      throw error;
    }
    const c2 = await session(true);
    try {
      await closeVersion(c2, s, e, 2, "2024-03-01T00:00:00Z", change);
      await mkVersion(c2, s, e, 3, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
      await assert.rejects(end(c2, true), (error: unknown) => code(error) === "23514", "stale");
    } catch (error) {
      await end(c2, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("three-valued-logic holes stay shut: null provenance, sourceless system actor, NaN FTE", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "3vl");
    const c = await session(true);
    try {
      // service_start set with NULL provenance: must fail, not pass-as-NULL.
      await refused(
        c,
        () =>
          c.query(
            `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id, service_start)
             values ($1, $2, $3, '2020-05-01'::date)`,
            [s.orgId, s.partyId, s.subId],
          ),
        (error: unknown) => code(error) === "23514",
      );
      // system actor with NULL source ref: must fail, not pass-as-NULL.
      const e = await mkEmployment(c, s, "E1");
      await refused(
        c,
        () =>
          c.query(
            `insert into employment_changes
               (org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_source)
             values ($1, $2, 1, 'created', '{}', 'ok reason', 'system')`,
            [s.orgId, e],
          ),
        (error: unknown) => code(error) === "23514",
      );
      // NaN FTE: numeric NaN sorts above ordinary numbers, so fte > 0 alone
      // accepts it; the explicit NaN rejection must fire.
      const a = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'k') returning id`,
          [s.orgId, e],
        )
      ).rows[0]!.id as string;
      await refused(
        c,
        () =>
          c.query(
            `insert into employment_assignment_versions
               (org_id, assignment_id, employment_id, version_no, fte, effective_from, recorded_at)
             values ($1, $2, $3, 1, 'NaN', '2024-01-01'::date, now())`,
            [s.orgId, a, e],
          ),
        (error: unknown) => code(error) === "23514",
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("closure allowlist: content edits refused, audit touch allowed, deletes refused", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "allow");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      // The delete probes below must match REAL rows: triggers fire per row,
      // so deleting from an empty table would vacuously succeed.
      await mkEvidence(c, s, e, 1, { kind: "created" });
      await refused(
        c,
        () =>
          c.query(
            `update worker_employment_versions set status = 'terminated'
             where employment_id = $1 and version_no = 1`,
            [e],
          ),
        /append-only/,
      );
      // A live row names no successor yet, so content edits stop at the
      // first branch (append-only), never reaching the allowlist branch.
      await refused(
        c,
        () =>
          c.query(
            `update worker_employment_versions set recorded_at = '2023-01-01T00:00:00Z'
             where employment_id = $1 and version_no = 1`,
            [e],
          ),
        /append-only/,
      );
      await refused(
        c,
        () =>
          c.query(
            `update worker_employment_versions set created_by = $1
             where employment_id = $2 and version_no = 1`,
            [s.userId, e],
          ),
        /append-only/,
      );
      // The allowlist branch itself: a closing transition that ALSO rewrites
      // content is refused even though the closing columns are present.
      await refused(
        c,
        () =>
          c.query(
            `update worker_employment_versions
                set recorded_until = '2024-03-01T00:00:00Z', superseded_by = 2,
                    status = 'terminated'
             where employment_id = $1 and version_no = 1`,
            [e],
          ),
        /closure sets/,
      );
      await refused(
        c,
        () => c.query(`delete from worker_employment_versions where employment_id = $1`, [e]),
        /never deleted/,
      );
      await refused(
        c,
        () => c.query(`delete from employment_changes where employment_id = $1`, [e]),
        /immutable/,
      );
      // Pure audit touch passes the allowlist.
      await c.query(
        `update worker_employment_versions set updated_by = $1 where employment_id = $2 and version_no = 1`,
        [s.userId, e],
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("single primary per employment at any bitemporal point; reassignment allowed", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "primary");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      const a = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'primary') returning id`,
          [s.orgId, e],
        )
      ).rows[0]!.id as string;
      const b = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'extra') returning id`,
          [s.orgId, e],
        )
      ).rows[0]!.id as string;
      const ins = (aid: string, v: number, primary: boolean, from: string, rec: string) =>
        c.query(
          `insert into employment_assignment_versions
             (org_id, assignment_id, employment_id, version_no, is_primary, effective_from, recorded_at)
           values ($1, $2, $3, $4, $5, $6::date, $7::timestamptz)`,
          [s.orgId, aid, e, v, primary, from, rec],
        );
      await ins(a, 1, true, "2024-01-01", "2024-01-01T00:00:00Z");
      // Second primary overlapping in BOTH dimensions: refused at commit
      // (the primary exclusion is DEFERRABLE like the overlap exclusions).
      // Separate transaction: the refusal poisons it.
      const bad = await session(true);
      try {
        const be = await mkEmployment(bad, s, "E-dup");
        const ba = (
          await bad.query(
            `insert into employment_assignments (org_id, employment_id, assignment_key)
             values ($1, $2, 'primary') returning id`,
            [s.orgId, be],
          )
        ).rows[0]!.id as string;
        const bb = (
          await bad.query(
            `insert into employment_assignments (org_id, employment_id, assignment_key)
             values ($1, $2, 'extra') returning id`,
            [s.orgId, be],
          )
        ).rows[0]!.id as string;
        const bins = (aid: string, v: number, primary: boolean, from: string, rec: string) =>
          bad.query(
            `insert into employment_assignment_versions
               (org_id, assignment_id, employment_id, version_no, is_primary, effective_from, recorded_at)
             values ($1, $2, $3, $4, $5, $6::date, $7::timestamptz)`,
            [s.orgId, aid, be, v, primary, from, rec],
          );
        await bins(ba, 1, true, "2024-01-01", "2024-01-01T00:00:00Z");
        await bins(bb, 1, true, "2024-01-01", "2024-02-01T00:00:00Z");
        await assert.rejects(
          end(bad, true),
          (error: unknown) => code(error) === "23P01",
        );
      } catch (error) {
        await end(bad, false);
        throw error;
      }
      // Sequential primary (disjoint effective): allowed.
      await ins(b, 1, false, "2024-01-01", "2024-02-01T00:00:00Z");
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("stable identity pinned: assignment parent and employment org/employer cannot move", { skip }, async () => {
  const org = await createScratchOrg();
  const orgB = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "pin");
    // Assignment parent: immediate BEFORE trigger, refused in-transaction.
    const c = await session(true);
    try {
      const e1 = await mkEmployment(c, s, "E1");
      const e2 = await mkEmployment(c, s, "E2");
      const a = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'k') returning id`,
          [s.orgId, e1],
        )
      ).rows[0]!.id as string;
      await refused(
        c,
        () => c.query(`update employment_assignments set employment_id = $1 where id = $2`, [e2, a]),
        /immutable/,
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
    // Employment org/employer: the identity guard is a DEFERRED constraint
    // trigger (merge marker must be visible at commit), so each genuine move
    // — to a REAL other org / subsidiary, never a same-value no-op — is
    // proven at commit. Separate transactions so one refusal poisons nothing.
    // Org move re-points worker AND employer into orgB in the same UPDATE so
    // both composite FKs pass and the guard (org check first) is what fires.
    const probeO = await seed(org.orgId, org.subsidiaryId, "pin-org");
    const oc = await session(true);
    try {
      const partyB = (
        await oc.query(
          `insert into parties (org_id, kind, display_name) values ($1, 'person', 'Pin Dependent') returning id`,
          [orgB.orgId],
        )
      ).rows[0]!.id as string;
      const e = await mkEmployment(oc, probeO, "E-org");
      await oc.query(
        `update worker_employments
            set org_id = $1, worker_party_id = $2, employer_subsidiary_id = $3 where id = $4`,
        [orgB.orgId, partyB, orgB.subsidiaryId, e],
      );
      await assert.rejects(end(oc, true), /immutable/, "pin-org");
    } catch (error) {
      await end(oc, false);
      throw error;
    }
    const sub2 = (
      await db.execute<{ id: string }>(sql`
        insert into subsidiaries (org_id, parent_id, name, base_currency, country)
        values (${org.orgId}, ${org.subsidiaryId}, 'Second Legal', 'CAD', 'CA') returning id`)
    ).rows[0]!.id;
    const probeE = await seed(org.orgId, org.subsidiaryId, "pin-emp");
    const ec = await session(true);
    try {
      const e = await mkEmployment(ec, probeE, "E-emp");
      await ec.query(`update worker_employments set employer_subsidiary_id = $1 where id = $2`, [
        sub2,
        e,
      ]);
      await assert.rejects(end(ec, true), /immutable/, "pin-emp");
    } catch (error) {
      await end(ec, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
    await dropScratchOrgReporting(orgB.orgId);
  }
});

test("evidence provenance: foreign assignment, cross-employment supersedes, actor shape refused", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "prov");
    const c = await session(true);
    try {
      const e1 = await mkEmployment(c, s, "E1");
      const e2 = await mkEmployment(c, s, "E2");
      const foreign = (
        await c.query(
          `insert into employment_assignments (org_id, employment_id, assignment_key)
           values ($1, $2, 'x') returning id`,
          [s.orgId, e2],
        )
      ).rows[0]!.id as string;
      await refused(
        c,
        () =>
          c.query(
            `insert into employment_changes
               (org_id, employment_id, assignment_id, revision, change_kind, prior_snapshot, reason,
                recorded_source, recorded_by)
             values ($1, $2, $3::uuid, 1, 'created', '{}', 'x', 'user', $4::uuid)`,
            [s.orgId, e1, foreign, s.userId],
          ),
        /same employment/,
      );
      await refused(
        c,
        () =>
          c.query(
            `insert into employment_changes
               (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
                recorded_source, recorded_source_ref)
             values ($1, $2, 1, 'created', '{}', '   ', 'system', 'hrm-test')`,
            [s.orgId, e1],
          ),
        /blank|reason|btrim/i,
      );
      await refused(
        c,
        () =>
          c.query(
            `insert into employment_changes
               (org_id, employment_id, revision, change_kind, prior_snapshot, reason, recorded_source)
             values ($1, $2, 1, 'created', '{}', 'ok reason', 'user')`,
            [s.orgId, e1],
          ),
        /actor|recorded_by/i,
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("native merge moves stable employments with marker; bare remap refused", { skip }, async () => {
  const org = await createScratchOrg();
  // Second legal employer for the two-employment merge case: a child of the
  // root (the org root is unique per org, so a second root is refused).
  const sub2 = (
    await db.execute<{ id: string }>(sql`
      insert into subsidiaries (org_id, parent_id, name, base_currency, country)
      values (${org.orgId}, ${org.subsidiaryId}, 'Second Legal', 'CAD', 'CA') returning id`)
  ).rows[0]!.id;
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "merge");
    // The survivor party must outlive the refused remap transaction below
    // (which rolls back), so it is committed in its own setup transaction.
    const sc = await session(true);
    let survivor = "";
    try {
      survivor = await mkParty(sc, s.orgId, "survivor");
      await end(sc, true);
    } catch (error) {
      await end(sc, false);
      throw error;
    }
    // Employments committed FIRST: the refused remap below rolls its whole
    // transaction back, so rows it must later move cannot be created there.
    const setup = await session(true);
    let first = "";
    let second = "";
    try {
      first = await mkEmployment(setup, s, "E1");
      await mkVersion(setup, s, first, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      second = (
        await setup.query(
          `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id, employment_number)
           values ($1, $2, $3, 'E2') returning id`,
          [s.orgId, s.partyId, sub2],
        )
      ).rows[0]!.id as string;
      await end(setup, true);
    } catch (error) {
      await end(setup, false);
      throw error;
    }
    const c = await session(true);
    try {
      // Bare remap with no merge marker: deferred guard rolls back.
      await c.query(`update worker_employments set worker_party_id = $1 where id = $2`, [
        survivor,
        first,
      ]);
      await assert.rejects(end(c, true), /audited native party merge/);
    } catch (error) {
      await end(c, false);
      throw error;
    }
    // Full native merge: BOTH employments under different employers follow
    // with stable ids intact (proves no one-employment-per-party crept in).
    const result = await applySourcePartyMerge({
      orgId: org.orgId,
      sourceName: "hrm-test",
      absorbedRef: "absorbed",
      survivorRef: "survivor",
      absorbedId: s.partyId,
      survivorId: survivor,
      actorId: s.userId,
      runId: "hrm-test-run",
    });
    assert.equal(result.alreadyMerged, false);
    // Move keys are table.column (party-merges moveSimple), not bare table.
    const moved = (result.moved ?? []).find(
      (m) => m.table === "worker_employments.worker_party_id",
    );
    assert.equal(moved?.rows, 2);
    const check = await session(true);
    try {
      const rows = (
        await check.query(
          `select id, employer_subsidiary_id from worker_employments
           where id = any ($1::uuid[]) order by employment_number nulls last`,
          [[first, second]],
        )
      ).rows as { id: string; employer_subsidiary_id: string }[];
      assert.equal(rows.length, 2);
      assert.deepEqual(
        rows.map((r) => r.id).sort(),
        [first, second].sort(),
      );
      assert.deepEqual(
        rows.map((r) => r.employer_subsidiary_id).sort(),
        [s.subId, sub2].sort(),
      );
      await end(check, true);
    } catch (error) {
      await end(check, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("manager cycle through a later effective slice is found; matrix is free", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "cycle");
    const c = await session(true);
    try {
      const mk = (name: string) => mkEmployment(c, { ...s, partyId: name }, name);
      const e = await mk(await mkParty(c, s.orgId, "E"));
      const m = await mk(await mkParty(c, s.orgId, "M"));
      const p1 = await mk(await mkParty(c, s.orgId, "P1"));
      const p2 = await mk(await mkParty(c, s.orgId, "P2"));
      const line = (sub: string, mgr: string, from: string, to: string | null, id: string) =>
        c.query(
          `insert into reporting_relationships
             (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from, effective_to)
           values ($1, $2, $3, 'line', $4::uuid, $5::date, $6::date)`,
          [s.orgId, sub, mgr, id, from, to],
        );
      await line(e, m, "2024-01-01", null, rel());
      await line(m, p1, "2024-01-01", "2025-01-01", rel());
      await line(m, p2, "2025-01-01", null, rel());
      // Cycle E->M->P2->E is reachable only through P2's later slice: refused.
      await refused(c, () => line(p2, e, "2024-01-01", null, rel()), /management cycle/);
      // Matrix edges never participate: the same triangle as matrix passes.
      await c.query(
        `insert into reporting_relationships
           (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from)
         values ($1, $2, $3, 'matrix', $4::uuid, '2024-01-01'::date)`,
        [s.orgId, p2, e, rel()],
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

for (const isolation of ["read committed", "repeatable read"] as const) {
  test(`two-session opposite-edge race fails closed; at most one survives (${isolation})`, { skip }, async () => {
    const org = await createScratchOrg();
    const a = await pool.connect();
    const b = await pool.connect();
    try {
      const s = await seed(org.orgId, org.subsidiaryId, `race-${isolation}`);
      const setup = await session(true);
      let ea = "";
      let eb = "";
      try {
        ea = await mkEmployment(setup, { ...s, partyId: await mkParty(setup, s.orgId, "A") }, "A");
        eb = await mkEmployment(setup, { ...s, partyId: await mkParty(setup, s.orgId, "B") }, "B");
        // First-write seed path: no reporting write has happened yet, so the
        // race below exercises the ON CONFLICT DO NOTHING initialization too.
        const pre = (
          await setup.query(`select count(*)::int as n from hrm_graph_revisions where org_id = $1`, [
            s.orgId,
          ])
        ).rows as { n: number }[];
        assert.equal(pre[0]!.n, 0, "race must start on a fresh graph row");
        await end(setup, true);
      } catch (error) {
        await end(setup, false);
        throw error;
      }
      const edge = (sub: string, mgr: string) =>
        `insert into reporting_relationships
           (org_id, employment_id, manager_employment_id, kind, relationship_id, effective_from)
         values ('${s.orgId}', '${sub}', '${mgr}', 'line', '${rel()}'::uuid, '2024-01-01'::date)`;
      for (const client of [a, b]) {
        await client.query(`begin isolation level ${isolation}`);
        await client.query("select set_config('app.bypass_rls', 'on', true)");
      }
      // Each side commits independently the moment its own INSERT resolves.
      // Holding either side open while awaiting the other deadlocks the
      // harness: the graph-revision seed row serializes the two writers, so
      // the loser blocks until the winner commits, then fails closed (cycle
      // 23514 under read committed once the winner's edge is visible,
      // serialization 40001 under repeatable read).
      const run = async (client: PoolClient, sub: string, mgr: string): Promise<"committed"> => {
        try {
          await client.query(edge(sub, mgr));
          await client.query("commit");
          return "committed";
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          throw error;
        }
      };
      const [oa, ob] = await Promise.allSettled([run(a, ea, eb), run(b, eb, ea)]);
      // Exactly one side must commit: on this fresh graph row the seed
      // INSERT conflict serializes the writers (the pre-count above proves
      // no seed row existed), so the loser only proceeds after the winner
      // commits and then fails closed.
      const committed = [oa, ob].filter((o) => o.status === "fulfilled").length;
      assert.equal(committed, 1, `exactly one edge must commit under ${isolation}`);
      for (const [name, o] of [
        ["a", oa],
        ["b", ob],
      ] as const) {
        if (o.status === "rejected") {
          const got = code(o.reason);
          assert.ok(
            got === "23514" || got === "40001",
            `${name} refused with cycle or serialization, got ${got}: ${String(
              (o.reason as Error)?.message ?? o.reason,
            ).slice(0, 200)}`,
          );
        }
      }
      const check = await session(true);
      try {
        const rows = (
          await check.query(
            `select count(*)::int as n from reporting_relationships
             where org_id = $1 and kind = 'line' and superseded_by is null
               and ((employment_id = $2 and manager_employment_id = $3)
                 or (employment_id = $3 and manager_employment_id = $2))`,
            [s.orgId, ea, eb],
          )
        ).rows as { n: number }[];
        assert.ok(rows[0]!.n <= 1, `both opposite edges survived under ${isolation}`);
        await end(check, true);
      } catch (error) {
        await end(check, false);
        throw error;
      }
    } finally {
      a.release();
      b.release();
      await dropScratchOrgReporting(org.orgId);
    }
  });
}

test("tenant RLS through a restricted role: invisible cross-org, writes refused", { skip }, async () => {
  const orgA = await createScratchOrg();
  const orgB = await createScratchOrg();
  const admin = await pool.connect();
  try {
    await admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runner') THEN
        CREATE ROLE app_runner LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
      END IF; END $$;`);
    // Restrictive privilege assertion: the role under test must never bypass
    // RLS, whatever database this suite lands on. Declared here, not assumed.
    const priv = (
      await admin.query(
        `select rolbypassrls as bypass, rolsuper as super from pg_roles where rolname = 'app_runner'`,
      )
    ).rows as { bypass: boolean; super: boolean }[];
    assert.equal(priv.length, 1, "app_runner must exist (declared above)");
    assert.equal(priv[0]!.bypass, false, "app_runner must not bypass RLS");
    assert.equal(priv[0]!.super, false, "app_runner must not be superuser");
    await admin.query(`GRANT CONNECT ON DATABASE ${admin.database} TO app_runner`);
    await admin.query(`GRANT USAGE ON SCHEMA public TO app_runner`);
    await admin.query(
      `GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_runner`,
    );
    const s = await seed(orgA.orgId, orgA.subsidiaryId, "rls");
    const setup = await session(true);
    try {
      const e = await mkEmployment(setup, s, "E1");
      await mkVersion(setup, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await end(setup, true);
    } catch (error) {
      await end(setup, false);
      throw error;
    }
    const c = await pool.connect();
    try {
      await c.query("begin");
      await c.query("select set_config('app.bypass_rls', 'off', true)");
      await c.query("SET ROLE app_runner");
      await c.query("select set_config('app.current_org', $1, true)", [orgB.orgId]);
      const foreign = (await c.query(`select count(*)::int as n from worker_employments`)).rows[0]!
        .n as number;
      assert.equal(foreign, 0);
      await refused(
        c,
        () =>
          c.query(
            `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id)
             values ($1, $2, $3)`,
            [orgA.orgId, s.partyId, orgA.subsidiaryId],
          ),
        /row-level security|policy/i,
      );
      await c.query("RESET ROLE");
      await c.query("rollback");
    } finally {
      c.release();
    }
  } finally {
    admin.release();
    await dropScratchOrgReporting(orgA.orgId);
    await dropScratchOrgReporting(orgB.orgId);
  }
});

test("history preserved: employment deletes restricted", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "restrict");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await refused(
        c,
        () => c.query(`delete from worker_employments where id = $1`, [e]),
        (error: unknown) => code(error) === "23503",
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("finite civil time: boundary dates commit, infinity/BC/year-10000 refused", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "finite");
    const c = await session(true);
    try {
      // Full supported span commits: earliest civil date through latest.
      const e = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, e, 1, "active", "0001-01-01", "9999-12-31", "2024-01-01T00:00:00Z");
      // Known service start at the earliest boundary commits with provenance.
      await c.query(
        `insert into worker_employments
           (org_id, worker_party_id, employer_subsidiary_id, employment_number, service_start, service_start_provenance)
         values ($1, $2, $3, 'E2', '0001-01-01'::date, 'prior-provider export')`,
        [s.orgId, s.partyId, s.subId],
      );
      await end(c, true);
    } catch (error) {
      await end(c, false);
      throw error;
    }
    // Each refusal runs on a FRESH employment with a single version, so the
    // bitemporal exclusion cannot fire: only the finite-time CHECK can refuse.
    const refuse = async (
      label: string,
      from: string,
      recordedAt: string,
    ): Promise<void> => {
      const probe = await seed(org.orgId, org.subsidiaryId, label);
      const c = await session(true);
      try {
        const e = await mkEmployment(c, probe, label);
        await refused(
          c,
          () => mkVersion(c, probe, e, 1, "active", from, null, recordedAt),
          (error: unknown) => code(error) === "23514",
        );
        await end(c, true);
      } catch (error) {
        await end(c, false);
        throw error;
      }
    };
    await refuse("infinite-effective", "infinity", "2024-01-01T00:00:00Z");
    await refuse("bc-effective", "0001-01-01 BC", "2024-01-01T00:00:00Z");
    await refuse("infinite-recorded", "2024-01-01", "infinity");
    const c2 = await session(true);
    try {
      // Year 10000 is past the reader's last representable instant.
      await refused(
        c2,
        () =>
          c2.query(
            `insert into worker_employments
               (org_id, worker_party_id, employer_subsidiary_id, service_start, service_start_provenance)
             values ($1, $2, $3, '10000-01-01'::date, 'prior-provider export')`,
            [s.orgId, s.partyId, s.subId],
          ),
        (error: unknown) => code(error) === "23514",
      );
      await end(c2, true);
    } catch (error) {
      await end(c2, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("dangling successor refused: superseded_by must name a real version", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "dangle");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e, 2, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      // Version 2 is never inserted: the pointer dangles.
      await c.query(
        `update worker_employment_versions
            set recorded_until = '2024-03-01T00:00:00Z', superseded_by = 99,
                closed_by_change_id = $1::uuid
          where employment_id = $2 and version_no = 1`,
        [change, e],
      );
      await assert.rejects(end(c, true), /dangling/);
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("forged or omitted before-image refused at commit", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const attempt = async (
      label: string,
      mutate: (before: Record<string, unknown>) => Record<string, unknown> | undefined,
    ): Promise<void> => {
      const s = await seed(org.orgId, org.subsidiaryId, label);
      const c = await session(true);
      try {
        const e = await mkEmployment(c, s, label);
        const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
        const live = (await beforeImage(c, "worker_employment_versions", v1)) as Record<
          string,
          unknown
        >;
        const forged = mutate({ ...live });
        const element: Record<string, unknown> = {
          table: "worker_employment_versions",
          identity: e,
          version_no: 1,
          row_id: v1,
        };
        if (forged !== undefined) element.before = forged;
        const change = (
          await c.query(
            `insert into employment_changes
               (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
                recorded_source, recorded_by, closed_versions)
             values ($1, $2, 2, 'corrected', '{}', 'test evidence 2', 'user', $3::uuid, $4::jsonb)
             returning id`,
            [s.orgId, e, s.userId, JSON.stringify([element])],
          )
        ).rows[0]!.id as string;
        await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
        await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
        await assert.rejects(end(c, true), /before-image/, label);
      } catch (error) {
        await end(c, false);
        throw error;
      }
    };
    // Same identifiers, invented content: the status never said terminated.
    await attempt("forged", (before) => ({ ...before, status: "terminated" }));
    // Same identifiers, no image at all.
    await attempt("omitted", () => undefined);
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("duplicate closure entries refused: exactly one element per closure", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "dup");
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const before = await beforeImage(c, "worker_employment_versions", v1);
      const element = {
        table: "worker_employment_versions",
        identity: e,
        version_no: 1,
        row_id: v1,
        before,
      };
      // Same closure named twice with the same (correct) image: no single
      // before-image can be authoritative, so the commit must refuse.
      const change = (
        await c.query(
          `insert into employment_changes
             (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
              recorded_source, recorded_by, closed_versions)
           values ($1, $2, 2, 'corrected', '{}', 'test evidence 2', 'user', $3::uuid, $4::jsonb)
           returning id`,
          [s.orgId, e, s.userId, JSON.stringify([element, element])],
        )
      ).rows[0]!.id as string;
      await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
      await assert.rejects(end(c, true), /more than once/, "dup");
    } catch (error) {
      await end(c, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});

test("evidence false claims refused: nonexistent row and unlinked live row", { skip }, async () => {
  const org = await createScratchOrg();
  try {
    const attempt = async (
      label: string,
      extra: (c: PoolClient, s: Seed, e: string) => Promise<Record<string, unknown>>,
    ): Promise<void> => {
      const s = await seed(org.orgId, org.subsidiaryId, label);
      const c = await session(true);
      try {
        const e = await mkEmployment(c, s, label);
        const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
        const change = (
          await c.query(
            `insert into employment_changes
               (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
                recorded_source, recorded_by, closed_versions)
             values ($1, $2, 2, 'corrected', '{}', 'test evidence 2', 'user', $3::uuid, $4::jsonb)
             returning id`,
            [
              s.orgId,
              e,
              s.userId,
              JSON.stringify([
                {
                  table: "worker_employment_versions",
                  identity: e,
                  version_no: 1,
                  row_id: v1,
                  before: await beforeImage(c, "worker_employment_versions", v1),
                },
                await extra(c, s, e),
              ]),
            ],
          )
        ).rows[0]!.id as string;
        await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
        await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
        // The genuine closure proves forward; the extra element must fail
        // the reverse proof at commit.
        await assert.rejects(end(c, true), /real closed row/, label);
      } catch (error) {
        await end(c, false);
        throw error;
      }
    };
    // Well-formed identifiers, correct shape, but no such row exists.
    await attempt("ghost", async () => ({
      table: "worker_employment_versions",
      identity: "00000000-0000-4000-8000-ffffffffffff",
      version_no: 1,
      row_id: "00000000-0000-4000-8000-ffffffffffff",
      before: {},
    }));
    // A real LIVE row of the same employment with its exact image — but it
    // was never closed by this event, so the link-back fails. Two live
    // versions coexist here (disjoint effective slices sharing recorded time
    // is legal).
    const live = await seed(org.orgId, org.subsidiaryId, "live");
    const lc = await session(true);
    try {
      const e = await mkEmployment(lc, live, "live-1");
      const v1 = await mkVersion(
        lc,
        live,
        e,
        1,
        "active",
        "2024-01-01",
        "2024-06-01",
        "2024-01-01T00:00:00Z",
      );
      const v2 = await mkVersion(
        lc,
        live,
        e,
        2,
        "active",
        "2024-06-01",
        null,
        "2024-02-01T00:00:00Z",
      );
      const change = (
        await lc.query(
          `insert into employment_changes
             (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
              recorded_source, recorded_by, closed_versions)
           values ($1, $2, 2, 'corrected', '{}', 'test evidence 2', 'user', $3::uuid, $4::jsonb)
           returning id`,
          [
            live.orgId,
            e,
            live.userId,
            JSON.stringify([
              {
                table: "worker_employment_versions",
                identity: e,
                version_no: 1,
                row_id: v1,
                before: await beforeImage(lc, "worker_employment_versions", v1),
              },
              {
                table: "worker_employment_versions",
                identity: e,
                version_no: 2,
                row_id: v2,
                before: await beforeImage(lc, "worker_employment_versions", v2),
              },
            ]),
          ],
        )
      ).rows[0]!.id as string;
      // v2 (version_no 2, recorded 02-01) is v1's genuine successor; v2
      // itself stays live, so the extra element claims a row this event
      // never closed.
      await closeVersion(lc, live, e, 1, "2024-02-01T00:00:00Z", change);
      await assert.rejects(end(lc, true), /real closed row/, "live");
    } catch (error) {
      await end(lc, false);
      throw error;
    }
  } finally {
    await dropScratchOrgReporting(org.orgId);
  }
});
