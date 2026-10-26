import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  assertBaselineCatalogsEqual,
  baselineDigest,
  baselineRegistrySql,
} from "./migration-baseline-catalog.mjs";
import {
  assertBaselineHistory,
  migrationIdentityIsApplied,
  missingUpgradeLedger,
  releaseMigrationPlan,
} from "./migration-baseline-plan.mjs";

function fixture(context) {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-baseline-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  mkdirSync(join(directory, "generated"));
  mkdirSync(join(directory, "baselines"));
  const files = ["0001_first.sql", "0002_second.sql"];
  for (const file of files) writeFileSync(join(directory, "generated", file), `-- ${file}\n`);
  writeFileSync(join(directory, "baselines/alpha35.sql"), "-- release schema\n");
  const identity = (filename) => ({ filename, sha256: baselineDigest(filename) });
  const upgradeFrom = [identity("baselines/alpha29.sql"), identity("generated/0482_prior.sql")];
  const baseline = {
    format: 2,
    verified: true,
    filename: "baselines/alpha35.sql",
    baselineSha256: baselineDigest("-- release schema\n"),
    catalogSha256: baselineDigest("catalog"),
    upgradeFromRelease: "v0.1.0-alpha.34.3",
    upgradeFrom,
    covered: [
      identity("generated/0001_baseline.sql"),
      identity("generated/0251_payment_link_token_at_rest.sql"),
      ...upgradeFrom,
    ],
  };
  const publish = () => writeFileSync(join(directory, "baseline.json"), JSON.stringify(baseline));
  return { directory, baseline, files, publish };
}

test("without a release baseline every forward migration is the plan", (context) => {
  const { directory, files } = fixture(context);
  assert.deepEqual(
    releaseMigrationPlan(directory, files).filenames,
    files.map((file) => `generated/${file}`),
  );
});

test("a release applies its baseline and then the forward migrations, none of which need retired source files", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  assert.deepEqual(releaseMigrationPlan(directory, files).filenames, [
    "baselines/alpha35.sql",
    "generated/0001_first.sql",
    "generated/0002_second.sql",
  ]);
  assert.deepEqual(releaseMigrationPlan(directory, []).filenames, ["baselines/alpha35.sql"]);
});

test("a forward migration may not reuse an identity the baseline covers", (context) => {
  const { directory, publish } = fixture(context);
  publish();
  writeFileSync(join(directory, "generated/0001_baseline.sql"), "-- reused name\n");
  assert.throws(
    () => releaseMigrationPlan(directory, ["0001_baseline.sql"]),
    /reuses an identity baselines\/alpha35.sql covers/,
  );
});

test("forward migrations wait for their declared prerequisites without changing their identities", (context) => {
  const { directory, files, publish } = fixture(context);
  const generated = [...files, "0003_authority.sql"];
  writeFileSync(join(directory, "generated/0003_authority.sql"), "-- 0003\n");
  writeFileSync(
    join(directory, "prerequisites.json"),
    JSON.stringify({
      format: 1,
      dependencies: [
        { migration: "generated/0001_first.sql", requires: ["generated/0003_authority.sql"] },
      ],
    }),
  );
  publish();
  assert.deepEqual(releaseMigrationPlan(directory, generated).filenames, [
    "baselines/alpha35.sql",
    "generated/0002_second.sql",
    "generated/0003_authority.sql",
    "generated/0001_first.sql",
  ]);
});

test("missing prerequisites and cycles refuse the release before any migration is applied", (context) => {
  const { directory, files } = fixture(context);
  const publish = (dependencies) =>
    writeFileSync(
      join(directory, "prerequisites.json"),
      JSON.stringify({ format: 1, dependencies }),
    );
  publish([{ migration: "generated/0002_second.sql", requires: ["generated/0003_missing.sql"] }]);
  assert.throws(
    () => releaseMigrationPlan(directory, files),
    /requires missing migration generated\/0003_missing.sql/,
  );
  publish([
    { migration: "generated/0002_second.sql", requires: ["generated/0001_first.sql"] },
    { migration: "generated/0001_first.sql", requires: ["generated/0002_second.sql"] },
  ]);
  assert.throws(() => releaseMigrationPlan(directory, files), /prerequisites contain a cycle/);
});

