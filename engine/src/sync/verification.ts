import { fromUnits, toUnits } from "../money.ts";
import type {
  SourceAccountMonthRow,
  SourceProjectAccountMonthRow,
} from "./source.ts";

export interface AccountMonthMismatch {
  accountRef: string;
  month: string;
  periodRef?: string;
  ours: string;
  theirs: string;
}

export interface AccountMonthVerification {
  checked: number;
  matches: number;
  mismatches: AccountMonthMismatch[];
}

export interface ProjectAccountMonthMismatch {
  projectRef: string;
  accountRef: string;
  month: string;
  periodRef?: string;
  ours: string;
  theirs: string;
}

export interface ProjectAccountMonthVerification {
  checked: number;
  matches: number;
  mismatches: ProjectAccountMonthMismatch[];
}

/**
 * Compare source and target account-month activity with one canonical rule for
 * every connector. Duplicate buckets are summed exactly as numeric(19,4),
 * source-only and target-only buckets are both checked, and malformed source
 * rows fail the run instead of silently weakening verification.
 */
export function verifyAccountMonths(
  sourceRows: readonly SourceAccountMonthRow[],
  targetRows: readonly SourceAccountMonthRow[],
  mismatchLimit = 50,
): AccountMonthVerification {
  if (!Number.isSafeInteger(mismatchLimit) || mismatchLimit < 0) {
    throw new Error("account-month mismatch limit must be a non-negative integer");
  }

  const usePeriodRefs = sourceUsesPeriodRefs(sourceRows, "account-month");
  const source = bucket(sourceRows, "source", usePeriodRefs);
  const target = bucket(targetRows, "target", usePeriodRefs);
  const keys = new Set([...source.amounts.keys(), ...target.amounts.keys()]);
  const mismatches: AccountMonthMismatch[] = [];
  let matches = 0;

  for (const key of [...keys].sort()) {
    const theirs = source.amounts.get(key) ?? 0n;
    const ours = target.amounts.get(key) ?? 0n;
    if (ours === theirs) {
      matches++;
      continue;
    }
    if (mismatches.length < mismatchLimit) {
      const separator = key.lastIndexOf("|");
      const label = source.labels.get(key) ?? target.labels.get(key)!;
      mismatches.push({
        accountRef: key.slice(0, separator),
        month: label.month,
        ...(label.periodRef ? { periodRef: label.periodRef } : {}),
        ours: fromUnits(ours),
        theirs: fromUnits(theirs),
      });
    }
  }

  return { checked: keys.size, matches, mismatches };
}

function sourceUsesPeriodRefs(
  rows: readonly { periodRef?: string | null }[],
  label: string,
): boolean {
  const refs = rows.filter((row) => String(row.periodRef ?? "").trim() !== "");
  if (refs.length > 0 && refs.length !== rows.length) {
    throw new Error(
      `source ${label} population mixes exact period references with month-only rows`,
    );
  }
  return rows.length > 0 && refs.length === rows.length;
}

interface PeriodBucket {
  amounts: Map<string, bigint>;
  labels: Map<string, { month: string; periodRef?: string }>;
}

function bucket(
  rows: readonly SourceAccountMonthRow[],
  side: "source" | "target",
  usePeriodRefs: boolean,
): PeriodBucket {
  const result: PeriodBucket = { amounts: new Map(), labels: new Map() };
  for (const row of rows) {
    const accountRef = String(row.accountRef ?? "").trim();
    const month = String(row.month ?? "").trim();
    const periodRef = String(row.periodRef ?? "").trim();
    if (!accountRef) throw new Error(`${side} account-month row has no account reference`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error(`${side} account-month row for ${accountRef} has invalid month "${month}"`);
    }
    if (usePeriodRefs && !periodRef) {
      throw new Error(
        `${side} account-month row for ${accountRef} has no exact period reference`,
      );
    }
    let amount: bigint;
    try {
      amount = toUnits(String(row.amount));
    } catch (error) {
      throw new Error(
        `${side} account-month row for ${accountRef} in ${month} has invalid amount "${row.amount}": ${(error as Error).message}`,
      );
    }
    const key = `${accountRef}|${usePeriodRefs ? periodRef : month}`;
    result.amounts.set(key, (result.amounts.get(key) ?? 0n) + amount);
    result.labels.set(key, {
      month,
      ...(usePeriodRefs ? { periodRef } : {}),
    });
  }
  return result;
}

