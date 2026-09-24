/**
 * Conformance corpus CLI.
 *
 *   npm -w engine run conformance -- list
 *   npm -w engine run conformance -- run [--filter <text>] [--allow-empty] [--allow-not-run]
 *   npm -w engine run conformance -- report [--out <dir>]
 *   npm -w engine run conformance -- controls list|run|report [--out <dir>] [--filter <text>] [--allow-empty] [--allow-not-run]
 *
 * A filter that admits zero cases is a named failure (non-zero exit) unless
 * --allow-empty is passed, and ledger-tier cases that go unrun for want of
 * OPENBOOKS_DB_URL fail the run unless --allow-not-run is passed — a typo or
 * a missing database must never read as green.
 *
 * `run` prints one line per case and exits non-zero on any failure. `report`
 * additionally writes the publishable artifacts: the markdown matrix and the
 * machine-readable JSON that CI uploads and the trust badge reads.
 *
 * The `controls` subcommand runs the internal-controls evidence set instead:
 * same runner, own matrix (control ids, never standard paragraphs), own
 * artifacts (`controls-matrix.md`, `controls.json` with kind
 * "internal-controls").
 *
 * Ledger-tier cases need `OPENBOOKS_DB_URL`. Without it they report as "not
 * run" rather than silently passing — the same anti-false-green rule the
 * integration CI job enforces with its canary.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  CONTROL_CORPUS,
  coveredControls,
  renderControlsConsole,
  renderControlsJson,
  renderControlsMarkdown,
  validateControls,
} from "./controls.ts";
import { CONFORMANCE_CORPUS, coveredStandards, validateCorpus } from "./matrix.ts";
import { renderConsole, renderJson, renderMarkdown } from "./report.ts";
import { createConformanceOrg } from "./roles.ts";
import { finalizeCorpus, runCorpus } from "./runner.ts";
import { runId, sourceSha } from "../platform/provenance.ts";
import type { ControlCase } from "./controls.ts";
import type { CorpusReport } from "./types.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

interface SelectionOptions {
  allowEmpty: boolean;
  allowNotRun: boolean;
}

async function execute(filter?: string, selection: SelectionOptions = { allowEmpty: false, allowNotRun: false }): Promise<CorpusReport> {
  const problems = validateCorpus();
  if (problems.length > 0) {
    console.error("The conformance register is malformed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(2);
  }

  const at = new Date().toISOString();
  // OPENBOOKS_SOURCE_SHA first: on workflow_run GITHUB_SHA names the trust
  // workflow's own tip, not the pinned producer checkout (see trust.yml).
  const gitSha = sourceSha();
  const producerRunId = runId();

  const needsLedger = CONFORMANCE_CORPUS.some(
    (kase) => kase.tier === "ledger" && kase.support !== "not-implemented",
  );
  if (!needsLedger || !process.env.OPENBOOKS_DB_URL) {
    if (needsLedger) {
      console.warn("OPENBOOKS_DB_URL is not set — ledger-tier cases will report as not run.\n");
    }
    return await runCorpus(CONFORMANCE_CORPUS, {
      at,
      gitSha,
      runId: producerRunId,
      filter,
      allowEmpty: selection.allowEmpty,
      allowNotRun: selection.allowNotRun,
    });
  }

  // Each ledger case gets a FRESH tenant. Cases post real documents and some
  // deliberately leave balances behind; sharing one tenant would let an earlier
  // case's stock or receivables change a later case's answer.
  const results: CorpusReport["results"] = [];
  for (const kase of CONFORMANCE_CORPUS) {
    if (kase.tier !== "ledger" || kase.support === "not-implemented") {
      // Emptiness is judged once on the aggregate below, not per admitted
      // single: a non-matching single contributes nothing either way.
      const single = await runCorpus([kase], { at, gitSha, runId: producerRunId, filter, allowEmpty: true });
      results.push(...single.results);
      continue;
    }
    if (filter && !kase.id.includes(filter)) continue;
    const org = await createConformanceOrg();
    try {
      const single = await runCorpus([kase], {
        at,
        gitSha,
        runId: producerRunId,
        ledger: { roles: org.roles, ledger: org.ledger },
      });
      results.push(...single.results);
    } finally {
      await org.drop();
    }
  }

  return finalizeCorpus({
    at,
    gitSha,
    runId: producerRunId,
    results,
    selected: results.length,
    totalCases: CONFORMANCE_CORPUS.length,
    filter,
    allowEmpty: selection.allowEmpty,
    allowNotRun: selection.allowNotRun,
  });
}

async function executeControls(filter?: string, selection: SelectionOptions = { allowEmpty: false, allowNotRun: false }): Promise<CorpusReport<ControlCase>> {
  const problems = validateControls();
  if (problems.length > 0) {
    console.error("The controls register is malformed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(2);
  }

  const at = new Date().toISOString();
  const gitSha = sourceSha();
  const producerRunId = runId();

  const needsLedger = CONTROL_CORPUS.some(
    (kase) => kase.tier === "ledger" && kase.support !== "not-implemented",
  );
  if (!needsLedger || !process.env.OPENBOOKS_DB_URL) {
    if (needsLedger) {
      console.warn("OPENBOOKS_DB_URL is not set — ledger-tier cases will report as not run.\n");
    }
    return await runCorpus(CONTROL_CORPUS, {
      at,
      gitSha,
      runId: producerRunId,
      filter,
      allowEmpty: selection.allowEmpty,
      allowNotRun: selection.allowNotRun,
    });
  }

  // Each ledger case gets a FRESH tenant, like the standards corpus: runs
  // leave journals and lineage behind that would change a later case.
  const results: CorpusReport<ControlCase>["results"] = [];
  for (const kase of CONTROL_CORPUS) {
    if (kase.tier !== "ledger" || kase.support === "not-implemented") {
      // Emptiness is judged once on the aggregate below, not per admitted
      // single: a non-matching single contributes nothing either way.
      const single = await runCorpus([kase], { at, gitSha, runId: producerRunId, filter, allowEmpty: true });
      results.push(...single.results);
      continue;
    }
    if (filter && !kase.id.includes(filter)) continue;
    const org = await createConformanceOrg();
    try {
      const single = await runCorpus([kase], {
        at,
        gitSha,
        runId: producerRunId,
        ledger: { roles: org.roles, ledger: org.ledger },
      });
      results.push(...single.results);
    } finally {
      await org.drop();
    }
  }

  return finalizeCorpus({
    at,
    gitSha,
    runId: producerRunId,
    results,
    selected: results.length,
    totalCases: CONTROL_CORPUS.length,
    filter,
    allowEmpty: selection.allowEmpty,
    allowNotRun: selection.allowNotRun,
  });
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";
  const selection = { allowEmpty: flag("allow-empty"), allowNotRun: flag("allow-not-run") };

  if (command === "controls") {
    const sub = process.argv[3] ?? "run";
    if (sub === "list") {
      console.log(`${CONTROL_CORPUS.length} cases across ${coveredControls().join(", ")}\n`);
      for (const kase of CONTROL_CORPUS) {
        console.log(`  ${kase.id.padEnd(46)} ${kase.support.padEnd(16)} control ${kase.control}`);
      }
      return;
    }
    if (sub === "run" || sub === "report") {
      const report = await executeControls(arg("filter"), selection);
      console.log(renderControlsConsole(report));

      if (sub === "report") {
        const outDir = arg("out") ?? ".local/controls";
        mkdirSync(outDir, { recursive: true });
        writeFileSync(join(outDir, "controls-matrix.md"), renderControlsMarkdown(report));
        writeFileSync(join(outDir, "controls.json"), renderControlsJson(report));
        console.log(`\n  wrote ${join(outDir, "controls-matrix.md")}`);
        console.log(`  wrote ${join(outDir, "controls.json")}`);
      }

      process.exit(report.pass ? 0 : 1);
    }
    console.error(`unknown controls command '${sub}' — expected list, run, or report`);
    process.exit(2);
  }

  if (command === "list") {
    console.log(`${CONFORMANCE_CORPUS.length} cases across ${coveredStandards().join(", ")}\n`);
    for (const kase of CONFORMANCE_CORPUS) {
      const citation = kase.citations[0]!;
      console.log(
        `  ${kase.id.padEnd(46)} ${kase.support.padEnd(16)} ${citation.standard} ${citation.reference}`,
      );
    }
    return;
  }

  if (command === "run" || command === "report") {
    const report = await execute(arg("filter"), selection);
    console.log(renderConsole(report));

    if (command === "report") {
      const outDir = arg("out") ?? ".local/conformance";
      mkdirSync(outDir, { recursive: true });
      writeFileSync(join(outDir, "conformance-matrix.md"), renderMarkdown(report));
      writeFileSync(join(outDir, "conformance.json"), renderJson(report));
      console.log(`\n  wrote ${join(outDir, "conformance-matrix.md")}`);
      console.log(`  wrote ${join(outDir, "conformance.json")}`);
    }

    process.exit(report.pass ? 0 : 1);
  }

  console.error(`unknown command '${command}' — expected list, run, or report`);
  process.exit(2);
}

await main();
