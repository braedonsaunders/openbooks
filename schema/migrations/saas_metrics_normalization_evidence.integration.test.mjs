/**
 * Testdb proof for 0455_saas_metrics_normalization_evidence.
 *
 * Additive DDL foundation only: nullable all-null-or-complete reporting
 * columns on the three SaaS metric tables, append-only FX evidence, and a
 * guarded normalization request lifecycle whose attempt history lives in
 * the canonical audit_log. Proves tenant isolation, the reporting
 * completeness checks, evidence immutability, legal/illegal request
 * transitions, approver immutability, live-token fencing, heartbeat without
 * manufactured events, stale reacquisition after expiry with paired
 * abandoned/reacquired audit rows carrying token digests (never raw
 * tokens), crash/retry, concurrent stale-worker refusal, and that every
 * computed refusal names a usable remedy. 0455 itself is applied here when
 * the template predates it; the file is never rewritten.
 */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";

/** Deterministic distinct 64-hex digests for fixtures. */
const DIGEST_A = "a".repeat(64);
const DIGEST_B = "b".repeat(64);
const DIGEST_C = "c".repeat(64);
const DIGEST_D = "d".repeat(64);
const DIGEST_E = "e".repeat(64);
const DIGEST_F = "f".repeat(64);
/** Pinned SHA-256 over the exact canonical v1 selection payload bytes. */
const SELECTION_DIGEST = "e8c1ae000043448f172f98499341827135cd170081182f2d76558e01d839b8da";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import pg from "pg";
import { withBypassContext } from "@openbooks/engine/src/platform/db.ts";
import { createScratchOrg, dropScratchOrg } from "@openbooks/engine/src/testing/fixtures.ts";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const here = dirname(fileURLToPath(import.meta.url));
const migrationSql = readFileSync(
  join(here, "generated", "0455_saas_metrics_normalization_evidence.sql"),
  "utf8",
);

function connectionString() {
  const explicit = process.env.OPENBOOKS_TEST_ADMIN_DB_URL;
  if (explicit?.trim()) return explicit.trim();
  const runtime = process.env.OPENBOOKS_DB_URL ?? "";
  assert.ok(runtime, "OPENBOOKS_DB_URL is required");
  return runtime;
}

function postgresCode(error) {
  let current = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    if (current.code) return current.code;
    current = current.cause;
  }
  return undefined;
}

async function ensureMigration(client) {
  const existing = await client.query(
    `select to_regclass('public.saas_metrics_fx_evidence') as rel`,
  );
  if (existing.rows[0].rel === null) await client.query(migrationSql);
}

