/// <reference types="node" />

/**
 * Behavioral upgrade-safety coverage for 0010_bank_statement_source_evidence.
 *
 * The sibling unit test pins byte identity and wiring by matching source text;
 * this suite proves what those bytes actually do to a real database. It builds
 * the genuine pre-migration state by replaying every published migration file
 * that precedes the evidence migration (byte-exact, in bootstrap's
 * lexicographic apply order) on a throwaway database, seeding the legacy rows
 * an upgrading installation would hold, and then running the published files
 * themselves:
 *
 *   - the fail-closed verification gate refuses an uncovered legacy row,
 *   - legacy statements receive honest append-only gap attestations (never a
 *     fabricated SHA-256) and raw_file_ref becomes mandatory,
 *   - the later companion idempotency migration composes over the attestations,
 *   - reapplying the evidence migration creates no second attestations (the
 *     property bootstrap's approved `reapply` digest transition relies on),
 *   - the remaining published chain completes over the upgraded data.
 *
 * Like every DB-backed suite it self-skips without OPENBOOKS_DB_URL; when set,
 * the connected role needs CREATEDB because the upgrade under test is a
 * database-level state machine and cannot be simulated inside the shared
 * already-migrated schema.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import pg from "pg";

const root = join(import.meta.dirname, "..", "..");
const generatedDir = join(root, "schema", "migrations", "generated");
const EVIDENCE_FILE = "0010_bank_statement_source_evidence.sql";

const publishedFiles = readdirSync(generatedDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const evidenceIndex = publishedFiles.indexOf(EVIDENCE_FILE);
assert.ok(evidenceIndex > 0, "the evidence migration must exist among the published files");

const PRE_EVIDENCE_FILES = publishedFiles.slice(0, evidenceIndex).map((name) => ({
  name,
  content: readFileSync(join(generatedDir, name), "utf8"),
}));
const evidenceMigration = readFileSync(join(generatedDir, EVIDENCE_FILE), "utf8");
const TAIL_FILES = publishedFiles.slice(evidenceIndex + 1).map((name) => ({
  name,
  content: readFileSync(join(generatedDir, name), "utf8"),
}));

/** The published fail-closed gate, extracted as an exact byte range. */
const VERIFICATION_MARKER = "$bank_statement_source_evidence_verification$";
const verificationBlockStart = evidenceMigration.indexOf(`DO ${VERIFICATION_MARKER}`);
const verificationBlockEnd =
  evidenceMigration.indexOf(`${VERIFICATION_MARKER};`, verificationBlockStart)
  + `${VERIFICATION_MARKER};`.length;
assert.ok(verificationBlockStart >= 0, "verification DO block marker found");
const verificationBlock = evidenceMigration.slice(
  verificationBlockStart,
  verificationBlockEnd,
);

const DB = Boolean(process.env.OPENBOOKS_DB_URL);

function postgresFailure(error: unknown): { code?: string; message?: string } | null {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth++) {
    const candidate = current as { code?: string; message?: string; cause?: unknown };
    if (candidate.code) return candidate;
    current = candidate.cause;
  }
  return null;
}

interface LegacyFixture {
  control: pg.Client;
  client: pg.Client;
  databaseName: string;
  orgId: string;
  accountId: string;
  /** Statements stored without any source reference by the pre-0010 release. */
  legacyStatementIds: string[];
  /** A statement whose exact source bytes WERE retained before the upgrade. */
  retainedStatementId: string;
  retainedPointer: string;
  retainedSha256: string;
}

let scratchPromise: Promise<LegacyFixture> | undefined;

function scratch(): Promise<LegacyFixture> {
  return (scratchPromise ??= buildScratch());
}

