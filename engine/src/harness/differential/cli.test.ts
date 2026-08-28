import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";

const REPO_ROOT = resolve(import.meta.dirname, "../../../../");
const CLI = join(REPO_ROOT, "engine", "src", "harness", "differential", "cli.ts");

const CORPUS = {
  schemaVersion: 1,
  name: "differential-corrupt",
  seed: "corrupt",
  currency: "CAD",
  country: "CA",
  startDate: "2026-01-01",
  endDate: "2026-01-01",
  accounts: [
    { key: "ar", number: "1100", name: "Accounts receivable", type: "asset_receivable" },
    { key: "ap", number: "2000", name: "Accounts payable", type: "liability_payable" },
    { key: "bank", number: "1000", name: "Bank", type: "asset_bank" },
  ],
  parties: [],
  events: [],
} as const;

const VALID_EXPECTED = {
  schemaVersion: 1,
  corpus: CORPUS.name,
  seed: CORPUS.seed,
  trialBalance: {},
  openBalances: {},
  eventCount: 0,
};

function runCheck(published: string): { status: number | null; output: string } {
  const dir = mkdtempSync(join(tmpdir(), "openbooks-differential-cli-"));
  const corpusPath = join(dir, "corpus-corrupt.json");
  const expectedPath = join(dir, "expected-corrupt.json");
  writeFileSync(corpusPath, `${JSON.stringify(CORPUS)}\n`);
  writeFileSync(expectedPath, published);
  try {
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", CLI, "check", corpusPath],
      { cwd: REPO_ROOT, encoding: "utf8" },
    );
    return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("differential check rejects corrupt expected evidence", () => {
  const valid = runCheck(`${JSON.stringify(VALID_EXPECTED)}\n`);
  assert.equal(valid.status, 0, valid.output);
  assert.match(valid.output, /published expected file matches recomputation/);

  const truncated = runCheck("{\"schemaVersion\":1");
  assert.equal(truncated.status, 1, truncated.output);
  assert.match(truncated.output, /invalid published expected file/);

  const wrongShape = runCheck(JSON.stringify({ ...VALID_EXPECTED, trialBalance: [] }));
  assert.equal(wrongShape.status, 1, wrongShape.output);
  assert.match(wrongShape.output, /trialBalance must be an object/);

  const wrongBalance = runCheck(JSON.stringify({
    ...VALID_EXPECTED,
    openBalances: { orphan: { ar: "1.00" } },
  }));
  assert.equal(wrongBalance.status, 1, wrongBalance.output);
  assert.match(wrongBalance.output, /published expected open balances vs recomputed/);
});
