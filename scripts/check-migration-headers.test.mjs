import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { publishedMigrationSessionPrelude, publishedMigrationSessionSettings, publishedMigrationUsesRunnerLockTimeout } from "./migration-session-headers.mjs";
import {
  LOCK_TIMEOUT_AMNESTY_MAX_ORDINAL,
  scanMigrationFile,
  scanTree,
} from "./check-migration-headers.mjs";

const HEADER = [
  "SET statement_timeout = 0;",
  "SET idle_in_transaction_session_timeout = 0;",
  "SET client_encoding = 'UTF8';",
  "SET standard_conforming_strings = on;",
  "SET client_min_messages = warning;",
].join("\n");

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-migration-headers-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

test("a compliant new migration passes: header present, no lock_timeout", () => {
  assert.deepEqual(
    scanMigrationFile("0261_fk_index_coverage.sql", `${HEADER}\nCREATE INDEX CONCURRENTLY x;`),
    [],
  );
});

test("every zero lock_timeout spelling is refused by name", () => {
  for (const stmt of [
    "SET lock_timeout = 0;",
    "SET lock_timeout TO 0;",
    "SET SESSION lock_timeout = '0s';",
    "SET LOCAL lock_timeout TO '0ms';",
    "SET lock_timeout = DEFAULT;",
    "RESET lock_timeout;",
  ]) {
    const findings = scanMigrationFile("0261_bad.sql", `${HEADER}\n${stmt}\nselect 1;`);
    assert.equal(findings.length, 1, stmt);
    assert.equal(findings[0].kind, "lock_timeout-zero");
    assert.ok(findings[0].value.includes("lock_timeout"), stmt);
  }
});

test("a bounded lock_timeout passes the zero check (the runner still owns it)", () => {
  assert.deepEqual(
    scanMigrationFile("0261_bounded.sql", `${HEADER}\nSET lock_timeout = '5s';\nselect 1;`),
    [],
  );
  for (const unbounded of ["SET lock_timeout = 0;", "SET LOCAL lock_timeout TO '0ms';", "RESET lock_timeout;"]) {
    const findings = scanMigrationFile("0261_bounded.sql", `${HEADER}\nSET lock_timeout = '5s';\n${unbounded}\nselect 1;`);
    assert.equal(findings.length, 1, unbounded);
    assert.equal(findings[0].kind, "lock_timeout-zero", unbounded);
  }
});

test("set_config lock_timeout is refused at any value (the runner cannot strip it)", () => {
  for (const stmt of [
    "SELECT set_config('lock_timeout', '0', false);",
    "SELECT set_config('lock_timeout', '5s', true);",
  ]) {
    const findings = scanMigrationFile("0261_setconfig.sql", `${HEADER}\n${stmt}\nselect 1;`);
    assert.equal(findings.length, 1, stmt);
    assert.equal(findings[0].kind, "lock_timeout-set_config");
    assert.ok(findings[0].value.includes("set_config"), stmt);
  }
});

test("a missing header line is refused naming the missing SET", () => {
  const findings = scanMigrationFile(
    "0261_no_header.sql",
    "SET statement_timeout = 0;\nselect 1;",
  );
  const kinds = findings.map((finding) => finding.kind);
  assert.ok(!kinds.includes("lock_timeout-zero"));
  assert.deepEqual(
    findings.map((finding) => finding.value).sort(),
    [
      "SET client_encoding",
      "SET client_min_messages",
      "SET idle_in_transaction_session_timeout",
      "SET standard_conforming_strings",
    ],
  );
});