async function seedOrg(client, label) {
  const orgId = randomUUID();
  await client.query(
    `insert into currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `SaaS norm ${label}`],
  );
  return orgId;
}

async function seedSubsidiary(client, orgId) {
  const id = randomUUID();
  await client.query(
    `insert into subsidiaries (id, org_id, name, base_currency, country)
     values ($1, $2, 'Sub', 'CAD', 'CA')`,
    [id, orgId],
  );
  return id;
}

async function seedUser(client, orgId, label) {
  const id = randomUUID();
  await client.query(
    `insert into users (id, org_id, email, name, password_hash)
     values ($1, $2, $3, $4, 'test-hash')`,
    [id, orgId, `${label}-${id}@example.invalid`, `User ${label}`],
  );
  const role = await client.query(
    `insert into app_roles (org_id, key, name, permissions)
     values ($1, $2, 'Normalization reviewer', '[]'::jsonb) returning id`,
    [orgId, `normalization-reviewer-${id}`],
  );
  assert.equal(role.rowCount, 1, "normalization reviewer role is created");
  const assignment = await client.query(
    `insert into role_assignments (org_id, user_id, role_id) values ($1, $2, $3) returning user_id`,
    [orgId, id, role.rows[0].id],
  );
  assert.equal(assignment.rowCount, 1, "active normalization reviewer has an explicit role");
  return id;
}

async function pendingRequest(client, orgId, month) {
  const id = randomUUID();
  const requester = await seedUser(client, orgId, "requester");
  await client.query(
    `insert into saas_metrics_normalization_requests
       (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [id, orgId, month, "normalize September SaaS revenue", requester, randomUUID(), DIGEST_A],
  );
  return { id, requester };
}

async function auditEvents(client, requestId) {
  // These fresh append-only rows can share a transaction timestamp and a
  // millisecond UUID prefix. The insertion command records their order in
  // the transaction; rows emitted by one command are an atomic batch, whose
  // sibling actions are presented deterministically.
  const result = await client.query(
    `select action, changes, actor_id from audit_log
      where table_name = 'saas_metrics_normalization_requests' and row_id = $1
      order by at, cmin::text::bigint, action`,
    [requestId],
  );
  return result.rows;
}

/** Every audit event carries a present actor; D surfaces the retry remedy on zero rows. */
function assertActorsPresent(events) {
  for (const event of events) {
    assert.ok(event.actor_id !== null && event.actor_id !== undefined, `${event.action} carries an actor`);
    assert.ok(event.changes.actor !== null && event.changes.actor !== undefined, `${event.action} names its actor`);
    assert.equal(event.changes.actor, event.actor_id, `${event.action} actor agrees`);
  }
}

test("0455 reporting columns remain nullable and evidence tables enforce tenant isolation",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await ensureMigration(client);
      for (const table of ["saas_metrics_monthly", "saas_metrics_facts_monthly", "saas_metrics_cohort_monthly"]) {
        const cols = await client.query(
          `select column_name, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name in ('reporting_currency', 'denomination_version', 'normalization_evidence')`,
          [table],
        );
        assert.equal(cols.rows.length, 3, `${table} gains the reporting triple`);
        for (const row of cols.rows) assert.equal(row.is_nullable, "YES", `${table}.${row.column_name} stays nullable`);
      }
      for (const table of ["saas_metrics_fx_evidence", "saas_metrics_normalization_requests"]) {
        const rel = await client.query(`select to_regclass($1) as rel`, [`public.${table}`]);
        assert.ok(rel.rows[0].rel !== null, `${table} exists`);
        const rls = await client.query(
          `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
          [`public.${table}`],
        );
        assert.deepEqual([rls.rows[0].relrowsecurity, rls.rows[0].relforcerowsecurity], [true, true]);
      }
    } finally {
      await client.end();
    }
  },
);

test("tenant isolation holds on both new tables", { skip: !DB }, async () => {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await ensureMigration(client);
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const orgA = await seedOrg(client, "iso-A");
    const orgB = await seedOrg(client, "iso-B");
    const month = "2026-09-01";
    await client.query(
      `insert into saas_metrics_fx_evidence
         (org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
       values ($1, $2, 'CAD', 'USD', 0.72, 'bank_of_canada', '2026-09-01T00:00:00Z', '{"base_currency":"CAD","quote_currency":"USD","rate":"0.72","source":"bank_of_canada","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
      [orgA, month],
    );
    const { id: reqA } = await pendingRequest(client, orgA, month);
    await client.query("set local role openbooks_app");
    await client.query("select set_config('app.bypass_rls', 'off', true)");
    await client.query("select set_config('app.current_org', $1, true)", [orgB]);
    const hidden = await client.query(`select id from saas_metrics_fx_evidence where org_id = $1`, [orgA]);
    assert.equal(hidden.rows.length, 0, "org B cannot read org A FX evidence");
    const hiddenReq = await client.query(
      `select id from saas_metrics_normalization_requests where id = $1`, [reqA],
    );
    assert.equal(hiddenReq.rows.length, 0, "org B cannot read org A requests");
    await client.query("savepoint before_cross_insert");
    await assert.rejects(
      client.query(
        `insert into saas_metrics_fx_evidence
           (org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
         values ($1, $2, 'CAD', 'USD', 0.72, 'bank_of_canada', '2026-09-01T00:00:00Z', '{"base_currency":"CAD","quote_currency":"USD","rate":"0.72","source":"bank_of_canada","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
        [orgA, month],
      ),
      (error) => {
        assert.equal(postgresCode(error), "42501");
        return true;
      },
    );
    await client.query("rollback to savepoint before_cross_insert");
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

test("metric reporting triple is all-null-or-complete with a usable shape refusal",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await ensureMigration(client);
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "triple");
      const subId = await seedSubsidiary(client, orgId);
      const base = {
        id: randomUUID(), org_id: orgId, subsidiary_id: subId, month: "2026-09-01",
      };
      const amounts = `0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 'recognised', 'hash'`;
      await client.query(
        `insert into saas_metrics_facts_monthly
           (id, org_id, subsidiary_id, month, mrr_start, mrr_end, new_mrr, expansion_mrr, contraction_mrr,
            churned_mrr, reactivation_mrr, recognized_revenue, deferred_delta, mrr_at_risk,
            customers_start, customers_end, customers_new, customers_churned, customers_reactivated,
            gl_revenue, gl_cogs, bookings, billings, deferred_balance, basis, inputs_hash)
         values ($1, $2, $3, $4, ${amounts})`,
        [base.id, base.org_id, base.subsidiary_id, base.month],
      );
      await client.query("savepoint before_partial");
      await assert.rejects(
        client.query(
          `update saas_metrics_facts_monthly set reporting_currency = 'USD' where id = $1`,
          [base.id],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_partial");
      await client.query("savepoint before_shape");
      await assert.rejects(
        client.query(
          `update saas_metrics_facts_monthly
              set reporting_currency = 'usd', denomination_version = 'v1',
                  normalization_evidence = '{"inputs_hash":"${DIGEST_A}"}'
            where id = $1`,
          [base.id],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_shape");
      await client.query("savepoint before_prose_version");
      await assert.rejects(
        client.query(
          `update saas_metrics_facts_monthly
              set reporting_currency = 'USD', denomination_version = 'Version One',
                  normalization_evidence = '{"inputs_hash":"${DIGEST_A}"}'
            where id = $1`,
          [base.id],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_prose_version");
      await client.query("savepoint before_bad_digest");
      await assert.rejects(
        client.query(
          `update saas_metrics_facts_monthly
              set reporting_currency = 'USD', denomination_version = 'v2',
                  normalization_evidence = '{"inputs_hash":"not-a-digest"}'
            where id = $1`,
          [base.id],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_bad_digest");
      await client.query(
        `update saas_metrics_facts_monthly
            set reporting_currency = 'USD', denomination_version = 'v1',
                normalization_evidence = '{"inputs_hash":"${DIGEST_A}"}'
          where id = $1`,
        [base.id],
      );
      const stored = await client.query(
        `select reporting_currency from saas_metrics_facts_monthly where id = $1`, [base.id],
      );
      assert.equal(stored.rows[0].reporting_currency, "USD");
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);

test("FX evidence is append-only with a remedy-naming refusal", { skip: !DB }, async () => {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await ensureMigration(client);
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const orgId = await seedOrg(client, "fx");
    const evId = randomUUID();
    await client.query(
      `insert into saas_metrics_fx_evidence
         (id, org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
       values ($1, $2, '2026-09-01', 'CAD', 'USD', 0.72, 'bank_of_canada', '2026-09-01T00:00:00Z',
         '{"base_currency":"CAD","quote_currency":"USD","rate":"0.72","source":"bank_of_canada","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
      [evId, orgId],
    );
    for (const statement of [
      `update saas_metrics_fx_evidence set rate = 0.73 where id = '${evId}'`,
      `delete from saas_metrics_fx_evidence where id = '${evId}'`,
    ]) {
      await client.query("savepoint before_immutable");
      await assert.rejects(
        client.query(statement),
        (error) => {
          assert.match(String(error), /instead/);
          return true;
        },
      );
      await client.query("rollback to savepoint before_immutable");
    }
    await client.query("savepoint before_shape");
    await assert.rejects(
      client.query(
        `insert into saas_metrics_fx_evidence
           (org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
         values ($1, '2026-09-01', 'CAD', 'CAD', 1, 'bank_of_canada', '2026-09-01T00:00:00Z',
           '{"base_currency":"CAD","quote_currency":"CAD","rate":"1","source":"bank_of_canada","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
        [orgId],
      ),
      (error) => {
        assert.equal(postgresCode(error), "23514");
        return true;
      },
    );
    await client.query("rollback to savepoint before_shape");
    // A producer-vocabulary source is enforced: free-text provenance refused.
    await client.query("savepoint before_source");
    await assert.rejects(
      client.query(
        `insert into saas_metrics_fx_evidence
           (org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
         values ($1, '2026-09-01', 'CAD', 'USD', 0.72, 'wire-transfer desk notes', '2026-09-01T00:00:00Z',
           '{"base_currency":"CAD","quote_currency":"USD","rate":"0.72","source":"wire-transfer desk notes","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
        [orgId],
      ),
      (error) => {
        assert.equal(postgresCode(error), "23514");
        return true;
      },
    );
    await client.query("rollback to savepoint before_source");
    // Evidence contradicting its typed columns is refused, not stored.
    await client.query("savepoint before_contradiction");
    await assert.rejects(
      client.query(
        `insert into saas_metrics_fx_evidence
           (org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
         values ($1, '2026-09-01', 'CAD', 'USD', 0.72, 'ecb', '2026-09-01T00:00:00Z',
           '{"base_currency":"CAD","quote_currency":"USD","rate":"0.99","source":"ecb","quoted_at":"2026-09-01T00:00:00Z","inputs_hash":"${DIGEST_A}"}', '${DIGEST_A}')`,
        [orgId],
      ),
      (error) => {
        assert.ok(["23514", "22P02"].includes(postgresCode(error)), `refused contradiction, got ${postgresCode(error)}`);
        return true;
      },
    );
    await client.query("rollback to savepoint before_contradiction");
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

test("FX evidence preserves full observation provenance byte-equivalent", { skip: !DB }, async () => {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await ensureMigration(client);
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const orgId = await seedOrg(client, "provenance");
    // Slice-B producible fixture: two direct September observations whose
    // derived rates 0.73 and 0.71 average to exactly the declared envelope
    // rate. Observation ids are pinned UUIDs so the canonical digest below
    // is reproducible byte-for-byte.
    const obsFirst = "00000000-0000-4000-8000-000000000001";
    const obsMid = "00000000-0000-4000-8000-000000000002";
    const observations = [
      { id: obsFirst, asOf: "2026-09-01", source: "bank_of_canada", storedRate: "0.7300000000", updatedAt: "2026-09-01T00:00:00.000000Z", direction: "direct", derivedRate: "0.7300000000" },
      { id: obsMid, asOf: "2026-09-15", source: "bank_of_canada", storedRate: "0.7100000000", updatedAt: "2026-09-15T00:00:00.000000Z", direction: "direct", derivedRate: "0.7100000000" },
    ];
    // Slice-B exact digest payload key order: v, kind, from, to, scope,
    // policy, table, rate, observations. sameCurrencyPar is returned in the
    // selection but intentionally excluded from the digest payload.
    const digestPayload = {
      v: 1,
      kind: "calendar-month-average",
      from: "CAD",
      to: "USD",
      scope: { year: 2026, month: 9, monthStart: "2026-09-01", monthEnd: "2026-09-30" },
      policy: "direct-or-inverse-spot",
      table: "fx_rates",
      rate: "0.7200000000",
      observations,
    };
    const computedDigest = createHash("sha256").update(JSON.stringify(digestPayload), "utf8").digest("hex");
    assert.equal(computedDigest, SELECTION_DIGEST, "canonical digest pins the exact v1 payload bytes");
    const selection = {
      policy: "direct-or-inverse-spot",
      table: "fx_rates",
      kind: "calendar-month-average",
      year: 2026,
      month: 9,
      monthStart: "2026-09-01",
      monthEnd: "2026-09-30",
      from: "CAD",
      to: "USD",
      rate: "0.7200000000",
      digest: computedDigest,
      sameCurrencyPar: false,
      observations,
    };
    const provenance = {
      base_currency: "CAD",
      quote_currency: "USD",
      rate: "0.7200000000",
      source: "bank_of_canada",
      quoted_at: "2026-09-01T00:00:00Z",
      inputs_hash: DIGEST_A,
      selection,
    };
    const evId = randomUUID();
    await client.query(
      `insert into saas_metrics_fx_evidence
         (id, org_id, month, base_currency, quote_currency, rate, source, quoted_at, evidence, inputs_hash)
       values ($1, $2, '2026-09-01', 'CAD', 'USD', 0.72, 'bank_of_canada', '2026-09-01T00:00:00Z', $3, '${DIGEST_A}')`,
      [evId, orgId, JSON.stringify(provenance)],
    );
    const stored = await client.query(
      `select base_currency, quote_currency, rate, source, quoted_at, inputs_hash, evidence
         from saas_metrics_fx_evidence where id = $1`,
      [evId],
    );
    assert.equal(stored.rows.length, 1);
    assert.deepEqual(stored.rows[0].evidence, provenance, "full provenance round-trips without loss");
    assert.deepEqual(stored.rows[0].evidence.selection, selection, "selection round-trips byte-equivalent");
    assert.equal(stored.rows[0].evidence.selection.observations.length, 2);
    assert.equal(stored.rows[0].evidence.selection.observations[0].id, obsFirst);
    assert.equal(stored.rows[0].evidence.selection.observations[1].id, obsMid);
    assert.equal(stored.rows[0].base_currency, stored.rows[0].evidence.base_currency);
    assert.equal(stored.rows[0].quote_currency, stored.rows[0].evidence.quote_currency);
    assert.equal(stored.rows[0].source, stored.rows[0].evidence.source);
    assert.equal(stored.rows[0].inputs_hash, stored.rows[0].evidence.inputs_hash);
    assert.equal(Number(stored.rows[0].rate), Number(stored.rows[0].evidence.rate));
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

test("request lifecycle: guarded transitions, live-token fencing, immutable approver",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await ensureMigration(client);
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "lifecycle");
      const otherOrg = await seedOrg(client, "lifecycle-other");
      const requester = await seedUser(client, orgId, "requester");
      const approver = await seedUser(client, orgId, "approver");
      const replacementApprover = await seedUser(client, orgId, "replacement-approver");
      const stranger = await seedUser(client, otherOrg, "stranger");
      const month = "2026-09-01";

      // Inserts start pending with a requester, no lease, no outcome, no approver.
      await client.query("savepoint before_running_insert");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, requested_by, idempotency_key, request_hash, status)
           values ($1, $2, 'normalize September SaaS revenue', $3, $4, '${DIGEST_B}', 'running')`,
          [orgId, month, requester, randomUUID()],
        ),
        /start as pending/,
      );
      await client.query("rollback to savepoint before_running_insert");
      await client.query("savepoint before_missing_requester");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, idempotency_key, request_hash)
           values ($1, $2, 'normalize September SaaS revenue', $3, '${DIGEST_B}')`,
          [orgId, month, randomUUID()],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23502");
          return true;
        },
      );
      await client.query("rollback to savepoint before_missing_requester");
      await client.query("savepoint before_short_reason");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, requested_by, idempotency_key, request_hash)
           values ($1, $2, 'short', $3, $4, '${DIGEST_B}')`,
          [orgId, month, requester, randomUUID()],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_short_reason");
      const reqId = randomUUID();
      const idemKey = randomUUID();
      await client.query(
        `insert into saas_metrics_normalization_requests
           (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
         values ($1, $2, $3, 'normalize September SaaS revenue', $4, $5, '${DIGEST_B}')`,
        [reqId, orgId, month, requester, idemKey],
      );
      // Cross-organization actor is refused against the subject.
      await client.query("savepoint before_stranger");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
          [stranger, reqId],
        ),
        /requesting organization/,
      );
      await client.query("rollback to savepoint before_stranger");
      // The approver must be distinct from the requester.
      await client.query("savepoint before_self_approve");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
          [requester, reqId],
        ),
        /distinct from the requester/,
      );
      await client.query("rollback to savepoint before_self_approve");
      // Deleting the requester is refused: identity cannot be erased.
      await client.query("set constraints all immediate");
      await client.query("savepoint before_user_delete");
      await assert.rejects(
        client.query(`delete from users where id = $1`, [requester]),
        (error) => {
          assert.equal(postgresCode(error), "23503");
          return true;
        },
      );
      await client.query("rollback to savepoint before_user_delete");
      // Approval records once and stays immutable with a usable audit row.
      await client.query(
        `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
        [approver, reqId],
      );
      await client.query("savepoint before_reapprove");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests set approved_by = $1 where id = $2`,
          [replacementApprover, reqId],
        ),
        /approver is immutable once recorded; the recorded approval stands/,
      );
      await client.query("rollback to savepoint before_reapprove");
      // Illegal jump pending to succeeded names the legal path.
      const tokenA = randomUUID();
      await client.query("savepoint before_jump");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests
              set status = 'succeeded', result = '{"ok":true}'
            where id = $1`,
          [reqId],
        ),
        /pending to running/,
      );
      await client.query("rollback to savepoint before_jump");
      // An unapproved claim fails with the approval remedy.
      const unapprovedId = randomUUID();
      await client.query(
        `insert into saas_metrics_normalization_requests
           (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
         values ($1, $2, '2026-08-01', 'normalize August SaaS revenue unapproved', $3, $4, '${DIGEST_F}')`,
        [unapprovedId, orgId, requester, randomUUID()],
      );
      await client.query("savepoint before_unapproved_claim");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests
              set status = 'running', lease_token = $1,
                  lease_expires_at = now() + interval '1 hour', attempt_count = 1, updated_by = $2
            where id = $3`,
          [randomUUID(), requester, unapprovedId],
        ),
        /recorded approval/,
      );
      await client.query("rollback to savepoint before_unapproved_claim");
      // A cross-org actor cannot execute even an approved claim.
      await client.query("savepoint before_stranger_claim");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests
              set status = 'running', lease_token = $1,
                  lease_expires_at = now() + interval '1 hour', attempt_count = 1, updated_by = $2
            where id = $3`,
          [randomUUID(), stranger, reqId],
        ),
        /approver as the acting user/,
      );
      await client.query("rollback to savepoint before_stranger_claim");
      // First claim is D-shaped: pending plus recorded approval, exactly one row.
      // Execution runs as the approver, never the requester.
      const claim = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'running', lease_token = $1,
                lease_expires_at = now() + interval '2 seconds', attempt_count = 1, updated_by = $2
          where id = $3 and org_id = $4 and status = 'pending'
            and approved_by is not null and approved_at is not null
          returning id`,
        [tokenA, approver, reqId, orgId],
      );
      assert.equal(claim.rowCount, 1, "approved pending claim affects exactly one row");
      // A concurrent second first-claim matches zero rows: already claimed.
      const loserClaim = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'running', lease_token = $1,
                lease_expires_at = now() + interval '1 hour', attempt_count = 1, updated_by = $2
          where id = $3 and org_id = $4 and status = 'pending'
            and approved_by is not null and approved_at is not null
          returning id`,
        [randomUUID(), approver, reqId, orgId],
      );
      assert.equal(loserClaim.rowCount, 0, "second first-claim matches zero rows; the request left pending, inspect status");
      let events = await auditEvents(client, reqId);
      assert.deepEqual(events.map((e) => e.action), [
        "saas_normalization_requested",
        "saas_normalization_approved",
        "saas_normalization_claimed",
      ]);
      assertActorsPresent(events);
      assert.equal(events[0].changes.actor, requester, "request event actor is the requester");
      assert.equal(events[1].changes.actor, approver, "approval event actor is the approver");
      assert.equal(events[2].changes.actor, approver, "claim event actor is the approver");
      assert.equal(events[2].changes.attempt, 1);
      assert.match(events[2].changes.newLeaseDigest, /^sha256:[0-9a-f]{64}$/);
      assert.ok(!JSON.stringify(events[2].changes).includes(tokenA), "raw lease token never enters audit");
      // Concurrent stale worker cannot steal the live lease.
      await client.query("savepoint before_steal");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests
              set lease_token = $1, lease_expires_at = now() + interval '1 hour', attempt_count = 2
            where id = $2`,
          [randomUUID(), reqId],
        ),
        /still live/,
      );
      await client.query("rollback to savepoint before_steal");
      // Live heartbeat updates progress and manufactures no audit event.
      await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":10}' where id = $1`,
        [reqId],
      );
      events = await auditEvents(client, reqId);
      assert.equal(events.length, 3, "heartbeat appends no attempt event");
      const hb = await client.query(`select last_heartbeat_at from saas_metrics_normalization_requests where id = $1`, [reqId]);
      assert.ok(hb.rows[0].last_heartbeat_at !== null);
      // D-shaped conditional heartbeat: the live token updates exactly one row.
      const liveHb = await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":11}'
          where id = $1 and org_id = $2 and status = 'running'
            and lease_token = $3 and lease_expires_at > now()
          returning id`,
        [reqId, orgId, tokenA],
      );
      assert.equal(liveHb.rowCount, 1, "live token heartbeats exactly one row");
      // A wrong token matches zero rows: the caller surfaces the retry remedy.
      const wrongHb = await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":12}'
          where id = $1 and org_id = $2 and status = 'running'
            and lease_token = $3 and lease_expires_at > now()
          returning id`,
        [reqId, orgId, randomUUID()],
      );
      assert.equal(wrongHb.rowCount, 0, "wrong token matches zero rows; surface the live-claim retry remedy");
      // A live-token heartbeat presenting a stranger actor refuses.
      await client.query("savepoint before_stranger_hb");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests set progress = '{"scanned":13}', updated_by = $1 where id = $2`,
          [stranger, reqId],
        ),
        /approver as the acting user/,
      );
      await client.query("rollback to savepoint before_stranger_hb");
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);

test("stale reacquisition after expiry pairs abandoned evidence and fences the old worker",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    const org = await withBypassContext(() => createScratchOrg());
    try {
      await ensureMigration(client);
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = org.orgId;
      const month = "2026-10-01";
      const reqId = randomUUID();
      const requester = await seedUser(client, orgId, "requester");
      const approver = await seedUser(client, orgId, "approver");
      await client.query(
        `insert into saas_metrics_normalization_requests
           (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
         values ($1, $2, $3, 'normalize October SaaS revenue', $4, $5, '${DIGEST_C}')`,
        [reqId, orgId, month, requester, randomUUID()],
      );
      await client.query(
        `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
        [approver, reqId],
      );
      const tokenA = randomUUID();
      const claim = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'running', lease_token = $1,
                lease_expires_at = now() + interval '2 seconds', attempt_count = 1,
                progress = '{"scanned":7}', updated_by = $2
          where id = $3 and org_id = $4 and status = 'pending'
            and approved_by is not null and approved_at is not null
          returning id`,
        [tokenA, approver, reqId, orgId],
      );
      assert.equal(claim.rowCount, 1, "approved pending claim affects exactly one row");
      // Commit the claim so the next transaction has a new now(). Wait for
      // the stored expiry using the database wall clock, then prove expiry
      // is visible to the transaction that exercises the refused heartbeat.
      await client.query("commit");
      await client.query(
        `select pg_sleep(greatest(0, extract(epoch from (lease_expires_at - clock_timestamp()))::double precision))
           from saas_metrics_normalization_requests where id = $1`, [reqId],
      );
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const expired = await client.query(
        `select lease_expires_at <= now() as expired from saas_metrics_normalization_requests where id = $1`, [reqId],
      );
      assert.deepEqual(expired.rows, [{ expired: true }], "new transaction observes the stored lease expiry");
      // Expired heartbeat refuses and names reacquisition as the remedy.
      await client.query("savepoint before_expired_hb");
      await assert.rejects(
        client.query(`update saas_metrics_normalization_requests set progress = '{"scanned":8}' where id = $1`, [reqId]),
        /reacquire/,
      );
      await client.query("rollback to savepoint before_expired_hb");
      // D-shaped conditional heartbeat after expiry matches zero rows.
      const expiredHb = await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":8}'
          where id = $1 and org_id = $2 and status = 'running'
            and lease_token = $3 and lease_expires_at > now()
          returning id`,
        [reqId, orgId, tokenA],
      );
      assert.equal(expiredHb.rowCount, 0, "expired lease matches zero rows; reacquire, then retry");
      // Reacquisition is D-shaped: expired old token fences exactly one row.
      // A concurrent loser presenting a foreign token matches zero rows.
      const loser = await client.query(
        `update saas_metrics_normalization_requests
            set lease_token = $1, lease_expires_at = now() + interval '1 hour',
                attempt_count = 2, updated_by = $2
          where id = $3 and org_id = $4 and status = 'running'
            and lease_token = $5 and lease_expires_at <= now()
          returning id`,
        [randomUUID(), requester, reqId, orgId, randomUUID()],
      );
      assert.equal(loser.rowCount, 0, "foreign token reacquires zero rows; wait for expiry with the held token, then retry");
      const tokenB = randomUUID();
      const reacquire = await client.query(
        `update saas_metrics_normalization_requests
            set lease_token = $1, lease_expires_at = now() + interval '1 hour',
                attempt_count = 2, progress = '{"scanned":0}', updated_by = $2
          where id = $3 and org_id = $4 and status = 'running'
            and lease_token = $5 and lease_expires_at <= now()
          returning id`,
        [tokenB, approver, reqId, orgId, tokenA],
      );
      assert.equal(reacquire.rowCount, 1, "expired lease reacquires exactly one row");
      const events = await auditEvents(client, reqId);
      assert.deepEqual(events.map((e) => e.action), [
        "saas_normalization_requested",
        "saas_normalization_approved",
        "saas_normalization_claimed",
        "saas_normalization_abandoned",
        "saas_normalization_reacquired",
      ]);
      assertActorsPresent(events);
      const abandoned = events[3].changes;
      assert.equal(abandoned.attempt, 1);
      assert.deepEqual(abandoned.progressBefore, { scanned: 7 });
      assert.match(abandoned.priorLeaseDigest, /^sha256:[0-9a-f]{64}$/);
      const serialized = JSON.stringify(events.map((e) => e.changes));
      assert.ok(!serialized.includes(tokenA) && !serialized.includes(tokenB), "digests only, never raw tokens");
      // D-shaped fenced heartbeat: the new live token hits exactly one row.
      const liveHb = await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":1}'
          where id = $1 and org_id = $2 and status = 'running'
            and lease_token = $3 and lease_expires_at > now()
          returning id`,
        [reqId, orgId, tokenB],
      );
      assert.equal(liveHb.rowCount, 1, "reacquired token heartbeats exactly one row");
      // The crashed worker's stale token matches zero rows: surface the retry remedy.
      const staleHb = await client.query(
        `update saas_metrics_normalization_requests set progress = '{"scanned":2}'
          where id = $1 and org_id = $2 and status = 'running'
            and lease_token = $3 and lease_expires_at > now()
          returning id`,
        [reqId, orgId, tokenA],
      );
      assert.equal(staleHb.rowCount, 0, "stale token matches zero rows; the attempt was superseded, reacquire to retry");
      // D-shaped stale finalize: the superseded token matches zero rows and the
      // presented token is never rotated in SET. Surface the reacquire remedy.
      const staleFinalize = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'succeeded', result = '{"ok":true}', updated_by = $1
          where id = $2 and org_id = $3 and status = 'running'
            and lease_token = $4 and lease_expires_at > now()
          returning id`,
        [approver, reqId, orgId, tokenA],
      );
      assert.equal(staleFinalize.rowCount, 0, "stale token finalizes zero rows; reacquire the live claim, then retry");
      // Live finalization is D-shaped: succeeds, clears the lease, seals the row.
      const done_update = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'succeeded', result = '{"months":1}', updated_by = $1
          where id = $2 and org_id = $3 and status = 'running'
            and lease_token = $4 and lease_expires_at > now()
          returning id`,
        [approver, reqId, orgId, tokenB],
      );
      assert.equal(done_update.rowCount, 1, "live token finalizes exactly one row");
      const done = await client.query(
        `select status, lease_token from saas_metrics_normalization_requests where id = $1`, [reqId],
      );
      assert.equal(done.rows[0].status, "succeeded");
      assert.equal(done.rows[0].lease_token, null);
      const terminal = await auditEvents(client, reqId);
      assert.equal(terminal[terminal.length - 1].action, "saas_normalization_succeeded");
      assertActorsPresent(terminal);
      await client.query("savepoint before_terminal_mutation");
      await assert.rejects(
        client.query(`update saas_metrics_normalization_requests set progress = '{}' where id = $1`, [reqId]),
        /terminal state succeeded/,
      );
      await client.query("rollback to savepoint before_terminal_mutation");
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
      await dropScratchOrg(org.orgId);
    }
  },
);

test("cancellation is guarded, actor-bound, and audited once", { skip: !DB }, async () => {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    await ensureMigration(client);
    await client.query("begin");
    await client.query("select set_config('app.bypass_rls', 'on', true)");
    const orgId = await seedOrg(client, "cancel");
    const requester = await seedUser(client, orgId, "requester");
    const reqId = randomUUID();
    await client.query(
      `insert into saas_metrics_normalization_requests
         (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
       values ($1, $2, '2026-09-01', 'normalize September SaaS revenue', $3, $4, '${DIGEST_E}')`,
      [reqId, orgId, requester, randomUUID()],
    );
    await client.query("savepoint before_actorless_cancel");
    await assert.rejects(
      client.query(`update saas_metrics_normalization_requests set status = 'cancelled' where id = $1`, [reqId]),
      /acting user/,
    );
    await client.query("rollback to savepoint before_actorless_cancel");
    const cancelled = await client.query(
      `update saas_metrics_normalization_requests set status = 'cancelled', updated_by = $1
        where id = $2 and org_id = $3 and status = 'pending'
        returning id`,
      [requester, reqId, orgId],
    );
    assert.equal(cancelled.rowCount, 1, "pending cancel affects exactly one row");
    const events = await auditEvents(client, reqId);
    assert.deepEqual(events.map((e) => e.action), ["saas_normalization_requested", "saas_normalization_cancelled"]);
    assertActorsPresent(events);
    await client.query("savepoint before_second_cancel");
    await assert.rejects(
      client.query(
        `update saas_metrics_normalization_requests set progress = '{"x":1}', updated_by = $1 where id = $2`,
        [requester, reqId],
      ),
      /terminal state cancelled/,
    );
    await client.query("rollback to savepoint before_second_cancel");
    // Failed cancel binds the approver, not the requester.
    const approver = await seedUser(client, orgId, "approver");
    const failedId = randomUUID();
    const failedToken = randomUUID();
    await client.query(
      `insert into saas_metrics_normalization_requests
         (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
       values ($1, $2, '2026-10-01', 'normalize October SaaS revenue', $3, $4, '${DIGEST_F}')`,
      [failedId, orgId, requester, randomUUID()],
    );
    await client.query(
      `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
      [approver, failedId],
    );
    await client.query(
      `update saas_metrics_normalization_requests
          set status = 'running', lease_token = $1,
              lease_expires_at = now() + interval '1 hour', attempt_count = 1, updated_by = $2
        where id = $3`,
      [failedToken, approver, failedId],
    );
    await client.query(
      `update saas_metrics_normalization_requests
          set status = 'failed', failure = 'rate missing', remedy = 'record the observation, then retry', updated_by = $1
        where id = $2`,
      [approver, failedId],
    );
    await client.query("savepoint before_requester_failed_cancel");
    await assert.rejects(
      client.query(
        `update saas_metrics_normalization_requests set status = 'cancelled', updated_by = $1 where id = $2`,
        [requester, failedId],
      ),
      /approver as the acting user/,
    );
    await client.query("rollback to savepoint before_requester_failed_cancel");
    const failedCancelled = await client.query(
      `update saas_metrics_normalization_requests set status = 'cancelled', failure = null, remedy = null, updated_by = $1
        where id = $2 and org_id = $3 and status = 'failed'
        returning id`,
      [approver, failedId, orgId],
    );
    assert.equal(failedCancelled.rowCount, 1, "failed cancel affects exactly one row");
    const failedEvents = await auditEvents(client, failedId);
    assert.deepEqual(failedEvents.map((e) => e.action), [
      "saas_normalization_requested",
      "saas_normalization_approved",
      "saas_normalization_claimed",
      "saas_normalization_failed",
      "saas_normalization_cancelled",
    ]);
    assertActorsPresent(failedEvents);
    await client.query("rollback");
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
});

