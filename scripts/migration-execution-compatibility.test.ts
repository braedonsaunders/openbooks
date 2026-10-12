import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";
import type pg from "pg";
import { migrationExecutionCompatibility } from "./migration-execution-compatibility.ts";
import { executeMigrationAttempt, executeMigrationBody, migrationLockConfig } from "./bootstrap-migration-client.ts";

const filename = "generated/0699_financial_history_native_clone_guards.sql";
const source = readFileSync(new URL(`../schema/migrations/${filename}`, import.meta.url), "utf8");
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

test("published execution compatibility preserves the ledger identity and changes only SQL CASE grouping", () => {
  const result = migrationExecutionCompatibility(filename, source);
  assert.ok(result.correction);
  assert.equal(result.correction.publishedSha256, sha(source));
  assert.equal(result.correction.executedSha256, sha(result.content));
  assert.notEqual(result.correction.executedSha256, sha(source));
  const expression = "CASE candidate->>'key' WHEN 'spot' THEN 'Spot' WHEN 'average' THEN 'Average' ELSE 'Historical' END";
  assert.equal(result.content.replace(`(${expression})`, expression), source);
  assert.equal(result.content.length, source.length + 2);
  assert.throws(() => migrationExecutionCompatibility(filename, source + "\n"), /exact published digest/);
  assert.deepEqual(migrationExecutionCompatibility("generated/0698_rbc_std152_bank_files.sql", source), { content: source });
});

test("native correction evidence is atomic with migration execution and its original ledger record", async () => {
  const statements: { text: string; values?: unknown[] }[] = [];
  const client = { query: async (text: string, values?: unknown[]) => {
    statements.push({ text, values });
    return { rows: [], rowCount: 1 };
  } } as unknown as pg.PoolClient;
  const result = migrationExecutionCompatibility(filename, source);
  await executeMigrationAttempt(client, { filename, body: result.content, digest: sha(source),
    transactional: true, lock: migrationLockConfig({}), executionCorrection: result.correction,
    beforeBody: async applyingClient => { assert.equal(applyingClient, client); await applyingClient.query("select 'strict preflight'"); },
    executeBody: executeMigrationBody });
  assert.equal(statements[0]!.text, "begin");
  assert.ok(statements.findIndex(row => row.text === "select 'strict preflight'") < statements.findIndex(row => row.text === result.content));
  const ledger = statements.find(row => row.text.includes("insert into public._applied_migrations"))!;
  assert.deepEqual(ledger.values, [filename, sha(source)]);
  const evidence = statements.find(row => row.text.includes("insert into public._migration_execution_corrections"))!;
  assert.deepEqual(evidence.values, [filename, result.correction!.id, sha(source), sha(result.content)]);
  assert.equal(statements.at(-1)!.text, "commit");
});

test("apply-time drift and conflicting execution evidence cannot commit a migration", async () => {
  const result = migrationExecutionCompatibility(filename, source);
  const calls: string[] = [];
  const client = { query: async (text: string) => { calls.push(text); return { rows: [], rowCount: 0 }; } } as unknown as pg.PoolClient;
  const attempt = { filename, body: result.content, digest: sha(source), transactional: true,
    lock: migrationLockConfig({}), executionCorrection: result.correction, executeBody: executeMigrationBody };
  await assert.rejects(executeMigrationAttempt(client, { ...attempt, beforeBody: async () => { throw new Error("strict guard drift"); } }), /strict guard drift/);
  assert.ok(!calls.includes(result.content));
  assert.ok(!calls.includes("commit"));
  calls.length = 0;
  await assert.rejects(executeMigrationAttempt(client, attempt), /conflicts with recorded evidence/);
  assert.ok(!calls.includes("commit"));
  await assert.rejects(executeMigrationAttempt(client, { ...attempt, transactional: false }), /atomic transaction/);
  await assert.rejects(executeMigrationAttempt(client, { ...attempt, digest: "0".repeat(64) }), /exact published identity/);
  await assert.rejects(executeMigrationAttempt(client, { ...attempt, body: result.content + "\n" }), /executable differs/);
});
