/**
 * HRM → payroll employment context (migration 0186).
 *
 * The resolver the payroll shards consume: one worker = one employment for
 * pay purposes, resolved through the 0184 HRM record, never guessed. Plus
 * the one-time `stampEmploymentContext` backfill that links pre-HRM payroll
 * rows to their employment, plus `resolveManagerForRouting` for the Flows
 * owner to wire later.
 *
 * SCOPE. Reads worker_employments / worker_employment_versions (status
 * as-of via employment-read.ts's pure assembler + temporal.ts),
 * reporting_relationships (manager as-of), parties (subsidiary link),
 * employee_roles (supervisor fallback), and the ten 0186 payroll tables.
 * Writes ONLY the 0186 employment_id columns (stamp path). Never touches
 * payroll calculation, run lifecycle, Flows, or UI: the payroll shards own
 * those and consume this resolver under the Slice D contract.
 *
 * AUTHORIZATION (own boundary, by design). employment-read.ts states that a
 * future payroll resolver must bring its own permission boundary and reuse
 * the pure assembler, never the HRM loader — this module is that resolver.
 * Both resolve functions AND the stamp require the caller's actor and enforce
 * the `payroll.run` duty via the existing actorHasPermission primitive, first
 * inside the transaction before any tenant read or write; there is
 * deliberately no HRM feature gate here, so payroll stays usable while HRM is
 * off. Unknown/inactive actors fail closed. The stamp checks the same duty as
 * the read (no distinct maintenance permission): it serves pay adoption under
 * the calculation duty, fills nulls only, and a new catalogue permission for
 * a one-time backfill would be new surface with no second user. A dry-run
 * previews nine tables of tenant data, so it is gated exactly like the write.
 *
 * TRANSACTIONS. Each function owns one withOrgTransaction(orgId) unit, which
 * nests safely inside the payroll caller's transaction (same org reuses the
 * pinned connection). Stamp writes its whole org atomically: any refusal
 * rolls everything back. Dry-run executes the identical path including the
 * UPDATEs, then rolls back, so the report proves what the real run would do.
 *
 * REFUSALS. Identity refusals carry a stable `code` (no_employment,
 * ambiguous_employment, employer_mismatch, ambiguous_manager) plus a message
 * naming the remedy; every remedy below names artifacts verified to exist:
 * the hrm_employment_change_requests correction record (0185 storage with a
 * draft lifecycle), the 0184 immutability rule (employer transfer =
 * terminate + rehire), the audited native party merge
 * (engine/src/sync/party-merges.ts), Admin → Users person linkage
 * (web/app/(app)/admin/users party route), and /admin/roles grants. There is
 * no HRM write service, API route, or change-request Flow adapter yet, so no
 * remedy points at one. Engine errors in this repository carry no i18n
 * catalog keys (only permission label keys exist); the codes above are the
 * stable contract the UI owner maps to catalog keys when wiring surfaces —
 * zero new web/messages keys are added in any locale by this slice.
 *
 * TEMPORAL RULES. asOf is a civil date (YYYY-MM-DD, parsed by temporal.ts —
 * malformed fails closed before any read). Employment status resolves at
 * (asOf, knownAt) through the same pure assembler the HRM read path uses;
 * knownAt defaults to the database clock projected in SQL (never a JS Date).
 * Manager routing reads currently-asserted reporting lines
 * (recorded_until IS NULL) whose effective window contains asOf — routing
 * always uses current knowledge and takes no knownAt. Only kind = 'line'
 * participates: matrix edges are simultaneous by design and must never read
 * as ambiguity.
 */

import { sql } from "drizzle-orm";
import { actorHasPermission } from "../actor-permissions.ts";
import { db, withOrgTransaction } from "../db.ts";
import {
  assembleEmploymentAsOf,
  type EmploymentStableRow,
  type EmploymentVersionRow,
} from "./employment-read.ts";
import { NoRevisionError, parseCivilDate, resolveAsOf } from "./temporal.ts";

/** Stable coded refusals of the employment-identity contract. */
export type PayrollContextCode =
  | "no_employment"
  | "ambiguous_employment"
  | "employer_mismatch"
  | "ambiguous_manager";

