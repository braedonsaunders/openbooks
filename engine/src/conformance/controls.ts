/**
 * Internal-controls evidence set.
 *
 * The standards corpus (matrix.ts) answers "does this system produce the
 * accounting the standard requires". This register answers the companion
 * question a controller asks next: "do this system's own financial controls
 * hold". Cases pin invariants of OpenBooks' design (today: the allocation
 * kernel and the posted-history correction model) as executable fixtures
 * and map each row to its AUDIT-CONTROLS.md
 * control id — never to a published standard paragraph, which would be a
 * checkable lie (see engine/src/conformance/README.md on citations).
 *
 * Same case format and runner as the standards corpus: a ControlCase is a
 * RunnableCase with `control` where a ConformanceCase carries `citations`.
 * Same doctrine too: amounts are compared exactly, a requirement the product
 * does not implement is declared with `support: "not-implemented"` and
 * reported as a GAP — gaps are published, never omitted, never counted as
 * passing.
 */

import { toUnits } from "../money/money.ts";
import { caseDigest } from "../platform/provenance.ts";
import type { CaseResult, CorpusReport, RunnableCase } from "./types.ts";
import { ALLOCATION_CONTROL_CASES } from "./cases/allocations.ts";
import { CORRECTION_CONTROL_CASES } from "./cases/corrections.ts";

export interface ControlCase extends RunnableCase {
  title: string;
  /** AUDIT-CONTROLS.md control id this case evidences, e.g. "A12". */
  control: string;
  /**
   * What an accountant learns if this passes, written for a controller.
   * Goes straight into the published controls matrix.
   */
  assertion: string;
  /** The scenario's facts, in our own words. Numbers live here. */
  facts: string[];
  /** Required when support is "partial" — what the product does NOT do. */
  limitation?: string;
  /** Required when support is "not-implemented" — what is missing. */
  gap?: string;
}

export const CONTROL_CORPUS: readonly ControlCase[] = [
  ...ALLOCATION_CONTROL_CASES,
  ...CORRECTION_CONTROL_CASES,
];

/**
 * The published floor for each control area, frozen at publication. Same
 * contract as the standards register: removing a case makes validation fail
 * until the floor is lowered in the same commit, in public view, with a
 * reason — withdrawing a claim cannot happen silently.
 */
export const CONTROL_FLOORS: readonly {
  area: string;
  source: readonly ControlCase[];
  minimum: number;
}[] = [
  { area: "allocation controls", source: ALLOCATION_CONTROL_CASES, minimum: 7 },
  { area: "correction controls", source: CORRECTION_CONTROL_CASES, minimum: 1 },
];

/** Every control id the evidence set makes a claim about. */
export function coveredControls(): string[] {
  return [...new Set(CONTROL_CORPUS.map((kase) => kase.control))].sort();
}

/**
 * Structural integrity of the controls register, asserted by the test suite
 * so a malformed case cannot be published. Mirrors validateCorpus, with the
 * control mapping in place of the citation rule.
 */
export function validateControls(cases: readonly ControlCase[] = CONTROL_CORPUS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const kase of cases) {
    if (ids.has(kase.id)) problems.push(`${kase.id}: duplicate case id`);
    ids.add(kase.id);

    if (!kase.control.trim()) problems.push(`${kase.id}: a case must map to an AUDIT-CONTROLS.md control id`);
    if (!kase.assertion.trim()) problems.push(`${kase.id}: missing assertion`);
    if (kase.facts.length === 0) problems.push(`${kase.id}: a case must state its facts`);

    if (kase.support === "not-implemented") {
      if (!kase.gap?.trim()) problems.push(`${kase.id}: a declared gap must describe what is missing`);
      if (kase.run) problems.push(`${kase.id}: a declared gap must not have a run function`);
    } else {
      if (!kase.run) problems.push(`${kase.id}: an implemented case must have a run function`);
      if (kase.gap) problems.push(`${kase.id}: only a declared gap may carry a gap description`);
    }

    if (kase.support === "partial" && !kase.limitation?.trim()) {
      problems.push(`${kase.id}: partial conformance must record the limitation`);
    }
    if (kase.support !== "partial" && kase.limitation) {
      problems.push(`${kase.id}: only partial conformance may record a limitation`);
    }

    const hasExpectation =
      (kase.expected.entries?.length ?? 0) > 0 || Object.keys(kase.expected.values ?? {}).length > 0;
    if (!hasExpectation) {
      problems.push(`${kase.id}: a case must state an expected outcome, including a declared gap`);
    }

    for (const entry of kase.expected.entries ?? []) {
      const residual = entry.lines.reduce((sum, line) => sum + toUnits(line.amount), 0n);
      if (residual !== 0n && entry.lines.length > 0) {
        problems.push(`${kase.id}: expected entry "${entry.step}" does not balance`);
      }
    }
  }

  for (const { area, source, minimum } of CONTROL_FLOORS) {
    if (source.length < minimum) {
      problems.push(
        `${area}: the register fell below its published floor of ${minimum} cases — ` +
          `withdrawn claims must lower this floor deliberately, in the same commit, with a reason`,
      );
    }
  }
  return problems;
}

