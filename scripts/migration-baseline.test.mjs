import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { assertBaselineCatalogsEqual, baselineDigest, baselineRegistrySql } from "./migration-baseline-catalog.mjs";
import { assertBaselineHistory, migrationIdentityIsApplied, releaseMigrationPlan } from "./migration-baseline-plan.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-baseline-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "generated"));
  mkdirSync(join(directory, "baselines"));
  const files = ["0001_baseline.sql", "0480_last.sql", "0481_new.sql"];
  for (const file of files) writeFileSync(join(directory, "generated", file), `-- ${file}\n`);
  writeFileSync(join(directory, "baselines/alpha29.sql"), "-- release schema\n");
  const baseline = { format: 1, verified: true, filename: "baselines/alpha29.sql",
    baselineSha256: baselineDigest("-- release schema\n"), catalogSha256: baselineDigest("catalog"),
    covered: files.slice(0,2).map((file) => ({ filename: `generated/${file}`, sha256: baselineDigest(`-- ${file}\n`) })) };
  const publish = () => writeFileSync(join(directory, "baseline.json"), JSON.stringify(baseline));
  return { directory, baseline, files, publish };
}

test("without a release cut every historical migration remains active", (context) => {
  const { directory, files } = fixture(context);
  assert.deepEqual(releaseMigrationPlan(directory, files).filenames, files.map((file) => `generated/${file}`));
});

test("a release cut applies one baseline and only the later forward migrations", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  assert.deepEqual(releaseMigrationPlan(directory, files).filenames, ["baselines/alpha29.sql", "generated/0481_new.sql"]);
});

test("a covered write cannot change after the baseline was verified", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  writeFileSync(join(directory, "generated/0480_last.sql"), "-- different guard\n");
  assert.throws(() => releaseMigrationPlan(directory, files), /covered migration changed: generated\/0480_last.sql/);
});

test("an unverified new ordinal inside the cut is refused", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  assert.throws(() => releaseMigrationPlan(directory, [...files.slice(0,1), "0479_late.sql", ...files.slice(1)]), /0479_late.sql.*without verified coverage/);
});

test("unverified and unordered release manifests fail closed", (context) => {
  const { directory, files, baseline, publish } = fixture(context);
  baseline.verified = false;
  publish();
  assert.throws(() => releaseMigrationPlan(directory, files), /manifest is malformed/);
  baseline.verified = true;
  baseline.covered.reverse();
  publish();
  assert.throws(() => releaseMigrationPlan(directory, files), /unique ordered migration identities/);
});

test("changed baseline bytes are refused even when historical inputs match", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  writeFileSync(join(directory, "baselines/alpha29.sql"), "-- wrong constraints\n");
  assert.throws(() => releaseMigrationPlan(directory, files), /baseline bytes differ/);
});

test("only an empty database or the exact adopted identity may apply the release", (context) => {
  const { baseline } = fixture(context);
  assert.doesNotThrow(() => assertBaselineHistory(baseline, [], false));
  assert.doesNotThrow(() => assertBaselineHistory(baseline, [{ filename: baseline.filename, sha256: baseline.baselineSha256 }], true));
  for (const history of [[], [{ filename: "generated/0001_baseline.sql", sha256: baseline.baselineSha256 }], [{ filename: baseline.filename, sha256: "old-digest" }]]) {
    assert.throws(() => assertBaselineHistory(baseline, history, true), /upgrade or reconcile.*adopt-migration-baseline.*No baseline SQL may be replayed over tenant data/);
  }
});

test("catalog equivalence preserves whitespace inside financial refusal messages", () => {
  assert.throws(() => assertBaselineCatalogsEqual({ functions: [{ definition: "RAISE EXCEPTION 'rate  unavailable'" }] }, { functions: [{ definition: "RAISE EXCEPTION 'rate unavailable'" }] }), /differs in functions/);
});

test("application-side credential sealing still runs when its SQL migration is covered by a baseline", (context) => {
  const { baseline } = fixture(context);
  const filename = "generated/0251_payment_link_token_at_rest.sql";
  baseline.covered.push({ filename, sha256: baselineDigest("seal schema") });
  assert.equal(migrationIdentityIsApplied(filename, [{ filename: baseline.filename, sha256: baseline.baselineSha256 }], baseline), true);
  assert.equal(migrationIdentityIsApplied(filename, [{ filename: baseline.filename, sha256: "wrong-digest" }], baseline), false);
  assert.equal(migrationIdentityIsApplied(filename, [], baseline), false);
  assert.equal(migrationIdentityIsApplied("generated/9999_uncovered.sql", [{ filename: baseline.filename, sha256: baseline.baselineSha256 }], baseline), false);
  assert.equal(migrationIdentityIsApplied(filename, [{ filename, sha256: "historical" }], null), true);
});

