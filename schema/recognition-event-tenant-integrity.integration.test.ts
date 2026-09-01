/// <reference types="node" />

/**
 * Live-PostgreSQL proof for 0084_recognition_event_tenant_coherence.
 *
 * The upgrade path bootstraps a clean catalog, restores the 0062
 * single-column-FK shape, proves that it admits a cross-tenant event, and then
 * runs 0084's fail-closed preflight before repairing the clean state. The
 * migration is replayed to prove it is idempotent. A separate empty database
 * receives the complete published chain to prove fresh bootstrap wiring.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import pg from "pg";

const execFileAsync = promisify(execFile);
const DB = Boolean(process.env.OPENBOOKS_DB_URL);
const root = join(import.meta.dirname, "..");
const generatedDir = join(root, "schema", "migrations", "generated");
const migrationName = "0084_recognition_event_tenant_coherence.sql";
const migrationPath = join(generatedDir, migrationName);
const migrationBody = readFileSync(migrationPath, "utf8");
const publishedFiles = readdirSync(generatedDir)
  .filter((file) => file.endsWith(".sql"))
  .sort();
const migrationIndex = publishedFiles.indexOf(migrationName);
assert.ok(migrationIndex > 0, "0084 must be a published forward migration");

type ScratchDatabase = {
  control: pg.Client;
  client: pg.Client;
  name: string;
  url: string;
};

type RecognitionFixture = {
  orgA: string;
  orgB: string;
  obligationA: string;
  obligationB: string;
};

function postgresCode(error: unknown): string | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current && typeof current === "object"; depth += 1) {
    const candidate = current as { code?: string; cause?: unknown };
    if (candidate.code) return candidate.code;
    current = candidate.cause;
  }
  return undefined;
}

async function createScratchDatabase(baseUrl: URL, label: string): Promise<ScratchDatabase> {
  const name = `openbooks_recognition_${label}_${randomBytes(4).toString("hex")}`;
  const controlUrl = new URL(baseUrl.href);
  controlUrl.pathname = "/postgres";
  const control = new pg.Client({ connectionString: controlUrl.href });
  await control.connect();
  await control.query(`create database "${name}"`);

  const databaseUrl = new URL(baseUrl.href);
  databaseUrl.pathname = `/${name}`;
  const client = new pg.Client({ connectionString: databaseUrl.href });
  await client.connect();
  await client.query("select set_config('app.bypass_rls', 'on', false)");
  return { control, client, name, url: databaseUrl.href };
}

async function dropScratchDatabase(scratch: ScratchDatabase): Promise<void> {
  await scratch.client.end().catch(() => undefined);
  await scratch.control
    .query(`drop database if exists "${scratch.name}" with (force)`)
    .catch(() => undefined);
  await scratch.control.end().catch(() => undefined);
}

async function ensureMigrationRoles(control: pg.Client): Promise<void> {
  await control.query(`do $$ begin
    if not exists (select 1 from pg_roles where rolname = 'openbooks_read') then
      create role openbooks_read nologin;
    end if;
    if not exists (select 1 from pg_roles where rolname = 'openbooks_app') then
      create role openbooks_app nologin;
    end if;
  end $$;`);
}

async function runBootstrap(databaseUrl: string): Promise<void> {
  await execFileAsync(
    process.execPath,
    ["--import", "tsx", "scripts/bootstrap.ts"],
    {
      cwd: root,
      env: {
        ...process.env,
        NODE_ENV: "test",
        OPENBOOKS_DB_URL: databaseUrl,
        OPENBOOKS_RUNTIME_DB_URL: "",
        OPENBOOKS_CONSTRAINED_SCHEMA_OWNER_MIGRATION: "",
        ORG_CURRENCY: "USD",
        ORG_COUNTRY: "US",
        OPENBOOKS_DATA_KEY:
          process.env.OPENBOOKS_DATA_KEY
          ?? "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      },
      maxBuffer: 2 * 1024 * 1024,
    },
  );
}

async function seedRecognitionFixture(client: pg.Client, suffix: string): Promise<RecognitionFixture> {
  const orgA = randomUUID();
  const orgB = randomUUID();
  const partyA = randomUUID();
  const partyB = randomUUID();
  const ruleA = randomUUID();
  const ruleB = randomUUID();
  const contractA = randomUUID();
  const contractB = randomUUID();
  const obligationA = randomUUID();
  const obligationB = randomUUID();

  await client.query(
    `insert into public.orgs (id, name, base_currency, country)
     values ($1, $3, 'USD', 'US'), ($2, $4, 'USD', 'US')`,
    [orgA, orgB, `Recognition A ${suffix}`, `Recognition B ${suffix}`],
  );
  await client.query(
    `insert into public.parties (id, org_id, kind, display_name)
     values ($1, $3, 'customer', $5), ($2, $4, 'customer', $6)`,
    [partyA, partyB, orgA, orgB, `Customer A ${suffix}`, `Customer B ${suffix}`],
  );
  await client.query(
    `insert into public.recognition_rules (id, org_id, code, name, method)
     values ($1, $3, $5, $7, 'milestone'), ($2, $4, $6, $8, 'milestone')`,
    [ruleA, ruleB, orgA, orgB, `recognition-a-${suffix}`, `recognition-b-${suffix}`, `Rule A ${suffix}`, `Rule B ${suffix}`],
  );
  await client.query(
    `insert into public.revenue_contracts (id, org_id, customer_id, contract_number)
     values ($1, $3, $5, $7), ($2, $4, $6, $8)`,
    [contractA, contractB, orgA, orgB, partyA, partyB, `contract-a-${suffix}`, `contract-b-${suffix}`],
  );
  await client.query(
     `insert into public.performance_obligations
       (id, org_id, contract_id, description, recognition_rule_id, allocated_price)
     values ($1, $3, $5, $7, $9, 10), ($2, $4, $6, $8, $10, 10)`,
    [
      obligationA,
      obligationB,
      orgA,
      orgB,
      contractA,
      contractB,
      `Obligation A ${suffix}`,
      `Obligation B ${suffix}`,
      ruleA,
      ruleB,
    ],
  );
  return { orgA, orgB, obligationA, obligationB };
}

async function constraintDefinition(client: pg.Client): Promise<string> {
  const result = await client.query<{ definition: string }>(
    `select pg_get_constraintdef(oid) as definition
       from pg_constraint
      where conrelid = 'public.recognition_events'::regclass
        and conname = 'recognition_events_obligation_id_fkey'`,
  );
  assert.equal(result.rows.length, 1);
  return result.rows[0]!.definition;
}

async function assertCrossTenantInsertRejected(
  client: pg.Client,
  fixture: RecognitionFixture,
  sourceReference: string,
): Promise<void> {
  await assert.rejects(
    client.query(
      `insert into public.recognition_events
         (id, org_id, obligation_id, period_month, amount, source_reference)
       values ($1, $2, $3, '2026-08-01', 10, $4)`,
      [randomUUID(), fixture.orgA, fixture.obligationB, sourceReference],
    ),
    (error: unknown) => {
      assert.equal(postgresCode(error), "23503");
      return true;
    },
  );
}

async function assertSameTenantCascade(
  client: pg.Client,
  fixture: RecognitionFixture,
  sourceReference: string,
): Promise<void> {
  const eventId = randomUUID();
  await client.query(
    `insert into public.recognition_events
       (id, org_id, obligation_id, period_month, amount, source_reference)
     values ($1, $2, $3, '2026-08-01', 10, $4)`,
    [eventId, fixture.orgB, fixture.obligationB, sourceReference],
  );
  await client.query(`delete from public.performance_obligations where id = $1`, [fixture.obligationB]);
  const remaining = await client.query(
    `select 1 from public.recognition_events where id = $1`,
    [eventId],
  );
  assert.equal(remaining.rows.length, 0, "same-tenant parent deletion must cascade its event");
}

test(
  "0084 enforces tenant-coherent recognition events on replay and fresh bootstrap",
  { skip: !DB, timeout: 300_000 },
  async () => {
    const baseUrl = new URL(process.env.OPENBOOKS_DB_URL!.trim());
    const upgrade = await createScratchDatabase(baseUrl, "upgrade");
    const fresh = await createScratchDatabase(baseUrl, "fresh");
    try {
      await ensureMigrationRoles(upgrade.control);
      await ensureMigrationRoles(fresh.control);

      // Upgrade replay: bootstrap a clean database through 0084, then
      // reproduce the deployed 0062 state by replacing only this edge with
      // its original single-column definition and clearing its ledger row.
      // This keeps the test focused on the live forward-repair boundary while
      // the separate fresh database below exercises the complete chain.
      await runBootstrap(upgrade.url);
      await upgrade.client.query(`
        alter table public.recognition_events
          drop constraint recognition_events_obligation_id_fkey;
        alter table public.recognition_events
          add constraint recognition_events_obligation_id_fkey
          foreign key (obligation_id)
          references public.performance_obligations (id)
          on delete cascade;
        drop index if exists public.performance_obligations_org_id_id_unique;
        delete from public._applied_migrations
         where filename = 'generated/0084_recognition_event_tenant_coherence.sql';
      `);
      const upgradeFixture = await seedRecognitionFixture(upgrade.client, "upgrade");
      const legacyEventId = randomUUID();
      await upgrade.client.query(
        `insert into public.recognition_events
           (id, org_id, obligation_id, period_month, amount, source_reference)
         values ($1, $2, $3, '2026-08-01', 10, $4)`,
        [legacyEventId, upgradeFixture.orgA, upgradeFixture.obligationB, "legacy-cross-tenant"],
      );
      assert.equal(
        (await upgrade.client.query(`select 1 from public.recognition_events where id = $1`, [legacyEventId])).rows.length,
        1,
        "0062's single-column FK must reproduce the legacy cross-tenant state",
      );

      await assert.rejects(
        runBootstrap(upgrade.url),
        (error: unknown) => {
          assert.match(String(error), /23514|legacy data violates tenant coherence/);
          assert.match(String(error), /legacy data violates tenant coherence/);
          return true;
        },
      );
      assert.match(await constraintDefinition(upgrade.client), /FOREIGN KEY \(obligation_id\) REFERENCES performance_obligations\(id\)/);
      assert.equal(
        (await upgrade.client.query(`select 1 from public.recognition_events where id = $1`, [legacyEventId])).rows.length,
        1,
        "failed preflight must preserve the legacy event for approved reconciliation",
      );

      await upgrade.client.query(`delete from public.recognition_events where id = $1`, [legacyEventId]);
      await runBootstrap(upgrade.url);
      assert.match(await constraintDefinition(upgrade.client), /FOREIGN KEY \(org_id, obligation_id\) REFERENCES performance_obligations\(org_id, id\)/);
      assert.equal(
        (await upgrade.client.query(`select 1 from public.recognition_events where org_id = $1`, [upgradeFixture.orgA])).rows.length,
        0,
        "the clean upgrade must not invent event rows",
      );

      // Replaying the exact published body must not duplicate the key or
      // disturb the already-upgraded data.
      await upgrade.client.query(migrationBody);
      const replayConstraint = await upgrade.client.query(
        `select count(*)::int as count from pg_constraint
          where conrelid = 'public.recognition_events'::regclass
            and conname = 'recognition_events_obligation_id_fkey'`,
      );
      const replayIndex = await upgrade.client.query(
        `select count(*)::int as count from pg_indexes
          where schemaname = 'public'
            and indexname = 'performance_obligations_org_id_id_unique'`,
      );
      assert.equal(replayConstraint.rows[0]?.count, 1);
      assert.equal(replayIndex.rows[0]?.count, 1);
      await assertCrossTenantInsertRejected(upgrade.client, upgradeFixture, "post-upgrade-cross-tenant");
      await assertSameTenantCascade(upgrade.client, upgradeFixture, "post-upgrade-same-tenant");

      // Fresh bootstrap: applying the complete published chain installs the
      // same key and composite edge before any event is written.
      await runBootstrap(fresh.url);
      const freshFixture = await seedRecognitionFixture(fresh.client, "fresh");
      await assertCrossTenantInsertRejected(fresh.client, freshFixture, "fresh-cross-tenant");
      await assertSameTenantCascade(fresh.client, freshFixture, "fresh-same-tenant");
      assert.match(await constraintDefinition(fresh.client), /FOREIGN KEY \(org_id, obligation_id\) REFERENCES performance_obligations\(org_id, id\)/);
    } finally {
      await dropScratchDatabase(upgrade);
      await dropScratchDatabase(fresh);
    }
  },
);
