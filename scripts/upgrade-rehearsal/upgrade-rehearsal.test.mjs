// source-pin-contract: upgrade-rehearsal release-only trigger policy and publish refusal without upgrade-verification (upgrade-rehearsal.yml, publish-container.yml)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compareSnapshots, activeOrgIds, candidateHarnessOrgIds, rowHashQuery } from "./ledger.mjs";
import {
  REMEDY_DIR_PREFIX,
  coverageGaps,
  defaultMatrix,
  loadConfig,
  planMatrix,
  readCandidateBaseline,
  readSourceBaselineAtTag,
  sourceEligibilityProblems,
  sourceUpgradeRefusal,
  validateConfig,
} from "./plan.mjs";
import {
  assertionsFileFor,
  assertionsRefusal,
  classifyHarnessFailures,
  clearPhaseLogSink,
  diffFindingKeys,
  findingKeys,
  harness,
  maskDatabaseUrl,
  phaseLogPath,
  PhaseRefusal,
  preUpgradeDumpName,
  run,
  setPhaseLogSink,
  summarize,
  tailLines,
} from "./rehearse.mjs";

const WORKFLOW = readFileSync(".github/workflows/upgrade-rehearsal.yml", "utf8");
const PUBLISH = readFileSync(".github/workflows/publish-container.yml", "utf8");