export class PayrollContextError extends Error {
  readonly code: PayrollContextCode;
  constructor(code: PayrollContextCode, message: string) {
    super(message);
    this.name = "PayrollContextError";
    this.code = code;
  }
}

/** The payroll.run duty the resolve functions enforce; denied actors land here. */
export class PayrollContextAuthorizationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayrollContextAuthorizationError";
  }
}

/**
 * Org-level stamp refusal: the whole org wrote nothing. Carries the people
 * (or rows) that need review, or the stamped rows that contradict the
 * resolver — the caller reports them, never drops them.
 */
export interface StampReviewEntry {
  readonly partyId: string;
  readonly reason: string;
  readonly detail: string;
}

export class StampRefusedError extends Error {
  readonly requiresReview: readonly StampReviewEntry[];
  constructor(message: string, requiresReview: readonly StampReviewEntry[]) {
    super(message);
    this.name = "StampRefusedError";
    this.requiresReview = requiresReview;
  }
}

export interface ResolveEmploymentQuery {
  readonly orgId: string;
  /** Payroll caller's actor: the payroll.run duty is enforced, never assumed. */
  readonly actorId: string;
  readonly partyId: string;
  readonly subsidiaryId: string;
  /** Civil effective date (YYYY-MM-DD) the status resolves at. */
  readonly asOf: string;
  /** As-known UTC instant text; defaults to the database clock (never JS Date). */
  readonly knownAt?: string;
}

export interface ResolvedPayrollEmployment {
  readonly employmentId: string;
  readonly employerSubsidiaryId: string;
  /** Stable revision of the snapshot the status was read from. */
  readonly revision: number;
  /** Effective status as-of (offered|active|on_leave|suspended|terminated). */
  readonly status: string;
  readonly versionNo: number;
}

export interface ResolveManagerQuery {
  readonly orgId: string;
  /** Payroll/Flows caller's actor: the payroll.run duty is enforced. */
  readonly actorId: string;
  readonly partyId: string;
  /** Civil effective date (YYYY-MM-DD) the reporting line resolves at. */
  readonly asOf: string;
}

export interface ManagerRouting {
  readonly employmentId: string;
  /** Resolved manager employment; null when no manager as-of / no supervisor. */
  readonly managerEmploymentId: string | null;
  /** Resolved manager person; null when no manager as-of / no supervisor. */
  readonly managerPartyId: string | null;
  /**
   * Which source answered: 'reporting' (reporting_relationships governs,
   * including its null answer) or 'supervisor' (employee_roles fallback —
   * managerEmploymentId is then null because a party is not an employment;
   * the Flows owner resolves it when wiring targets.ts).
   */
  readonly source: "reporting" | "supervisor";
}

/** The ten 0186 person-keyed payroll tables, in stamp order. */
const STAMP_TABLES = [
  "employee_payroll_profiles",
  "employee_pay_components",
  "employee_tax_certificates",
  "pay_stubs",
  "payroll_opening_balances",
  "entitlement_ledger",
  "entitlement_plan_limits",
  "payroll_retro_settlements",
  "pay_run_adjustments",
  "pay_run_holiday_assertions",
] as const;

type StampTable = (typeof STAMP_TABLES)[number];

/**
 * Tables the stamp reports but never rewrites: entitlement_ledger refuses
 * EVERY update (entitlement_ledger_append_only_guard — balance = SUM(amount),
 * so any rewrite breaks the audit trail). Pre-0186 ledger rows keep a null
 * link and are counted in `unstampable`; new ledger rows carry the link at
 * INSERT under the coherence trigger. Weakening that guard for a metadata
 * backfill is the entitlements owner's decision, not this slice's.
 */
const READ_ONLY_STAMP_TABLES: readonly StampTable[] = ["entitlement_ledger"] as const;

const WRITABLE_STAMP_TABLES: readonly StampTable[] = STAMP_TABLES.filter(
  (table): table is StampTable => !READ_ONLY_STAMP_TABLES.includes(table),
);

export interface StampOptions {
  readonly orgId: string;
  /** Payroll caller's actor: the payroll.run duty is enforced by the writer. */
  readonly actorId: string;
  readonly dryRun: boolean;
  /**
   * Stamp only the unambiguous people and list the rest. Without it any
   * single requires_review person refuses the whole org (nothing written).
   * A stamped row that DISAGREES with the resolver refuses either way.
   */
  readonly allowPartial?: boolean;
}

