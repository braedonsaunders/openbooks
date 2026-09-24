/**
 * Corpus selection truthfulness (D16) and unrun-case truthfulness (D17).
 *
 * Two shapes used to read as green while proving nothing: a --filter typo
 * admitted zero cases ("0 passing, 0 failing", exit 0), and a DB-less run
 * skipped every ledger-tier case ("59 passing, 0 failing, 26 not run", exit
 * 0). Both are now named failures unless explicitly allowed.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { CONFORMANCE_CORPUS } from "./matrix.ts";
import { renderConsole } from "./report.ts";
import { runCorpus } from "./runner.ts";

const AT = "2026-09-24T00:00:00.000Z";

test("a filter matching zero cases is a named failure, not green", async () => {
  const report = await runCorpus(CONFORMANCE_CORPUS, { at: AT, filter: "no-such-case-xyz" });
  assert.equal(report.pass, false);
  assert.deepEqual(report.totals, { pass: 0, fail: 0, gap: 0, skipped: 0 });
  assert.match(report.emptySelection ?? "", /no-such-case-xyz/);
  assert.match(report.emptySelection ?? "", /0 of \d+ cases/);
  const consoleText = renderConsole(report);
  assert.match(consoleText, /0 passing, 0 failing/);
  assert.match(consoleText, /empty selection: .*no-such-case-xyz/);
});

test("an explicitly allowed empty selection still passes", async () => {
  const report = await runCorpus(CONFORMANCE_CORPUS, {
    at: AT,
    filter: "no-such-case-xyz",
    allowEmpty: true,
  });
  assert.equal(report.pass, true);
  assert.equal(report.emptySelection, undefined);
});

test("ledger cases without a ledger context fail the run and name the not-run count", async () => {
  const report = await runCorpus(CONFORMANCE_CORPUS, { at: AT });
  assert.ok(report.totals.skipped > 0, "the corpus must contain ledger-tier cases for this test to mean anything");
  assert.equal(report.pass, false);
  assert.match(report.notRunReason ?? "", new RegExp(`${report.totals.skipped} ledger-tier case\\(s\\) not run`));
  const consoleText = renderConsole(report);
  assert.match(consoleText, new RegExp(`${report.totals.skipped} not run`));
  assert.match(consoleText, /ledger-tier case\(s\) not run/);
});

test("an explicitly allowed not-run still passes on zero failures", async () => {
  const report = await runCorpus(CONFORMANCE_CORPUS, { at: AT, allowNotRun: true });
  assert.equal(report.pass, true);
  // The unrun cases are still disclosed even when allowed.
  assert.ok((report.notRunReason ?? "").length > 0);
});

const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");

function runCli(args: string[]): { status: number | null; output: string } {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test",
    FORCE_COLOR: "0",
    OPENBOOKS_DB_URL: "",
    OPENBOOKS_DATA_KEY:
      process.env.OPENBOOKS_DATA_KEY ?? "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
    OPENBOOKS_TRUSTED_TEST_BYPASS: "1",
  };
  delete childEnv.NODE_TEST_CONTEXT;
  delete childEnv.NODE_TEST_WORKER_ID;
  const run = spawnSync(process.execPath, ["--import", "tsx", "engine/src/conformance/cli.ts", ...args], {
    cwd: REPO_ROOT,
    env: childEnv,
    encoding: "utf8",
    timeout: 300_000,
  });
  return { status: run.status, output: `${run.stdout ?? ""}\n${run.stderr ?? ""}` };
}

test("CLI: a filter typo exits non-zero and names the empty selection", () => {
  const { status, output } = runCli(["run", "--filter", "no-such-case-xyz"]);
  assert.notEqual(status, 0);
  assert.match(output, /empty selection: .*no-such-case-xyz/);
});

test("CLI: no database exits non-zero and names the not-run count", () => {
  const { status, output } = runCli(["run"]);
  assert.notEqual(status, 0);
  assert.match(output, /not run/);
  assert.match(output, /ledger-tier case\(s\) not run/);
});

test("CLI: --allow-not-run exits zero without a database", () => {
  const { status, output } = runCli(["run", "--allow-not-run"]);
  assert.equal(status, 0, output);
});