test("unselected migration prerequisites do not expand a selected release and malformed declarations refuse", (context) => {
  const { directory, files } = fixture(context);
  const publish = (dependencies) =>
    writeFileSync(
      join(directory, "prerequisites.json"),
      JSON.stringify({ format: 1, dependencies }),
    );
  const entry = {
    migration: "generated/0998_unselected.sql",
    requires: ["generated/0999_unselected.sql"],
  };
  publish([entry]);
  assert.deepEqual(
    releaseMigrationPlan(directory, files).filenames,
    files.map((file) => `generated/${file}`),
  );
  for (const invalid of [
    [entry, entry],
    [{ ...entry, requires: [entry.migration] }],
    [{ ...entry, requires: [entry.requires[0], entry.requires[0]] }],
    [{ ...entry, requires: ["../unreviewed.sql"] }],
  ]) {
    publish(invalid);
    assert.throws(
      () => releaseMigrationPlan(directory, files),
      /unique exact migration identities/,
    );
  }
});

test("unverified, incomplete and inconsistent release manifests fail closed", (context) => {
  const { directory, files, baseline, publish } = fixture(context);
  for (const change of [
    (m) => {
      m.verified = false;
    },
    (m) => {
      m.format = 1;
    },
    (m) => {
      delete m.upgradeFromRelease;
    },
    (m) => {
      m.upgradeFrom = [];
    },
    (m) => {
      m.covered = [...m.covered, m.covered[0]];
    },
    (m) => {
      m.covered = [...m.covered, { filename: "../outside.sql", sha256: "0".repeat(64) }];
    },
  ]) {
    const original = structuredClone(baseline);
    change(baseline);
    publish();
    assert.throws(() => releaseMigrationPlan(directory, files), /manifest is malformed/);
    Object.keys(baseline).forEach((key) => delete baseline[key]);
    Object.assign(baseline, original);
  }
  baseline.covered = baseline.covered.filter(
    (entry) => entry.filename !== "generated/0482_prior.sql",
  );
  publish();
  assert.throws(() => releaseMigrationPlan(directory, files), /upgrade ledger must be covered/);
});

test("changed baseline bytes are refused", (context) => {
  const { directory, files, publish } = fixture(context);
  publish();
  writeFileSync(join(directory, "baselines/alpha35.sql"), "-- wrong constraints\n");
  assert.throws(() => releaseMigrationPlan(directory, files), /baseline bytes differ/);
});

test("only an empty database or the exact adopted identity may apply the release", (context) => {
  const { baseline } = fixture(context);
  assert.doesNotThrow(() => assertBaselineHistory(baseline, [], false));
  assert.doesNotThrow(() =>
    assertBaselineHistory(
      baseline,
      [{ filename: baseline.filename, sha256: baseline.baselineSha256 }],
      true,
    ),
  );
  for (const history of [
    [],
    baseline.upgradeFrom,
    [{ filename: "generated/0001_baseline.sql", sha256: baseline.baselineSha256 }],
  ]) {
    assert.throws(
      () => assertBaselineHistory(baseline, history, true),
      /Upgrade it with v0\.1\.0-alpha\.34\.3 first.*adopt-migration-baseline.*No baseline SQL may be replayed over tenant data/,
    );
  }
  assert.throws(
    () =>
      assertBaselineHistory(
        baseline,
        [{ filename: baseline.filename, sha256: "0".repeat(64) }],
        true,
      ),
    /at another digest/,
  );
});

test("adoption requires the previous release's exact ledger", (context) => {
  const { baseline } = fixture(context);
  assert.deepEqual(missingUpgradeLedger(baseline, baseline.upgradeFrom), []);
  assert.deepEqual(
    missingUpgradeLedger(baseline, [
      ...baseline.upgradeFrom,
      { filename: "generated/0001_baseline.sql", sha256: "f".repeat(64) },
    ]),
    [],
  );
  assert.deepEqual(missingUpgradeLedger(baseline, baseline.upgradeFrom.slice(0, 1)), [
    "generated/0482_prior.sql",
  ]);
  assert.deepEqual(
    missingUpgradeLedger(baseline, [
      baseline.upgradeFrom[0],
      { ...baseline.upgradeFrom[1], sha256: "0".repeat(64) },
    ]),
    ["generated/0482_prior.sql"],
  );
  assert.deepEqual(
    missingUpgradeLedger(baseline, []),
    baseline.upgradeFrom.map((entry) => entry.filename),
  );
});

test("catalog equivalence preserves whitespace inside financial refusal messages", () => {
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(
        { functions: [{ definition: "RAISE EXCEPTION 'rate  unavailable'" }] },
        { functions: [{ definition: "RAISE EXCEPTION 'rate unavailable'" }] },
      ),
    /differs in functions/,
  );
});