/**
 * Exact project/account/month comparison used by every project-capable source
 * adapter. Source-only and target-only buckets are both material differences.
 */
export function verifyProjectAccountMonths(
  sourceRows: readonly SourceProjectAccountMonthRow[],
  targetRows: readonly SourceProjectAccountMonthRow[],
  mismatchLimit = 50,
): ProjectAccountMonthVerification {
  if (!Number.isSafeInteger(mismatchLimit) || mismatchLimit < 0) {
    throw new Error(
      "project-account-month mismatch limit must be a non-negative integer",
    );
  }

  const usePeriodRefs = sourceUsesPeriodRefs(
    sourceRows,
    "project-account-month",
  );
  const source = projectBucket(sourceRows, "source", usePeriodRefs);
  const target = projectBucket(targetRows, "target", usePeriodRefs);
  const keys = new Set([...source.amounts.keys(), ...target.amounts.keys()]);
  const mismatches: ProjectAccountMonthMismatch[] = [];
  let matches = 0;

  for (const key of [...keys].sort()) {
    const theirs = source.amounts.get(key) ?? 0n;
    const ours = target.amounts.get(key) ?? 0n;
    if (ours === theirs) {
      matches++;
      continue;
    }
    if (mismatches.length < mismatchLimit) {
      const [projectRef, accountRef] = key.split("|");
      const label = source.labels.get(key) ?? target.labels.get(key)!;
      mismatches.push({
        projectRef: projectRef!,
        accountRef: accountRef!,
        month: label.month,
        ...(label.periodRef ? { periodRef: label.periodRef } : {}),
        ours: fromUnits(ours),
        theirs: fromUnits(theirs),
      });
    }
  }

  return { checked: keys.size, matches, mismatches };
}

function projectBucket(
  rows: readonly SourceProjectAccountMonthRow[],
  side: "source" | "target",
  usePeriodRefs: boolean,
): PeriodBucket {
  const result: PeriodBucket = { amounts: new Map(), labels: new Map() };
  for (const row of rows) {
    const projectRef = String(row.projectRef ?? "").trim();
    const accountRef = String(row.accountRef ?? "").trim();
    const month = String(row.month ?? "").trim();
    const periodRef = String(row.periodRef ?? "").trim();
    if (!projectRef) {
      throw new Error(`${side} project-account-month row has no project reference`);
    }
    if (!accountRef) {
      throw new Error(`${side} project-account-month row has no account reference`);
    }
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error(
        `${side} project-account-month row for ${projectRef}/${accountRef} has invalid month "${month}"`,
      );
    }
    if (usePeriodRefs && !periodRef) {
      throw new Error(
        `${side} project-account-month row for ${projectRef}/${accountRef} has no exact period reference`,
      );
    }
    let amount: bigint;
    try {
      amount = toUnits(String(row.amount));
    } catch (error) {
      throw new Error(
        `${side} project-account-month row for ${projectRef}/${accountRef} in ${month} has invalid amount "${row.amount}": ${(error as Error).message}`,
      );
    }
    const key = `${projectRef}|${accountRef}|${usePeriodRefs ? periodRef : month}`;
    result.amounts.set(key, (result.amounts.get(key) ?? 0n) + amount);
    result.labels.set(key, {
      month,
      ...(usePeriodRefs ? { periodRef } : {}),
    });
  }
  return result;
}
