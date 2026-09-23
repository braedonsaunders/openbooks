/**
 * Migration preflight loader and evaluator.
 *
 * A preflight answers, read-only and before upgrading, "will this pending
 * migration work on MY data?" Every generated migration with ordinal >= 242
 * (the first after v0.1.0-alpha.23) must have EXACTLY ONE decision file in
 * schema/migrations/preflight/:
 *
 *   <basename>.sql   a preflight: exactly one read-only statement
 *                    (SELECT or WITH ... SELECT) returning zero rows when the
 *                    install is ready, else one row per finding with columns
 *                    code / severity / subject / detail / remedy.
 *   <basename>.none  plain text: no preflight is needed, and why
 *                    (at least 20 non-whitespace characters).
 *
 * This module is side-effect free on import (unlike scripts/bootstrap.ts,
 * which runs main() on import) so tests and the lint-adjacent tooling can
 * use it directly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

/** First ordinal covered by the preflight contract (after v0.1.0-alpha.23). */
export const PREFLIGHT_MIN_ORDINAL = 242;

/** Default ceiling for one preflight statement: 5 minutes. */
export const PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS = 300_000;
const PREFLIGHT_STATEMENT_TIMEOUT_MIN_MS = 1_000;
const PREFLIGHT_STATEMENT_TIMEOUT_MAX_MS = 3_600_000;

/** SQLSTATEs that mark a preflight as deferred rather than failed. */
export const PREFLIGHT_DEFERRED_SQLSTATES = Object.freeze(["42P01", "42703"]);

export type PreflightSeverity = "refuse" | "notice";

export type PreflightFinding = {
  migration: string;
  code: string;
  severity: PreflightSeverity;
  subject: string;
  detail: string;
  remedy: string;
};

export type PreflightDecision =
  | { kind: "sql"; basename: string; filename: string }
  | { kind: "none"; basename: string; filename: string; reason: string }
  | { kind: "missing"; basename: string };

export type PreflightEvaluation =
  | { status: "ready"; findings: PreflightFinding[]; leastPrivilege: boolean }
  | { status: "deferred"; reason: string; leastPrivilege: boolean };

export type PreflightRunOptions = {
  statementTimeoutMs: number;
  /**
   * When set, the evaluator runs SET LOCAL ROLE first to prove the preflight
   * works under the SELECT-only role. Membership failures fall back to the
   * connecting role (reported via leastPrivilege: false); anything else is
   * thrown. Bootstrap's own pre-gate leaves this unset: it runs as the
   * migration login, still inside BEGIN READ ONLY.
   */
  leastPrivilegeRole?: string;
};

export function preflightDirFor(repoRoot: string): string {
  return join(repoRoot, "schema", "migrations", "preflight");
}

export function ordinalOf(basename: string): number | null {
  const match = /^(\d{4})_[a-z0-9_]+\.sql$/.exec(basename);
  return match ? Number(match[1]) : null;
}

/**
 * Resolve the decision file for one generated migration basename.
 * `entries` is the set of filenames in the preflight directory (so callers
 * that already listed it do not re-list, and tests can pass fixtures).
 * Basenames below the contract ordinal have no decision ("missing" is only
 * meaningful for callers that check the ordinal first).
 */
export function preflightDecisionFor(
  basename: string,
  entries: ReadonlySet<string>,
): PreflightDecision {
  const stem = basename.replace(/\.sql$/, "");
  const sql = `${stem}.sql`;
  const none = `${stem}.none`;
  const hasSql = entries.has(sql);
  const hasNone = entries.has(none);
  if (hasSql && hasNone) {
    throw new Error(
      `[bootstrap] migration preflight for ${basename} is contradictory: both ${sql} and ${none} exist; keep exactly one`,
    );
  }
  if (hasSql) return { kind: "sql", basename, filename: sql };
  if (hasNone) {
    return { kind: "none", basename, filename: none, reason: "" };
  }
  return { kind: "missing", basename };
}

export function readPreflightSql(preflightDir: string, filename: string): string {
  return readFileSync(join(preflightDir, filename), "utf8");
}

export function readNoneReason(preflightDir: string, filename: string): string {
  return readFileSync(join(preflightDir, filename), "utf8").trim();
}

/** A .none reason is adequate when it says something (20+ non-whitespace chars). */
export function isAdequateNoneReason(reason: string): boolean {
  return reason.replace(/\s/g, "").length >= 20;
}

