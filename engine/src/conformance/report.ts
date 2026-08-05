/**
 * Rendering the corpus result for publication.
 *
 * Two audiences, one run:
 *  - `renderMarkdown` produces the matrix an accountant reads — requirement,
 *    citation, status, and, for anything short of full conformance, exactly
 *    what the shortfall is.
 *  - `renderJson` produces the machine-readable artifact CI publishes and the
 *    badge endpoint reads.
 */

import type { CaseResult, CorpusReport } from "./types.ts";

const STATUS_LABEL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  gap: "GAP",
  skipped: "not run",
};

function supportLabel(result: CaseResult): string {
  switch (result.case.support) {
    case "supported":
      return "Implemented";
    case "semantic":
      return "Implemented (different mechanism)";
    case "partial":
      return "Partial";
    case "not-implemented":
      return "Not implemented";
  }
}

/** Group by the first-cited standard, which is the case's primary home. */
function byStandard(results: readonly CaseResult[]): Map<string, CaseResult[]> {
  const groups = new Map<string, CaseResult[]>();
  for (const result of results) {
    const standard = result.case.citations[0]!.standard;
    const list = groups.get(standard) ?? [];
    list.push(result);
    groups.set(standard, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function renderMarkdown(report: CorpusReport): string {
  const out: string[] = [];
  const { totals } = report;

  out.push("# Accounting standards conformance matrix");
  out.push("");
  out.push(
    "Each row is one requirement of a published accounting standard, encoded as an executable " +
      "fixture and run against OpenBooks. Amounts are compared exactly — a hundredth of a cent " +
      "is a failure. Requirements the product does not implement are listed as **GAP**; they are " +
      "never omitted and never counted as passing.",
  );
  out.push("");
  out.push(
    "The wording of each requirement is our own restatement. Verify a row by reading the cited " +
      "paragraph in an authoritative copy of the standard.",
  );
  out.push("");
  out.push(
    `**${totals.pass} passing · ${totals.fail} failing · ${totals.gap} gaps · ${totals.skipped} not run**`,
  );
  out.push("");
  if (report.gitSha) out.push(`Commit \`${report.gitSha}\`${report.at ? ` · ${report.at}` : ""}`);
  else if (report.at) out.push(report.at);
  out.push("");

  for (const [standard, results] of byStandard(report.results)) {
    out.push(`## ${standard}`);
    out.push("");
    out.push("| Requirement | Citation | Status | Conformance |");
    out.push("| --- | --- | --- | --- |");
    for (const result of results) {
      // IFRS-style references already carry their standard ("IAS 16.63");
      // Codification-style ones do not ("360-10-35-17"). Do not repeat it.
      const citations = result.case.citations
        .map((c) => (c.reference.startsWith(c.standard) ? c.reference : `${c.standard} ${c.reference}`))
        .join("<br>");
      out.push(
        `| **${result.case.title}**<br><sub>${result.case.assertion}</sub> | ${citations} | ` +
          `${STATUS_LABEL[result.status]} | ${supportLabel(result)} |`,
      );
    }
    out.push("");

    const notable = results.filter(
      (r) => r.case.support === "partial" || r.case.support === "not-implemented" || r.status === "fail",
    );
    if (notable.length > 0) {
      out.push(`### ${standard} — shortfalls`);
      out.push("");
      for (const result of notable) {
        out.push(`**${result.case.id} — ${result.case.title}**`);
        out.push("");
        if (result.case.gap) out.push(`> ${result.case.gap}`);
        if (result.case.limitation) out.push(`> ${result.case.limitation}`);
        if (result.status === "fail") {
          if (result.error) {
            out.push("");
            out.push(`Run error: \`${result.error}\``);
          }
          for (const difference of result.differences) {
            out.push("");
            out.push(`- ${difference.at}: expected \`${difference.expected}\`, got \`${difference.actual}\``);
          }
        }
        out.push("");
      }
    }
  }

  out.push("## Reproducing this");
  out.push("");
  out.push("```bash");
  out.push("npm -w engine run conformance -- report");
  out.push("```");
  out.push("");
  out.push(
    "Computation-tier cases need nothing but the repository. Ledger-tier cases post real " +
      "documents through the accounting kernel and need `OPENBOOKS_DB_URL` pointed at a " +
      "throwaway PostgreSQL database.",
  );
  out.push("");
  return out.join("\n");
}

export function renderJson(report: CorpusReport): string {
  return JSON.stringify(
    {
      at: report.at,
      gitSha: report.gitSha,
      totals: report.totals,
      pass: report.pass,
      cases: report.results.map((result) => ({
        id: result.case.id,
        title: result.case.title,
        standards: [...new Set(result.case.citations.map((c) => c.standard))],
        citations: result.case.citations.map((c) => ({
          standard: c.standard,
          reference: c.reference,
          kind: c.kind,
          requirement: c.requirement,
        })),
        support: result.case.support,
        tier: result.case.tier,
        status: result.status,
        assertion: result.case.assertion,
        facts: result.case.facts,
        ...(result.case.limitation ? { limitation: result.case.limitation } : {}),
        ...(result.case.gap ? { gap: result.case.gap } : {}),
        ...(result.differences.length > 0 ? { differences: result.differences } : {}),
        ...(result.error ? { error: result.error } : {}),
        ms: Math.round(result.ms),
      })),
    },
    null,
    2,
  );
}

/** One line per case — what CI prints so a failure is legible in the log. */
export function renderConsole(report: CorpusReport): string {
  const lines = report.results.map((result) => {
    const mark =
      result.status === "pass" ? "ok  " : result.status === "fail" ? "FAIL" : result.status === "gap" ? "gap " : "skip";
    return `  ${mark}  ${result.case.id.padEnd(46)} ${result.case.citations[0]!.standard} ${result.case.citations[0]!.reference}`;
  });
  const { totals } = report;
  lines.push("");
  lines.push(
    `  ${totals.pass} passing, ${totals.fail} failing, ${totals.gap} declared gaps, ${totals.skipped} not run`,
  );
  return lines.join("\n");
}