test("failure names failure and remedy; retry and live-month fencing compose",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await ensureMigration(client);
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "retry");
      const month = "2026-11-01";
      const reqId = randomUUID();
      const idemKey = randomUUID();
      const requester = await seedUser(client, orgId, "requester");
      const approver = await seedUser(client, orgId, "approver");
      await client.query(
        `insert into saas_metrics_normalization_requests
           (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
         values ($1, $2, $3, 'normalize November SaaS revenue', $4, $5, '${DIGEST_D}')`,
        [reqId, orgId, month, requester, idemKey],
      );
      await client.query(
        `update saas_metrics_normalization_requests set approved_by = $1, approved_at = now() where id = $2`,
        [approver, reqId],
      );
      // A malformed request hash is refused by format, not stored.
      await client.query("savepoint before_bad_hash");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, requested_by, idempotency_key, request_hash)
           values ($1, '2026-12-01', 'normalize December SaaS revenue', $2, $3, 'not-a-digest')`,
          [orgId, requester, randomUUID()],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23514");
          return true;
        },
      );
      await client.query("rollback to savepoint before_bad_hash");
      // One live request per org and month.
      await client.query("savepoint before_second_live");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, requested_by, idempotency_key, request_hash)
           values ($1, $2, 'normalize November SaaS revenue again', $3, $4, '${DIGEST_E}')`,
          [orgId, month, requester, randomUUID()],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23505");
          return true;
        },
      );
      await client.query("rollback to savepoint before_second_live");
      // Idempotency keys stay unique per org: same key and same body replays
      // into the same refusal, and same key with a different body is refused.
      await client.query("savepoint before_dup_key");
      await assert.rejects(
        client.query(
          `insert into saas_metrics_normalization_requests
             (org_id, month, reason, requested_by, idempotency_key, request_hash)
           values ($1, '2026-12-01', 'normalize December SaaS revenue', $2, $3, '${DIGEST_F}')`,
          [orgId, requester, idemKey],
        ),
        (error) => {
          assert.equal(postgresCode(error), "23505");
          return true;
        },
      );
      await client.query("rollback to savepoint before_dup_key");
      // A new key carrying the same body hash is not blocked: uniqueness is
      // org plus idempotency key, never the content hash.
      const sameBodyId = randomUUID();
      await client.query(
        `insert into saas_metrics_normalization_requests
           (id, org_id, month, reason, requested_by, idempotency_key, request_hash)
         values ($1, $2, '2026-12-01', 'normalize December SaaS revenue', $3, $4, '${DIGEST_D}')`,
        [sameBodyId, orgId, requester, randomUUID()],
      );
      const token = randomUUID();
      const claim = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'running', lease_token = $1,
                lease_expires_at = now() + interval '1 hour', attempt_count = 1, updated_by = $2
          where id = $3 and org_id = $4 and status = 'pending'
            and approved_by is not null and approved_at is not null
          returning id`,
        [token, approver, reqId, orgId],
      );
      assert.equal(claim.rowCount, 1, "approved pending claim affects exactly one row");
      // Finalize without remedy refuses and names the remedy field.
      await client.query("savepoint before_remedyless");
      await assert.rejects(
        client.query(
          `update saas_metrics_normalization_requests
              set status = 'failed', failure = 'rate missing', updated_by = $1
            where id = $2`,
          [approver, reqId],
        ),
        /remedy/,
      );
      await client.query("rollback to savepoint before_remedyless");
      const failed = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'failed', failure = 'rate missing', remedy = 'record the November FX observation, then retry the request',
                updated_by = $1
          where id = $2 and org_id = $3 and status = 'running'
            and lease_token = $4 and lease_expires_at > now()
          returning id`,
        [approver, reqId, orgId, token],
      );
      assert.equal(failed.rowCount, 1, "live token fails exactly one row");
      // Crash/retry: failed retries with a fresh lease and succeeds.
      const token2 = randomUUID();
      const retried = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'running', lease_token = $1,
                lease_expires_at = now() + interval '1 hour', attempt_count = 2,
                failure = null, remedy = null, updated_by = $2
          where id = $3 and org_id = $4 and status = 'failed'
          returning id`,
        [token2, approver, reqId, orgId],
      );
      assert.equal(retried.rowCount, 1, "failed retry reopens exactly one row");
      const done = await client.query(
        `update saas_metrics_normalization_requests
            set status = 'succeeded', result = '{"months":1}', updated_by = $1
          where id = $2 and org_id = $3 and status = 'running'
            and lease_token = $4 and lease_expires_at > now()
          returning id`,
        [approver, reqId, orgId, token2],
      );
      assert.equal(done.rowCount, 1, "live token finalizes exactly one row");
      const events = await auditEvents(client, reqId);
      const actions = events.map((e) => e.action);
      assert.deepEqual(actions, [
        "saas_normalization_requested",
        "saas_normalization_approved",
        "saas_normalization_claimed",
        "saas_normalization_failed",
        "saas_normalization_retried",
        "saas_normalization_succeeded",
      ]);
      assertActorsPresent(events);
      assert.equal(events[4].changes.actor, approver, "retry event actor is the approver");
      await client.query("rollback");
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      await client.end();
    }
  },
);