test("application-side credential sealing still runs when its SQL migration is covered by a baseline", (context) => {
  const { baseline } = fixture(context);
  const filename = "generated/0251_payment_link_token_at_rest.sql";
  baseline.covered.push({ filename, sha256: baselineDigest("seal schema") });
  assert.equal(
    migrationIdentityIsApplied(
      filename,
      [{ filename: baseline.filename, sha256: baseline.baselineSha256 }],
      baseline,
    ),
    true,
  );
  assert.equal(
    migrationIdentityIsApplied(
      filename,
      [{ filename: baseline.filename, sha256: "wrong-digest" }],
      baseline,
    ),
    false,
  );
  assert.equal(migrationIdentityIsApplied(filename, [], baseline), false);
  assert.equal(
    migrationIdentityIsApplied(
      "generated/9999_uncovered.sql",
      [{ filename: baseline.filename, sha256: baseline.baselineSha256 }],
      baseline,
    ),
    false,
  );
  assert.equal(
    migrationIdentityIsApplied(filename, [{ filename, sha256: "historical" }], null),
    true,
  );
});

test("missing security sections, invalid indexes and changed registry rows are refused", () => {
  for (const section of ["policies", "indexes", "openbooks_document_close_modules"]) {
    assert.throws(
      () =>
        assertBaselineCatalogsEqual(
          { [section]: [{ valid: true }] },
          { [section]: [{ valid: false }] },
        ),
      new RegExp(`differs in ${section}`),
    );
  }
  assert.throws(() => assertBaselineCatalogsEqual({ policies: [] }, {}), /differs in policies/);
});

test("optional trigram absence permits only its acceleration indexes to be absent", () => {
  const extension = { name: "pg_trgm", version: "1.6", schema: "public" };
  const index = {
    definition: "CREATE INDEX name_search ON files USING gin (name public.gin_trgm_ops)",
    valid: true,
  };
  const expected = { extensions: [extension], indexes: [index] };
  assert.doesNotThrow(() => assertBaselineCatalogsEqual(expected, { extensions: [], indexes: [] }));
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(expected, {
        extensions: [extension],
        indexes: [{ ...index, valid: false }],
      }),
    /differs in indexes/,
  );
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(
        { extensions: [{ name: "btree_gist", version: "1.7" }], indexes: [] },
        { extensions: [], indexes: [] },
      ),
    /differs in extensions/,
  );
});

test("system seed SQL preserves currency precision and registry identity", () => {
  const sql = baselineRegistrySql({
    currencies: [{ code: "KWD", name: "Kuwait's dinar", minor_units: 3 }],
    platform_settings: [{ id: "platform" }],
    openbooks_query_catalog_relations: [{ relation: "pay_runs", added_in: "0352" }],
    openbooks_document_close_modules: [{ kind: "invoice", close_module: "ar", added_in: "0418" }],
    openbooks_schedule_board_types: [
      { key: "people", row_kind: "people", capabilities: ["bookings"], added_in: "0737" },
    ],
    marketplace_nexus_state_rules: [
      { state: "CA", include_in_threshold: true, needs_review: false, source: "cited" },
    ],
  });
  assert.match(sql, /'KWD', 'Kuwait''s dinar', '3'/);
  assert.match(sql, /platform_settings \(id\)/);
  assert.doesNotMatch(sql, /added_at|ON CONFLICT|settings,/i);
  assert.throws(() => baselineRegistrySql({}), /registry is empty: currencies/);
});

test("system seed SQL writes array columns as PostgreSQL arrays and absent values as NULL", () => {
  const sql = baselineRegistrySql({
    currencies: [{ code: "USD", name: "US dollar", minor_units: 2 }],
    platform_settings: [{ id: "platform" }],
    openbooks_query_catalog_relations: [{ relation: "pay_runs", added_in: "0352" }],
    openbooks_document_close_modules: [{ kind: "invoice", close_module: "ar", added_in: "0418" }],
    openbooks_schedule_board_types: [
      {
        key: "people",
        row_kind: "people",
        capabilities: ["bookings", 'say "hi"'],
        added_in: "0737",
      },
      { key: "tasks", row_kind: "tasks", capabilities: [], added_in: "0737" },
    ],
    marketplace_nexus_state_rules: [
      { state: "CA", include_in_threshold: true, needs_review: false, source: null },
    ],
  });
  assert.match(sql, /\('people', 'people', '\{"bookings","say \\"hi\\""\}', '0737'\)/);
  assert.match(sql, /\('tasks', 'tasks', '\{\}', '0737'\)/);
  assert.match(sql, /\('CA', 'true', 'false', NULL\)/);
});

