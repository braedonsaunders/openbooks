/**
 * Conformance corpus CLI.
 *
 *   npm -w engine run conformance -- list
 *   npm -w engine run conformance -- run [--filter <text>]
 *   npm -w engine run conformance -- report [--out <dir>]
 *
 * `run` prints one line per case and exits non-zero on any failure. `report`
 * additionally writes the publishable artifacts: the markdown matrix and the
 * machine-readable JSON that CI uploads and the trust badge reads.
 *
 * Ledger-tier cases need `OPENBOOKS_DB_URL`. Without it they report as "not
 * run" rather than silently passing — the same anti-false-green rule the
 * integration CI job enforces with its canary.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CONFORMANCE_CORPUS, coveredStandards, validateCorpus } from "./matrix.ts";
import { renderConsole, renderJson, renderMarkdown } from "./report.ts";
import { createConformanceOrg } from "./roles.ts";
import { runCorpus } from "./runner.ts";
import type { CorpusReport } from "./types.ts";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function execute(filter?: string): Promise<CorpusReport> {
  const problems = validateCorpus();
  if (problems.length > 0) {
    console.error("The conformance register is malformed:");
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(2);
  }

  const at = new Date().toISOString();
  const gitSha = process.env.GITHUB_SHA ?? null;

  const needsLedger = CONFORMANCE_CORPUS.some(
    (kase) => kase.tier === "ledger" && kase.support !== "not-implemented",
  );
  if (!needsLedger || !process.env.OPENBOOKS_DB_URL) {
    if (needsLedger) {
      console.warn("OPENBOOKS_DB_URL is not set — ledger-tier cases will report as not run.\n");
    }
    return await runCorpus(CONFORMANCE_CORPUS, { at, gitSha, filter });
  }

  // Each ledger case gets a FRESH tenant. Cases post real documents and some
  // deliberately leave balances behind; sharing one tenant would let an earlier
  // case's stock or receivables change a later case's answer.
  const results: CorpusReport["results"] = [];
  for (const kase of CONFORMANCE_CORPUS) {
    if (kase.tier !== "ledger" || kase.support === "not-implemented") {
      const single = await runCorpus([kase], { at, gitSha, filter });
      results.push(...single.results);
      continue;
    }
    if (filter && !kase.id.includes(filter)) continue;
    const org = await createConformanceOrg();
    try {
      const single = await runCorpus([kase], {
        at,
        gitSha,
        ledger: { roles: org.roles, ledger: org.ledger },
      });
      results.push(...single.results);
    } finally {
      await org.drop();
    }
  }

  const totals = { pass: 0, fail: 0, gap: 0, skipped: 0 };
  for (const result of results) totals[result.status]++;
  return { at, gitSha, results, totals, pass: totals.fail === 0 };
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? "run";

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
    const report = await execute(arg("filter"));
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