async function buildScratch(): Promise<LegacyFixture> {
  const baseUrl = new URL(process.env.OPENBOOKS_DB_URL!.trim());
  const databaseName = `openbooks_evidence_upgrade_${randomBytes(4).toString("hex")}`;

  // CREATE DATABASE cannot run inside a transaction; the control client talks
  // to the maintenance database purely to create and later remove the sandbox.
  const controlUrl = new URL(baseUrl.href);
  controlUrl.pathname = "/postgres";
  const control = new pg.Client({ connectionString: controlUrl.href });
  await control.connect();
  await control.query(`create database "${databaseName}"`);

  const sandboxUrl = new URL(baseUrl.href);
  sandboxUrl.pathname = `/${databaseName}`;
  const client = new pg.Client({ connectionString: sandboxUrl.href });
  await client.connect();
  // The suite is a trusted maintenance context (like bootstrap's migrate unit):
  // policies key off this GUC directly, so tenant RLS cannot hide fixture rows
  // regardless of whether the connecting role is a superuser.
  await client.query("select set_config('app.bypass_rls', 'on', false)");
  // Bootstrap establishes openbooks_read BEFORE migrations because the
  // baseline's governed-query catalog grants reference the role.
  await client.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
      create role openbooks_read nologin;
    end if;
  end $$;`);

  for (const { name, content } of PRE_EVIDENCE_FILES) {
    try {
      await client.query(content);
    } catch (error) {
      throw new Error(`pre-evidence migration ${name} failed: ${(error as Error).message}`);
    }
  }

  // The legacy spine: one organization, one bank account, two statements the
  // old release stored with raw_file_ref null, plus one statement whose exact
  // source bytes were retained (pointer + audit row, as the old writer left it).
  const orgId = randomUUID();
  const accountId = randomUUID();
  const legacyStatementIds = [randomUUID(), randomUUID()];
  const retainedStatementId = randomUUID();
  const retainedEvidenceId = randomUUID();
  const retainedSha256 = randomBytes(32).toString("hex");
  const retainedPointer = `audit-log:${retainedEvidenceId}#sha256=${retainedSha256}`;

  await client.query(
    `insert into public.currencies (code, name, minor_units)
     values ('CAD', 'Canadian Dollar', 2)
     on conflict (code) do nothing`,
  );
  await client.query(
    `insert into public.orgs (id, name, base_currency, country, settings, env_kind)
     values ($1, $2, 'CAD', 'CA', '{}'::jsonb, 'production')`,
    [orgId, `Scratch ${orgId.slice(0, 8)}`],
  );
  await client.query(
    `insert into public.accounts (id, org_id, number, name, type)
     values ($1, $2, '1000', 'Cash', 'asset_bank')`,
    [accountId, orgId],
  );
  await client.query(
    `insert into public.bank_statements
       (id, org_id, account_id, source, statement_date, opening_balance, closing_balance)
     values ($3, $1, $2, 'csv', '2026-06-30', '100.0000', '150.0000'),
            ($4, $1, $2, 'csv', '2026-07-31', '150.0000', '220.0000')`,
    [orgId, accountId, legacyStatementIds[0], legacyStatementIds[1]],
  );
  await client.query(
    `insert into public.audit_log (id, org_id, table_name, row_id, action, changes, request_id)
     values ($1, $2, 'bank_statements', $3, 'insert',
             jsonb_build_object('operation', 'bank_statement_import'), 'fixture:retained-source')`,
    [retainedEvidenceId, orgId, retainedStatementId],
  );
  await client.query(
    `insert into public.bank_statements
       (id, org_id, account_id, source, statement_date, raw_file_ref)
     values ($1, $2, $3, 'ofx', '2026-07-15', $4)`,
    [retainedStatementId, orgId, accountId, retainedPointer],
  );

  return {
    control,
    client,
    databaseName,
    orgId,
    accountId,
    legacyStatementIds,
    retainedStatementId,
    retainedPointer,
    retainedSha256,
  };
}

test.after(async () => {
  if (!scratchPromise) return;
  const fixture = await scratchPromise;
  await fixture.client.end().catch(() => {});
  await fixture.control
    .query(`drop database if exists "${fixture.databaseName}" with (force)`)
    .catch((error: unknown) => {
      throw new Error(`failed to drop scratch database ${fixture.databaseName}: ${(error as Error).message}`);
    });
  await fixture.control.end();
});

