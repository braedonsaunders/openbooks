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
  return (
    await client.query(
      `insert into employment_changes
         (org_id, employment_id, assignment_id, revision, supersedes_id, change_kind,
          prior_snapshot, reason, recorded_source, recorded_by, recorded_source_ref,
          closed_versions)
       values ($1, $2, $3::uuid, $4, $5::uuid, $6, '{}', 'test evidence ' || $4,
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
        JSON.stringify(
          (opts.closed ?? []).map((c) => ({
            table: c.table,
            identity: c.identity,
            version_no: c.version,
            row_id: c.row,
          })),
        ),
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
             k.confdeltype as del, k.confupdatetype as upd,
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
    const c = await session(true);
    try {
      const e = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      // Same effective window, overlapping recorded window: ambiguous. Deferred:
      // the implicit-transaction commit must refuse with 23P01.
      await assert.rejects(
        mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-06-01T00:00:00Z"),
        (error: unknown) => code(error) === "23P01",
      );
      // Disjoint effective slices may share recorded windows: allowed.
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
        const rows = (
          await check.query(
            `select recorded_at::text as ra, recorded_until::text as ru
             from worker_employment_versions where employment_id = $1 order by version_no`,
            [e],
          )
        ).rows as { ra: string; ru: string | null }[];
        assert.equal(rows.length, 2);
        assert.equal(rows[0]!.ru, "2024-03-01 00:00:00+00");
        assert.equal(rows[1]!.ra, "2024-03-01 00:00:00+00");
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
      build: (c: PoolClient, s: Seed) => Promise<void>,
    ): Promise<void> => {
      const s = await seed(org.orgId, org.subsidiaryId, label);
      const c = await session(true);
      try {
        await build(c, s);
        await assert.rejects(end(c, true), (error: unknown) => code(error) === "23514", label);
      } catch (error) {
        await end(c, false);
        throw error;
      }
    };
    // Self-supersession.
    await attempt("self", async (c, s) => {
      const e = await mkEmployment(c, s, "E1");
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
    await attempt("gap", async (c, s) => {
      const e = await mkEmployment(c, s, "E1");
      const v1 = await mkVersion(c, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e, 2, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await closeVersion(c, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e, 2, "active", "2024-01-01", null, "2024-04-01T00:00:00Z");
    });
    // Evidence bound to another identity's row.
    await attempt("foreign", async (c, s) => {
      const e1 = await mkEmployment(c, s, "E1");
      const e2 = await mkEmployment(c, s, "E2");
      const v1 = await mkVersion(c, s, e1, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      await mkVersion(c, s, e2, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      const change = await mkEvidence(c, s, e1, 2, {
        closed: [{ table: "worker_employment_versions", identity: e2, version: 1, row: v1 }],
      });
      await closeVersion(c, s, e1, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c, s, e1, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
    });
    // Stale-transaction evidence: event committed earlier, closure now.
    const s = await seed(org.orgId, org.subsidiaryId, "stale");
    const setup = await session(true);
    let e = "";
    let v1 = "";
    let change = "";
    try {
      e = await mkEmployment(setup, s, "E1");
      v1 = await mkVersion(setup, s, e, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      change = await mkEvidence(setup, s, e, 1, {
        closed: [{ table: "worker_employment_versions", identity: e, version: 1, row: v1 }],
      });
      await end(setup, true);
    } catch (error) {
      await end(setup, false);
      throw error;
    }
    const c2 = await session(true);
    try {
      await closeVersion(c2, s, e, 1, "2024-03-01T00:00:00Z", change);
      await mkVersion(c2, s, e, 2, "active", "2024-01-01", null, "2024-03-01T00:00:00Z");
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
      await assert.rejects(
        c.query(
          `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id, service_start)
           values ($1, $2, $3, '2020-05-01'::date)`,
          [s.orgId, s.partyId, s.subId],
        ),
        (error: unknown) => code(error) === "23514",
      );
      // system actor with NULL source ref: must fail, not pass-as-NULL.
      const e = await mkEmployment(c, s, "E1");
      await assert.rejects(
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
      await assert.rejects(
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
      await assert.rejects(
        c.query(
          `update worker_employment_versions set status = 'terminated'
           where employment_id = $1 and version_no = 1`,
          [e],
        ),
        /append-only/,
      );
      await assert.rejects(
        c.query(
          `update worker_employment_versions set recorded_at = '2023-01-01T00:00:00Z'
           where employment_id = $1 and version_no = 1`,
          [e],
        ),
        /closure sets/,
      );
      await assert.rejects(
        c.query(
          `update worker_employment_versions set created_by = $1
           where employment_id = $2 and version_no = 1`,
          [s.userId, e],
        ),
        /closure sets/,
      );
      await assert.rejects(
        c.query(`delete from worker_employment_versions where employment_id = $1`, [e]),
        /never deleted/,
      );
      await assert.rejects(
        c.query(`delete from employment_changes where employment_id = $1`, [e]),
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
      // Second primary overlapping in BOTH dimensions: refused.
      await assert.rejects(
        ins(b, 1, true, "2024-01-01", "2024-02-01T00:00:00Z"),
        (error: unknown) => code(error) === "23P01",
      );
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
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "pin");
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
      await assert.rejects(
        c.query(`update employment_assignments set employment_id = $1 where id = $2`, [e2, a]),
        /immutable/,
      );
      await assert.rejects(
        c.query(`update worker_employments set org_id = $1 where id = $2`, [org.orgId, e1]),
        /immutable/,
      );
      await assert.rejects(
        c.query(`update worker_employments set employer_subsidiary_id = $1 where id = $2`, [
          org.subsidiaryId,
          e1,
        ]),
        /immutable/,
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
      await assert.rejects(
        c.query(
          `insert into employment_changes
             (org_id, employment_id, assignment_id, revision, change_kind, prior_snapshot, reason,
              recorded_source, recorded_by)
           values ($1, $2, $3::uuid, 1, 'created', '{}', 'x', 'user', $4::uuid)`,
          [s.orgId, e1, foreign, s.userId],
        ),
        /same employment/,
      );
      await assert.rejects(
        c.query(
          `insert into employment_changes
             (org_id, employment_id, revision, change_kind, prior_snapshot, reason,
              recorded_source, recorded_source_ref)
           values ($1, $2, 1, 'created', '{}', '   ', 'system', 'hrm-test')`,
        ),
        /reason|non-blank|btrim/i,
      );
      await assert.rejects(
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
  // Second legal employer for the two-employment merge case.
  const sub2 = (
    await db.execute<{ id: string }>(sql`
      insert into subsidiaries (org_id, name, base_currency, country)
      values (${org.orgId}, 'Second Legal', 'CAD', 'CA') returning id`)
  ).rows[0]!.id;
  try {
    const s = await seed(org.orgId, org.subsidiaryId, "merge");
    const c = await session(true);
    let first = "";
    let second = "";
    let survivor = "";
    try {
      first = await mkEmployment(c, s, "E1");
      await mkVersion(c, s, first, 1, "active", "2024-01-01", null, "2024-01-01T00:00:00Z");
      second = (
        await c.query(
          `insert into worker_employments (org_id, worker_party_id, employer_subsidiary_id, employment_number)
           values ($1, $2, $3, 'E2') returning id`,
          [s.orgId, s.partyId, sub2],
        )
      ).rows[0]!.id as string;
      // Bare remap with no merge marker: deferred guard rolls back.
      survivor = await mkParty(c, s.orgId, "survivor");
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
    const moved = (result.moved ?? []).find((m) => m.table === "worker_employments");
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
      await assert.rejects(line(p2, e, "2024-01-01", null, rel()), /management cycle/);
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
      await a.query(edge(ea, eb));
      const outcome: PromiseSettledResult<unknown> = await b
        .query(edge(eb, ea))
        .then(
          (value): PromiseSettledResult<unknown> => ({ status: "fulfilled", value }),
          (reason): PromiseSettledResult<unknown> => ({ status: "rejected", reason }),
        );
      // Do NOT pre-commit the loser: a rejected INSERT aborts only itself
      // inside an explicit transaction; commit/rollback decides the rest.
      // Await the loser first so its fate is known before touching A.
      if (outcome.status === "fulfilled") {
        await b.query("commit").catch(() => undefined);
      } else {
        await b.query("rollback").catch(() => undefined);
      }
      await a.query("commit").catch(() => undefined);
      // Fail-closed either way: the loser is refused (cycle 23514 under read
      // committed, serialization 40001 under repeatable read), so at most
      // one of the two opposite edges survives.
      if (outcome.status === "fulfilled") {
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
      } else {
        const got = code(outcome.reason);
        assert.ok(
          got === "23514" || got === "40001",
          `loser refused with cycle or serialization, got ${got}: ${String(
            (outcome.reason as Error)?.message ?? outcome.reason,
          ).slice(0, 200)}`,
        );
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
      await assert.rejects(
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
      await assert.rejects(
        c.query(`delete from worker_employments where id = $1`, [e]),
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
