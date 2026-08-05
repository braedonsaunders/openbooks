/**
 * The conformance scope register.
 *
 * This array IS the published claim. A requirement that is not in here is not
 * claimed, and a requirement that is in here is reported with its real status
 * every run — passing, failing, or an open gap. Adding a case is how coverage
 * grows; deleting one is how a claim is withdrawn, and should not happen
 * silently.
 *
 * Case ids are stable and are referenced from published reports. Never renumber
 * or reuse one.
 */

import { toUnits } from "../money.ts";
import { FOREIGN_CURRENCY_CASES } from "./cases/foreign-currency.ts";
import { INCOME_TAX_CASES } from "./cases/income-tax.ts";
import { INVENTORY_CASES } from "./cases/inventory.ts";
import { LEASE_CASES } from "./cases/leases.ts";
import { LONG_LIVED_ASSET_CASES } from "./cases/long-lived-assets.ts";
import { REVENUE_CASES } from "./cases/revenue.ts";
import type { ConformanceCase } from "./types.ts";

export const CONFORMANCE_CORPUS: readonly ConformanceCase[] = [
  ...REVENUE_CASES,
  ...LEASE_CASES,
  ...FOREIGN_CURRENCY_CASES,
  ...INVENTORY_CASES,
  ...LONG_LIVED_ASSET_CASES,
  ...INCOME_TAX_CASES,
];

/** Every standard the corpus makes a claim about, in citation order. */
export function coveredStandards(): string[] {
  const seen = new Set<string>();
  for (const kase of CONFORMANCE_CORPUS) {
    for (const citation of kase.citations) seen.add(citation.standard);
  }
  return [...seen].sort();
}

/**
 * Structural integrity of the register itself, asserted by the test suite so a
 * malformed case cannot be published. These are not accounting checks — they
 * are the rules that keep the register honest.
 */
export function validateCorpus(cases: readonly ConformanceCase[] = CONFORMANCE_CORPUS): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();

  for (const kase of cases) {
    if (ids.has(kase.id)) problems.push(`${kase.id}: duplicate case id`);
    ids.add(kase.id);

    if (kase.citations.length === 0) {
      problems.push(`${kase.id}: a case must cite at least one paragraph`);
    }
    for (const citation of kase.citations) {
      if (!citation.requirement.trim()) {
        problems.push(`${kase.id}: citation ${citation.reference} has no restated requirement`);
      }
    }
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

    // Expected entries must balance. An expectation that does not balance is a
    // bug in the corpus, and would let a case "pass" against wrong accounting.
    for (const entry of kase.expected.entries ?? []) {
      const residual = entry.lines.reduce((sum, line) => sum + toUnits(line.amount), 0n);
      if (residual !== 0n && entry.lines.length > 0) {
        problems.push(`${kase.id}: expected entry "${entry.step}" does not balance`);
      }
    }
  }
  return problems;
}