test("missing security sections, invalid indexes and changed registry rows are refused", () => {
  for (const section of ["policies", "indexes", "openbooks_document_close_modules"]) {
    assert.throws(() => assertBaselineCatalogsEqual({ [section]: [{ valid: true }] }, { [section]: [{ valid: false }] }), new RegExp(`differs in ${section}`));
  }
  assert.throws(() => assertBaselineCatalogsEqual({ policies: [] }, {}), /differs in policies/);
});

test("optional trigram absence permits only its acceleration indexes to be absent", () => {
  const extension = { name: "pg_trgm", version: "1.6", schema: "public" };
  const index = { definition: "CREATE INDEX name_search ON files USING gin (name public.gin_trgm_ops)", valid: true };
  const expected = { extensions: [extension], indexes: [index] };
  assert.doesNotThrow(() => assertBaselineCatalogsEqual(expected, { extensions: [], indexes: [] }));
  assert.throws(() => assertBaselineCatalogsEqual(expected, { extensions: [extension], indexes: [{ ...index, valid: false }] }), /differs in indexes/);
  assert.throws(() => assertBaselineCatalogsEqual({ extensions: [{ name: "btree_gist", version: "1.7" }], indexes: [] }, { extensions: [], indexes: [] }), /differs in extensions/);
});

test("system seed SQL preserves currency precision and registry identity", () => {
  const sql = baselineRegistrySql({ currencies: [{ code: "KWD", name: "Kuwait's dinar", minor_units: 3 }], platform_settings: [{ id: "platform" }],
    openbooks_query_catalog_relations: [{ relation: "pay_runs", added_in: "0352" }],
    openbooks_document_close_modules: [{ kind: "invoice", close_module: "ar", added_in: "0418" }] });
  assert.match(sql, /'KWD', 'Kuwait''s dinar', '3'/);
  assert.match(sql, /platform_settings \(id\)/);
  assert.doesNotMatch(sql, /added_at|ON CONFLICT|settings,/i);
  assert.throws(() => baselineRegistrySql({}), /registry is empty: currencies/);
});

test("baseline preparation refuses missing and remote resource declarations even with NODE_ENV unset", () => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.OPENBOOKS_BASELINE_ADMIN_URL;
  const args = ["--import", "tsx", "scripts/prepare-migration-baseline.mts", "--output", "/tmp/openbooks-baseline-should-never-be-created"];
  for (const url of [undefined, "postgres://operator@10.0.0.85/postgres", "postgres://operator@127.0.0.1/openbooks"]) {
    if (url) env.OPENBOOKS_BASELINE_ADMIN_URL = url;
    const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(result.status, 1);
    assert.match(result.stderr, url ? /remote and tenant databases are refused/ : /set OPENBOOKS_BASELINE_ADMIN_URL/);
  }
});

test("generic query projections ignore physical column order while preserving isolation and curated expressions", () => {
  const row = { schema: "openbooks_query", name: "entries", kind: "v", view: " SELECT id,\n    org_id\n   FROM entries\n  WHERE (org_id = openbooks_query_org_id());" };
  const reversed = { ...row, view: " SELECT org_id,\n    id\n   FROM entries\n  WHERE (org_id = openbooks_query_org_id());" };
  const registry = [{ relation: "entries" }];
  assert.doesNotThrow(() => assertBaselineCatalogsEqual({ relations: [row], openbooks_query_catalog_relations: registry }, { relations: [reversed], openbooks_query_catalog_relations: registry }));
  assert.throws(() => assertBaselineCatalogsEqual({ relations: [row], openbooks_query_catalog_relations: registry }, { relations: [{ ...reversed, view: reversed.view.replace("org_id = openbooks_query_org_id()", "true") }], openbooks_query_catalog_relations: registry }), /differs in relations/);
  assert.throws(() => assertBaselineCatalogsEqual({ relations: [row] }, { relations: [reversed] }), /differs in relations/);
});

test("catalog ACL comparison is independent of database collation", () => {
  const grants = [{ grantee: "PUBLIC", privilege_type: "USAGE" }, { grantee: "openbooks_read", privilege_type: "USAGE" }];
  assert.doesNotThrow(() => assertBaselineCatalogsEqual({ schema_acl: grants }, { schema_acl: grants.toReversed() }));
  assert.throws(() => assertBaselineCatalogsEqual({ schema_acl: grants }, { schema_acl: grants.slice(1) }), /differs in schema_acl/);
});