export interface StampReport {
  readonly orgId: string;
  readonly dryRun: boolean;
  /** Rows stamped by this run, per table. */
  readonly stamped: Record<StampTable, number>;
  /** Rows already carrying the resolved id (reported, never rewritten). */
  readonly alreadyStamped: Record<StampTable, number>;
  /**
   * Rows the stamp could not link because storage forbids rewriting them
   * (read-only tables above). Reported, never refused over, never written.
   */
  readonly unstampable: Partial<Record<StampTable, number>>;
  readonly stampedPeople: readonly string[];
  readonly requiresReview: readonly StampReviewEntry[];
}

/** UTC-instant wire format shared with employment-read.ts (RECORDED_TEXT). */
const RECORDED_TEXT = 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"' as const;

/** The duty this resolver serves: pay calculation runs on it. */
const RESOLVER_PERMISSION = "payroll.run" as const;

/** How many ids a refusal names before summarizing the remainder. */
const MAX_NAMED_IDS = 5;

function requireId(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${field} must be a non-empty id`);
  }
  return value;
}

function nameIds(ids: readonly string[]): string {
  const shown = ids.slice(0, MAX_NAMED_IDS).join(", ");
  return ids.length > MAX_NAMED_IDS
    ? `${shown}, and ${ids.length - MAX_NAMED_IDS} more`
    : shown;
}

async function requirePayrollRun(
  orgId: string,
  actorId: string,
): Promise<void> {
  if (!(await actorHasPermission(db, orgId, actorId, RESOLVER_PERMISSION))) {
    throw new PayrollContextAuthorizationError(
      `resolving payroll employment context requires the ${RESOLVER_PERMISSION} permission — ask an administrator to grant it in /admin/roles.`,
    );
  }
}

interface EmploymentIdentity {
  readonly id: string;
  readonly employerSubsidiaryId: string;
  readonly revision: number;
}

async function listEmployments(
  orgId: string,
  partyId: string,
): Promise<EmploymentIdentity[]> {
  const rows = (await db.execute<{
    id: string;
    employerSubsidiaryId: string;
    revision: number;
  }>(sql`
    select id,
           employer_subsidiary_id as "employerSubsidiaryId",
           revision
      from worker_employments
     where org_id = ${orgId} and worker_party_id = ${partyId}
     order by id`)).rows;
  return rows.map((row) => ({
    id: row.id,
    employerSubsidiaryId: row.employerSubsidiaryId,
    revision: row.revision,
  }));
}

function noEmployment(partyId: string): PayrollContextError {
  return new PayrollContextError(
    "no_employment",
    `no employment record for worker ${partyId} — create the employment (file an HRM employment change request for the hire, or correct the worker link in Admin → Users) and re-run; refusing to calculate without one`,
  );
}

function ambiguousEmployment(partyId: string, ids: readonly string[]): PayrollContextError {
  return new PayrollContextError(
    "ambiguous_employment",
    `worker ${partyId} has ${ids.length} employments (${nameIds(ids)}) — file an HRM employment change request to keep the single correct employment (a duplicate never merges silently; worker links remap only through the audited party merge) and re-run; refusing to pick one`,
  );
}

/** Single-employment resolution without a subsidiary filter (manager path). */
async function resolveSingleEmployment(
  orgId: string,
  partyId: string,
): Promise<EmploymentIdentity> {
  const employments = await listEmployments(orgId, partyId);
  if (employments.length === 0) throw noEmployment(partyId);
  if (employments.length > 1) {
    throw ambiguousEmployment(partyId, employments.map((item) => item.id));
  }
  return employments[0]!;
}

async function resolveStatusAsOf(args: {
  orgId: string;
  employment: EmploymentIdentity;
  workerPartyId: string;
  asOf: string;
  knownAt: string | null;
}): Promise<{ revision: number; status: string; versionNo: number }> {
  const knownAt =
    args.knownAt ??
    (await db.execute<{ at: string }>(sql`
      select to_char(now() at time zone 'UTC', ${RECORDED_TEXT}) as at`)).rows[0]!.at;
  const versions = (await db.execute<{
    id: string;
    versionNo: number;
    status: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    recordedAt: string;
    recordedUntil: string | null;
  }>(sql`
    select id::text as id, version_no as "versionNo", status,
           effective_from::text as "effectiveFrom",
           effective_to::text as "effectiveTo",
           to_char(recorded_at at time zone 'UTC', ${RECORDED_TEXT}) as "recordedAt",
           to_char(recorded_until at time zone 'UTC', ${RECORDED_TEXT}) as "recordedUntil"
      from worker_employment_versions
     where org_id = ${args.orgId} and employment_id = ${args.employment.id}
     order by version_no`)).rows;
  const stable: EmploymentStableRow = {
    id: args.employment.id,
    orgId: args.orgId,
    workerPartyId: args.workerPartyId,
    employerSubsidiaryId: args.employment.employerSubsidiaryId,
    revision: args.employment.revision,
  };
  const versionRows: EmploymentVersionRow[] = versions.map((row) => ({
    id: row.id,
    versionNo: row.versionNo,
    status: row.status,
    effectiveFrom: row.effectiveFrom,
    effectiveTo: row.effectiveTo,
    recordedAt: row.recordedAt,
    recordedUntil: row.recordedUntil,
  }));
  try {
    const assembled = assembleEmploymentAsOf(stable, versionRows, [], {
      effectiveDate: args.asOf,
      knownAt,
    });
    return {
      revision: assembled.revision,
      status: assembled.version.status,
      versionNo: assembled.version.versionNo,
    };
  } catch (error) {
    if (error instanceof NoRevisionError) {
      // The employment exists but no recorded state covers the date (not yet
      // hired as-of, or a coverage gap): there is no status to price from.
      // Same remedy as a missing employment, dated precisely.
      throw new PayrollContextError(
        "no_employment",
        `employment ${args.employment.id} has no recorded state as of ${args.asOf} — correct the employment's effective coverage with an HRM employment change request and re-run; refusing to price from no state`,
      );
    }
    throw error;
  }
}