test("baseline preparation refuses missing and remote resource declarations even with NODE_ENV unset", () => {
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.OPENBOOKS_BASELINE_ADMIN_URL;
  const args = [
    "--import",
    "tsx",
    "scripts/prepare-migration-baseline.mts",
    "--output",
    "/tmp/openbooks-baseline-should-never-be-created",
  ];
  for (const url of [
    undefined,
    "postgres://operator@10.0.0.85/postgres",
    "postgres://operator@127.0.0.1/openbooks",
  ]) {
    if (url) env.OPENBOOKS_BASELINE_ADMIN_URL = url;
    const result = spawnSync(process.execPath, args, { encoding: "utf8", env });
    assert.equal(result.status, 1);
    assert.match(
      result.stderr,
      url ? /remote and tenant databases are refused/ : /set OPENBOOKS_BASELINE_ADMIN_URL/,
    );
  }
});

test("generic query projections ignore physical column order while preserving isolation and curated expressions", () => {
  const row = {
    schema: "openbooks_query",
    name: "entries",
    kind: "v",
    view: " SELECT id,\n    org_id\n   FROM entries\n  WHERE (org_id = openbooks_query_org_id());",
  };
  const reversed = {
    ...row,
    view: " SELECT org_id,\n    id\n   FROM entries\n  WHERE (org_id = openbooks_query_org_id());",
  };
  const registry = [{ relation: "entries" }];
  assert.doesNotThrow(() =>
    assertBaselineCatalogsEqual(
      { relations: [row], openbooks_query_catalog_relations: registry },
      { relations: [reversed], openbooks_query_catalog_relations: registry },
    ),
  );
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(
        { relations: [row], openbooks_query_catalog_relations: registry },
        {
          relations: [
            {
              ...reversed,
              view: reversed.view.replace("org_id = openbooks_query_org_id()", "true"),
            },
          ],
          openbooks_query_catalog_relations: registry,
        },
      ),
    /differs in relations/,
  );
  assert.throws(
    () => assertBaselineCatalogsEqual({ relations: [row] }, { relations: [reversed] }),
    /differs in relations/,
  );
});

test("catalog ACL comparison is independent of database collation", () => {
  const grants = [
    { grantee: "PUBLIC", privilege_type: "USAGE" },
    { grantee: "openbooks_read", privilege_type: "USAGE" },
  ];
  assert.doesNotThrow(() =>
    assertBaselineCatalogsEqual({ schema_acl: grants }, { schema_acl: grants.toReversed() }),
  );
  assert.throws(
    () => assertBaselineCatalogsEqual({ schema_acl: grants }, { schema_acl: grants.slice(1) }),
    /differs in schema_acl/,
  );
});

test("public schema usage covers a redundant read-role grant without admitting public writes", () => {
  const usage = {
    schema: "public",
    grantee: "PUBLIC",
    privilege_type: "USAGE",
    is_grantable: false,
  };
  const read = { ...usage, grantee: "openbooks_read" };
  assert.doesNotThrow(() =>
    assertBaselineCatalogsEqual({ schema_acl: [usage, read] }, { schema_acl: [usage] }),
  );
  assert.throws(
    () => assertBaselineCatalogsEqual({ schema_acl: [usage, read] }, { schema_acl: [read] }),
    /differs in schema_acl/,
  );
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(
        { schema_acl: [usage] },
        { schema_acl: [usage, { ...usage, privilege_type: "CREATE" }] },
      ),
    /differs in schema_acl/,
  );
});

test("vendor UUID v4 defaults compare independently of PostgreSQL search-path qualification", () => {
  const extensions = [{ name: "pgcrypto", version: "1.3" }];
  const column = {
    schema: "public",
    relation: "obligations",
    name: "id",
    type: "uuid",
    not_null: true,
    default: "gen_random_uuid()",
  };
  const expected = { extensions, columns: [column] };
  assert.doesNotThrow(() =>
    assertBaselineCatalogsEqual(expected, {
      extensions,
      columns: [{ ...column, default: "pg_catalog.gen_random_uuid()" }],
    }),
  );
  for (const change of [
    { default: "custom.gen_random_uuid()" },
    { default: "uuid_generate_v7()" },
    { default: "pg_catalog.gen_random_uuid()", not_null: false },
  ]) {
    assert.throws(
      () =>
        assertBaselineCatalogsEqual(expected, { extensions, columns: [{ ...column, ...change }] }),
      /differs in columns/,
    );
  }
  assert.throws(
    () =>
      assertBaselineCatalogsEqual(
        { columns: [column] },
        { columns: [{ ...column, default: "pg_catalog.gen_random_uuid()" }] },
      ),
    /differs in columns/,
  );
});