test("legacy upgrades attest the gap honestly and make source evidence mandatory", { skip: !DB, timeout: 300_000 }, async () => {
  const fixture = await scratch();

  // Fail closed first: on the exact uncovered pre-state, the published
  // verification block must refuse to proceed — which is what stands between a
  // partial backfill and the NOT NULL ALTER that follows it in the same file.
  await assert.rejects(
    fixture.client.query(verificationBlock),
    (error: unknown) => {
      const failure = postgresFailure(error);
      assert.equal(failure?.code, "23502");
      assert.match(failure?.message ?? "", /still has no evidence reference/);
      return true;
    },
  );

  await fixture.client.query(evidenceMigration);

  const statements = await fixture.client.query<{
    id: string;
    raw_file_ref: string | null;
  }>(
    `select id, raw_file_ref from public.bank_statements
      where org_id = $1 order by id`,
    [fixture.orgId],
  );
  const byId = new Map(statements.rows.map((row) => [row.id, row.raw_file_ref]));
  assert.equal(statements.rows.length, fixture.legacyStatementIds.length + 1);

  const pointerPattern = /^audit-log:([0-9a-f-]{36})#evidence=legacy-source-unavailable$/;
  const evidenceIds: string[] = [];
  for (const legacyId of fixture.legacyStatementIds) {
    const pointer = byId.get(legacyId)!;
    const match = pointerPattern.exec(pointer ?? "");
    assert.ok(match, `legacy statement ${legacyId} carries a legacy-gap pointer`);
    assert.doesNotMatch(pointer!, /#sha256=/);
    evidenceIds.push(match![1]!);
  }
  // A previously retained source survives the upgrade byte-for-byte.
  assert.equal(byId.get(fixture.retainedStatementId), fixture.retainedPointer);

  const attestations = await fixture.client.query<{
    id: string;
    row_id: string;
    action: string;
    actor_id: string | null;
    request_id: string | null;
    provenance: string | null;
    source_available: string | null;
    ref_before: string | null;
    ref_after: string | null;
  }>(
    `select id, row_id, action, actor_id, request_id,
            changes->'sourceEvidence'->>'provenance' as provenance,
            changes->'sourceEvidence'->>'sourceAvailable' as source_available,
            changes->'rawFileRef'->>'before' as ref_before,
            changes->'rawFileRef'->>'after' as ref_after
       from public.audit_log
      where org_id = $1
        and changes->>'operation' = 'bank_statement_source_evidence_migration'
      order by row_id`,
    [fixture.orgId],
  );
  assert.equal(attestations.rows.length, fixture.legacyStatementIds.length);
  for (const attestation of attestations.rows) {
    assert.ok(fixture.legacyStatementIds.includes(attestation.row_id));
    assert.equal(attestation.action, "update");
    assert.equal(attestation.actor_id, null);
    assert.equal(attestation.request_id, "migration:0010_bank_statement_source_evidence");
    assert.equal(attestation.provenance, "legacy_source_unavailable");
    assert.equal(attestation.source_available, "false");
    assert.equal(attestation.ref_before, null);
    const pointer = byId.get(attestation.row_id)!;
    assert.equal(attestation.ref_after, pointer);
    // One honest gap attestation per statement, addressed by the pointer
    // itself, and nowhere is a SHA-256 invented for bytes nobody kept.
    assert.ok(evidenceIds.includes(attestation.id));
    assert.doesNotMatch(JSON.stringify(attestation), /sha256/i);
  }

  const column = await fixture.client.query<{ is_nullable: string }>(
    `select is_nullable from information_schema.columns
      where table_schema = 'public' and table_name = 'bank_statements'
        and column_name = 'raw_file_ref'`,
  );
  assert.equal(column.rows[0]?.is_nullable, "NO");
  await assert.rejects(
    fixture.client.query(
      `insert into public.bank_statements (id, org_id, account_id, source, statement_date)
       values ($1, $2, $3, 'csv', '2026-08-31')`,
      [randomUUID(), fixture.orgId, fixture.accountId],
    ),
    (error: unknown) => {
      assert.equal(postgresFailure(error)?.code, "23502");
      return true;
    },
  );

  // The idempotency migration applies later in publish order and must compose
  // over gap attestations: only genuinely hashed sources backfill.
  await fixture.client.query(
    TAIL_FILES.find((file) => file.name === "0036_bank_statement_source_idempotency.sql")!
      .content,
  );
  const hashes = await fixture.client.query<{
    id: string;
    source_file_sha256: string | null;
  }>(
    `select id, source_file_sha256 from public.bank_statements
      where org_id = $1 order by id`,
    [fixture.orgId],
  );
  const hashById = new Map(hashes.rows.map((row) => [row.id, row.source_file_sha256]));
  for (const legacyId of fixture.legacyStatementIds) {
    assert.equal(hashById.get(legacyId), null);
  }
  assert.equal(hashById.get(fixture.retainedStatementId), fixture.retainedSha256);
  const index = await fixture.client.query<{ indexname: string }>(
    `select indexname from pg_indexes
      where schemaname = 'public'
        and indexname = 'bank_statements_org_account_source_sha256'`,
  );
  assert.equal(index.rows.length, 1);
});

test("reapplying the published evidence migration creates no second attestations", { skip: !DB, timeout: 300_000 }, async () => {
  const fixture = await scratch();

  const before = await fixture.client.query<{
    audit_rows: string;
    attestations: string;
    state: unknown[];
  }>(
    `select (select count(*)::text from public.audit_log where org_id = $1) as audit_rows,
            (select count(*)::text from public.audit_log
              where org_id = $1
                and changes->>'operation' = 'bank_statement_source_evidence_migration') as attestations,
            (select coalesce(jsonb_agg(row_to_json(s) order by s.id), '[]'::jsonb)
               from (select id, raw_file_ref, source_file_sha256
                       from public.bank_statements where org_id = $1) s) as state`,
    [fixture.orgId],
  );

  await fixture.client.query(evidenceMigration);

  const after = await fixture.client.query<{
    audit_rows: string;
    attestations: string;
    state: unknown[];
  }>(
    `select (select count(*)::text from public.audit_log where org_id = $1) as audit_rows,
            (select count(*)::text from public.audit_log
              where org_id = $1
                and changes->>'operation' = 'bank_statement_source_evidence_migration') as attestations,
            (select coalesce(jsonb_agg(row_to_json(s) order by s.id), '[]'::jsonb)
               from (select id, raw_file_ref, source_file_sha256
                       from public.bank_statements where org_id = $1) s) as state`,
    [fixture.orgId],
  );

  assert.equal(after.rows[0]?.audit_rows, before.rows[0]?.audit_rows);
  assert.equal(after.rows[0]?.attestations, before.rows[0]?.attestations);
  assert.deepEqual(after.rows[0]?.state, before.rows[0]?.state);
});

test("the rest of the published chain completes over the upgraded data", { skip: !DB, timeout: 300_000 }, async () => {
  const fixture = await scratch();

  for (const { name, content } of TAIL_FILES) {
    try {
      await fixture.client.query(content);
    } catch (error) {
      throw new Error(`published migration ${name} failed after the upgrade: ${(error as Error).message}`);
    }
  }

  // The governed catalog scopes reads through its temp-table context (the same
  // mechanism the SQL workbench uses), not a GUC.
  await fixture.client.query(
    `create temporary table if not exists openbooks_query_context (org_id uuid)`,
  );
  await fixture.client.query("truncate table pg_temp.openbooks_query_context");
  await fixture.client.query(
    "insert into pg_temp.openbooks_query_context (org_id) values ($1)",
    [fixture.orgId],
  );
  const viewColumns = await fixture.client.query<{ column_name: string }>(
    `select column_name from information_schema.columns
      where table_schema = 'openbooks_query' and table_name = 'bank_statements'
      order by column_name`,
  );
  const names = viewColumns.rows.map((row) => row.column_name);
  assert.ok(names.includes("raw_file_ref"));
  assert.ok(names.includes("source_file_sha256"));
  const visible = await fixture.client.query<{ count: string }>(
    "select count(*)::text as count from openbooks_query.bank_statements",
  );
  assert.equal(visible.rows[0]?.count, String(fixture.legacyStatementIds.length + 1));
});
