import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  blankQuotedSpans,
  ordinalOf,
  scanNoneFile,
  scanPreflightSql,
  scanTree,
  splitSqlStatements,
} from "./check-migration-preflights.mjs";

const GOOD_SELECT = `select '0296.malformed_remittance_marker' as code,
       'refuse' as severity,
       id::text as subject,
       'delete these rows first' as detail,
       'fix the source rows, then upgrade' as remedy
  from payroll_stubs
 where remittance_marker not similar to '[A-Z]+:[0-9]+'
 limit 50`;

function fixtureTree(files) {
  const root = mkdtempSync(join(tmpdir(), "openbooks-preflights-"));
  for (const [relative, content] of Object.entries(files)) {
    const path = join(root, relative);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return { generatedDir: join(root, "generated"), preflightDir: join(root, "preflight") };
}

function kinds(findings) {
  return findings.map((finding) => finding.kind).sort();
}

test("a well-formed preflight passes, including remedy prose naming a write", () => {
  assert.deepEqual(scanPreflightSql("0296_x.sql", `${GOOD_SELECT};`), []);
});

test("a WITH ... SELECT preflight passes", () => {
  assert.deepEqual(
    scanPreflightSql(
      "0296_x.sql",
      "with bad as (select id from t where x is null) select '0296.bad_rows' as code, 'notice' as severity, id::text as subject, 'd' as detail, 'r' as remedy from bad;",
    ),
    [],
  );
});

test("two statements are refused by name (a pasted verification SELECT does not ride along)", () => {
  const findings = scanPreflightSql("0296_x.sql", `${GOOD_SELECT};\nselect 1;`);
  assert.deepEqual(kinds(findings), ["preflight-statements"]);
  assert.ok(findings[0].value.includes("found 2"));
});

test("an empty file and a comment-only file are refused, not silently clean", () => {
  for (const content of ["", "-- nothing to check\n", ";\n;\n"]) {
    const findings = scanPreflightSql("0296_x.sql", content);
    assert.deepEqual(kinds(findings), ["preflight-statements"], JSON.stringify(content));
  }
});

test("a non-SELECT statement is refused before any keyword scan", () => {
  const findings = scanPreflightSql("0296_x.sql", "update t set x = 1;");
  assert.deepEqual(kinds(findings), ["preflight-not-select"]);
});

test("every write keyword is refused by name", () => {
  const cases = [
    ["INSERT", "with i as (insert into t values (1) returning x) select * from i;", "preflight-write-keyword"],
    ["UPDATE", "with u as (update t set x = 1 returning id) select * from u;", "preflight-write-keyword"],
    ["DELETE", "with d as (delete from t returning id) select * from d;", "preflight-write-keyword"],
    ["MERGE", "merge into t using s on t.id = s.id when matched then update set x = 1;", "preflight-not-select"],
    ["CREATE", "create temp table t(x int);", "preflight-not-select"],
    ["DROP", "drop table t;", "preflight-not-select"],
    ["TRUNCATE", "truncate t;", "preflight-not-select"],
    ["GRANT", "grant select on t to r;", "preflight-not-select"],
    ["REVOKE", "revoke select on t from r;", "preflight-not-select"],
    ["SET", "set statement_timeout = 1;", "preflight-not-select"],
    ["COPY", "copy t from stdin;", "preflight-not-select"],
    ["CALL", "call refresh();", "preflight-not-select"],
    ["DO", "do $$ begin raise notice 'x'; end $$;", "preflight-not-select"],
    ["INTO", "select * into temp t from x;", "preflight-write-keyword"],
  ];
  for (const [keyword, body, kind] of cases) {
    const findings = scanPreflightSql("0296_x.sql", body);
    assert.ok(kinds(findings).includes(kind), `${keyword}: ${JSON.stringify(findings)}`);
    if (kind === "preflight-write-keyword") {
      assert.ok(findings.some((finding) => finding.value === keyword), keyword);
    }
  }
  const setConfig = scanPreflightSql("0296_x.sql", "select set_config('x', 'y', true);");
  assert.ok(setConfig.some((finding) => finding.value === "set_config()"));
});

test("a data-modifying CTE is refused even though the outer statement is a SELECT", () => {
  const findings = scanPreflightSql(
    "0296_x.sql",
    "with fixed as (update t set x = 1 returning id) select '0296.x' as code, 'refuse' as severity, id::text as subject, 'd' as detail, 'r' as remedy from fixed;",
  );
  // UPDATE ... SET trips both keywords; the UPDATE verdict is what matters.
  assert.ok(kinds(findings).every((kind) => kind === "preflight-write-keyword"));
  assert.ok(findings.some((finding) => finding.value === "UPDATE"));
});

test("advisory-lock calls are refused: a preflight must not lock a live install", () => {
  const findings = scanPreflightSql("0296_x.sql", "select pg_advisory_lock(1);");
  assert.deepEqual(kinds(findings), ["preflight-write-keyword"]);
});

test("a quoted identifier or literal that merely contains a keyword is not a write", () => {
  assert.deepEqual(
    scanPreflightSql("0296_x.sql", 'select "update" from t;'),
    [],
  );
  const blanked = blankQuotedSpans(`select 'it''s a delete' as x, "grant"`);
  assert.equal(blanked.length, `select 'it''s a delete' as x, "grant"`.length);
  assert.ok(!blanked.includes("'") && !blanked.includes('"'));
  assert.ok(blanked.startsWith("select ") && blanked.includes(" as x, "));
});

test("a semicolon inside a literal does not split the statement", () => {
  assert.deepEqual(splitSqlStatements("select 'a;b';").length, 1);
  assert.deepEqual(splitSqlStatements("select 1; -- trailing prose\n").length, 1);
  assert.deepEqual(splitSqlStatements("select 1; select 2;").length, 2);
});

test("an adequate .none reason passes; a short one names the deficit", () => {
  assert.deepEqual(scanNoneFile("0242_x.none", "Adds only a NOT VALID guard; existing rows are untouched.\n"), []);
  const findings = scanNoneFile("0242_x.none", "no data touched");
  assert.deepEqual(kinds(findings), ["preflight-none-short"]);
  const boundary = scanNoneFile("0242_x.none", "a".repeat(19));
  assert.deepEqual(kinds(boundary), ["preflight-none-short"]);
  assert.deepEqual(scanNoneFile("0242_x.none", "a".repeat(20)), []);
  assert.deepEqual(kinds(scanNoneFile("0242_x.none", "   \n  ")), ["preflight-none-short"]);
});

test("a migration with no decision file is refused naming the remedy", () => {
  const { generatedDir, preflightDir } = fixtureTree({
    "generated/0242_guarded.sql": "alter table t add constraint c check (x > 0);\n",
    "preflight/.keep": "",
  });
  const findings = scanTree(generatedDir, preflightDir);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].kind, "preflight-missing");
  assert.ok(findings[0].file.includes("0242_guarded.sql"));
  assert.ok(findings[0].value.includes(".none"));
});

