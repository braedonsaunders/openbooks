/**
 * One-time canonical employment migration executor.
 *
 * Populates the 0184 tables (worker_employments, worker_employment_versions,
 * employment_assignments plus one assignment version each) from
 * collector-supplied legacy person-keyed facts, driven by the pure
 * classifier in ./migration-preflight.ts. The collector that fetches source
 * rows belongs to a later slice; this module takes SourcePersonRow[] as its
 * input contract and never invents employment facts.
 *
 * Rules (financial-institution grade):
 * - Only `ready` rows WITH a candidate mapping are written. `requires_review`
 *   and every other non-ready classification is reported and never guessed.
 *   A `ready` row without a candidate (no current observation anchors it)
 *   is refused: there is no status or effective date to write.
 * - The written rows carry provenance in the 0184 evidence columns:
 *   employment_changes.recorded_source_ref binds the source system key, the
 *   source row identity, and the preflight candidate digest
 *   (fingerprintSourceRow); the reason carries the same digest in human
 *   form; worker_employments.service_start_provenance carries the service
 *   start provenance. No migration adds columns: 0184 is frozen.
 * - Idempotent per person: re-running with the same inputs writes nothing
 *   and reports `already_migrated` per person. Changed inputs refuse with
 *   the diff (binding_conflict) rather than silently re-migrating.
 * - Historical coverage stays `unknown`; no start dates are invented. An
 *   observation-date migration writes service_start NULL.
 * - Everything for an org runs in ONE transaction; any refusal rolls the
 *   whole org back. A per-org advisory transaction lock serializes
 *   concurrent applies so two operators cannot double-migrate an org.
 * - Every INSERT asserts its row count: a write that matches zero rows is a
 *   failure, never success. RLS is tenant-scoped (withOrgTransaction sets
 *   app.current_org with bypass off); this module never enables bypass.
 */

import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../db.ts";
import {
  fingerprintSourceRow,
  preflightEmploymentMigration,
  type MigrationBinding,
  type PreflightCode,
  type PreflightIssue,
  type PreflightNote,
  type SourcePersonRow,
} from "./migration-preflight.ts";

/** Versioned identity for the evidence token and the report envelope. */
export const EMPLOYMENT_MIGRATION_REF_PREFIX = "hrm-employment-migration/v1";
export const EMPLOYMENT_MIGRATION_REPORT_VERSION =
  "openbooks/hrm-employment-migration-report/v1";

/** Stable assignment slot key for the single slot the migration opens. */
export const MIGRATION_ASSIGNMENT_KEY = "migration-primary";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PersonMigrationOutcome =
  | "migrated"
  | "already_migrated"
  | "would_migrate"
  | "refused";

export interface MigrationBindingDiff {
  readonly expected: {
    readonly sourceFingerprint: string;
    readonly sourceVersion: string;
    readonly workerPartyId: string;
    readonly employerSubsidiaryId: string;
    readonly employmentId: string;
  };
  readonly actual: {
    readonly sourceFingerprint: string;
    readonly sourceVersion: string;
    readonly workerPartyId: string;
    readonly employerSubsidiaryId: string | null;
  };
}

export interface PersonMigrationResult {
  readonly orgId: string;
  readonly sourceNamespace: string;
  readonly sourceId: string;
  readonly nativePartyId: string;
  readonly classification: PreflightCode;
  readonly outcome: PersonMigrationOutcome;
  readonly employmentId: string | null;
  /** SHA-256 candidate digest (fingerprintSourceRow over the input row). */
  readonly candidateDigest: string;
  /** Pass-through of the classifier verdict; the executor never invents coverage. */
  readonly historicalCoverage: "known" | "unknown";
  readonly serviceStart: string | null;
  readonly serviceStartProvenance: string | null;
  readonly issues: readonly PreflightIssue[];
  readonly notes: readonly PreflightNote[];
  /** Present only when a prior binding conflicts: the refused diff. */
  readonly diff: MigrationBindingDiff | null;
}

