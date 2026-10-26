/** Storage conformance for nullable reporting triples, immutable FX evidence,
 * tenant isolation and native Flow decision authority. */
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import test from "node:test";
import pg from "pg";

/** Deterministic distinct 64-hex digests for fixtures. */
const DIGEST_A = "a".repeat(64);
/** Pinned SHA-256 over the exact canonical v1 selection payload bytes. */
const SELECTION_DIGEST = "e8c1ae000043448f172f98499341827135cd170081182f2d76558e01d839b8da";

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

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

test(
  "metric reporting columns are nullable and both evidence tables force row-level security",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      for (const table of [
        "saas_metrics_monthly",
        "saas_metrics_facts_monthly",
        "saas_metrics_cohort_monthly",
      ]) {
        const cols = await client.query(
          `select column_name, is_nullable from information_schema.columns
            where table_schema = 'public' and table_name = $1
              and column_name in ('reporting_currency', 'denomination_version', 'normalization_evidence')`,
          [table],
        );
        assert.equal(cols.rows.length, 3, `${table} carries the reporting triple`);
        for (const row of cols.rows)
          assert.equal(row.is_nullable, "YES", `${table}.${row.column_name} stays nullable`);
      }
      for (const table of ["saas_metrics_fx_evidence", "saas_metrics_normalization_requests"]) {
        const rel = await client.query(`select to_regclass($1) as rel`, [`public.${table}`]);
        assert.ok(rel.rows[0].rel !== null, `${table} exists`);
        const rls = await client.query(
          `select relrowsecurity, relforcerowsecurity from pg_class where oid = $1::regclass`,
          [`public.${table}`],
        );
        assert.deepEqual(
          [rls.rows[0].relrowsecurity, rls.rows[0].relforcerowsecurity],
          [true, true],
        );
      }
    } finally {
      await client.end();
    }
  },
);

test("tenant isolation holds on both evidence tables", { skip: !DB }, async () => {
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
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
    const hidden = await client.query(`select id from saas_metrics_fx_evidence where org_id = $1`, [
      orgA,
    ]);
    assert.equal(hidden.rows.length, 0, "org B cannot read org A FX evidence");
    const hiddenReq = await client.query(
      `select id from saas_metrics_normalization_requests where id = $1`,
      [reqA],
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

test(
  "metric reporting triple is all-null-or-complete with a usable shape refusal",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "triple");
      const subId = await seedSubsidiary(client, orgId);
      const base = {
        id: randomUUID(),
        org_id: orgId,
        subsidiary_id: subId,
        month: "2026-09-01",
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
        `select reporting_currency from saas_metrics_facts_monthly where id = $1`,
        [base.id],
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
      await assert.rejects(client.query(statement), (error) => {
        assert.match(String(error), /instead/);
        return true;
      });
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
        assert.ok(
          ["23514", "22P02"].includes(postgresCode(error)),
          `refused contradiction, got ${postgresCode(error)}`,
        );
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

test(
  "FX evidence preserves full observation provenance byte-equivalent",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "provenance");
      // Two direct September observations whose derived rates 0.73 and 0.71
      // average to exactly the declared envelope rate. Observation ids are
      // pinned UUIDs so the canonical digest below is reproducible byte-for-byte.
      const obsFirst = "00000000-0000-4000-8000-000000000001";
      const obsMid = "00000000-0000-4000-8000-000000000002";
      const observations = [
        {
          id: obsFirst,
          asOf: "2026-09-01",
          source: "bank_of_canada",
          storedRate: "0.7300000000",
          updatedAt: "2026-09-01T00:00:00.000000Z",
          direction: "direct",
          derivedRate: "0.7300000000",
        },
        {
          id: obsMid,
          asOf: "2026-09-15",
          source: "bank_of_canada",
          storedRate: "0.7100000000",
          updatedAt: "2026-09-15T00:00:00.000000Z",
          direction: "direct",
          derivedRate: "0.7100000000",
        },
      ];
      // Canonical digest payload key order: v, kind, from, to, scope,
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
      const computedDigest = createHash("sha256")
        .update(JSON.stringify(digestPayload), "utf8")
        .digest("hex");
      assert.equal(
        computedDigest,
        SELECTION_DIGEST,
        "canonical digest pins the exact v1 payload bytes",
      );
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
      assert.deepEqual(
        stored.rows[0].evidence,
        provenance,
        "full provenance round-trips without loss",
      );
      assert.deepEqual(
        stored.rows[0].evidence.selection,
        selection,
        "selection round-trips byte-equivalent",
      );
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
  },
);

test(
  "normalization storage requires native Flow authority for every approver identity",
  { skip: !DB },
  async () => {
    const client = new pg.Client({ connectionString: connectionString() });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("select set_config('app.bypass_rls', 'on', true)");
      const orgId = await seedOrg(client, "native-authority");
      const request = await pendingRequest(client, orgId, "2026-09-01");
      const other = await seedUser(client, orgId, "reviewer");
      const audit = async () =>
        (
          await client.query(
            `select action,actor_id,changes from audit_log
      where table_name='saas_metrics_normalization_requests' and row_id=$1 order by id`,
            [request.id],
          )
        ).rows;
      const beforeAudit = await audit();
      assert.deepEqual(
        beforeAudit.map((row) => row.action),
        ["saas_normalization_requested"],
      );
      for (const actor of [request.requester, other]) {
        await client.query("savepoint before_unrouted_decision");
        await assert.rejects(
          client.query(
            `update saas_metrics_normalization_requests
        set status='approved',approved_by=$1,approved_at=now() where org_id=$2 and id=$3`,
            [actor, orgId, request.id],
          ),
          /Complete native tenant Flow routing/,
        );
        await client.query("rollback to savepoint before_unrouted_decision");
      }
      assert.deepEqual(
        (
          await client.query(
            `select status,approved_by,approved_at
      from saas_metrics_normalization_requests where org_id=$1 and id=$2`,
            [orgId, request.id],
          )
        ).rows,
        [{ status: "pending", approved_by: null, approved_at: null }],
      );
      assert.deepEqual(
        await audit(),
        beforeAudit,
        "refused direct decisions append no approval evidence",
      );
    } finally {
      await client.query("rollback");
      await client.end();
    }
  },
);
