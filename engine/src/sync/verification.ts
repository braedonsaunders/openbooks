import { fromUnits, toUnits } from "../money.ts";
import type {
  SourceAccountMonthRow,
  SourceProjectAccountMonthRow,
} from "./source.ts";

export interface AccountMonthMismatch {
  accountRef: string;
  month: string;
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

  const source = bucket(sourceRows, "source");
  const target = bucket(targetRows, "target");
  const keys = new Set([...source.keys(), ...target.keys()]);
  const mismatches: AccountMonthMismatch[] = [];
  let matches = 0;

  for (const key of [...keys].sort()) {
    const theirs = source.get(key) ?? 0n;
    const ours = target.get(key) ?? 0n;
    if (ours === theirs) {
      matches++;
      continue;
    }
    if (mismatches.length < mismatchLimit) {
      const separator = key.lastIndexOf("|");
      mismatches.push({
        accountRef: key.slice(0, separator),
        month: key.slice(separator + 1),
        ours: fromUnits(ours),
        theirs: fromUnits(theirs),
      });
    }
  }

  return { checked: keys.size, matches, mismatches };
}

function bucket(rows: readonly SourceAccountMonthRow[], side: "source" | "target"): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows) {
    const accountRef = String(row.accountRef ?? "").trim();
    const month = String(row.month ?? "").trim();
    if (!accountRef) throw new Error(`${side} account-month row has no account reference`);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
      throw new Error(`${side} account-month row for ${accountRef} has invalid month "${month}"`);
    }
    let amount: bigint;
    try {
      amount = toUnits(String(row.amount));
    } catch (error) {
      throw new Error(
        `${side} account-month row for ${accountRef} in ${month} has invalid amount "${row.amount}": ${(error as Error).message}`,
      );
    }
    const key = `${accountRef}|${month}`;
    result.set(key, (result.get(key) ?? 0n) + amount);
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

  const source = projectBucket(sourceRows, "source");
  const target = projectBucket(targetRows, "target");
  const keys = new Set([...source.keys(), ...target.keys()]);
  const mismatches: ProjectAccountMonthMismatch[] = [];
  let matches = 0;

  for (const key of [...keys].sort()) {
    const theirs = source.get(key) ?? 0n;
    const ours = target.get(key) ?? 0n;
    if (ours === theirs) {
      matches++;
      continue;
    }
    if (mismatches.length < mismatchLimit) {
      const [projectRef, accountRef, month] = key.split("|");
      mismatches.push({
        projectRef: projectRef!,
        accountRef: accountRef!,
        month: month!,
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
): Map<string, bigint> {
  const result = new Map<string, bigint>();
  for (const row of rows) {
    const projectRef = String(row.projectRef ?? "").trim();
    const accountRef = String(row.accountRef ?? "").trim();
    const month = String(row.month ?? "").trim();
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
    let amount: bigint;
    try {
      amount = toUnits(String(row.amount));
    } catch (error) {
      throw new Error(
        `${side} project-account-month row for ${projectRef}/${accountRef} in ${month} has invalid amount "${row.amount}": ${(error as Error).message}`,
      );
    }
    const key = `${projectRef}|${accountRef}|${month}`;
    result.set(key, (result.get(key) ?? 0n) + amount);
  }
  return result;
}