test("both decision files present is a contradiction, not a pass", () => {
  const { generatedDir, preflightDir } = fixtureTree({
    "generated/0242_guarded.sql": "select 1;\n",
    "preflight/0242_guarded.sql": `${GOOD_SELECT};`,
    "preflight/0242_guarded.none": "This migration needs no preflight at all.\n",
  });
  const findings = scanTree(generatedDir, preflightDir);
  assert.deepEqual(kinds(findings), ["preflight-contradiction"]);
});

test("an orphan decision file names the stem it cannot match", () => {
  const { generatedDir, preflightDir } = fixtureTree({
    "generated/0242_guarded.sql": "select 1;\n",
    "preflight/0242_guarded.none": "This migration needs no preflight at all.\n",
    "preflight/0999_ghost.none": "This decision matches no migration at all.\n",
  });
  const findings = scanTree(generatedDir, preflightDir);
  assert.deepEqual(kinds(findings), ["preflight-orphan"]);
  assert.ok(findings[0].value.includes("0999_ghost"));
});

test("migrations before the contract ordinal are grandfathered", () => {
  const { generatedDir, preflightDir } = fixtureTree({
    "generated/0241_old.sql": "update t set x = 1;\n",
    "generated/0242_new.sql": "select 1;\n",
    "preflight/0242_new.none": "This migration needs no preflight at all.\n",
  });
  assert.deepEqual(scanTree(generatedDir, preflightDir), []);
});

test("a missing preflight directory fails closed on every covered migration", () => {
  const root = mkdtempSync(join(tmpdir(), "openbooks-preflights-nodir-"));
  const generatedDir = join(root, "generated");
  mkdirSync(generatedDir, { recursive: true });
  writeFileSync(join(generatedDir, "0242_guarded.sql"), "select 1;\n");
  const findings = scanTree(generatedDir, join(root, "preflight"));
  assert.deepEqual(kinds(findings), ["preflight-missing"]);
});

test("ordinal parsing accepts only the four-digit migration shape", () => {
  assert.equal(ordinalOf("0242_guarded.sql"), 242);
  assert.equal(ordinalOf("0242_guarded.none"), null);
  assert.equal(ordinalOf("not-a-migration.sql"), null);
});

test("on the real tree, no finding is worse than a missing decision", () => {
  // Decision files land separately (P1B); until then every finding must be
  // preflight-missing. If this fires on another kind, a decision file is
  // contradictory, orphaned, short, or malformed — fix the file, not this test.
  // (The committed-tree fully-green assertion joins the check:* chain with them.)
  for (const finding of scanTree()) {
    assert.equal(finding.kind, "preflight-missing");
  }
});
