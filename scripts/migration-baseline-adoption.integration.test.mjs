import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtemp, mkdir, copyFile, symlink, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import pg from "pg";
import { baselineCatalog, baselineDigest } from "./migration-baseline-catalog.mjs";

const run = promisify(execFile);

test("baseline adoption refuses schema drift and concurrent clients, preserves data and audits the original ledger", async (context) => {
  const rawUrl = process.env.OPENBOOKS_BASELINE_ADMIN_URL || process.env.OPENBOOKS_TEST_ADMIN_DB_URL || process.env.OPENBOOKS_DB_URL;
  assert.ok(rawUrl, "the integration partition requires a disposable local PostgreSQL administrator URL");
  const url = new URL(rawUrl);
  assert.ok(["127.0.0.1", "localhost", "[::1]"].includes(url.hostname), "adoption regression tests must never create databases on a remote host");
  url.pathname = "/postgres";
  const admin = new pg.Client({ connectionString: url.href });
  await admin.connect();
  const name = `openbooks_baseline_test_${randomBytes(6).toString("hex")}`;
  const directory = await mkdtemp(join(tmpdir(), "openbooks-baseline-adoption-"));
  let created = false;
  context.after(async () => {
    try { if (created) await admin.query(`drop database ${name}`); }
    finally { await admin.end(); await rm(directory, { recursive: true, force: true }); }
  });
  await admin.query(`create database ${name} template template0`);
  created = true;
  url.pathname = `/${name}`;
  async function withClient(work) {
    const client = new pg.Client({ connectionString: url.href });
    await client.connect();
    try { return await work(client); } finally { await client.end(); }
  }
  const catalog = await withClient(async (client) => {
    await client.query(`create table currencies (code text primary key,name text not null,minor_units integer not null);
      insert into currencies values ('KWD','Kuwaiti dinar',3);
      create table platform_settings (id text primary key,settings jsonb not null default '{}');
      insert into platform_settings values ('platform','{"keep":"operator settings"}');
      create table openbooks_query_catalog_relations (relation text primary key,added_in text not null);
      insert into openbooks_query_catalog_relations values ('financial_evidence','0480');
      create table openbooks_document_close_modules (kind text primary key,close_module text not null,added_in text not null);
      insert into openbooks_document_close_modules values ('invoice','ar','0418');
      create table financial_evidence (id integer primary key,amount numeric(18,2) not null check(amount>=0));
      insert into financial_evidence values (1,123.45);
      create table _applied_migrations (filename text primary key,sha256 text not null,applied_at timestamptz not null default now());
      insert into _applied_migrations values ('generated/0001_baseline.sql','historical-identity','2026-01-01');`);
    return await baselineCatalog(client);
  });
  await mkdir(join(directory, "scripts"));
  await mkdir(join(directory, "schema/migrations/generated"), { recursive: true });
  await mkdir(join(directory, "schema/migrations/baselines"));
  await symlink(resolve("node_modules"), join(directory, "node_modules"));
  for (const file of ["adopt-migration-baseline.mts", "migration-baseline-catalog.mjs", "migration-baseline-plan.mjs"]) await copyFile(resolve("scripts", file), join(directory, "scripts", file));
  const historical = "-- historical schema\n";
  const baseline = "-- release schema\n";
  const filename = "baselines/alpha29.sql";
  const manifest = { format: 1, verified: true, filename, baselineSha256: baselineDigest(baseline), catalogSha256: baselineDigest(JSON.stringify(catalog)),
    covered: [{ filename: "generated/0001_baseline.sql", sha256: baselineDigest(historical) }] };
  await writeFile(join(directory, "schema/migrations/generated/0001_baseline.sql"), historical);
  await writeFile(join(directory, "schema/migrations", filename), baseline);
  await writeFile(join(directory, "schema/migrations", `${filename}.catalog.json`), JSON.stringify(catalog));
  await writeFile(join(directory, "schema/migrations/baseline.json"), JSON.stringify(manifest));
  const common = ["--import", "tsx", join(directory, "scripts/adopt-migration-baseline.mts"), "--database", name];
  const invoke = (args) => run(process.execPath, [...common, ...args], { env: { ...process.env, OPENBOOKS_BASELINE_TARGET_URL: url.href } });
  const apply = ["--apply", "--actor", "release operator", "--reason", "verified test reconciliation", "--backup", "restored-test-snapshot"];
  const before = await withClient(async (client) => (await client.query("select * from _applied_migrations")).rows[0]);
  assert.match((await invoke(["--check"])).stdout, /VERIFIED.*no changes made/);
  await withClient((client) => client.query("alter table financial_evidence drop constraint financial_evidence_amount_check"));
  await assert.rejects(invoke(apply), (error) => /differs in constraints/.test(error.stderr));
  await withClient(async (client) => {
    assert.equal((await client.query("select count(*)::int as n from _applied_migrations")).rows[0].n, 1);
    await client.query("alter table financial_evidence add constraint financial_evidence_amount_check check(amount>=0)");
  });
  await withClient(async () => {
    await assert.rejects(invoke(apply), (error) => /other database client session/.test(error.stderr));
  });
  assert.match((await invoke(apply)).stdout, /historical ledger and tenant data preserved/);
  assert.match((await invoke(["--check"])).stdout, /VERIFIED.*no changes made/);
  assert.match((await invoke(apply)).stdout, /already adopted; no changes made/);
  await withClient(async (client) => {
    const rows = (await client.query("select * from _applied_migrations order by filename")).rows;
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.find((row) => row.filename === before.filename), before);
    assert.equal((await client.query("select amount::text as amount from financial_evidence")).rows[0].amount, "123.45");
    assert.deepEqual((await client.query("select settings from platform_settings")).rows[0].settings, { keep: "operator settings" });
    const audit = (await client.query("select * from openbooks_migrations.baseline_adoptions")).rows[0];
    assert.equal(audit.actor, "release operator");
    assert.equal(audit.backup_reference, "restored-test-snapshot");
    assert.equal(audit.previous_ledger.length, 1);
    assert.equal(audit.previous_ledger[0].sha256, before.sha256);
  });
});
