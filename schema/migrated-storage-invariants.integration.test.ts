/// <reference types="node" />

/**
 * Live storage-invariant cover for the behaviours formerly pinned as
 * migration-text assertions in schema/canonical-baseline.test.ts.
 *
 * Each test below drives the real interface — inserting a violating row (or
 * replaying a published data migration) against the migrated database — with
 * an independently derived expectation. Migration-internal mechanics (repair
 * ordering, preflight spellings, backfill semantics, mirror parity) are not
 * re-asserted here: the published bytes are protected by the bootstrap
 * digest check, and whole-corpus properties by the migration-headers gate
 * and the sanitizer tests. Where an engine or integration suite already
 * proves a behaviour, no test is added here at all (see the canonical
 * commit body for the per-pin cover map).
 *
 * Runs without a self-skip: the integration partition always provides a
 * database, so a missing one must fail loudly, never pass silently.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  executeMigrationBody,
  migrationRunsWithoutTransaction,
  sanitizeMigrationContent,
} from "../scripts/bootstrap-migration-client.ts";
import { pool } from "../engine/src/platform/db.ts";
import {
  createScratchOrg,
  createScratchUser,
  dropScratchOrg,
} from "../engine/src/testing/fixtures.ts";

function isConstraintViolation(error: unknown, pattern: RegExp): boolean {
  if (!(error instanceof Error)) return false;
  return pattern.test(error.message);
}

async function insertPayComponent(orgId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into pay_components (id, org_id, code, name, kind)
     values ($1, $2, 'T8BASE', 'T8 base component', 'earning')`,
    [id, orgId],
  );
  return id;
}

async function insertPaySchedule(orgId: string): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `insert into pay_schedules (id, org_id, name, frequency, periods_per_year, anchor_period_end)
     values ($1, $2, 'T8 schedule', 'biweekly', 26, '2026-01-02')`,
    [id, orgId],
  );
  return id;
}

test("overlapping active pay-derived windows for one rule identity are refused", async () => {
  // 0083: concurrent effective windows for the same (org, code) must not
  // both be active — payroll would price the same earnings twice.
  const org = await createScratchOrg();
  try {
    const componentId = await insertPayComponent(org.orgId);
    const first = randomUUID();
    await pool.query(
      `insert into pay_derived_rules
         (id, org_id, code, name, component_id, trigger, rate_value, effective_from, effective_to, is_active)
       values ($1, $2, 'T8RULE', 'T8 rule', $3, 'time_entry', 10, '2026-01-01', '2026-12-31', true)`,
      [first, org.orgId, componentId],
    );
    const overlapping = randomUUID();
    const refused = await pool
      .query(
        `insert into pay_derived_rules
           (id, org_id, code, name, component_id, trigger, rate_value, effective_from, effective_to, is_active)
         values ($1, $2, 'T8RULE', 'T8 rule', $3, 'time_entry', 10, '2026-06-01', null, true)`,
        [overlapping, org.orgId, componentId],
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(refused, /pay_derived_rules_no_active_overlap|exclusion/i),
      `expected the overlap exclusion to refuse, got: ${String(refused)}`,
    );
    // An inactive twin is not a second live rule and must commit.
    const inactive = randomUUID();
    await pool.query(
      `insert into pay_derived_rules
         (id, org_id, code, name, component_id, trigger, rate_value, effective_from, effective_to, is_active)
       values ($1, $2, 'T8RULE', 'T8 rule', $3, 'time_entry', 10, '2026-06-01', null, false)`,
      [inactive, org.orgId, componentId],
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("tax rates refuse negative percentages and setup codes refuse duplicates", async () => {
  // 0042: a negative rate would post inverted tax; a duplicate setup code
  // would make pack resolution ambiguous.
  const org = await createScratchOrg();
  try {
    const codeId = randomUUID();
    await pool.query(
      `insert into tax_codes (id, org_id, code, name) values ($1, $2, 'T8GST', 'T8 tax')`,
      [codeId, org.orgId],
    );
    const negative = await pool
      .query(
        `insert into tax_rates (id, org_id, tax_code_id, rate_percent, effective_from)
         values ($1, $2, $3, -5, '2026-01-01')`,
        [randomUUID(), org.orgId, codeId],
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(negative, /tax_rates_rate_percent_domain|check/i),
      `expected the rate domain check to refuse, got: ${String(negative)}`,
    );
    const duplicate = await pool
      .query(`insert into tax_codes (id, org_id, code, name) values ($1, $2, 'T8GST', 'T8 copy')`, [
        randomUUID(),
        org.orgId,
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(duplicate, /tax_codes_org_code_unique|unique/i),
      `expected the setup-code unique to refuse, got: ${String(duplicate)}`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("subscription plans refuse negative amounts", async () => {
  // 0041: a negative plan amount would bill customers to receive money.
  const org = await createScratchOrg();
  try {
    const refused = await pool
      .query(`insert into subscription_plans (id, org_id, name, amount) values ($1, $2, 'T8 plan', -10)`, [
        randomUUID(),
        org.orgId,
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(refused, /subscription_plans_amount_nonnegative|check/i),
      `expected the amount check to refuse, got: ${String(refused)}`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("forecast snapshots take at most one target and commit org-wide", async () => {
  // 0170: a snapshot forecasting for both an owner and a team double-counts
  // the pipeline; an org-wide snapshot is the honest default.
  const org = await createScratchOrg();
  const userId = randomUUID();
  const teamId = randomUUID();
  try {
    // An active user must carry a role assignment (0096); createScratchUser
    // inserts user and assignment atomically.
    await createScratchUser(org.orgId, "T8 owner", "t8_owner", userId);
    await pool.query(`insert into crm_sales_teams (id, org_id, key, name) values ($1, $2, 'T8', 'T8 team')`, [
      teamId,
      org.orgId,
    ]);
    const snapshot = (id: string, owner: string | null, team: string | null) =>
      pool.query(
        `insert into crm_forecast_snapshots
           (id, org_id, owner_user_id, sales_team_id, period_start, period_end,
            snapshot_kind, currency, pipeline_amount, weighted_amount, worst_case_amount,
            most_likely_amount, upside_amount, closed_amount)
         values ($1, $2, $3, $4, '2026-01-01', '2026-03-31', 'commit', 'CAD', 0, 0, 0, 0, 0, 0)`,
        [id, org.orgId, owner, team],
      );
    const both = await snapshot(randomUUID(), userId, teamId).then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(
      isConstraintViolation(both, /crm_forecast_snapshot_target|check/i),
      `expected the single-target check to refuse, got: ${String(both)}`,
    );
    await snapshot(randomUUID(), null, null);
    await snapshot(randomUUID(), userId, null);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("payroll profiles refuse an omitted country instead of defaulting one", async () => {
  // 0190: no country built-in exists, so an unset country must fail NOT NULL
  // rather than silently becoming Canada.
  const org = await createScratchOrg();
  try {
    const scheduleId = await insertPaySchedule(org.orgId);
    const refused = await pool
      .query(
        `insert into employee_payroll_profiles (id, org_id, employee_party_id, pay_schedule_id, province)
         values ($1, $2, $3, $4, 'Ontario')`,
        [randomUUID(), org.orgId, org.customerId, scheduleId],
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(refused, /null value in column "country"|not-null/i),
      `expected NOT NULL on country to refuse, got: ${String(refused)}`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("payroll pack facts refuse out-of-range values and accept unknown", async () => {
  // 0191: pack-declared facts are nullable (null = unknown, never guessed)
  // but a present value outside the pack's bounds is refused.
  const org = await createScratchOrg();
  try {
    const scheduleId = await insertPaySchedule(org.orgId);
    const base = (id: string, country: string) =>
      pool.query(
        `insert into employee_payroll_profiles
           (id, org_id, employee_party_id, pay_schedule_id, province, country)
         values ($1, $2, $3, $4, 'Ontario', $5)`,
        [id, org.orgId, org.customerId, scheduleId, country],
      );
    const profileId = randomUUID();
    await base(profileId, "ES");
    const outOfRange = await pool
      .query(`update employee_payroll_profiles set es_ano_nacimiento = 1800 where id = $1`, [profileId])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(outOfRange, /employee_payroll_profiles_es_ano|check/i),
      `expected the birth-year check to refuse, got: ${String(outOfRange)}`,
    );
    await pool.query(`update employee_payroll_profiles set es_ano_nacimiento = null where id = $1`, [
      profileId,
    ]);
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("sync runs detach from a deleted connection instead of vanishing", async () => {
  // 0085: run history is evidence; deleting a connection must null the link
  // (ON DELETE SET NULL over a nullable column), not cascade the runs.
  const org = await createScratchOrg();
  try {
    const connectionId = randomUUID();
    await pool.query(
      `insert into connections (id, org_id, source, display_name) values ($1, $2, 't8', 'T8 connection')`,
      [connectionId, org.orgId],
    );
    const runId = randomUUID();
    await pool.query(`insert into sync_runs (id, org_id, source, connection_id) values ($1, $2, 't8', $3)`, [
      runId,
      org.orgId,
      connectionId,
    ]);
    await pool.query(`delete from connections where id = $1`, [connectionId]);
    const stored = await pool.query(`select connection_id, status from sync_runs where id = $1`, [runId]);
    assert.equal(stored.rows[0]?.connection_id, null);
    assert.equal(stored.rows[0]?.status, "running");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("sftp prefixes refuse escape shapes and accept tenant folders", async () => {
  // 0030: a tenant names folders, never physical locations — dot segments,
  // absolute paths, and backslashes must not reach storage.
  const org = await createScratchOrg();
  try {
    // Usernames are globally unique: scope the probe name to this run.
    const username = `t8user-${randomUUID().slice(0, 8)}`;
    const attempt = (prefix: string) =>
      pool.query(
        `insert into sftp_servers (id, org_id, name, username, root_prefix)
         values ($1, $2, 'T8 sftp', $4, $3)`,
        [randomUUID(), org.orgId, prefix, username],
      );
    const escape = await attempt("../escape").then(
      () => null,
      (error: unknown) => error,
    );
    assert.ok(
      isConstraintViolation(escape, /sftp_servers_root_prefix_safe|check/i),
      `expected the prefix guard to refuse, got: ${String(escape)}`,
    );
    await attempt("t8-ok/sub");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the 0033 framework repair maps legacy values through the real migration", async () => {
  // 0033 preserves each org's effective pre-migration rule once, in the
  // settings document: ias12 meant IFRS, anything else meant US GAAP.
  // Replayed through the real attempt path (sanitize, then the published
  // body), not asserted from its text.
  const org = await createScratchOrg();
  try {
    // One org driven through each legacy shape in turn: provisioning seeds
    // builtin rows no raw org delete may remove, so no extra orgs are made.
    // Merge, never clobber: the scratch row carries fixture keys the
    // sandbox-wipe teardown path relies on.
    const body = sanitizeMigrationContent(
      readFileSync("schema/migrations/generated/0033_reporting_framework_policy.sql", "utf8"),
    );
    const replay = async (): Promise<void> => {
      const client = await pool.connect();
      try {
        await executeMigrationBody(client, body, {
          transactional: !migrationRunsWithoutTransaction(body),
        });
      } finally {
        client.release();
      }
    };
    const frameworkOf = async (): Promise<string | null> =>
      (
        (await pool.query(`select settings->>'reportingFramework' as framework from orgs where id = $1`, [
          org.orgId,
        ])).rows[0] as { framework: string | null }
      ).framework;
    const setTaxFramework = async (settings: string): Promise<void> => {
      await pool.query(`update orgs set settings = settings || $2::jsonb where id = $1`, [org.orgId, settings]);
    };
    await setTaxFramework('{"taxFramework": "ias12"}');
    await replay();
    assert.equal(await frameworkOf(), "ifrs");
    // Rerunnable: a second pass must change nothing.
    await replay();
    assert.equal(await frameworkOf(), "ifrs");
    await setTaxFramework('{"taxFramework": "other", "reportingFramework": null}');
    await replay();
    assert.equal(await frameworkOf(), "us_gaap");
    await setTaxFramework('{"taxFramework": "ias12", "reportingFramework": "ifrs"}');
    await replay();
    assert.equal(await frameworkOf(), "ifrs");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("recognition rules refuse a second live version of one code", async () => {
  // 0297: editing a rule in use must create a successor, never mutate the
  // version obligations already pinned — so only one live row per code.
  const org = await createScratchOrg();
  try {
    await pool.query(
      `insert into recognition_rules (id, org_id, code, name, method)
       values ($1, $2, 'T8RULE', 'T8 rule', 'straight_line_even')`,
      [randomUUID(), org.orgId],
    );
    const duplicate = await pool
      .query(
        `insert into recognition_rules (id, org_id, code, name, method)
         values ($1, $2, 'T8RULE', 'T8 twin', 'straight_line_even')`,
        [randomUUID(), org.orgId],
      )
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(duplicate, /recognition_rules_org_code|unique/i),
      `expected the live-version unique to refuse, got: ${String(duplicate)}`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("delivery keys refuse malformed values and double-claimed identities", async () => {
  // 0063/0059: the key is a fixed engine-minted shape, and one logical
  // delivery owns exactly one canonical row.
  const org = await createScratchOrg();
  try {
    const malformed = await pool
      .query(`insert into email_log (id, org_id, subject, delivery_key) values ($1, $2, 'T8', 'not-a-key')`, [
        randomUUID(),
        org.orgId,
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(malformed, /email_log_delivery_key_format|check/i),
      `expected the key format check to refuse, got: ${String(malformed)}`,
    );
    const key = `obem_${"a".repeat(40)}`;
    await pool.query(`insert into email_log (id, org_id, subject, delivery_key) values ($1, $2, 'T8', $3)`, [
      randomUUID(),
      org.orgId,
      key,
    ]);
    const twin = await pool
      .query(`insert into email_log (id, org_id, subject, delivery_key) values ($1, $2, 'T8 twin', $3)`, [
        randomUUID(),
        org.orgId,
        key,
      ])
      .then(
        () => null,
        (error: unknown) => error,
      );
    assert.ok(
      isConstraintViolation(twin, /email_log_delivery_key|unique/i),
      `expected the delivery identity unique to refuse, got: ${String(twin)}`,
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("document revisions advance on every committed update", async () => {
  // 0013/0167: two committed revisions must never share a token. The
  // collapse shape — an update storing updated_at byte-identical to the
  // row — is rewritten strictly forward by documents_revision_monotonic,
  // and openbooks_bump_revision_seq counts every UPDATE independently of
  // the editable display timestamp. (The web optimistic-concurrency test
  // proving the same lives in a skip-guarded plain .test.ts, so it never
  // runs; this is the live cover.)
  const org = await createScratchOrg();
  try {
    const id = randomUUID();
    // Microsecond-exact display timestamps: node-pg truncates to
    // milliseconds, which would never reproduce the collapse shape.
    const stamp = "2026-08-24T12:00:00.400001Z";
    await pool.query(
      `insert into documents (id, org_id, kind, document_number, subsidiary_id, document_date, currency, status,
         created_at, updated_at)
       values ($1, $2, 'transfer', $3, $4, '2026-01-02', 'CAD', 'draft', $5::timestamptz, $5::timestamptz)`,
      [id, org.orgId, `T8REV-${id.slice(0, 8)}`, org.subsidiaryId, stamp],
    );
    const read = async (): Promise<{ updated_at: Date; revision_seq: string }> =>
      (await pool.query(`select updated_at, revision_seq from documents where id = $1`, [id])).rows[0] as {
        updated_at: Date;
        revision_seq: string;
      };
    const first = await read();
    // Collapse-shaped write: store updated_at byte-identical to the row.
    await pool.query(`update documents set memo = 'T8 collapse', updated_at = $2::timestamptz where id = $1`, [
      id,
      stamp,
    ]);
    const second = await read();
    assert.ok(
      second.updated_at > first.updated_at,
      `a collapse write must move updated_at strictly forward, got ${String(second.updated_at)}`,
    );
    assert.equal(
      BigInt(second.revision_seq),
      BigInt(first.revision_seq) + 1n,
      "every committed UPDATE must bump the revision counter exactly once",
    );
    await pool.query(`update documents set memo = 'T8 second' where id = $1`, [id]);
    const third = await read();
    assert.ok(
      third.updated_at > second.updated_at,
      `a second update must advance updated_at again, got ${String(third.updated_at)}`,
    );
    assert.equal(
      BigInt(third.revision_seq),
      BigInt(second.revision_seq) + 1n,
      "the revision counter must keep counting past the first bump",
    );
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("bank-feed bookkeeping separates the attempt cursor from the success cursor", async () => {
  // 0054: last_attempt_at records every finished attempt; last_sync_at is
  // the success-only pull cursor the runner reads. The two must move
  // independently — recording an attempt (even a failed one) must not
  // advance the success cursor. (Runner-side attempt/success sequencing
  // lives in engine banking tests; this is the storage half the old pin
  // asserted as migration text.)
  const org = await createScratchOrg();
  try {
    const id = randomUUID();
    await pool.query(
      `insert into bank_feed_connections (id, org_id, name, provider, account_id)
       values ($1, $2, 'T8 feed', 'manual', $3)`,
      [id, org.orgId, randomUUID()],
    );
    await pool.query(
      `update bank_feed_connections set last_attempt_at = now(), last_error = 'T8 probe failure', status = 'error'
        where id = $1`,
      [id],
    );
    const attempted = (
      await pool.query(`select last_attempt_at, last_sync_at from bank_feed_connections where id = $1`, [id])
    ).rows[0] as { last_attempt_at: Date | null; last_sync_at: Date | null };
    assert.ok(attempted.last_attempt_at !== null, "a finished attempt must stamp the attempt cursor");
    assert.equal(attempted.last_sync_at, null, "a failed attempt must not move the success cursor");
    await pool.query(
      `update bank_feed_connections set last_attempt_at = now(), last_sync_at = now(), last_error = null,
         status = 'connected' where id = $1`,
      [id],
    );
    const succeeded = (
      await pool.query(`select last_attempt_at, last_sync_at from bank_feed_connections where id = $1`, [id])
    ).rows[0] as { last_attempt_at: Date | null; last_sync_at: Date | null };
    assert.ok(succeeded.last_sync_at !== null, "a success must stamp the success cursor");
    assert.ok(succeeded.last_attempt_at !== null, "a success is also a finished attempt");
  } finally {
    await dropScratchOrg(org.orgId);
  }
});

test("the migrated catalog carries the canonical baseline shape", async () => {
  // Replaces the baseline-text inventory pins (table/function/trigger/index
  // presence, retired-model absence, adjustment RLS wiring, source-identity
  // indexes) with the same facts read from the live catalog — no scratch
  // org needed, nothing written.
  const tables = await pool.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any ($1)`,
    [
      [
        "lease_agreements",
        "lease_agreement_schedule_lines",
        "inventory_writedowns",
        "pay_schedules",
        "pay_components",
        "pay_run_adjustments",
        "employee_payroll_profiles",
        "employee_pay_components",
        "pay_runs",
        "pay_stubs",
        "pay_stub_lines",
        "payroll_opening_balances",
        "union_agreements",
        "union_classifications",
        "union_fringes",
        "auth_sessions",
        "auth_login_events",
        "auth_mfa_factors",
        "auth_oidc_identities",
      ],
    ],
  );
  assert.equal(tables.rows.length, 19, "every canonical table must exist in the migrated catalog");
  const routines = await pool.query(
    `select proname from pg_proc where pronamespace = 'public'::regnamespace and proname = any ($1)`,
    [["posted_document_financial_guard"]],
  );
  assert.equal(routines.rows.length, 1, "the posted-document financial guard must exist");
  const triggers = await pool.query(
    `select tgname from pg_trigger where tgname = any ($1) and not tgisinternal`,
    [["documents_posted_financial_guard"]],
  );
  assert.equal(triggers.rows.length, 1, "the posted-document guard trigger must exist");
  const indexes = await pool.query(
    `select indexname from pg_indexes where schemaname = 'public' and indexname = any ($1)`,
    [["backup_runs_one_inflight_per_org", "parties_org_source_identity", "projects_org_source_identity"]],
  );
  assert.equal(indexes.rows.length, 3, "one-inflight backup, tenant source-identity indexes must exist");
  const retired = await pool.query(
    `select tablename from pg_tables where schemaname = 'public' and tablename = any ($1)`,
    [
      [
        "orphaned_tax_component_evidence",
        "_migration_control_exceptions",
        "_migration_schema_convergence",
        "selection_source",
        "legacy_json_migration",
        "validation_replay",
        "adminapp2",
      ],
    ],
  );
  assert.deepEqual(
    retired.rows.map((row) => row.tablename),
    [],
    "no upgrade-only evidence model may survive in the catalog",
  );
  const policies = await pool.query(
    `select policyname, permissive, roles::text, cmd, qual is not null as scoped, with_check is not null as checked
       from pg_policies where schemaname = 'public' and tablename = 'pay_run_adjustments' and policyname = 'org_isolation'`,
  );
  assert.equal(policies.rows.length, 1, "pay_run_adjustments must carry the org_isolation policy");
  assert.equal(policies.rows[0]?.scoped, true, "org_isolation must filter reads");
  assert.equal(policies.rows[0]?.checked, true, "org_isolation must filter writes");
  const relkind = await pool.query(
    `select relforcerowsecurity, relrowsecurity from pg_class where relname = 'pay_run_adjustments'`,
  );
  assert.equal(relkind.rows[0]?.relrowsecurity, true, "pay_run_adjustments must enforce row security");
  assert.equal(relkind.rows[0]?.relforcerowsecurity, true, "pay_run_adjustments must force row security");
});

test("the payroll opening-balances view exposes the rebuilt statutory columns", async () => {
  // 0141 rebuilds the governed payroll opening-balances view; the statutory
  // columns it adds are the view's interface to payroll reporting.
  const columns = await pool.query(
    `select column_name from information_schema.columns
     where table_schema = 'openbooks_query' and table_name = 'payroll_opening_balances'`,
  );
  const names = new Set(columns.rows.map((row) => row.column_name));
  for (const column of ["cpp2_bonus_ytd", "qc_csb_ytd", "fica_withheld_ytd"]) {
    assert.ok(names.has(column), `the rebuilt view must expose ${column}`);
  }
});
