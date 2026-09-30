import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import pg from "pg";
import { earlierPendingCreatesObject, evaluatePreflight } from "./migration-preflight.ts";

const migration = "generated/0459_provision_obligations.sql";
const preflight = readFileSync(new URL("../schema/migrations/preflight/0459_provision_obligations.sql", import.meta.url), "utf8");
const predecessor = readFileSync(new URL("../schema/migrations/generated/0458_mfg_scrap_frozen_snapshot.sql", import.meta.url), "utf8");

test("provision preflight waits for the manufacturing prerequisite and refuses actual catalog conflicts", { skip: !process.env.OPENBOOKS_DB_URL }, async () => {
  assert.ok(process.env.OPENBOOKS_TEST_ADMIN_DB_URL, "preflight catalog proof requires the test cluster administrator endpoint");
  const pool = new pg.Pool({ connectionString: process.env.OPENBOOKS_TEST_ADMIN_DB_URL });
  const client = await pool.connect();
  const schema = `provision_preflight_${randomBytes(6).toString("hex")}`;
  // Execute the migration query against isolated real catalog objects so the
  // proof can run alongside other database tests without changing their schema.
  const query = preflight.replaceAll("public.", `${schema}.`);
  const check = () => evaluatePreflight(client, migration, "0459", query, { statementTimeoutMs: 10_000 });
  const guard = "CHECK (domain IN ('lease','revenue','asset','consolidation','manufacturing'))";
  const refuses = async () => {
    const result = await check();
    assert.equal(result.status, "ready");
    if (result.status !== "ready") assert.fail("a completed prerequisite must not defer the conflict check");
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]?.code, "0459.provision_catalog_conflict");
    assert.match(result.findings[0]?.remedy ?? "", /catalog.*applied-migration ledger/);
  };
  try {
    await client.query(`CREATE SCHEMA ${schema}`);
    await client.query(`CREATE TABLE ${schema}.financial_changes(domain text CHECK (domain IN ('lease','revenue','asset','consolidation')))`);
    await client.query(`CREATE TABLE ${schema}.mfg_scrap_events(id uuid)`);
    const before = await check();
    assert.equal(before.status, "deferred", "an older catalog has not yet received the manufacturing snapshot");
    if (before.status !== "deferred") assert.fail("expected the missing prerequisite column to defer");
    assert.equal(earlierPendingCreatesObject(new Error(before.reason), [predecessor], preflight), true);
    await client.query(`ALTER TABLE ${schema}.mfg_scrap_events ADD COLUMN treatment text`);
    await refuses();
    await client.query(`ALTER TABLE ${schema}.financial_changes DROP CONSTRAINT financial_changes_domain_check`);
    await client.query(`ALTER TABLE ${schema}.financial_changes ADD CONSTRAINT financial_changes_domain_check ${guard}`);
    const ready = await check();
    assert.equal(ready.status, "ready");
    if (ready.status !== "ready") assert.fail("complete prerequisites must be checked");
    assert.deepEqual(ready.findings, []);
    await client.query(`ALTER TABLE ${schema}.financial_changes ADD CONSTRAINT duplicate_domain_guard ${guard}`);
    await refuses();
    await client.query(`ALTER TABLE ${schema}.financial_changes DROP CONSTRAINT duplicate_domain_guard`);
    for (const object of [
      { create: `CREATE TABLE ${schema}.provision_obligations(id uuid)`, drop: `DROP TABLE ${schema}.provision_obligations` },
      ...["provision_identity_guard", "provision_change_binding_guard"].map((name) => ({
        create: `CREATE FUNCTION ${schema}.${name}() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RETURN NEW; END$$`,
        drop: `DROP FUNCTION ${schema}.${name}()`,
      })),
    ]) {
      await client.query(object.create);
      await refuses();
      await client.query(object.drop);
    }
  } finally {
    try { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { client.release(); await pool.end(); }
  }
});