/**
 * The single employment payroll prices a worker's pay under, with its
 * effective status as-of. Never picks among several; never ignores the
 * subsidiary the pay run belongs to.
 */
export async function resolveEmploymentForPayroll(
  query: ResolveEmploymentQuery,
): Promise<ResolvedPayrollEmployment> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const partyId = requireId("partyId", query.partyId);
  const subsidiaryId = requireId("subsidiaryId", query.subsidiaryId);
  // Malformed dates fail before any read or permission probe: the empty-chain
  // probe parses (effective, asKnown) and swallows the expected NoRevision.
  parseCivilDate(query.asOf);
  if (query.knownAt !== undefined) {
    try {
      resolveAsOf([], { effective: query.asOf, asKnown: query.knownAt });
    } catch (error) {
      if (!(error instanceof NoRevisionError)) throw error;
    }
  }
  return withOrgTransaction(orgId, async () => {
    await requirePayrollRun(orgId, actorId);
    const employments = await listEmployments(orgId, partyId);
    if (employments.length === 0) throw noEmployment(partyId);
    if (employments.length > 1) {
      throw ambiguousEmployment(partyId, employments.map((item) => item.id));
    }
    const employment = employments[0]!;
    if (employment.employerSubsidiaryId !== subsidiaryId) {
      throw new PayrollContextError(
        "employer_mismatch",
        `employment ${employment.id} belongs to employer ${employment.employerSubsidiaryId}, not pay subsidiary ${subsidiaryId} — transfer the worker (terminate + rehire: employer_subsidiary_id is immutable) with an HRM employment change request and re-run; refusing to price under the wrong employer`,
      );
    }
    const status = await resolveStatusAsOf({
      orgId,
      employment,
      workerPartyId: partyId,
      asOf: query.asOf,
      knownAt: query.knownAt ?? null,
    });
    return {
      employmentId: employment.id,
      employerSubsidiaryId: employment.employerSubsidiaryId,
      revision: status.revision,
      status: status.status,
      versionNo: status.versionNo,
    };
  });
}

/**
 * The manager a worker's pay notifications route to as-of a date.
 * Reporting lines govern; the employee_roles supervisor is ONLY the
 * pre-HRM fallback when the employment has no line relationship at all.
 * Do not change engine/src/flows/targets.ts here — the Flows owner wires
 * this export to the notification targets later.
 */