export interface EmploymentMigrationTotals {
  readonly persons: number;
  readonly migrated: number;
  readonly alreadyMigrated: number;
  readonly wouldMigrate: number;
  readonly refused: number;
  readonly employmentsWritten: number;
  readonly versionsWritten: number;
  readonly assignmentsWritten: number;
  readonly changesWritten: number;
}

export interface EmploymentMigrationReport {
  readonly reportVersion: typeof EMPLOYMENT_MIGRATION_REPORT_VERSION;
  readonly orgId: string;
  readonly dryRun: boolean;
  readonly allowPartial: boolean;
  readonly status: "evaluated" | "empty_not_evaluated";
  readonly generatedAt: string;
  readonly persons: readonly PersonMigrationResult[];
  readonly totals: EmploymentMigrationTotals;
  readonly reportHash: string;
  readonly summary: string;
}

/** A computed refusal that must reach the caller; carries the full report. */
export class EmploymentMigrationRefusalError extends Error {
  readonly report: EmploymentMigrationReport;
  constructor(report: EmploymentMigrationReport) {
    super(
      `employment migration refused for org ${report.orgId}: ` +
        `${report.totals.refused} of ${report.totals.persons} persons refused; ` +
        `nothing was written (report ${report.reportHash.slice(0, 12)})`,
    );
    this.name = "EmploymentMigrationRefusalError";
    this.report = report;
  }
}

/** An operational failure (bad input shape, zero-row write, corrupt evidence). */
export class EmploymentMigrationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmploymentMigrationError";
  }
}

export interface ParsedMigrationRef {
  readonly sourceNamespace: string;
  readonly sourceId: string;
  readonly sourceFingerprint: string;
  readonly sourceVersion: string;
}

/**
 * Build the 0184 evidence token binding source key, row identity, and the
 * preflight candidate digest. Components are URI-encoded so the token parses
 * exactly; the fingerprint is hex and needs no encoding.
 */
export function buildMigrationRef(
  sourceNamespace: string,
  sourceId: string,
  sourceFingerprint: string,
  sourceVersion: string,
): string {
  return (
    `${EMPLOYMENT_MIGRATION_REF_PREFIX} ` +
    `ns=${encodeURIComponent(sourceNamespace)} ` +
    `id=${encodeURIComponent(sourceId)} ` +
    `fp=${sourceFingerprint} ` +
    `ver=${encodeURIComponent(sourceVersion)}`
  );
}

const MIGRATION_REF_PATTERN =
  /^hrm-employment-migration\/v1 ns=([^ ]+) id=([^ ]+) fp=([0-9a-f]{64}) ver=([^ ]+)$/;

/**
 * Parse an evidence token back. A token under our prefix that does not parse
 * is corrupt migration evidence and fails closed; tokens from other processes
 * are never queried (the read filters the prefix), so this never misfires.
 */
export function parseMigrationRef(ref: string): ParsedMigrationRef {
  const match = MIGRATION_REF_PATTERN.exec(ref);
  if (match === null) {
    throw new EmploymentMigrationError(
      `corrupt employment migration evidence token: ${JSON.stringify(ref)}; ` +
        "refusing to guess which source row it binds — reconcile the " +
        "employment_changes evidence for this org before re-migrating",
    );
  }
  return {
    sourceNamespace: decodeURIComponent(match[1]!),
    sourceId: decodeURIComponent(match[2]!),
    sourceFingerprint: match[3]!,
    sourceVersion: decodeURIComponent(match[4]!),
  };
}