test("the runner supplies the exact published partial header without admitting changed or unrelated files", () => {
  const filename = "0572_optional_custom_dimension_assignments.sql";
  const content = readFileSync(new URL(`../schema/migrations/generated/${filename}`, import.meta.url), "utf8");
  const settings = publishedMigrationSessionSettings(`generated/${filename}`, content);
  assert.deepEqual(settings.map(({ name }) => name).sort(), [
    "client_encoding", "client_min_messages", "idle_in_transaction_session_timeout", "standard_conforming_strings",
  ]);
  assert.deepEqual(scanMigrationFile(filename, content), []);
  const prelude = publishedMigrationSessionPrelude(`generated/${filename}`, content);
  assert.equal(prelude, `${HEADER.split("\n").slice(1).join("\n")}\n`);
  assert.equal(publishedMigrationSessionPrelude("generated/0576_other.sql", content), "");
  assert.equal(scanMigrationFile("0576_other.sql", content).filter(({ kind }) => kind === "header-missing").length, 4);
  for (const suffix of ["\n-- changed published bytes\n", "\nSET lock_timeout = 0;\n"]) {
    const changed = content + suffix;
    assert.throws(() => publishedMigrationSessionPrelude(`generated/${filename}`, changed), /published digest.*forward migration/);
    const findings = scanMigrationFile(filename, changed);
    assert.ok(findings.some(({ kind }) => kind === "published-content-changed"));
    assert.equal(findings.filter(({ kind }) => kind === "header-missing").length, 4);
    if (suffix.includes("lock_timeout")) assert.ok(findings.some(({ kind }) => kind === "lock_timeout-zero"));
  }
});

test("lock_timeout prose in comments is not code", () => {
  const content = [
    "-- SET lock_timeout = 0 used to hang deploys; the runner bounds it now.",
    "/* RESET lock_timeout would do the same. */",
    HEADER,
    "select 1;",
  ].join("\n");
  assert.deepEqual(scanMigrationFile("0261_prose.sql", content), []);
});

test("exact published lock header retains identity under the runner bound; changed and unrelated bytes refuse", () => {
  const filename = "0580_clone_preserves_recorded_document_balances.sql";
  const content = readFileSync(new URL(`../schema/migrations/generated/${filename}`, import.meta.url), "utf8");
  assert.equal(publishedMigrationUsesRunnerLockTimeout(`generated/${filename}`, content), true);
  assert.deepEqual(scanMigrationFile(filename, content), []);
  assert.equal(publishedMigrationSessionPrelude(`generated/${filename}`, content), "");
  assert.equal(publishedMigrationUsesRunnerLockTimeout("generated/0581_other.sql", content), false);
  assert.equal(scanMigrationFile("0581_other.sql", content).filter(({ kind }) => kind === "lock_timeout-zero").length, 1);
  for (const changed of [content + "\n-- changed bytes\n", content.replace("SET lock_timeout = 0;", "RESET lock_timeout;")]) {
    assert.throws(() => publishedMigrationSessionPrelude(`generated/${filename}`, changed), /published digest.*forward migration/);
    const findings = scanMigrationFile(filename, changed);
    assert.ok(findings.some(({ kind }) => kind === "published-content-changed"));
    assert.ok(findings.some(({ kind }) => kind === "lock_timeout-zero"));
  }
});

test("the amnesty covers 0251 exactly and nothing above it", () => {
  assert.equal(LOCK_TIMEOUT_AMNESTY_MAX_ORDINAL, 251);
  assert.deepEqual(
    scanMigrationFile("0251_payment_link_token_at_rest.sql", `${HEADER}\nSET lock_timeout = 0;`),
    [],
  );
  const findings = scanMigrationFile("0252_next.sql", `${HEADER}\nSET lock_timeout = 0;`);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "lock_timeout-zero");
});

test("scanTree derives the file list from the directory", () => {
  const root = fixtureTree({
    "0251_old.sql": "select 1;",
    "0261_ok.sql": `${HEADER}\nselect 1;`,
    "0262_bad.sql": `${HEADER}\nSET lock_timeout = 0;`,
    "README.md": "SET lock_timeout = 0;",
  });
  const findings = scanTree(root);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].file, "0262_bad.sql");
  assert.equal(findings[0].kind, "lock_timeout-zero");
});