export async function resolveManagerForRouting(
  query: ResolveManagerQuery,
): Promise<ManagerRouting> {
  const orgId = requireId("orgId", query.orgId);
  const actorId = requireId("actorId", query.actorId);
  const partyId = requireId("partyId", query.partyId);
  parseCivilDate(query.asOf);
  return withOrgTransaction(orgId, async () => {
    await requirePayrollRun(orgId, actorId);
    const employment = await resolveSingleEmployment(orgId, partyId);
    // Currently-asserted line rows whose effective window contains asOf.
    const active = (await db.execute<{
      managerEmploymentId: string;
      managerPartyId: string;
    }>(sql`
      select distinct r.manager_employment_id as "managerEmploymentId",
             m.worker_party_id as "managerPartyId"
        from reporting_relationships r
        join worker_employments m
          on m.org_id = r.org_id and m.id = r.manager_employment_id
       where r.org_id = ${orgId}
         and r.employment_id = ${employment.id}
         and r.kind = 'line'
         and r.recorded_until is null
         and r.effective_from <= ${query.asOf}::date
         and (r.effective_to is null or r.effective_to > ${query.asOf}::date)`)).rows;
    const picked = pickActiveManager(active, { employmentId: employment.id, asOf: query.asOf });
    if (picked !== null) {
      return {
        employmentId: employment.id,
        managerEmploymentId: picked.managerEmploymentId,
        managerPartyId: picked.managerPartyId,
        source: "reporting" as const,
      };
    }
    // No active line as-of. Reporting still governs when the employment has
    // ANY line history (it says no one, as-of) — the supervisor fallback is
    // only for employments reporting never covered.
    const ever = (await db.execute<{ n: string }>(sql`
      select count(*)::text as n
        from reporting_relationships
       where org_id = ${orgId} and employment_id = ${employment.id} and kind = 'line'`)).rows[0]!.n;
    if (ever !== "0") {
      return {
        employmentId: employment.id,
        managerEmploymentId: null,
        managerPartyId: null,
        source: "reporting" as const,
      };
    }
    const role = (await db.execute<{ supervisorId: string | null }>(sql`
      select supervisor_id as "supervisorId"
        from employee_roles
       where org_id = ${orgId} and party_id = ${partyId}`)).rows[0] ?? null;
    return {
      employmentId: employment.id,
      managerEmploymentId: null,
      managerPartyId: role?.supervisorId ?? null,
      source: "supervisor" as const,
    };
  });
}

/**
 * Dry-run rollback signal: thrown THROUGH withOrgTransaction so the write
 * path's updates roll back, caught outside the transaction to deliver the
 * report. Returning the report inside the callback would COMMIT the writes.
 */
class StampRollback extends Error {
  readonly report: StampReport;
  constructor(report: StampReport) {
    super("dry-run rollback");
    this.name = "StampRollback";
    this.report = report;
  }
}

/** One currently-asserted line manager behind a routing decision. */
export interface ActiveManager {
  readonly managerEmploymentId: string;
  readonly managerPartyId: string;
}

/**
 * Pure routing choice over the active line managers as-of a date: none is a
 * legitimate null answer, one wins, two distinct managers refuse. Same
 * manager on two rows (dual-recorded evidence) still routes unambiguously.
 * Pure so the refusal condition is unit-proven: the 0184 single_line
 * exclusion makes two live lines unseedable in storage, so no DB fixture can
 * reach the throw — the DB suite proves the exclusion holds instead.
 */
export function pickActiveManager(
  active: readonly ActiveManager[],
  context: { employmentId: string; asOf: string },
): ActiveManager | null {
  const managers = [...active].sort((a, b) =>
    a.managerEmploymentId < b.managerEmploymentId ? -1 : 1,
  );
  const distinct = [...new Set(managers.map((row) => row.managerEmploymentId))];
  if (distinct.length > 1) {
    throw new PayrollContextError(
      "ambiguous_manager",
      `employment ${context.employmentId} reports to ${distinct.length} managers as of ${context.asOf} (${nameIds(distinct)}) — correct reporting_relationships with an HRM employment change request and re-run; refusing to pick one`,
    );
  }
  return managers[0] ?? null;
}