const STATUS_LABEL: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  gap: "GAP",
  skipped: "not run",
};

function supportLabel(result: CaseResult<ControlCase>): string {
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

/** Group by the mapped AUDIT-CONTROLS.md control id, the case's home. */
function byControl(results: readonly CaseResult<ControlCase>[]): Map<string, CaseResult<ControlCase>[]> {
  const groups = new Map<string, CaseResult<ControlCase>[]>();
  for (const result of results) {
    const list = groups.get(result.case.control) ?? [];
    list.push(result);
    groups.set(result.case.control, list);
  }
  return new Map([...groups.entries()].sort(([a], [b]) => a.localeCompare(b)));
}

export function renderControlsMarkdown(report: CorpusReport<ControlCase>): string {
  const out: string[] = [];
  const { totals } = report;

  out.push("# Internal-controls evidence matrix");
  out.push("");
  out.push(
    "Each row is one executable check of an OpenBooks financial control from AUDIT-CONTROLS.md, " +
      "run against OpenBooks. Amounts are compared exactly — a hundredth of a cent is a failure. " +
      "Controls the product does not implement are listed as **GAP**; they are never omitted and " +
      "never counted as passing.",
  );
  out.push("");
  out.push(
    "These rows are the system's own controls, not requirements of a published accounting " +
      "standard: they cite control ids, never standard paragraphs, and they are published here — " +
      "never in the standards conformance matrix.",
  );
  out.push("");
  out.push(
    `**${totals.pass} passing · ${totals.fail} failing · ${totals.gap} gaps · ${totals.skipped} not run**`,
  );
  out.push("");
  if (report.gitSha) out.push(`Commit \`${report.gitSha}\`${report.at ? ` · ${report.at}` : ""}`);
  else if (report.at) out.push(report.at);
  out.push("");

  for (const [control, results] of byControl(report.results)) {
    out.push(`## Control ${control}`);
    out.push("");
    out.push("| Check | Control | Status | Conformance |");
    out.push("| --- | --- | --- | --- |");
    for (const result of results) {
      out.push(
        `| **${result.case.title}**<br><sub>${result.case.assertion}</sub> | ${result.case.control} | ` +
          `${STATUS_LABEL[result.status]} | ${supportLabel(result)} |`,
      );
    }
    out.push("");

    const notable = results.filter(
      (r) => r.case.support === "partial" || r.case.support === "not-implemented" || r.status === "fail",
    );
    if (notable.length > 0) {
      out.push(`### Control ${control} — shortfalls`);
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
  out.push("npm -w engine run conformance -- controls report");
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

export function renderControlsJson(report: CorpusReport<ControlCase>): string {
  const cases = report.results.map((result) => ({
    id: result.case.id,
    title: result.case.title,
    control: result.case.control,
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
  }));
  return JSON.stringify(
    {
      kind: "internal-controls",
      at: report.at,
      gitSha: report.gitSha,
      runId: report.runId,
      casesSha256: caseDigest(cases),
      totals: report.totals,
      pass: report.pass,
      cases,
    },
    null,
    2,
  );
}

/** One line per case — what CI prints so a failure is legible in the log. */
export function renderControlsConsole(report: CorpusReport<ControlCase>): string {
  const lines = report.results.map((result) => {
    const mark =
      result.status === "pass" ? "ok  " : result.status === "fail" ? "FAIL" : result.status === "gap" ? "gap " : "skip";
    return `  ${mark}  ${result.case.id.padEnd(46)} control ${result.case.control}`;
  });
  const { totals } = report;
  lines.push("");
  lines.push(
    `  ${totals.pass} passing, ${totals.fail} failing, ${totals.gap} declared gaps, ${totals.skipped} not run`,
  );
  return lines.join("\n");
}