export function preflightStatementTimeoutMs(
  source: Record<string, string | undefined>,
): number {
  const parsed = Number(source.OPENBOOKS_PREFLIGHT_STATEMENT_TIMEOUT_MS);
  if (
    !Number.isInteger(parsed) ||
    parsed < PREFLIGHT_STATEMENT_TIMEOUT_MIN_MS ||
    parsed > PREFLIGHT_STATEMENT_TIMEOUT_MAX_MS
  ) {
    return PREFLIGHT_STATEMENT_TIMEOUT_DEFAULT_MS;
  }
  return parsed;
}

/** True when the error is a missing relation/column (deferral candidate). */
export function isDeferredPreflightError(error: unknown): boolean {
  return PREFLIGHT_DEFERRED_SQLSTATES.includes(
    (error as { code?: unknown } | null)?.code as string,
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripSqlComments(source: string): string {
  let out = "";
  let i = 0;
  let state: "code" | "line" | "block" | "squote" = "code";
  let blockDepth = 0;
  const n = source.length;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (state === "code") {
      if (ch === "-" && next === "-") {
        state = "line";
        i += 2;
        continue;
      }
      if (ch === "/" && next === "*") {
        state = "block";
        blockDepth = 1;
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = "squote";
        out += ch;
        i += 1;
        continue;
      }
      out += ch;
      i += 1;
      continue;
    }
    if (state === "line") {
      if (ch === "\n") {
        state = "code";
        out += ch;
      }
      i += 1;
      continue;
    }
    if (state === "block") {
      if (ch === "/" && next === "*") {
        blockDepth += 1;
        i += 2;
        continue;
      }
      if (ch === "*" && next === "/") {
        blockDepth -= 1;
        i += 2;
        if (blockDepth === 0) state = "code";
        continue;
      }
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
    if (ch === "'" && next === "'") {
      out += next;
      i += 1;
    } else if (ch === "'") {
      state = "code";
    }
  }
  return out;
}

/**
 * True when an earlier PENDING migration creates the object a deferred
 * preflight tripped over, so the preflight runs at apply time instead.
 * Anything else (a genuinely absent object) is a real error, never a
 * silent skip: only a pending earlier migration can explain the absence.
 */
export function earlierPendingCreatesObject(
  error: unknown,
  earlierContents: readonly string[],
): boolean {
  const raw = error instanceof Error ? error.message : String(error);
  const missingTable = /relation "([^"]+)" does not exist/.exec(raw)?.[1];
  const missingColumn = /column "([^"]+)" of relation "([^"]+)" does not exist/.exec(raw);
  const table = missingColumn?.[2] ?? missingTable;
  const column = missingColumn?.[1];
  if (!table) return false;
  const tablePattern = new RegExp(
    `create\\s+(?:or\\s+replace\\s+)?(?:table|view|materialized\\s+view)\\b[^;]*?\\b${escapeRegExp(table)}\\b`,
    "is",
  );
  const columnPattern = column
    ? new RegExp(
        `alter\\s+table\\b[^;]*?\\b${escapeRegExp(table)}\\b[^;]*?\\badd\\s+(?:column\\s+)?${escapeRegExp(column)}\\b`,
        "is",
      )
    : null;
  return earlierContents.some((content) => {
    const code = stripSqlComments(content);
    return tablePattern.test(code) || (columnPattern !== null && columnPattern.test(code));
  });
}

const PREFLIGHT_CODE_PATTERN = /^\d{4}\.[a-z][a-z0-9_]*$/;

/**
 * Validate the rows a preflight returned. A preflight that returns the wrong
 * shape is a broken tool, not a clean bill of health: refuse by name naming
 * the migration, so a silent pass can never come from a malformed query.
 */
export function validateFindingRows(
  migration: string,
  ordinal: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): PreflightFinding[] {
  return rows.map((row, index) => {
    const at = `${migration} row ${index + 1}`;
    for (const column of ["code", "severity", "subject", "detail", "remedy"] as const) {
      if (typeof row[column] !== "string" || (row[column] as string).length === 0) {
        throw new Error(
          `[bootstrap] migration preflight ${at} is malformed: column ${column} must be a non-empty string`,
        );
      }
    }
    const code = row.code as string;
    const severity = row.severity as string;
    if (!PREFLIGHT_CODE_PATTERN.test(code)) {
      throw new Error(
        `[bootstrap] migration preflight ${at} is malformed: code ${JSON.stringify(code)} must look like <ordinal>.<snake_reason>`,
      );
    }
    if (!code.startsWith(`${ordinal}.`)) {
      throw new Error(
        `[bootstrap] migration preflight ${at} is malformed: code ${code} does not start with this migration's ordinal ${ordinal}`,
      );
    }
    if (severity !== "refuse" && severity !== "notice") {
      throw new Error(
        `[bootstrap] migration preflight ${at} is malformed: severity ${JSON.stringify(severity)} must be 'refuse' or 'notice'`,
      );
    }
    return {
      migration,
      code,
      severity,
      subject: row.subject as string,
      detail: row.detail as string,
      remedy: row.remedy as string,
    };
  });
}

/**
 * Refuse anything that is not a SELECT/WITH at runtime. The single-statement
 * shape is the lint's job; this is the backstop so bootstrap never executes
 * a write it did not review as a migration.
 */
export function assertReadOnlyPreflight(migration: string, preflightSql: string): void {
  const withoutComments = stripSqlComments(preflightSql).trim();
  if (!/^(select\b|with\b)/i.test(withoutComments)) {
    throw new Error(
      `[bootstrap] migration preflight ${migration} is not a SELECT or WITH ... SELECT statement`,
    );
  }
}

/**
 * Run one preflight statement: BEGIN READ ONLY with bypass RLS, a bounded
 * statement_timeout, then ROLLBACK.
 */
export async function evaluatePreflight(
  client: pg.PoolClient,
  migration: string,
  ordinal: string,
  preflightSql: string,
  options: PreflightRunOptions,
): Promise<PreflightEvaluation> {
  assertReadOnlyPreflight(migration, preflightSql);
  await client.query("begin transaction read only");
  let leastPrivilege = false;
  try {
    await client.query(`set local statement_timeout = ${options.statementTimeoutMs}`);
    await client.query("set local app.bypass_rls = 'on'");
    if (options.leastPrivilegeRole) {
      if (!/^[a-z_][a-z0-9_]{0,62}$/.test(options.leastPrivilegeRole)) {
        throw new Error(
          `[bootstrap] refusing to assume a least-privilege role with an unexpected name`,
        );
      }
      // A failed statement aborts the whole transaction, so the role attempt
      // AND the preflight under it run inside one savepoint. Rolling back to
      // it undoes the SET ROLE as well, and the fallback continues in a clean
      // transaction instead of tripping "current transaction is aborted".
      await client.query("savepoint preflight_least_privilege");
      try {
        await client.query(`set local role ${options.leastPrivilegeRole}`);
        leastPrivilege = true;
      } catch (error) {
        await client.query("rollback to savepoint preflight_least_privilege");
        const code = (error as { code?: unknown } | null)?.code;
        // 42501: not a member of the role; 22023: the role does not exist
        // yet on this install (verified against PostgreSQL 16: SET ROLE to
        // a missing role reports invalid_parameter_value, not undefined_object).
        if (code !== "42501" && code !== "22023" && code !== "42704") throw error;
        leastPrivilege = false;
      }
    }
    const run = async (): Promise<PreflightEvaluation> => {
      try {
        const result = await client.query<Record<string, unknown>>(preflightSql);
        return { status: "ready", findings: validateFindingRows(migration, ordinal, result.rows), leastPrivilege };
      } catch (error) {
        if (isDeferredPreflightError(error)) {
          const raw = error instanceof Error ? error.message : String(error);
          return { status: "deferred", reason: raw, leastPrivilege };
        }
        throw error;
      }
    };
    try {
      return await run();
    } catch (error) {
      // The read role lacks a grant this preflight needs. That is expected on
      // an install still running an OLDER release: grants for objects its
      // version never exposed to the read role converge only when the new
      // bootstrap runs, which is exactly what the check runs BEFORE. So a
      // denial as the read role is not drift. The check falls back to the
      // connecting role (still READ ONLY, still rolled back) and reports that
      // least privilege was not proven for this preflight.
      const code = (error as { code?: unknown } | null)?.code;
      if (!(leastPrivilege && code === "42501")) throw error;
      await client.query("rollback to savepoint preflight_least_privilege");
      leastPrivilege = false;
      return await run();
    }
  } finally {
    await client.query("rollback").catch(() => {});
  }
}

export function formatFinding(finding: PreflightFinding): string {
  return (
    `[${finding.severity}] ${finding.code} (${finding.migration}): ${finding.subject} — ${finding.detail} Remedy: ${finding.remedy}`
  );
}