/**
 * One-time backfill of the 0186 employment_id columns for one org.
 *
 * A person stamps ONLY when they hold EXACTLY ONE worker_employments row
 * whose employer matches the party's own subsidiary (parties.subsidiary_id):
 * zero employments, several, or an employer mismatch lands the person in
 * requires_review with the reason. Without allowPartial any such person
 * refuses the whole org (nothing written); with it, only the unambiguous
 * people stamp. Already-stamped rows are counted, never rewritten; a stamped
 * row that disagrees with the resolver refuses the org either way — history
 * that contradicts the resolver is evidence, not an overwrite target.
 *
 * Nine tables stamp; entitlement_ledger only reports (see
 * READ_ONLY_STAMP_TABLES): its append-only guard refuses every UPDATE, so
 * pre-0186 ledger rows keep a null link and are counted in `unstampable`.
 */
export async function stampEmploymentContext(options: StampOptions): Promise<StampReport> {
  const orgId = requireId("orgId", options.orgId);
  const actorId = requireId("actorId", options.actorId);
  const allowPartial = options.allowPartial ?? false;
  const dryRun = options.dryRun;
  try {
    return await withOrgTransaction(orgId, async () => {
      // The writer checks first: no tenant row is read or written before the
      // duty is proven — a dry-run preview is a read of nine tables too.
      await requirePayrollRun(orgId, actorId);
    // People with payroll rows, with their party subsidiary for the match.
    const people = (await db.execute<{ partyId: string; subsidiaryId: string | null }>(sql`
      select p.id as "partyId", p.subsidiary_id as "subsidiaryId"
        from parties p
       where p.org_id = ${orgId}
         and exists (
           select 1 from employee_payroll_profiles t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from employee_pay_components t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from employee_tax_certificates t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from pay_stubs t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from payroll_opening_balances t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from entitlement_ledger t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from entitlement_plan_limits t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from payroll_retro_settlements t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from pay_run_adjustments t where t.org_id = ${orgId} and t.employee_party_id = p.id
           union all select 1 from pay_run_holiday_assertions t where t.org_id = ${orgId} and t.employee_party_id = p.id
         )
       order by p.id`)).rows;
    const employments = (await db.execute<{
      id: string;
      workerPartyId: string;
      employerSubsidiaryId: string;
    }>(sql`
      select id, worker_party_id as "workerPartyId",
             employer_subsidiary_id as "employerSubsidiaryId"
        from worker_employments
       where org_id = ${orgId}
       order by id`)).rows;
    const byWorker = new Map<string, { id: string; employerSubsidiaryId: string }[]>();
    for (const item of employments) {
      const list = byWorker.get(item.workerPartyId) ?? [];
      list.push({ id: item.id, employerSubsidiaryId: item.employerSubsidiaryId });
      byWorker.set(item.workerPartyId, list);
    }
    const resolved = new Map<string, string>();
    const requiresReview: StampReviewEntry[] = [];
    for (const person of people) {
      const held = byWorker.get(person.partyId) ?? [];
      if (held.length === 0) {
        requiresReview.push({
          partyId: person.partyId,
          reason: "no_employment",
          detail: "no worker_employments row for this worker — create the employment first",
        });
        continue;
      }
      if (held.length > 1) {
        requiresReview.push({
          partyId: person.partyId,
          reason: "ambiguous_employment",
          detail: `holds ${held.length} employments (${nameIds(held.map((item) => item.id))}) — keep the single correct one first`,
        });
        continue;
      }
      const only = held[0]!;
      if (person.subsidiaryId === null || only.employerSubsidiaryId !== person.subsidiaryId) {
        requiresReview.push({
          partyId: person.partyId,
          reason: "employer_mismatch",
          detail: `employment ${only.id} belongs to employer ${only.employerSubsidiaryId}, not party subsidiary ${person.subsidiaryId ?? "unknown"} — transfer first`,
        });
        continue;
      }
      resolved.set(person.partyId, only.id);
    }
    if (requiresReview.length > 0 && !allowPartial) {
      throw new StampRefusedError(
        `employment stamp refused for ${requiresReview.length} of ${people.length} people with payroll rows (first: ${requiresReview[0]!.partyId} — ${requiresReview[0]!.reason}); nothing was written — pass allowPartial to stamp only the unambiguous people, or resolve every listed person and re-run`,
        requiresReview,
      );
    }
    // Every resolved person is stampable here: without allowPartial any
    // requires_review already refused above, and with it only unambiguous
    // people resolve.
    const targetPeople = [...resolved.keys()];
    // A stamped row that disagrees with the resolver refuses the org: the
    // resolver is the identity authority, and contradicting history is
    // evidence to reconcile, never to overwrite — under allowPartial too.
    const conflicts: StampReviewEntry[] = [];
    for (const table of STAMP_TABLES) {
      const rows = (await db.execute<{ partyId: string; employmentId: string }>(sql`
        select employee_party_id as "partyId", employment_id as "employmentId"
          from ${sql.identifier(table)}
         where org_id = ${orgId} and employment_id is not null`)).rows;
      for (const row of rows) {
        const expected = resolved.get(row.partyId);
        if (expected === undefined || expected !== row.employmentId) {
          conflicts.push({
            partyId: row.partyId,
            reason: "conflicting_stamp",
            detail: `${table} already names employment ${row.employmentId} but the resolver ${expected === undefined ? "holds no unambiguous employment" : `resolves ${expected}`} — reconcile before stamping`,
          });
        }
      }
    }
    if (conflicts.length > 0) {
      throw new StampRefusedError(
        `employment stamp refused: ${conflicts.length} stamped rows disagree with the resolver (first: ${conflicts[0]!.detail}); nothing was written — reconcile the listed rows and re-run`,
        conflicts,
      );
    }
    const stamped = Object.fromEntries(STAMP_TABLES.map((table) => [table, 0])) as Record<StampTable, number>;
    const alreadyStamped = Object.fromEntries(STAMP_TABLES.map((table) => [table, 0])) as Record<StampTable, number>;
    const unstampable: Partial<Record<StampTable, number>> = {};
    // Explicit value list: bare JS arrays interpolate as row constructors in
    // drizzle SQL, never as IN-lists, so the list is joined element-wise.
    const targetList = targetPeople.length === 0
      ? sql`false`
      : sql`employee_party_id in (${sql.join(targetPeople.map((partyId) => sql`${partyId}`), sql`, `)})`;
    for (const table of WRITABLE_STAMP_TABLES) {
      const already = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n
          from ${sql.identifier(table)}
         where org_id = ${orgId} and employment_id is not null and ${targetList}`)).rows[0]!.n;
      alreadyStamped[table] = Number(already);
      for (const partyId of targetPeople) {
        await db.execute(sql`
          update ${sql.identifier(table)} set employment_id = ${resolved.get(partyId)!}
           where org_id = ${orgId}
             and employee_party_id = ${partyId}
             and employment_id is null`);
      }
    }
    // Recount per table for the report: rows now carrying an id minus those
    // already stamped equals this run's writes, because conflicting stamps
    // refused above and only nulls were written.
    for (const table of WRITABLE_STAMP_TABLES) {
      const now = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n
          from ${sql.identifier(table)}
         where org_id = ${orgId} and employment_id is not null and ${targetList}`)).rows[0]!.n;
      stamped[table] = Number(now) - alreadyStamped[table]!;
    }
    // Read-only tables are counted, never written.
    for (const table of READ_ONLY_STAMP_TABLES) {
      const left = (await db.execute<{ n: string }>(sql`
        select count(*)::text as n
          from ${sql.identifier(table)}
         where org_id = ${orgId} and employment_id is null and ${targetList}`)).rows[0]!.n;
      if (Number(left) > 0) unstampable[table] = Number(left);
    }
    const report: StampReport = {
      orgId,
      dryRun,
      stamped,
      alreadyStamped,
      unstampable,
      stampedPeople: targetPeople,
      requiresReview,
    };
    // Dry-run proves the write path, then rolls everything back: the throw
    // must ESCAPE withOrgTransaction (returning here would commit).
    if (dryRun) throw new StampRollback(report);
    return report;
    });
  } catch (error) {
    if (error instanceof StampRollback) return error.report;
    throw error;
  }
}