/** Stable canonical encoding for the report hash (mirrors the preflight). */
function canonicalEncode(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalEncode).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entry]) => entry !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalEncode(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Content hash binding the evaluated report. generatedAt is metadata, not
 * reviewed content: excluding it keeps the hash stable across runs over
 * identical inputs and database state, which is what the production apply
 * interlock compares (--dry-run-hash). The timestamp stays in the report.
 */
export function hashEmploymentMigrationReport(
  report: Omit<EmploymentMigrationReport, "reportHash" | "summary" | "generatedAt"> & {
    generatedAt?: string;
  },
): string {
  const { generatedAt: _generatedAt, ...stable } = report;
  void _generatedAt;
  return createHash("sha256")
    .update(
      `${EMPLOYMENT_MIGRATION_REPORT_VERSION}\n${canonicalEncode(stable)}`,
      "utf8",
    )
    .digest("hex");
}

/** Human summary; the JSON report stays the machine contract. */
export function summarizeEmploymentMigrationReport(
  report: Omit<EmploymentMigrationReport, "reportHash" | "summary">,
): string {
  const lines: string[] = [];
  lines.push(
    `employment migration ${report.dryRun ? "dry run" : "apply"} for org ${report.orgId}: ` +
      `${report.totals.persons} persons, ${report.totals.migrated} migrated, ` +
      `${report.totals.alreadyMigrated} already migrated, ` +
      `${report.totals.wouldMigrate} would migrate, ${report.totals.refused} refused`,
  );
  if (report.status === "empty_not_evaluated") {
    lines.push("empty inventory: not evaluated, never a clean migration claim");
    return lines.join("\n");
  }
  for (const person of report.persons) {
    const head =
      `${person.sourceNamespace}/${person.sourceId} -> ${person.outcome}` +
      (person.employmentId !== null ? ` employment ${person.employmentId}` : "") +
      ` digest ${person.candidateDigest.slice(0, 12)}`;
    lines.push(head);
    for (const issue of person.issues) {
      lines.push(`  ${issue.level}/${issue.code}: ${issue.detail}`);
      lines.push(`    remedy: ${issue.remedy}`);
    }
    if (person.diff !== null) {
      lines.push(
        `  binding diff: expected fingerprint ${person.diff.expected.sourceFingerprint} ` +
          `version ${JSON.stringify(person.diff.expected.sourceVersion)} ` +
          `employer ${person.diff.expected.employerSubsidiaryId}; actual fingerprint ` +
          `${person.diff.actual.sourceFingerprint} version ` +
          `${JSON.stringify(person.diff.actual.sourceVersion)} employer ` +
          `${person.diff.actual.employerSubsidiaryId ?? "unknown"}`,
      );
    }
  }
  return lines.join("\n");
}

export interface FinalizedMigrationReportInput {
  readonly orgId: string;
  readonly dryRun: boolean;
  readonly allowPartial: boolean;
  readonly status: "evaluated" | "empty_not_evaluated";
  readonly generatedAt: string;
  readonly persons: readonly PersonMigrationResult[];
  readonly totals: EmploymentMigrationTotals;
}

/** Attach totals-proof hash and summary; pure, unit-tested. */
export function finalizeEmploymentMigrationReport(
  input: FinalizedMigrationReportInput,
): EmploymentMigrationReport {
  const unsigned: Omit<EmploymentMigrationReport, "reportHash" | "summary"> = {
    reportVersion: EMPLOYMENT_MIGRATION_REPORT_VERSION,
    orgId: input.orgId,
    dryRun: input.dryRun,
    allowPartial: input.allowPartial,
    status: input.status,
    generatedAt: input.generatedAt,
    persons: input.persons,
    totals: input.totals,
  };
  const reportHash = hashEmploymentMigrationReport(unsigned);
  const summary = summarizeEmploymentMigrationReport(unsigned);
  return { ...unsigned, reportHash, summary };
}

/**
 * CLI exit contract. Non-zero when any person was refused unless partial
 * application was explicitly allowed; an empty inventory is never clean;
 * already_migrated needs no operator action so it never blocks.
 */
export function migrationExitCode(report: EmploymentMigrationReport): number {
  if (report.status === "empty_not_evaluated") return 1;
  if (report.totals.refused > 0 && !report.allowPartial) return 1;
  return 0;
}

// ---------------------------------------------------------------------------
// Executor.
// ---------------------------------------------------------------------------

export interface ExecuteEmploymentMigrationOptions {
  readonly orgId: string;
  readonly rows: readonly SourcePersonRow[];
  readonly dryRun?: boolean;
  readonly allowPartial?: boolean;
}

interface StoredBinding {
  readonly binding: MigrationBinding;
  readonly sourceNamespace: string;
  readonly sourceId: string;
}

type EvidenceRow = {
  ref: string;
  employment_id: string;
  bound_at: string;
  worker_party_id: string;
  employer_subsidiary_id: string;
};

function bindingKey(sourceNamespace: string, sourceId: string): string {
  return `${sourceNamespace} ${sourceId}`;
}

/** Digest lookup keyed by the full person identity the classifier reports. */
function personKey(
  orgId: string,
  sourceNamespace: string,
  sourceId: string,
  nativePartyId: string,
): string {
  return `${orgId} ${sourceNamespace} ${sourceId} ${nativePartyId}`;
}

/**
 * Read this org's prior migration evidence (0184 employment_changes rows this
 * module wrote) and rebuild the idempotency bindings. Runs inside the org's
 * single migration transaction, under tenant RLS with bypass off.
 */
async function loadStoredBindings(orgId: string): Promise<StoredBinding[]> {
  const found = (await db.execute<EvidenceRow>(sql`
    select c.recorded_source_ref as ref, c.employment_id::text as employment_id,
           to_char(c.recorded_at, 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as bound_at,
           e.worker_party_id::text as worker_party_id,
           e.employer_subsidiary_id::text as employer_subsidiary_id
      from employment_changes c
      join worker_employments e
        on e.org_id = c.org_id and e.id = c.employment_id
     where c.org_id = ${orgId}
       and c.recorded_source = 'system'
       and c.recorded_source_ref like ${`${EMPLOYMENT_MIGRATION_REF_PREFIX} %`}
     order by c.recorded_at, c.id`)) as unknown as { rows: EvidenceRow[] };
  if (found.rows.length === 0) return [];
  // A write that matches rows no read can observe is not a save: every
  // evidence row must join a live employment, or the binding is corrupt.
  // (The composite FK makes this unreachable except through the governed
  // amend path; fail closed rather than assume it.)
  const orphans = found.rows.filter(
    (row) => row.employment_id === null || row.worker_party_id === null,
  );
  if (orphans.length > 0) {
    throw new EmploymentMigrationError(
      `employment migration evidence for org ${orgId} names ${orphans.length} ` +
        "employment(s) no read can observe; refusing to migrate onto corrupt " +
        "evidence — reconcile employment_changes before re-running",
    );
  }
  return found.rows.map((row) => {
    const parsed = parseMigrationRef(row.ref);
    return {
      sourceNamespace: parsed.sourceNamespace,
      sourceId: parsed.sourceId,
      binding: {
        canonicalOrgId: orgId,
        canonicalWorkerPartyId: row.worker_party_id,
        canonicalEmployerSubsidiaryId: row.employer_subsidiary_id,
        canonicalEmploymentId: row.employment_id,
        sourceFingerprint: parsed.sourceFingerprint,
        sourceVersion: parsed.sourceVersion,
        boundAt: row.bound_at,
        provenance: row.ref,
      },
    };
  });
}

function effectiveEmployerOf(row: SourcePersonRow): string | null {
  if (row.resolution !== null && row.resolution.kind === "operator-employer-date-mapping") {
    const mapped = row.resolution.employerSubsidiaryId;
    if (mapped !== null && mapped.length > 0) return mapped;
  }
  const asserted = row.employer.assertedSubsidiaryId;
  return asserted !== null && asserted.length > 0 ? asserted : null;
}

function assertUuid(value: string, what: string, remedy: string): void {
  if (!UUID_PATTERN.test(value)) {
    throw new EmploymentMigrationError(
      `${what} ${JSON.stringify(value)} is not a valid UUID; ${remedy}`,
    );
  }
}

async function insertOne<T extends Record<string, string>>(
  label: string,
  query: ReturnType<typeof sql>,
): Promise<T> {
  const result = (await db.execute<T>(query)) as unknown as { rows: T[] };
  const row = result.rows[0];
  if (row === undefined) {
    // A write that matches zero rows is a failure, not a success: under RLS
    // an unscoped write silently matches nothing and reports success.
    throw new EmploymentMigrationError(
      `${label} matched zero rows; refusing to report success for an ` +
        "unobservable write — check the org RLS scope of this transaction",
    );
  }
  return row;
}

/**
 * Execute the one-time migration for one org in ONE transaction. Dry runs
 * evaluate and report without writing. Without allowPartial any refused
 * person throws EmploymentMigrationRefusalError and the whole org rolls
 * back; with allowPartial the ready subset is written and the rest listed.
 */
export async function executeEmploymentMigration(
  options: ExecuteEmploymentMigrationOptions,
): Promise<EmploymentMigrationReport> {
  const { orgId } = options;
  const dryRun = options.dryRun ?? false;
  const allowPartial = options.allowPartial ?? false;
  if (!UUID_PATTERN.test(orgId)) {
    throw new EmploymentMigrationError(
      `org ${JSON.stringify(orgId)} is not a valid UUID; refusing to migrate ` +
        "without an explicit tenant scope",
    );
  }
  for (const row of options.rows) {
    if (row.orgId !== orgId) {
      throw new EmploymentMigrationError(
        `source row ${row.sourceNamespace}/${row.sourceId} belongs to org ` +
          `${row.orgId}, not the requested org ${orgId}; refusing a ` +
          "multi-org batch — migrate one org per run",
      );
    }
  }

  return withOrgTransaction(orgId, async () => {
    if (!dryRun) {
      // Serialize concurrent applies per org: without this two operators
      // could double-migrate the same persons past each other's evidence
      // read. Transaction-scoped, so it releases on commit or rollback.
      await db.execute(
        sql`select pg_advisory_xact_lock(hashtext(${`hrm-employment-migration:${orgId}`}))`,
      );
    }
    const stored = dryRun ? [] : await loadStoredBindings(orgId);
    const storedByKey = new Map<string, StoredBinding>();
    for (const entry of stored) {
      const key = bindingKey(entry.sourceNamespace, entry.sourceId);
      const prior = storedByKey.get(key);
      if (prior !== undefined) {
        throw new EmploymentMigrationError(
          `duplicate migration evidence for ${entry.sourceNamespace}/` +
            `${entry.sourceId} in org ${orgId}; refusing to guess which ` +
            "employment is canonical — reconcile employment_changes first",
        );
      }
      storedByKey.set(key, entry);
    }

    const digests = new Map<string, string>();
    const withBindings = options.rows.map((row) => {
      digests.set(
        personKey(row.orgId, row.sourceNamespace, row.sourceId, row.nativePartyId),
        fingerprintSourceRow(row),
      );
      const storedBinding = storedByKey.get(bindingKey(row.sourceNamespace, row.sourceId));
      if (
        row.existingBinding !== null &&
        storedBinding !== undefined &&
        row.existingBinding.canonicalEmploymentId !==
          storedBinding.binding.canonicalEmploymentId
      ) {
        throw new EmploymentMigrationError(
          `source row ${row.sourceNamespace}/${row.sourceId} carries a ` +
            "caller binding for a different employment than the stored " +
            "migration evidence; refusing to migrate onto divergent bindings",
        );
      }
      return {
        ...row,
        existingBinding: row.existingBinding ?? storedBinding?.binding ?? null,
      };
    });

    const preflight = preflightEmploymentMigration(withBindings);
    // Ready rows carry unique source keys (duplicates are always ambiguous),
    // so the digest join below is exact for every row this run can write.
    // Same-key rows sharing a native party but differing elsewhere are all
    // refused; their digests are audit-only and never select writes.
    const persons: PersonMigrationResult[] = preflight.rows.map((evaluated) => {
      const digest =
        digests.get(
          personKey(
            evaluated.orgId,
            evaluated.sourceNamespace,
            evaluated.sourceId,
            evaluated.nativePartyId,
          ),
        ) ?? "";
      const storedBinding = storedByKey.get(
        bindingKey(evaluated.sourceNamespace, evaluated.sourceId),
      );
      const base = {
        orgId: evaluated.orgId,
        sourceNamespace: evaluated.sourceNamespace,
        sourceId: evaluated.sourceId,
        nativePartyId: evaluated.nativePartyId,
        classification: evaluated.classification,
        candidateDigest: digest,
        historicalCoverage: evaluated.historicalCoverage,
        serviceStart: evaluated.serviceStart,
        serviceStartProvenance: evaluated.serviceStartProvenance,
        notes: evaluated.notes,
      };
      if (evaluated.classification === "already_migrated") {
        const binding = withBindings.find(
          (row) =>
            row.sourceNamespace === evaluated.sourceNamespace &&
            row.sourceId === evaluated.sourceId &&
            row.existingBinding !== null,
        )?.existingBinding;
        return {
          ...base,
          outcome: "already_migrated" as const,
          employmentId: binding?.canonicalEmploymentId ?? null,
          issues: evaluated.issues,
          diff: null,
        };
      }
      if (evaluated.classification === "ready" && evaluated.candidate !== null) {
        return {
          ...base,
          outcome: (dryRun ? "would_migrate" : "migrated") as PersonMigrationOutcome,
          employmentId: null,
          issues: evaluated.issues,
          diff: null,
        };
      }
      if (evaluated.classification === "ready") {
        // Ready with no candidate: no current observation anchors a status
        // or effective date, so there is nothing honest to write.
        const issue: PreflightIssue = {
          code: "missing_current_observation",
          level: "requires_review",
          detail:
            "employment evidence is sufficient but no current observation " +
            "anchors a status or effective date; the migration asserts " +
            "current observed state and never invents it.",
          remedy:
            "Supply collector evidence with an operator-asserted current " +
            "observation (canonical status, UTC instant, provenance) for " +
            "observation-date migration.",
        };
        return {
          ...base,
          outcome: "refused" as const,
          employmentId: null,
          issues: [...evaluated.issues, issue],
          diff: null,
        };
      }
      let diff: MigrationBindingDiff | null = null;
      if (evaluated.classification === "binding_conflict" && storedBinding !== undefined) {
        const source = withBindings.find(
          (row) =>
            row.sourceNamespace === evaluated.sourceNamespace &&
            row.sourceId === evaluated.sourceId,
        );
        diff = {
          expected: {
            sourceFingerprint: storedBinding.binding.sourceFingerprint,
            sourceVersion: storedBinding.binding.sourceVersion,
            workerPartyId: storedBinding.binding.canonicalWorkerPartyId,
            employerSubsidiaryId: storedBinding.binding.canonicalEmployerSubsidiaryId,
            employmentId: storedBinding.binding.canonicalEmploymentId,
          },
          actual: {
            sourceFingerprint: digest,
            sourceVersion: source?.sourceVersion ?? "",
            workerPartyId: evaluated.nativePartyId,
            employerSubsidiaryId: source === undefined ? null : effectiveEmployerOf(source),
          },
        };
      }
      return {
        ...base,
        outcome: "refused" as const,
        employmentId: null,
        issues: evaluated.issues,
        diff,
      };
    });

    const refused = persons.filter((person) => person.outcome === "refused");
    const finalize = (
      finalizePersons: readonly PersonMigrationResult[],
      written: number,
    ): EmploymentMigrationReport =>
      finalizeEmploymentMigrationReport({
        orgId,
        dryRun,
        allowPartial,
        status: preflight.status,
        generatedAt: new Date().toISOString(),
        persons: finalizePersons,
        totals: {
          persons: finalizePersons.length,
          migrated: finalizePersons.filter((p) => p.outcome === "migrated").length,
          alreadyMigrated: finalizePersons.filter((p) => p.outcome === "already_migrated").length,
          wouldMigrate: finalizePersons.filter((p) => p.outcome === "would_migrate").length,
          refused: finalizePersons.filter((p) => p.outcome === "refused").length,
          employmentsWritten: written,
          versionsWritten: written,
          assignmentsWritten: written,
          changesWritten: written,
        },
      });

    if (!dryRun && refused.length > 0 && !allowPartial) {
      // Throw before any write: the transaction rolls back and the org is
      // untouched. The refusal carries the per-person report.
      throw new EmploymentMigrationRefusalError(finalize(persons, 0));
    }

    if (!dryRun) {
      const written = new Map<string, string>();
      for (const person of persons) {
        if (person.outcome !== "migrated") continue;
        const evaluated = preflight.rows.find(
          (row) =>
            row.sourceNamespace === person.sourceNamespace &&
            row.sourceId === person.sourceId,
        );
        const candidate = evaluated?.candidate;
        if (candidate === null || candidate === undefined) continue;
        assertUuid(
          person.nativePartyId,
          "native party",
          "supply collector evidence with the native parties.id this candidate maps to",
        );
        assertUuid(
          candidate.employerSubsidiaryId,
          "employer subsidiary",
          "supply collector evidence with the legal subsidiary id of the current employer",
        );
        const employment = await insertOne<{ id: string }>(
          `worker_employments insert for ${person.sourceNamespace}/${person.sourceId}`,
          sql`insert into worker_employments
                (org_id, worker_party_id, employer_subsidiary_id, service_start, service_start_provenance)
              values (${orgId}, ${person.nativePartyId}::uuid,
                      ${candidate.employerSubsidiaryId}::uuid,
                      ${person.serviceStart}, ${person.serviceStartProvenance})
              returning id::text as id`,
        );
        await insertOne<{ id: string }>(
          `worker_employment_versions insert for ${person.sourceNamespace}/${person.sourceId}`,
          sql`insert into worker_employment_versions
                (org_id, employment_id, version_no, status, effective_from)
              values (${orgId}, ${employment.id}::uuid, 1,
                      ${candidate.status}, ${candidate.effectiveFrom}::date)
              returning id::text as id`,
        );
        const assignment = await insertOne<{ id: string }>(
          `employment_assignments insert for ${person.sourceNamespace}/${person.sourceId}`,
          sql`insert into employment_assignments (org_id, employment_id, assignment_key)
              values (${orgId}, ${employment.id}::uuid, ${MIGRATION_ASSIGNMENT_KEY})
              returning id::text as id`,
        );
        // No FTE is asserted: the column default applies and the slot is a
        // structural primary, not a measured workload. No title, department,
        // or location is invented either.
        await insertOne<{ id: string }>(
          `employment_assignment_versions insert for ${person.sourceNamespace}/${person.sourceId}`,
          sql`insert into employment_assignment_versions
                (org_id, assignment_id, employment_id, version_no, is_primary, effective_from)
              values (${orgId}, ${assignment.id}::uuid, ${employment.id}::uuid,
                      1, true, ${candidate.effectiveFrom}::date)
              returning id::text as id`,
        );
        // The idempotency anchor: source system key, row identity, and the
        // preflight candidate digest, bound in the 0184 evidence columns.
        const ref = buildMigrationRef(
          person.sourceNamespace,
          person.sourceId,
          person.candidateDigest,
          withBindings.find(
            (row) =>
              row.sourceNamespace === person.sourceNamespace &&
              row.sourceId === person.sourceId,
          )?.sourceVersion ?? "",
        );
        await insertOne<{ id: string }>(
          `employment_changes insert for ${person.sourceNamespace}/${person.sourceId}`,
          sql`insert into employment_changes
                (org_id, employment_id, revision, change_kind, prior_snapshot,
                 reason, recorded_source, recorded_source_ref)
              values (${orgId}, ${employment.id}::uuid, 1, 'created', '{}'::jsonb,
                      ${`One-time employment migration: ${person.sourceNamespace}/${person.sourceId} ` +
                        `migrated as ${candidate.status} effective ${candidate.effectiveFrom}; ` +
                        `candidate digest ${person.candidateDigest}; historical coverage unknown.`},
                      'system', ${ref})
              returning id::text as id`,
        );
        written.set(`${person.sourceNamespace} ${person.sourceId}`, employment.id);
      }
      const completed: PersonMigrationResult[] = persons.map((person) =>
        person.outcome === "migrated"
          ? {
              ...person,
              employmentId:
                written.get(`${person.sourceNamespace} ${person.sourceId}`) ?? null,
            }
          : person,
      );
      return finalize(completed, written.size);
    }

    return finalize(persons, 0);
  });
}