test("source harness evidence names its checkout even when CI declares the candidate", async () => {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-upgrade-evidence-"));
  try {
    mkdirSync(join(directory, "engine"));
    writeFileSync(
      join(directory, "engine/package.json"),
      JSON.stringify({ scripts: { harness: "node evidence.mjs" } }),
    );
    const provenance = pathToFileURL(resolve("engine/src/platform/provenance.ts")).href;
    writeFileSync(
      join(directory, "engine/evidence.mjs"),
      `
      import assert from 'node:assert/strict';
      import { execFileSync } from 'node:child_process';
      import { sourceSha } from ${JSON.stringify(provenance)};
      const expected = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      assert.equal(sourceSha(), expected);
    `,
    );
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
    git("init", "--quiet");
    git("add", "engine");
    git(
      "-c",
      "user.name=Upgrade Verification",
      "-c",
      "user.email=verification@example.invalid",
      "commit",
      "--quiet",
      "-m",
      "Source evidence fixture",
    );
    const candidate = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    assert.notEqual(git("rev-parse", "HEAD"), candidate);
    assert.deepEqual(
      await harness("source-harness", directory, ["fixture"], new Set(), {
        GITHUB_SHA: candidate,
        OPENBOOKS_SOURCE_SHA: candidate,
      }),
      [],
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

const CANDIDATE_BASELINE = Object.freeze({
  filename: "baselines/next.sql",
  baselineSha256: "a".repeat(64),
  upgradeFromRelease: "v1.0.0",
});
// Every source tree already records the candidate's baseline identity.
const CARRIES_BASELINE = Object.freeze({
  candidateBaseline: CANDIDATE_BASELINE,
  sourceBaseline: () => ({ filename: "baselines/next.sql", baselineSha256: "a".repeat(64) }),
});

function config(overrides = {}) {
  return {
    sources: [{ tag: "v1.0.0" }, { tag: "v1.1.0" }],
    requiredDatasetClasses: ["empty", "small"],
    datasets: [
      { id: "empty", class: "empty", steps: [] },
      {
        id: "small",
        class: "small",
        steps: [
          {
            kind: "sim",
            mode: "run",
            profile: "saas",
            seed: "1",
            start: "2026-01-01",
            end: "2026-03-31",
          },
        ],
      },
    ],
    ...overrides,
  };
}

test("the committed rehearsal config is well-formed", () => {
  // Class COVERAGE is enforced where it matters: the release-time plan refuses
  // on any gap (below). A class still being built must not turn every
  // ordinary commit red.
  assert.deepEqual(validateConfig(loadConfig()), []);
});

test("the committed matrix rehearses exactly the release the candidate baseline upgrades from", () => {
  const { upgradeFromRelease } = readCandidateBaseline();
  const committed = loadConfig();
  assert.deepEqual(
    committed.sources.map((source) => source.tag),
    [upgradeFromRelease],
  );
  assert.deepEqual(
    planMatrix(committed).include,
    committed.datasets.map((dataset) => ({ source: upgradeFromRelease, dataset: dataset.id })),
  );
  assert.deepEqual(defaultMatrix(committed).include, [
    { source: upgradeFromRelease, dataset: "multi-entity" },
  ]);
});

test("the matrix is one cell per source release and dataset", () => {
  assert.deepEqual(planMatrix(config(), CARRIES_BASELINE).include, [
    { source: "v1.0.0", dataset: "empty" },
    { source: "v1.0.0", dataset: "small" },
    { source: "v1.1.0", dataset: "empty" },
    { source: "v1.1.0", dataset: "small" },
  ]);
});

test("the release default is oldest plus latest source on the gate datasets", () => {
  const declared = {
    ...loadConfig(),
    sources: [{ tag: "v1.0.0" }, { tag: "v1.1.0" }, { tag: "v1.2.0" }],
  };
  assert.deepEqual(defaultMatrix(declared, CARRIES_BASELINE).include, [
    { source: "v1.0.0", dataset: "multi-entity" },
    { source: "v1.2.0", dataset: "multi-entity" },
  ]);
  assert.equal(
    planMatrix(declared, CARRIES_BASELINE).include.length,
    declared.sources.length * declared.datasets.length,
  );
});

test("the release default refuses an unknown dataset and dedupes one source", () => {
  const unknown = config();
  unknown.defaultGate = { datasets: ["no-such-dataset"] };
  assert.throws(() => defaultMatrix(unknown), /unknown dataset/);
  const single = config({
    sources: [{ tag: "v1.0.0" }],
    requiredDatasetClasses: ["empty", "small", "multi-entity"],
  });
  single.datasets.push({ id: "multi-entity", class: "multi-entity", steps: [{ kind: "samples" }] });
  single.defaultGate = { datasets: ["multi-entity"] };
  assert.deepEqual(defaultMatrix(single, CARRIES_BASELINE).include, [
    { source: "v1.0.0", dataset: "multi-entity" },
  ]);
});

test("the release default refuses a vacuous gate", () => {
  const emptyOnly = config();
  emptyOnly.defaultGate = { datasets: ["empty"] };
  assert.throws(() => defaultMatrix(emptyOnly), /multi-entity-class/);
  const dupe = config({ requiredDatasetClasses: ["empty", "small", "multi-entity"] });
  dupe.datasets.push({ id: "multi-entity", class: "multi-entity", steps: [{ kind: "samples" }] });
  dupe.defaultGate = { datasets: ["multi-entity", "multi-entity"] };
  assert.throws(() => defaultMatrix(dupe), /twice/);
});

test("the release plan refuses a required dataset class with no dataset, by name", () => {
  assert.deepEqual(
    coverageGaps(config({ requiredDatasetClasses: ["empty", "small", "perf-1m"] })),
    ['required dataset class "perf-1m" has no dataset'],
  );
  assert.throws(
    () => planMatrix(config({ requiredDatasetClasses: ["empty", "small", "perf-1m"] })),
    /perf-1m/,
  );
});

test("malformed sources, unknown step kinds, and empty non-empty datasets are refused", () => {
  assert.ok(validateConfig(config({ sources: [] })).some((p) => p.includes("no source releases")));
  assert.ok(
    validateConfig(config({ sources: [{ tag: "main" }] })).some((p) =>
      p.includes("not a release tag"),
    ),
  );
  const unknownKind = config();
  unknownKind.datasets[1].steps = [{ kind: "raw-sql" }];
  assert.ok(validateConfig(unknownKind).some((p) => p.includes("unknown step kind")));
  const hollow = config();
  hollow.datasets[1].steps = [];
  assert.ok(
    validateConfig(hollow).some((p) => p.includes("only the empty class may have no steps")),
  );
  const backwards = config();
  backwards.datasets[1].steps[0].start = "2026-04-01";
  assert.ok(validateConfig(backwards).some((p) => p.includes("starts after it ends")));
});

test("a source upgrades only as the baseline's previous release or by already recording that baseline", () => {
  const same = { filename: "baselines/next.sql", baselineSha256: "a".repeat(64) };
  assert.equal(sourceUpgradeRefusal("v1.0.0", CANDIDATE_BASELINE, null), null);
  assert.equal(sourceUpgradeRefusal("v1.1.0", CANDIDATE_BASELINE, same), null);
  assert.match(
    sourceUpgradeRefusal("v0.9.0", CANDIDATE_BASELINE, null),
    /v0\.9\.0 cannot upgrade .*records no release baseline.*upgrade to v1\.0\.0 first/,
  );
  assert.match(
    sourceUpgradeRefusal("v0.9.0", CANDIDATE_BASELINE, {
      filename: "baselines/older.sql",
      baselineSha256: "c".repeat(64),
    }),
    /records baselines\/older\.sql at cccccccccccc rather than baselines\/next\.sql/,
  );
  assert.match(
    sourceUpgradeRefusal("v1.1.0", CANDIDATE_BASELINE, { ...same, baselineSha256: "b".repeat(64) }),
    /cannot upgrade/,
  );
  assert.match(
    sourceUpgradeRefusal(undefined, CANDIDATE_BASELINE, null),
    /\(untagged\) cannot upgrade/,
  );
  // An unknown candidate identity refuses even the previous release's tag.
  for (const candidate of [
    null,
    { ...CANDIDATE_BASELINE, upgradeFromRelease: undefined },
    { ...CANDIDATE_BASELINE, baselineSha256: "" },
  ]) {
    assert.match(
      sourceUpgradeRefusal("v1.0.0", candidate, same),
      /no usable release baseline manifest/,
    );
  }
});

test("the plan refuses an ineligible source, a missing previous release, and an unreadable tag by name", () => {
  const unreadable = () => {
    throw new Error("release tag v1.1.0 is not available in this checkout");
  };
  assert.throws(
    () =>
      planMatrix(config({ sources: [{ tag: "v1.0.0" }, { tag: "v0.9.0" }] }), {
        candidateBaseline: CANDIDATE_BASELINE,
        sourceBaseline: () => null,
      }),
    /v0\.9\.0 cannot upgrade/,
  );
  assert.throws(
    () =>
      defaultMatrix(
        { ...loadConfig(), sources: [{ tag: "v0.9.0" }] },
        { candidateBaseline: CANDIDATE_BASELINE, sourceBaseline: () => null },
      ),
    /sources must include v1\.0\.0/,
  );
  assert.deepEqual(
    sourceEligibilityProblems(config({ sources: [{ tag: "v1.1.0" }] }), CARRIES_BASELINE),
    [
      "sources must include v1.0.0: existing installations adopt baselines/next.sql from it, and the gate must rehearse that path",
    ],
  );
  assert.deepEqual(
    sourceEligibilityProblems(config(), {
      candidateBaseline: CANDIDATE_BASELINE,
      sourceBaseline: unreadable,
    }),
    ["source v1.1.0: release tag v1.1.0 is not available in this checkout"],
  );
  // The previous release qualifies by tag; its tree is never read.
  assert.deepEqual(
    sourceEligibilityProblems(config({ sources: [{ tag: "v1.0.0" }] }), {
      candidateBaseline: CANDIDATE_BASELINE,
      sourceBaseline: unreadable,
    }),
    [],
  );
  assert.deepEqual(
    sourceEligibilityProblems(config(), { candidateBaseline: null, sourceBaseline: unreadable })
      .length,
    1,
  );
});

test("a source tag's baseline identity is read from its tree, and an unresolvable tag refuses", () => {
  const directory = mkdtempSync(join(tmpdir(), "openbooks-upgrade-source-"));
  try {
    const git = (...args) =>
      execFileSync("git", ["-C", directory, ...args], { stdio: "pipe", encoding: "utf8" }).trim();
    const commit = (message) =>
      git(
        "-c",
        "user.name=Upgrade Verification",
        "-c",
        "user.email=verification@example.invalid",
        "commit",
        "--quiet",
        "-m",
        message,
      );
    git("init", "--quiet");
    writeFileSync(join(directory, "README.md"), "source\n");
    git("add", "README.md");
    commit("Release without a baseline");
    git("tag", "v1.0.0");
    mkdirSync(join(directory, "schema/migrations"), { recursive: true });
    writeFileSync(
      join(directory, "schema/migrations/baseline.json"),
      JSON.stringify({ filename: "baselines/next.sql", baselineSha256: "a".repeat(64) }),
    );
    git("add", "schema");
    commit("Release carrying the baseline");
    git("tag", "v1.1.0");
    assert.equal(readSourceBaselineAtTag("v1.0.0", directory), null);
    assert.deepEqual(readSourceBaselineAtTag("v1.1.0", directory), {
      filename: "baselines/next.sql",
      baselineSha256: "a".repeat(64),
    });
    assert.throws(
      () => readSourceBaselineAtTag("v9.9.9", directory),
      /v9\.9\.9 is not available in this checkout; fetch release tags/,
    );
    assert.equal(
      sourceUpgradeRefusal(
        "v1.1.0",
        CANDIDATE_BASELINE,
        readSourceBaselineAtTag("v1.1.0", directory),
      ),
      null,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

function snapshot(overrides = {}) {
  return {
    counts: { journal_lines: 4, documents: 2, applications: 1, stock_counts: null },
    orgs: ["o1"],
    entryStatus: [{ org_id: "o1", status: "posted", entries: "2" }],
    trialBalance: [
      {
        org_id: "o1",
        book_id: "b",
        status: "posted",
        subsidiary_id: "s",
        account_id: "a1",
        currency: "USD",
        lines: "2",
        amount: "100.0000",
        txn_amount: "100.0000",
      },
      {
        org_id: "o1",
        book_id: "b",
        status: "posted",
        subsidiary_id: "s",
        account_id: "a2",
        currency: "USD",
        lines: "2",
        amount: "-100.0000",
        txn_amount: "-100.0000",
      },
    ],
    unbalancedEntries: [],
    documents: [
      {
        org_id: "o1",
        kind: "customer_invoice",
        status: "posted",
        currency: "USD",
        documents: "2",
        total: "100.0000",
        open_balance: "40.0000",
      },
    ],
    applications: [{ org_id: "o1", applications: "1", amount: "60.0000" }],
    ...overrides,
  };
}

test("identical fingerprints compare clean", () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), []);
});

test("a moved trial balance, open balance, or lost row is a named difference", () => {
  const after = snapshot();
  after.trialBalance = after.trialBalance.map((row) =>
    row.account_id === "a1" ? { ...row, amount: "99.9900" } : row,
  );
  after.documents = [{ ...after.documents[0], open_balance: "0.0000" }];
  after.counts = { ...after.counts, journal_lines: 3 };
  const sections = compareSnapshots(snapshot(), after)
    .map((difference) => difference.section)
    .sort();
  assert.deepEqual(sections, ["counts", "documents", "trialBalance"]);
});

test("a table the source release did not have may appear; one it had may not vanish", () => {
  const after = snapshot();
  after.counts = { ...after.counts, stock_counts: 7 };
  assert.deepEqual(compareSnapshots(snapshot(), after), []);
  const gone = snapshot();
  gone.counts = { ...gone.counts, applications: null };
  assert.deepEqual(
    compareSnapshots(snapshot(), gone).map((d) => d.key),
    ["applications"],
  );
});

test("an unbalanced posted entry is refused on either side of the upgrade", () => {
  const broken = snapshot({
    unbalancedEntries: [{ org_id: "o1", entry_id: "e9", residual: "0.0100" }],
  });
  assert.deepEqual(
    compareSnapshots(broken, snapshot()).map((d) => d.section),
    ["unbalanced-before"],
  );
  assert.deepEqual(
    compareSnapshots(snapshot(), broken).map((d) => d.section),
    ["unbalanced-after"],
  );
});

test("the candidate harness runs on every seeded org, even one that never posted", () => {
  assert.deepEqual(activeOrgIds(snapshot()), ["o1"]);
  // o2 was seeded with drafts and configuration only, so it has no posted line.
  assert.deepEqual(candidateHarnessOrgIds(["o2"], snapshot()), ["o1", "o2"]);
  assert.deepEqual(candidateHarnessOrgIds([], snapshot()), ["o1"]);
});

test("the summary names a refusal, the adopted baseline, and each slow migration with its recorded digest", () => {
  const text = summarize({
    source: "v1.0.0",
    candidate: "deadbeef",
    dataset: "small",
    ok: false,
    error: "[ledger-parity] 1 ledger difference(s) across the upgrade",
    phases: [{ name: "ledger-parity", ok: false, seconds: 1 }],
    baselineAdoption: { filename: "baselines/next.sql", sha256: "a".repeat(64) },
    upgrade: {
      seconds: 12,
      migrations: [
        { filename: "generated/0001_x.sql", sha256: "0123456789abcdef", seconds: 9 },
        { filename: "generated/0002_y.sql", sha256: null, seconds: 2 },
      ],
    },
    refusals: [{ section: "trialBalance", key: "o1" }],
  });
  assert.match(text, /candidate: `deadbeef`/);
  assert.match(text, /REFUSED:\*\* \[ledger-parity\]/);
  assert.match(text, /Adopted release baseline baselines\/next\.sql \(sha256 aaaaaaaa\)/);
  assert.match(text, /\| generated\/0001_x\.sql \| 01234567 \| 9 \|/);
  // A migration the ledger did not record never borrows a digest.
  assert.match(text, /\| generated\/0002_y\.sql \| unrecorded \| 2 \|/);
  assert.match(
    summarize({
      source: "v1.0.0",
      dataset: "empty",
      ok: true,
      phases: [],
      upgrade: { seconds: 1, migrations: [] },
      refusals: [],
    }),
    /Upgrade applied no migrations in 1s/,
  );
});

test("the rehearsal starts only on explicit dispatch without candidate branches", () => {
  const triggers = WORKFLOW.slice(WORKFLOW.indexOf("\non:"), WORKFLOW.indexOf("\npermissions:"));
  assert.doesNotMatch(
    triggers,
    /(?:push|pull_request|schedule|merge_group|workflow_run|branches):/,
  );
  assert.match(triggers, /workflow_dispatch:/);
});

test("finding keys compare as a multiset, so a duplicate refusal is not hidden", () => {
  const actual = findingKeys([
    { severity: "refuse", code: "0001.bad_a" },
    { severity: "notice", code: "0002.note_b" },
    { severity: "refuse", code: "0001.bad_a" },
  ]);
  assert.deepEqual(actual, ["notice:0002.note_b", "refuse:0001.bad_a", "refuse:0001.bad_a"]);
  assert.deepEqual(
    diffFindingKeys(actual, ["refuse:0001.bad_a", "notice:0002.note_b", "refuse:0001.bad_a"]),
    {
      missing: [],
      extra: [],
    },
  );
  assert.deepEqual(
    diffFindingKeys(["refuse:0001.bad_a"], ["refuse:0001.bad_a", "refuse:0001.missing"]),
    {
      missing: ["refuse:0001.missing"],
      extra: [],
    },
  );
  assert.deepEqual(
    diffFindingKeys(["refuse:0001.bad_a", "refuse:0001.surprise"], ["refuse:0001.bad_a"]),
    {
      missing: [],
      extra: ["refuse:0001.surprise"],
    },
  );
});

function refusalDataset(overrides = {}) {
  return {
    id: "edge-probe",
    class: "edge",
    steps: [{ kind: "seeder", name: "probe-shapes" }],
    expectFindings: [{ code: "0001.bad_a", severity: "refuse" }],
    remedies: [
      {
        kind: "remedy",
        code: "0001.bad_a",
        sql: `${REMEDY_DIR_PREFIX}0001.bad_a.sql`,
      },
    ],
    ...overrides,
  };
}

function refusalConfig(datasets) {
  return {
    sources: [{ tag: "v1.0.0" }],
    requiredDatasetClasses: ["edge"],
    datasets,
  };
}

test("a closed expectFindings/remedies loop validates", () => {
  assert.deepEqual(validateConfig(refusalConfig([refusalDataset()])), []);
});

test("a dataset declaring assertions needs its assertions file, and the flag is boolean", () => {
  const missing = refusalDataset({ id: "no-such-dataset", assertions: true });
  assert.ok(
    validateConfig(refusalConfig([missing])).some((problem) =>
      problem.includes("declares assertions but"),
    ),
  );
  const malformed = refusalDataset({ assertions: "yes" });
  assert.ok(
    validateConfig(refusalConfig([malformed])).some((problem) =>
      problem.includes("assertions must be true or absent"),
    ),
  );
});

test("a remedy outside the remedies directory is refused (no private remedies)", () => {
  for (const sql of [
    "scripts/upgrade-rehearsal/remediations/edge-probe.sql",
    "schema/migrations/preflight/remedies/../0001.bad_a.sql",
    "schema/migrations/preflight/remedies/notes.txt",
    "schema/migrations/preflight/remedies/.sql",
  ]) {
    const dataset = refusalDataset({ remedies: [{ kind: "remedy", code: "0001.bad_a", sql }] });
    assert.ok(
      validateConfig(refusalConfig([dataset])).some((problem) =>
        problem.includes("remedy sql must be a file under"),
      ),
      sql,
    );
  }
});

test("a remedy whose code matches neither its file nor an expected refuse is refused", () => {
  const wrongFile = refusalDataset({
    remedies: [{ kind: "remedy", code: "0001.bad_a", sql: `${REMEDY_DIR_PREFIX}0001.other.sql` }],
  });
  assert.ok(
    validateConfig(refusalConfig([wrongFile])).some((problem) =>
      problem.includes("does not match its file"),
    ),
  );
  const unmatched = refusalDataset({
    remedies: [
      { kind: "remedy", code: "0001.unexpected", sql: `${REMEDY_DIR_PREFIX}0001.unexpected.sql` },
    ],
  });
  assert.ok(
    validateConfig(refusalConfig([unmatched])).some((problem) =>
      problem.includes("matches no expected refuse"),
    ),
  );
});

test("an expected refuse with no remedy, and remedies with no expectations, are refused", () => {
  const noRemedy = refusalDataset({ remedies: [] });
  assert.ok(
    validateConfig(refusalConfig([noRemedy])).some((problem) => problem.includes("has no remedy")),
  );
  const noExpectations = refusalDataset({
    expectFindings: [],
    remedies: refusalDataset().remedies,
  });
  assert.ok(
    validateConfig(refusalConfig([noExpectations])).some((problem) =>
      problem.includes("without expectFindings"),
    ),
  );
});

test("malformed expectFindings and a remedy hiding in steps are refused", () => {
  const badCode = refusalDataset({
    expectFindings: [{ code: "oops", severity: "refuse" }],
    remedies: [],
  });
  assert.ok(
    validateConfig(refusalConfig([badCode])).some((problem) => problem.includes("must look like")),
  );
  const badSeverity = refusalDataset({
    expectFindings: [{ code: "0001.bad_a", severity: "warn" }],
    remedies: [],
  });
  assert.ok(
    validateConfig(refusalConfig([badSeverity])).some((problem) =>
      problem.includes("severity must be"),
    ),
  );
  const hidden = refusalDataset({ steps: [refusalDataset().remedies[0]], remedies: [] });
  assert.ok(
    validateConfig(refusalConfig([hidden])).some((problem) =>
      problem.includes("belong in the remedies array"),
    ),
  );
});

test("the summary lists unexpected preflight notices by code", () => {
  const text = summarize({
    source: "v1.0.0",
    candidate: "abc",
    dataset: "edge",
    ok: true,
    phases: [{ name: "preflight", ok: true, seconds: 1 }],
    upgrade: null,
    preflight: { expected: false, notices: [{ code: "0002.old_rule" }, { code: "0002.old_rule" }] },
    refusals: [],
  });
  assert.match(text, /Preflight notices.*0002\.old_rule/);
});

test("publish refuses a release whose exact commit has no passing upgrade-verification job", () => {
  const verify = PUBLISH.slice(
    PUBLISH.indexOf("Require a passing upgrade rehearsal"),
    PUBLISH.indexOf("Verify deployment workflow contracts"),
  );
  assert.match(verify, /head_sha=\$\{SOURCE_COMMIT\}&status=success/);
  assert.match(verify, /select\(\.name == "upgrade-rehearsal"\)/);
  assert.match(verify, /select\(\.name == "upgrade-verification"\)/);
  assert.match(verify, /exit 1/);
  assert.match(WORKFLOW, /\n {2}upgrade-verification:\n/);
});

test("row hashes cover every source column, quote identifiers, and refuse unexpected names", () => {
  const query = rowHashQuery("public", "documents", ["id", "org_id", "party_id"]);
  assert.match(query, /md5\(row\(t\."id", t\."org_id", t\."party_id"\)::text\)/);
  assert.match(query, /from "public"\."documents" t/);
  assert.throws(
    () => rowHashQuery("public", "documents", ['id"; drop table x; --']),
    /unexpected identifier/,
  );
});

test("a per-record hash difference is refused even when every aggregate matches", () => {
  const before = snapshot({
    rowHashes: {
      documents: {
        columns: ["id"],
        dropped: [],
        perOrg: [{ org_id: "o1", rows: "2", hash: "10" }],
      },
    },
  });
  const after = snapshot({
    rowHashes: {
      documents: {
        columns: ["id"],
        dropped: [],
        perOrg: [{ org_id: "o1", rows: "2", hash: "11" }],
      },
    },
  });
  assert.deepEqual(
    compareSnapshots(before, after).map((d) => d.section),
    ["rowHashes.documents"],
  );
});

test("only harness checks a source release declares broken may fail at the source", () => {
  const out = [
    "  PASS  per-entry-balance      0 unbalanced",
    "  FAIL  open-balance-fresh     3 closed-period documents have stale open_balance (want 0)",
    "  FAIL  subledger-tieout       residual 12.00",
  ].join("\n");
  assert.deepEqual(classifyHarnessFailures(out, new Set(["open-balance-fresh"])), {
    failed: ["open-balance-fresh", "subledger-tieout"],
    unexpected: ["subledger-tieout"],
  });
  assert.deepEqual(
    classifyHarnessFailures(out, new Set(["open-balance-fresh", "subledger-tieout"])).unexpected,
    [],
  );
});

test("the assertions file lives per dataset under assertions/", () => {
  assert.ok(assertionsFileFor("edge").endsWith("scripts/upgrade-rehearsal/assertions/edge.mjs"));
  assert.ok(assertionsFileFor("edge-probe").endsWith("assertions/edge-probe.mjs"));
});

test("a clean assertions result passes, naming nothing", () => {
  assert.equal(
    assertionsRefusal("edge", { assertions: [{ name: "artifact-frozen-or-refused", ok: true }] }),
    null,
  );
});

test("a failed post-upgrade assertion refuses by check name", () => {
  const refusal = assertionsRefusal("edge", {
    assertions: [
      { name: "artifact-frozen-or-refused", ok: true },
      { name: "unbound-schedule-paused", ok: false, detail: "no notice row" },
    ],
  });
  assert.match(refusal, /edge.*unbound-schedule-paused/);
  assert.doesNotMatch(refusal, /artifact-frozen-or-refused/);
});

test("a result that declares no checks refuses instead of reading green", () => {
  for (const result of [{ assertions: [] }, {}, null, { assertions: [{ name: "x", ok: 1 }] }]) {
    assert.match(assertionsRefusal("edge", result) ?? "", /edge/, JSON.stringify(result));
  }
});

test("the pre-upgrade dump name carries source, candidate, and stamp, and a hostile tag cannot escape the report dir", () => {
  assert.equal(
    preUpgradeDumpName("v1.0.0", "deadbeef", "2026-01-01T00-00-00"),
    "pre-v1.0.0-deadbeef-2026-01-01T00-00-00.dump",
  );
  const hostile = preUpgradeDumpName("refs/tags/v1 ../../x", "abc", "s");
  assert.equal(hostile, "pre-refs_tags_v1_.._.._x-abc-s.dump");
  assert.doesNotMatch(hostile, /[/\s]/);
  assert.equal(preUpgradeDumpName("", null, ""), "pre-untagged-candidate-nostamp.dump");
});

test("tailLines keeps the last lines for a refusal message", () => {
  assert.equal(tailLines("a\nb\nc\n", 2), "b\nc");
  assert.equal(tailLines("", 20), "");
  assert.equal(tailLines("only", 20), "only");
});

test("phase logs live per phase and stream under the report dir, and hostile names are refused", () => {
  assert.ok(phaseLogPath("/tmp/r", "upgrade", "stderr").endsWith("upgrade.stderr.log"));
  assert.ok(phaseLogPath("/tmp/r", "upgrade", "stdout").endsWith("upgrade.stdout.log"));
  assert.throws(() => phaseLogPath("/tmp/r", "../escape", "stdout"), /unsafe phase/);
  assert.throws(() => phaseLogPath("/tmp/r", "upgrade", "stdin"), /unknown log stream/);
});

test("a phase refusal carries its stderr as cause so the report can name the installer error", () => {
  const refusal = new PhaseRefusal(
    "upgrade",
    "bootstrap exited 1",
    { stdout: "", stderr: "line1\nline2" },
    { cause: "line1\nline2" },
  );
  assert.equal(refusal.phase, "upgrade");
  assert.match(refusal.message, /\[upgrade\]/);
  assert.equal(refusal.cause, "line1\nline2");
  assert.equal(refusal.details.stderr, "line1\nline2");
});

test("run() captures a failing child's stderr into details and cause", async () => {
  await assert.rejects(
    run("probe-test", process.execPath, [
      "-e",
      "console.error('installer says no'); process.exit(1)",
    ]),
    (error) => {
      assert.match(error.message, /installer says no/);
      assert.match(error.details.stderr, /installer says no/);
      assert.match(String(error.cause ?? ""), /installer says no/);
      return true;
    },
  );
});

test("run() still resolves stdout on success", async () => {
  const out = await run("probe-test", process.execPath, ["-e", "console.log('hello')"]);
  assert.match(out, /hello/);
});

test("database credentials never reach phase logs or refusal messages", () => {
  assert.equal(
    maskDatabaseUrl("postgres://openbooks:s3cret@127.0.0.1:5439/openbooks_upgrade_test"),
    "postgres://***@127.0.0.1:5439/openbooks_upgrade_test",
  );
  assert.equal(
    maskDatabaseUrl("postgres://openbooks@127.0.0.1:5439/db"),
    "postgres://openbooks@127.0.0.1:5439/db",
  );
  assert.equal(maskDatabaseUrl("redis://127.0.0.1:6391/0"), "redis://127.0.0.1:6391/0");
  assert.equal(maskDatabaseUrl("--dataset"), "--dataset");
});

test("a phase evidence log failure refuses at child close", async () => {
  setPhaseLogSink("/tmp/definitely-missing-dir-ug-probe", "probe-test");
  try {
    await assert.rejects(
      run("probe-test", process.execPath, ["-e", "process.exit(0)"]),
      (error) => {
        assert.match(error.message, /phase evidence log failed/);
        return true;
      },
    );
  } finally {
    clearPhaseLogSink();
  }
});

test("a declared source harness defect must name its check and say why the tagged check is wrong", () => {
  const vague = config({
    sources: [
      { tag: "v1.0.0", knownHarnessDefects: [{ check: "open-balance-fresh", reason: "flaky" }] },
    ],
  });
  assert.ok(validateConfig(vague).some((p) => p.includes("needs a reason")));
  const unnamed = config({
    sources: [{ tag: "v1.0.0", knownHarnessDefects: [{ reason: "x".repeat(60) }] }],
  });
  assert.ok(validateConfig(unnamed).some((p) => p.includes("needs its check name")));
});
