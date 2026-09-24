// source-pin-contract: upgrade-rehearsal release-only trigger policy and publish refusal without upgrade-verification (upgrade-rehearsal.yml, publish-container.yml)
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareSnapshots, activeOrgIds, candidateHarnessOrgIds, rowHashQuery } from "./ledger.mjs";
import { REMEDY_DIR_PREFIX, coverageGaps, loadConfig, planMatrix, validateConfig } from "./plan.mjs";
import { assertionsFileFor, assertionsRefusal, classifyHarnessFailures, diffFindingKeys, findingKeys, summarize, watchListDigests, WATCH_LIST_MIGRATIONS } from "./rehearse.mjs";

const WORKFLOW = readFileSync(".github/workflows/upgrade-rehearsal.yml", "utf8");
const PUBLISH = readFileSync(".github/workflows/publish-container.yml", "utf8");

function config(overrides = {}) {
  return {
    sources: [{ tag: "v0.1.0-alpha.22" }, { tag: "v0.1.0-alpha.23" }],
    requiredDatasetClasses: ["empty", "small"],
    datasets: [
      { id: "empty", class: "empty", steps: [] },
      {
        id: "small",
        class: "small",
        steps: [{ kind: "sim", mode: "run", profile: "saas", seed: "1", start: "2026-01-01", end: "2026-03-31" }],
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

test("the matrix is one cell per source release and dataset", () => {
  assert.deepEqual(planMatrix(config()).include, [
    { source: "v0.1.0-alpha.22", dataset: "empty" },
    { source: "v0.1.0-alpha.22", dataset: "small" },
    { source: "v0.1.0-alpha.23", dataset: "empty" },
    { source: "v0.1.0-alpha.23", dataset: "small" },
  ]);
});

test("the release plan refuses a required dataset class with no dataset, by name", () => {
  assert.deepEqual(coverageGaps(config({ requiredDatasetClasses: ["empty", "small", "perf-1m"] })), [
    'required dataset class "perf-1m" has no dataset',
  ]);
  assert.throws(() => planMatrix(config({ requiredDatasetClasses: ["empty", "small", "perf-1m"] })), /perf-1m/);
});

test("malformed sources, unknown step kinds, and empty non-empty datasets are refused", () => {
  assert.ok(validateConfig(config({ sources: [] })).some((p) => p.includes("no source releases")));
  assert.ok(validateConfig(config({ sources: [{ tag: "main" }] })).some((p) => p.includes("not a release tag")));
  const unknownKind = config();
  unknownKind.datasets[1].steps = [{ kind: "raw-sql" }];
  assert.ok(validateConfig(unknownKind).some((p) => p.includes("unknown step kind")));
  const hollow = config();
  hollow.datasets[1].steps = [];
  assert.ok(validateConfig(hollow).some((p) => p.includes("only the empty class may have no steps")));
  const backwards = config();
  backwards.datasets[1].steps[0].start = "2026-04-01";
  assert.ok(validateConfig(backwards).some((p) => p.includes("starts after it ends")));
});

function snapshot(overrides = {}) {
  return {
    counts: { journal_lines: 4, documents: 2, applications: 1, stock_counts: null },
    orgs: ["o1"],
    entryStatus: [{ org_id: "o1", status: "posted", entries: "2" }],
    trialBalance: [
      { org_id: "o1", book_id: "b", status: "posted", subsidiary_id: "s", account_id: "a1", currency: "USD", lines: "2", amount: "100.0000", txn_amount: "100.0000" },
      { org_id: "o1", book_id: "b", status: "posted", subsidiary_id: "s", account_id: "a2", currency: "USD", lines: "2", amount: "-100.0000", txn_amount: "-100.0000" },
    ],
    unbalancedEntries: [],
    documents: [{ org_id: "o1", kind: "customer_invoice", status: "posted", currency: "USD", documents: "2", total: "100.0000", open_balance: "40.0000" }],
    applications: [{ org_id: "o1", applications: "1", amount: "60.0000" }],
    ...overrides,
  };
}

test("identical fingerprints compare clean", () => {
  assert.deepEqual(compareSnapshots(snapshot(), snapshot()), []);
});

test("a moved trial balance, open balance, or lost row is a named difference", () => {
  const after = snapshot();
  after.trialBalance = after.trialBalance.map((row) => (row.account_id === "a1" ? { ...row, amount: "99.9900" } : row));
  after.documents = [{ ...after.documents[0], open_balance: "0.0000" }];
  after.counts = { ...after.counts, journal_lines: 3 };
  const sections = compareSnapshots(snapshot(), after).map((difference) => difference.section).sort();
  assert.deepEqual(sections, ["counts", "documents", "trialBalance"]);
});

test("a table the source release did not have may appear; one it had may not vanish", () => {
  const after = snapshot();
  after.counts = { ...after.counts, stock_counts: 7 };
  assert.deepEqual(compareSnapshots(snapshot(), after), []);
  const gone = snapshot();
  gone.counts = { ...gone.counts, applications: null };
  assert.deepEqual(compareSnapshots(snapshot(), gone).map((d) => d.key), ["applications"]);
});

test("an unbalanced posted entry is refused on either side of the upgrade", () => {
  const broken = snapshot({ unbalancedEntries: [{ org_id: "o1", entry_id: "e9", residual: "0.0100" }] });
  assert.deepEqual(compareSnapshots(broken, snapshot()).map((d) => d.section), ["unbalanced-before"]);
  assert.deepEqual(compareSnapshots(snapshot(), broken).map((d) => d.section), ["unbalanced-after"]);
});

test("the candidate harness runs on every seeded org, even one that never posted", () => {
  assert.deepEqual(activeOrgIds(snapshot()), ["o1"]);
  // o2 was seeded with drafts and configuration only, so it has no posted line.
  assert.deepEqual(candidateHarnessOrgIds(["o2"], snapshot()), ["o1", "o2"]);
  assert.deepEqual(candidateHarnessOrgIds([], snapshot()), ["o1"]);
});

test("the summary names a refusal and the slowest migrations", () => {
  const text = summarize({
    source: "v0.1.0-alpha.23",
    candidate: "abc",
    dataset: "small",
    ok: false,
    error: "[ledger-parity] 1 ledger difference(s) across the upgrade",
    phases: [{ name: "ledger-parity", ok: false, seconds: 1 }],
    upgrade: { seconds: 12, migrations: [{ filename: "generated/0296_x.sql", seconds: 9 }] },
    refusals: [{ section: "trialBalance", key: "o1" }],
  });
  assert.match(text, /REFUSED:\*\* \[ledger-parity\]/);
  assert.match(text, /generated\/0296_x\.sql \| 9/);
});

test("the rehearsal never runs on ordinary commits (owner directive: release gate only)", () => {
  const triggers = WORKFLOW.slice(WORKFLOW.indexOf("\non:"), WORKFLOW.indexOf("\npermissions:"));
  assert.doesNotMatch(triggers, /pull_request|schedule|merge_group|workflow_run/);
  assert.doesNotMatch(triggers, /branches:\s*\n\s*-\s*"?main"?/);
  assert.deepEqual(
    [...triggers.matchAll(/^\s+-\s+"([^"]+)"$/gm)].map((match) => match[1]),
    ["upgrade-rehearsal/**"],
    "the only push trigger is the release-candidate upgrade-rehearsal/** branch",
  );
});

test("finding keys compare as a multiset, so a duplicate refusal is not hidden", () => {
  const actual = findingKeys([
    { severity: "refuse", code: "0296.bad_a" },
    { severity: "notice", code: "0297.note_b" },
    { severity: "refuse", code: "0296.bad_a" },
  ]);
  assert.deepEqual(actual, ["notice:0297.note_b", "refuse:0296.bad_a", "refuse:0296.bad_a"]);
  assert.deepEqual(diffFindingKeys(actual, ["refuse:0296.bad_a", "notice:0297.note_b", "refuse:0296.bad_a"]), {
    missing: [],
    extra: [],
  });
  assert.deepEqual(diffFindingKeys(["refuse:0296.bad_a"], ["refuse:0296.bad_a", "refuse:0296.missing"]), {
    missing: ["refuse:0296.missing"],
    extra: [],
  });
  assert.deepEqual(diffFindingKeys(["refuse:0296.bad_a", "refuse:0296.surprise"], ["refuse:0296.bad_a"]), {
    missing: [],
    extra: ["refuse:0296.surprise"],
  });
});

function refusalDataset(overrides = {}) {
  return {
    id: "edge-refusals",
    class: "edge",
    steps: [{ kind: "seeder", name: "legacy-shapes" }],
    expectFindings: [{ code: "0296.bad_a", severity: "refuse" }],
    remedies: [
      {
        kind: "remedy",
        code: "0296.bad_a",
        sql: `${REMEDY_DIR_PREFIX}0296.bad_a.sql`,
      },
    ],
    ...overrides,
  };
}

function refusalConfig(datasets) {
  return {
    sources: [{ tag: "v0.1.0-alpha.23" }],
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
    validateConfig(refusalConfig([missing])).some((problem) => problem.includes("declares assertions but")),
  );
  const malformed = refusalDataset({ assertions: "yes" });
  assert.ok(
    validateConfig(refusalConfig([malformed])).some((problem) => problem.includes("assertions must be true or absent")),
  );
  const committed = loadConfig().datasets.find((dataset) => dataset.id === "edge-legacy");
  assert.equal(committed?.assertions, true);
  assert.deepEqual(validateConfig(loadConfig()), []);
});

test("a remedy outside the remedies directory is refused (no private remedies)", () => {
  for (const sql of [
    "scripts/upgrade-rehearsal/remediations/edge-refusals.sql",
    "schema/migrations/preflight/remedies/../0296.bad_a.sql",
    "schema/migrations/preflight/remedies/notes.txt",
    "schema/migrations/preflight/remedies/.sql",
  ]) {
    const dataset = refusalDataset({ remedies: [{ kind: "remedy", code: "0296.bad_a", sql }] });
    assert.ok(
      validateConfig(refusalConfig([dataset])).some((problem) => problem.includes("remedy sql must be a file under")),
      sql,
    );
  }
});

test("a remedy whose code matches neither its file nor an expected refuse is refused", () => {
  const wrongFile = refusalDataset({
    remedies: [{ kind: "remedy", code: "0296.bad_a", sql: `${REMEDY_DIR_PREFIX}0296.other.sql` }],
  });
  assert.ok(
    validateConfig(refusalConfig([wrongFile])).some((problem) => problem.includes("does not match its file")),
  );
  const unmatched = refusalDataset({
    remedies: [{ kind: "remedy", code: "0296.unexpected", sql: `${REMEDY_DIR_PREFIX}0296.unexpected.sql` }],
  });
  assert.ok(
    validateConfig(refusalConfig([unmatched])).some((problem) => problem.includes("matches no expected refuse")),
  );
});

test("an expected refuse with no remedy, and remedies with no expectations, are refused", () => {
  const noRemedy = refusalDataset({ remedies: [] });
  assert.ok(
    validateConfig(refusalConfig([noRemedy])).some((problem) => problem.includes("has no remedy")),
  );
  const noExpectations = refusalDataset({ expectFindings: [], remedies: refusalDataset().remedies });
  assert.ok(
    validateConfig(refusalConfig([noExpectations])).some((problem) => problem.includes("without expectFindings")),
  );
});

test("malformed expectFindings and a remedy hiding in steps are refused", () => {
  const badCode = refusalDataset({ expectFindings: [{ code: "oops", severity: "refuse" }], remedies: [] });
  assert.ok(validateConfig(refusalConfig([badCode])).some((problem) => problem.includes("must look like")));
  const badSeverity = refusalDataset({
    expectFindings: [{ code: "0296.bad_a", severity: "warn" }],
    remedies: [],
  });
  assert.ok(validateConfig(refusalConfig([badSeverity])).some((problem) => problem.includes("severity must be")));
  const hidden = refusalDataset({ steps: [refusalDataset().remedies[0]], remedies: [] });
  assert.ok(
    validateConfig(refusalConfig([hidden])).some((problem) => problem.includes("belong in the remedies array")),
  );
});

test("every summary carries the candidate SHA and the five watch-list digests", () => {
  assert.deepEqual(WATCH_LIST_MIGRATIONS, [
    "0293_stock_count_line_subject_unique",
    "0294_dunning_delivery_state_machine",
    "0296_payroll_remittance_destination_snapshot",
    "0299_stock_count_line_counted_nonnegative",
    "0301_item_price_schedule_versioning",
  ]);
  const digests = watchListDigests();
  assert.equal(digests.length, 5);
  for (const entry of digests) {
    assert.match(entry.digest, /^[0-9a-f]{8}$/, `${entry.name} must resolve to a real digest on this tree, never a placeholder`);
  }
  const text = summarize({
    source: "v0.1.0-alpha.23",
    candidate: "deadbeef",
    dataset: "perf-1m",
    ok: true,
    phases: [{ name: "seed", ok: true, seconds: 1 }],
    upgrade: null,
    refusals: [],
  });
  assert.match(text, /candidate: `deadbeef`/);
  for (const entry of digests) {
    assert.ok(text.includes(`| ${entry.name} | ${entry.digest} |`), `summary must name ${entry.name} with its digest`);
  }
});

test("the summary lists unexpected preflight notices by code", () => {
  const text = summarize({
    source: "v0.1.0-alpha.23",
    candidate: "abc",
    dataset: "edge-legacy",
    ok: true,
    phases: [{ name: "preflight", ok: true, seconds: 1 }],
    upgrade: null,
    preflight: { expected: false, notices: [{ code: "0297.old_rule" }, { code: "0297.old_rule" }] },
    refusals: [],
  });
  assert.match(text, /Preflight notices.*0297\.old_rule/);
});

test("publish refuses a release whose exact commit has no passing upgrade-verification job", () => {
  const verify = PUBLISH.slice(PUBLISH.indexOf("Require a passing upgrade rehearsal"), PUBLISH.indexOf("Refuse to release a commit that is not on main"));
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
  assert.throws(() => rowHashQuery("public", "documents", ['id"; drop table x; --']), /unexpected identifier/);
});

test("a per-record hash difference is refused even when every aggregate matches", () => {
  const before = snapshot({ rowHashes: { documents: { columns: ["id"], dropped: [], perOrg: [{ org_id: "o1", rows: "2", hash: "10" }] } } });
  const after = snapshot({ rowHashes: { documents: { columns: ["id"], dropped: [], perOrg: [{ org_id: "o1", rows: "2", hash: "11" }] } } });
  assert.deepEqual(compareSnapshots(before, after).map((d) => d.section), ["rowHashes.documents"]);
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
  assert.deepEqual(classifyHarnessFailures(out, new Set(["open-balance-fresh", "subledger-tieout"])).unexpected, []);
});

test("the assertions file lives per dataset under assertions/", () => {
  assert.ok(assertionsFileFor("edge-legacy").endsWith("scripts/upgrade-rehearsal/assertions/edge-legacy.mjs"));
  assert.ok(assertionsFileFor("edge-refusals").endsWith("assertions/edge-refusals.mjs"));
});

test("a clean assertions result passes, naming nothing", () => {
  assert.equal(
    assertionsRefusal("edge-legacy", { assertions: [{ name: "waiver-frozen-or-legacy", ok: true }] }),
    null,
  );
});

test("a failed post-upgrade assertion refuses by check name", () => {
  const refusal = assertionsRefusal("edge-legacy", {
    assertions: [
      { name: "waiver-frozen-or-legacy", ok: true },
      { name: "unbound-schedule-paused", ok: false, detail: "no notice row" },
    ],
  });
  assert.match(refusal, /edge-legacy.*unbound-schedule-paused/);
  assert.doesNotMatch(refusal, /waiver-frozen-or-legacy/);
});

test("a result that declares no checks refuses instead of reading green", () => {
  for (const result of [{ assertions: [] }, {}, null, { assertions: [{ name: "x", ok: 1 }] }]) {
    assert.match(assertionsRefusal("edge-legacy", result) ?? "", /edge-legacy/, JSON.stringify(result));
  }
});

test("a declared source harness defect must name its check and say why the tagged check is wrong", () => {
  const vague = config({ sources: [{ tag: "v0.1.0-alpha.23", knownHarnessDefects: [{ check: "open-balance-fresh", reason: "flaky" }] }] });
  assert.ok(validateConfig(vague).some((p) => p.includes("needs a reason")));
  const unnamed = config({ sources: [{ tag: "v0.1.0-alpha.23", knownHarnessDefects: [{ reason: "x".repeat(60) }] }] });
  assert.ok(validateConfig(unnamed).some((p) => p.includes("needs its check name")));
});
