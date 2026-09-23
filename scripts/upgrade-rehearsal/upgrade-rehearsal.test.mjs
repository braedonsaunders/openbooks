import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { compareSnapshots, activeOrgIds, candidateHarnessOrgIds, rowHashQuery } from "./ledger.mjs";
import { coverageGaps, loadConfig, planMatrix, validateConfig } from "./plan.mjs";
import { summarize } from "./rehearse.mjs";

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
