import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { actorAllowedSubsidiaryIds } from "../organization/actor-subsidiaries.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { requireAggregatePositionRead, requireHrmPositionRead } from "./authorization.ts";
import { HRM_FEATURE_KEY, likeEscape } from "./employment-read.ts";
import {
  computeVacancy,
  formatFte,
  HrmPositionError,
  parseFte,
  positionDisagreements,
  vacancyRefusalFor,
  type PositionVersionDTO,
  type VacancyResult,
} from "./positions.ts";
import {
  AmbiguousRevisionError,
  NoRevisionError,
  parseCivilDate,
  resolveAsOf,
} from "./temporal.ts";

/**
 * Canonical as-of position READ service (no mutations).
 *
 * Reads the 0192 headcount-plan tables: positions (stable) +
 * position_versions (bitemporal) + position_funding (plan rows) +
 * employment_assignment_versions.position_id (holders). Resolution
 * delegates to temporal.ts exactly like the employment read service:
 * recorded filter first, then effective membership; zero applicable
 * revisions for a position at the as-of point is legitimate absence from
 * an as-of LIST (the establishment does not cover that date), while the
 * single-position read refuses it by name. More than one applicable
 * revision at either level fails the whole read — never a silent choice.
 *
 * Vacancy is planned versus funded versus filled FTE, all in exact
 * ten-thousandths (never floats): filled sums the live PRIMARY assignment
 * versions naming the position (the same primary semantics headcount
 * counts by); funded sums the plan rows whose fiscal period contains the
 * as-of date. A breached plan (over-filled, under-funded) travels as DATA
 * on the row — the read must keep rendering a breach, never hide it —
 * with the coded refusal class and remedy intact.
 *
 * Authority is the aggregate half (grant + employer-subsidiary scope).
 * Holder employments are filtered to the reader's allowed subsidiaries; a
 * referenced subsidiary or department with no name row is a refusal:
 * vacancy must never be misattributed.
 */

async function assertPositionFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPositionError(
      "REFUSED",
      "hrm feature is disabled: enable it on Company Settings → Features before reading positions",
    );
  }
}

type StoredPositionVersion = {
  id: string;
  position_id: string;
  version_no: number;
  title: string;
  department_id: string | null;
  location_id: string | null;
  employer_subsidiary_id: string;
  job_grade: string | null;
  planned_fte: string;
  status: string;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
};

function toVersionDTO(row: StoredPositionVersion): PositionVersionDTO {
  return {
    versionId: row.id,
    versionNo: row.version_no,
    title: row.title,
    departmentId: row.department_id,
    locationId: row.location_id,
    employerSubsidiaryId: row.employer_subsidiary_id,
    jobGrade: row.job_grade,
    plannedFte: row.planned_fte,
    status: row.status,
    effectiveFrom: row.effective_from,
    effectiveTo: row.effective_to,
    recordedAt: row.recorded_at,
    recordedUntil: row.recorded_until,
  };
}

function toRevision(row: StoredPositionVersion) {
  return {
    effective: {
      start: parseCivilDate(row.effective_from),
      end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
    },
    recordedAt: row.recorded_at,
    recordedUntil: row.recorded_until,
    payload: row,
  };
}

const VERSION_COLUMNS = sql`
  id, position_id::text as position_id, version_no, title,
  department_id::text as department_id, location_id::text as location_id,
  employer_subsidiary_id::text as employer_subsidiary_id, job_grade,
  planned_fte::text as planned_fte, status,
  effective_from::text as effective_from,
  effective_to::text as effective_to,
  to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
  to_char(recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_until
`;

async function loadAllVersions(
  exec: SqlExecutor,
  orgId: string,
  positionIds: readonly string[],
): Promise<Map<string, StoredPositionVersion[]>> {
  const byPosition = new Map<string, StoredPositionVersion[]>();
  if (positionIds.length === 0) return byPosition;
  const ids = positionIds.map((id) => sql`${id}::uuid`);
  const rows = (await exec.execute<StoredPositionVersion>(sql`
    select ${VERSION_COLUMNS}
      from position_versions
     where org_id = ${orgId}::uuid and position_id in (${sql.join(ids, sql`, `)})
     order by position_id, version_no`)).rows;
  for (const row of rows) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }
  return byPosition;
}

type FundingPlanRow = {
  id: string;
  position_id: string;
  period_id: string;
  funded_fte: string;
  funding_source_id: string | null;
  amount: string | null;
  currency: string | null;
  period_starts_on: string;
  period_ends_on: string;
};

async function loadFundingRows(
  exec: SqlExecutor,
  orgId: string,
  positionIds: readonly string[],
): Promise<Map<string, FundingPlanRow[]>> {
  const byPosition = new Map<string, FundingPlanRow[]>();
  if (positionIds.length === 0) return byPosition;
  const ids = positionIds.map((id) => sql`${id}::uuid`);
  const rows = (await exec.execute<FundingPlanRow>(sql`
    select f.id::text as id, f.position_id::text as position_id,
           f.period_id::text as period_id, f.funded_fte::text as funded_fte,
           f.funding_source_id::text as funding_source_id,
           f.amount::text as amount, f.currency,
           p.starts_on::text as period_starts_on, p.ends_on::text as period_ends_on
      from position_funding f
      join accounting_periods p on p.id = f.period_id
     where f.org_id = ${orgId}::uuid and f.position_id in (${sql.join(ids, sql`, `)})
     order by f.position_id, p.starts_on`)).rows;
  for (const row of rows) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }
  return byPosition;
}

type HolderVersionRow = {
  assignment_id: string;
  assignment_key: string;
  employment_id: string;
  employer_subsidiary_id: string;
  worker_party_id: string;
  version_no: number;
  job_title: string | null;
  department_id: string | null;
  location_id: string | null;
  fte: string;
  is_primary: boolean;
  effective_from: string;
  effective_to: string | null;
  recorded_at: string;
  recorded_until: string | null;
};

async function loadHolderVersions(
  exec: SqlExecutor,
  orgId: string,
  positionIds: readonly string[],
): Promise<Map<string, HolderVersionRow[]>> {
  const byPosition = new Map<string, HolderVersionRow[]>();
  if (positionIds.length === 0) return byPosition;
  const ids = positionIds.map((id) => sql`${id}::uuid`);
  const rows = (await exec.execute<HolderVersionRow & { position_id: string }>(sql`
    select av.position_id::text as position_id,
           av.assignment_id::text as assignment_id, a.assignment_key,
           av.employment_id::text as employment_id,
           e.employer_subsidiary_id::text as employer_subsidiary_id,
           e.worker_party_id::text as worker_party_id,
           av.version_no, av.job_title,
           av.department_id::text as department_id,
           av.location_id::text as location_id,
           av.fte::text as fte, av.is_primary,
           av.effective_from::text as effective_from,
           av.effective_to::text as effective_to,
           to_char(av.recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
           to_char(av.recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_until
      from employment_assignment_versions av
      join employment_assignments a on a.id = av.assignment_id and a.org_id = av.org_id
      join worker_employments e on e.id = av.employment_id and e.org_id = av.org_id
     where av.org_id = ${orgId}::uuid and av.position_id in (${sql.join(ids, sql`, `)})
     order by av.position_id, av.assignment_id, av.version_no`)).rows;
  for (const row of rows) {
    const list = byPosition.get(row.position_id) ?? [];
    list.push(row);
    byPosition.set(row.position_id, list);
  }
  return byPosition;
}

export interface PositionHolderDTO {
  readonly employmentId: string;
  readonly workerPartyId: string;
  readonly assignmentKey: string;
  readonly jobTitle: string | null;
  readonly fte: string;
}

export interface PositionVacancyDTO extends VacancyResult {
  /** Coded breach with remedy, or null when the plan covers the holder. */
  readonly refusal: { code: "OVER_FILLED" | "UNDER_FUNDED"; message: string } | null;
}

export interface PositionRowDTO {
  readonly id: string;
  readonly positionCode: string;
  readonly revision: number;
  readonly version: PositionVersionDTO;
  readonly vacancy: PositionVacancyDTO;
  /** No-silent-inheritance warnings between the position and its holders. */
  readonly disagreementWarnings: readonly string[];
  readonly holders: readonly PositionHolderDTO[];
}

export interface VacancyQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Civil effective date (YYYY-MM-DD). */
  readonly effectiveDate: string;
  /** As-known UTC instant (YYYY-MM-DDTHH:mm:ss[.fraction]Z). */
  readonly knownAt: string;
  /** Keep only this lifecycle status; omit for every status. */
  readonly status?: string;
}

type ResolvedHolder = {
  readonly dto: PositionHolderDTO;
  readonly departmentId: string | null;
  readonly locationId: string | null;
};

function resolveHolderChains(
  rows: readonly HolderVersionRow[],
  query: Pick<VacancyQuery, "effectiveDate" | "knownAt">,
  positionCode: string,
  allowed: Set<string> | null,
): { holders: ResolvedHolder[]; filledTenths: bigint } {
  const holders: ResolvedHolder[] = [];
  let filledTenths = 0n;
  const byAssignment = new Map<string, HolderVersionRow[]>();
  for (const row of rows) {
    // Holder employments outside the reader's legal-entity scope are
    // filtered, never returned: scope is a filter on data, not a refusal
    // of the position read.
    if (allowed !== null && !allowed.has(row.employer_subsidiary_id)) continue;
    const list = byAssignment.get(row.assignment_id) ?? [];
    list.push(row);
    byAssignment.set(row.assignment_id, list);
  }
  for (const [assignmentId, versions] of byAssignment) {
    let live;
    try {
      live = resolveAsOf(
        versions.map((row) => ({
          effective: {
            start: parseCivilDate(row.effective_from),
            end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
          },
          recordedAt: row.recorded_at,
          recordedUntil: row.recorded_until,
          payload: row,
        })),
        { effective: query.effectiveDate, asKnown: query.knownAt },
      );
    } catch (error) {
      // Not on this position at the as-of point (or not yet recorded):
      // legitimately absent, never a gap failure. Ambiguity propagates
      // and fails the read — a silently picked holder is how headcount
      // goes missing.
      if (error instanceof NoRevisionError) continue;
      if (error instanceof AmbiguousRevisionError) {
        throw new HrmPositionError(
          "REFUSED",
          `position ${positionCode} assignment ${assignmentId} resolves ambiguously — supersede all but one revision before reading vacancy`,
        );
      }
      throw error;
    }
    const row = live.payload;
    if (!row.is_primary) continue;
    holders.push({
      dto: {
        employmentId: row.employment_id,
        workerPartyId: row.worker_party_id,
        assignmentKey: row.assignment_key,
        jobTitle: row.job_title,
        fte: row.fte,
      },
      departmentId: row.department_id,
      locationId: row.location_id,
    });
    filledTenths += parseFte(row.fte);
  }
  holders.sort((a, b) =>
    a.dto.employmentId < b.dto.employmentId ? -1 : a.dto.employmentId > b.dto.employmentId ? 1 : 0,
  );
  return { holders, filledTenths };
}

function buildRow(args: {
  id: string;
  positionCode: string;
  revision: number;
  version: StoredPositionVersion;
  funding: readonly FundingPlanRow[];
  holderRows: readonly HolderVersionRow[];
  allowed: Set<string> | null;
  query: Pick<VacancyQuery, "effectiveDate" | "knownAt">;
}): PositionRowDTO {
  const { holders, filledTenths } = resolveHolderChains(args.holderRows, args.query, args.positionCode, args.allowed);
  let fundedTenths = 0n;
  for (const row of args.funding) {
    if (row.period_starts_on <= args.query.effectiveDate && args.query.effectiveDate <= row.period_ends_on) {
      fundedTenths += parseFte(row.funded_fte);
    }
  }
  const vacancy = computeVacancy({
    plannedFte: args.version.planned_fte,
    fundedFte: formatFte(fundedTenths),
    filledFte: formatFte(filledTenths),
  });
  const refusal = vacancyRefusalFor(args.positionCode, vacancy);
  const disagreementWarnings = holders.flatMap((holder) =>
    positionDisagreements(
      args.positionCode,
      { title: args.version.title, departmentId: args.version.department_id, locationId: args.version.location_id },
      { title: holder.dto.jobTitle, departmentId: holder.departmentId, locationId: holder.locationId },
    ),
  );
  return {
    id: args.id,
    positionCode: args.positionCode,
    revision: args.revision,
    version: toVersionDTO(args.version),
    vacancy: {
      ...vacancy,
      refusal: refusal === null ? null : { code: refusal.code, message: refusal.message },
    },
    disagreementWarnings,
    holders: holders.map((holder) => holder.dto),
  };
}

type StablePosition = { id: string; positionCode: string; revision: number };

async function loadStablePositions(exec: SqlExecutor, orgId: string): Promise<StablePosition[]> {
  const rows = (await exec.execute<{ id: string; positionCode: string; revision: number }>(sql`
    select id::text as id, position_code as "positionCode", revision
      from positions
     where org_id = ${orgId}::uuid
     order by position_code`)).rows;
  return rows.map((row) => ({ id: row.id, positionCode: row.positionCode, revision: row.revision }));
}

function validateVacancyQuery(query: VacancyQuery): void {
  parseCivilDate(query.effectiveDate);
  try {
    resolveAsOf([], { effective: query.effectiveDate, asKnown: query.knownAt });
  } catch (error) {
    if (error instanceof NoRevisionError) return;
    throw error;
  }
}

async function resolveRows(
  exec: SqlExecutor,
  orgId: string,
  allowed: Set<string> | null,
  query: VacancyQuery,
): Promise<PositionRowDTO[]> {
  validateVacancyQuery(query);
  const stable = await loadStablePositions(exec, orgId);
  if (stable.length === 0) return [];
  const ids = stable.map((row) => row.id);
  const versionsByPosition = await loadAllVersions(exec, orgId, ids);
  const fundingByPosition = await loadFundingRows(exec, orgId, ids);
  const holdersByPosition = await loadHolderVersions(exec, orgId, ids);
  const rows: PositionRowDTO[] = [];
  for (const position of stable) {
    let resolved;
    try {
      resolved = resolveAsOf(
        (versionsByPosition.get(position.id) ?? []).map(toRevision),
        { effective: query.effectiveDate, asKnown: query.knownAt },
      );
    } catch (error) {
      // The establishment does not cover the as-of date (or was never
      // recorded then): legitimately absent from an as-of list, never a
      // gap failure. Ambiguity fails the read — a silently picked version
      // is how vacancy goes missing.
      if (error instanceof NoRevisionError) continue;
      throw error;
    }
    const version = resolved.payload;
    if (allowed !== null && !allowed.has(version.employer_subsidiary_id)) continue;
    if (query.status !== undefined && version.status !== query.status) continue;
    rows.push(
      buildRow({
        id: position.id,
        positionCode: position.positionCode,
        revision: position.revision,
        version,
        funding: fundingByPosition.get(position.id) ?? [],
        holderRows: holdersByPosition.get(position.id) ?? [],
        allowed,
        query,
      }),
    );
  }
  return rows;
}

export interface PositionDetailDTO extends PositionRowDTO {
  readonly funding: readonly {
    readonly id: string;
    readonly periodId: string;
    readonly periodStartsOn: string;
    readonly periodEndsOn: string;
    readonly fundedFte: string;
    readonly fundingSourceId: string | null;
    readonly amount: string | null;
    readonly currency: string | null;
  }[];
}

export interface VacancyTotalsDTO {
  readonly positions: number;
  readonly plannedFte: string;
  readonly fundedFte: string;
  readonly filledFte: string;
  readonly vacantFte: string;
  /** Filled FTE with no funding behind it — the headline plan gap. */
  readonly unfundedFilledFte: string;
}

export interface VacancyGroupDTO {
  readonly departmentId: string | null;
  readonly departmentName: string | null;
  readonly employerSubsidiaryId: string;
  readonly employerSubsidiaryName: string;
  readonly positions: number;
  readonly plannedFte: string;
  readonly fundedFte: string;
  readonly filledFte: string;
  readonly vacantFte: string;
}

export interface VacancyDTO {
  readonly orgId: string;
  readonly effectiveDate: string;
  readonly knownAt: string;
  readonly totals: VacancyTotalsDTO;
  readonly byDepartment: readonly VacancyGroupDTO[];
  readonly positions: readonly PositionRowDTO[];
}

function sumTenths(values: readonly string[]): bigint {
  return values.reduce((total, value) => total + parseFte(value), 0n);
}

async function namesById(
  exec: SqlExecutor,
  orgId: string,
  table: "subsidiaries" | "departments",
  ids: readonly string[],
): Promise<Map<string, string>> {
  if (ids.length === 0) return new Map();
  const params = ids.map((id) => sql`${id}::uuid`);
  const rows = (await exec.execute<{ id: string; name: string }>(sql`
    select id::text as id, name from ${table === "subsidiaries" ? sql`subsidiaries` : sql`departments`}
     where org_id = ${orgId}::uuid and id in (${sql.join(params, sql`, `)})`)).rows;
  return new Map(rows.map((row) => [row.id, row.name] as const));
}

/**
 * Vacancy as of (effectiveDate, knownAt): every established position with
 * its planned/funded/filled/vacant FTE, plus department and subsidiary
 * aggregates and org totals. Read-only; authorization is the aggregate
 * half (grant + employer-subsidiary scope).
 */
export async function loadVacancyAsOf(exec: SqlExecutor, query: VacancyQuery): Promise<VacancyDTO> {
  const orgId = query.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  if (typeof query.actorId !== "string" || query.actorId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "actorId must be a non-empty string");
  }
  const allowed = await requireAggregatePositionRead(exec, orgId, query.actorId);
  const positions = await resolveRows(exec, orgId, allowed, query);
  const subsidiaryIds = [...new Set(positions.map((row) => row.version.employerSubsidiaryId))];
  const departmentIds = [
    ...new Set(
      positions.map((row) => row.version.departmentId).filter((id): id is string => id !== null),
    ),
  ];
  const subsidiaryNames = await namesById(exec, orgId, "subsidiaries", subsidiaryIds);
  const departmentNames = await namesById(exec, orgId, "departments", departmentIds);
  const grouped = new Map<string, VacancyGroupDTO & { planned: bigint; funded: bigint; filled: bigint }>();
  for (const row of positions) {
    const subsidiaryName = subsidiaryNames.get(row.version.employerSubsidiaryId);
    if (subsidiaryName === undefined) {
      throw new HrmPositionError(
        "REFUSED",
        `vacancy references subsidiary ${row.version.employerSubsidiaryId} with no subsidiaries row; refusing a misattributed count`,
      );
    }
    let departmentName: string | null = null;
    if (row.version.departmentId !== null) {
      const resolved = departmentNames.get(row.version.departmentId);
      if (resolved === undefined) {
        throw new HrmPositionError(
          "REFUSED",
          `vacancy references department ${row.version.departmentId} with no departments row; refusing a misattributed count`,
        );
      }
      departmentName = resolved;
    }
    const key = `${row.version.employerSubsidiaryId} ${row.version.departmentId ?? ""}`;
    const existing = grouped.get(key);
    const planned = parseFte(row.vacancy.plannedFte);
    const funded = parseFte(row.vacancy.fundedFte);
    const filled = parseFte(row.vacancy.filledFte);
    if (existing) {
      grouped.set(key, {
        ...existing,
        positions: existing.positions + 1,
        planned: existing.planned + planned,
        funded: existing.funded + funded,
        filled: existing.filled + filled,
      });
    } else {
      grouped.set(key, {
        departmentId: row.version.departmentId,
        departmentName,
        employerSubsidiaryId: row.version.employerSubsidiaryId,
        employerSubsidiaryName: subsidiaryName,
        positions: 1,
        plannedFte: "",
        fundedFte: "",
        filledFte: "",
        vacantFte: "",
        planned,
        funded,
        filled,
      });
    }
  }
  const byDepartment = [...grouped.values()]
    .map((group) => ({
      departmentId: group.departmentId,
      departmentName: group.departmentName,
      employerSubsidiaryId: group.employerSubsidiaryId,
      employerSubsidiaryName: group.employerSubsidiaryName,
      positions: group.positions,
      plannedFte: formatFte(group.planned),
      fundedFte: formatFte(group.funded),
      filledFte: formatFte(group.filled),
      vacantFte: formatFte(group.planned - group.filled),
    }))
    .sort((a, b) => {
      if (a.employerSubsidiaryName !== b.employerSubsidiaryName) {
        return a.employerSubsidiaryName < b.employerSubsidiaryName ? -1 : 1;
      }
      if (a.departmentName === b.departmentName) return 0;
      if (a.departmentName === null) return 1;
      if (b.departmentName === null) return -1;
      return a.departmentName < b.departmentName ? -1 : 1;
    });
  const planned = sumTenths(positions.map((row) => row.vacancy.plannedFte));
  const funded = sumTenths(positions.map((row) => row.vacancy.fundedFte));
  const filled = sumTenths(positions.map((row) => row.vacancy.filledFte));
  const unfunded = filled > funded ? filled - funded : 0n;
  return {
    orgId,
    effectiveDate: query.effectiveDate,
    knownAt: query.knownAt,
    totals: {
      positions: positions.length,
      plannedFte: formatFte(planned),
      fundedFte: formatFte(funded),
      filledFte: formatFte(filled),
      vacantFte: formatFte(planned - filled),
      unfundedFilledFte: formatFte(unfunded),
    },
    byDepartment,
    positions,
  };
}

/**
 * Public boundary: one tenant-scoped transaction, the authoritative HRM
 * feature gate rechecked inside it, then the authorized vacancy. Read
 * only: no mutations, no payroll fanout.
 */
export async function getVacancyAsOf(query: VacancyQuery): Promise<VacancyDTO> {
  const orgId = query.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  return withOrgTransaction(orgId, async () => {
    await assertPositionFeature(db, orgId);
    return loadVacancyAsOf(db, query);
  });
}

export interface PositionOptionsQuery {
  readonly orgId: string;
  readonly actorId: string;
  /** Substring match on the code or title; empty matches all. */
  readonly q?: string;
  /** Bounded page size; defaults to 25, refuses above 100. */
  readonly limit?: number;
  /** Position id to pin first (the draft's stored value under edit). */
  readonly includePositionId?: string;
}

export interface PositionOptionDTO {
  readonly positionId: string;
  readonly label: string;
}

/**
 * Position options for the assignment picker: code, current title and
 * lifecycle status. Same aggregate authority as the vacancy read; a
 * position is visible only when its current version's employer sits inside
 * the actor's scope. Closed positions still list — whether a closed
 * establishment takes a holder is the service's decision, never a
 * picker-side hiding. An unknown or out-of-scope id stays absent rather
 * than leaking existence.
 */
export async function listPositionOptions(query: PositionOptionsQuery): Promise<readonly PositionOptionDTO[]> {
  const orgId = query.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  if (typeof query.actorId !== "string" || query.actorId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "actorId must be a non-empty string");
  }
  const limit = query.limit ?? 25;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) {
    throw new HrmPositionError("INVALID_INPUT", "limit must be an integer between 1 and 100");
  }
  return withOrgTransaction(orgId, async () => {
    await assertPositionFeature(db, orgId);
    const allowed = await requireAggregatePositionRead(db, orgId, query.actorId);
    const fragment = (query.q ?? "").trim();
    const includeId = query.includePositionId?.trim() ? query.includePositionId.trim() : null;
    type OptionRow = {
      positionId: string;
      code: string;
      title: string;
      status: string;
      subsidiaryId: string;
    };
    const page = (await db.execute<OptionRow>(sql`
      select p.id::text as "positionId", p.position_code as code,
             v.title, v.status,
             v.employer_subsidiary_id::text as "subsidiaryId"
        from positions p
        join lateral (
          select title, status, employer_subsidiary_id
            from position_versions
           where org_id = p.org_id and position_id = p.id and recorded_until is null
           order by version_no desc
           limit 1
        ) v on true
       where p.org_id = ${orgId}::uuid
         ${fragment ? sql`and (p.position_code ilike ${`%${likeEscape(fragment)}%`} escape '\\' or v.title ilike ${`%${likeEscape(fragment)}%`} escape '\\')` : sql``}
       order by p.position_code, p.id
       limit ${limit}`)).rows.filter(
      (row) => allowed === null || allowed.has(row.subsidiaryId),
    );
    const pinned = includeId
      ? (await db.execute<OptionRow>(sql`
        select p.id::text as "positionId", p.position_code as code,
               v.title, v.status,
               v.employer_subsidiary_id::text as "subsidiaryId"
          from positions p
          join lateral (
            select title, status, employer_subsidiary_id
              from position_versions
             where org_id = p.org_id and position_id = p.id and recorded_until is null
             order by version_no desc
             limit 1
          ) v on true
         where p.org_id = ${orgId}::uuid and p.id = ${includeId}::uuid`)).rows.filter(
          (row) => allowed === null || allowed.has(row.subsidiaryId),
        )[0] ?? null
      : null;
    const rows = pinned
      ? [pinned, ...page.filter((row) => row.positionId !== pinned.positionId)]
      : page;
    return rows.map((row) => ({
      positionId: row.positionId,
      label: `${row.code} · ${row.title} · ${row.status}`,
    }));
  });
}

export interface PositionAsOfQuery extends VacancyQuery {
  readonly positionId: string;
}

/**
 * One position as of (effectiveDate, knownAt): the applicable version, the
 * funding plan by period, the current holders with disagreement warnings,
 * and the vacancy with its coded refusal. A position with no applicable
 * version at the as-of point is a named refusal here (unlike the list,
 * where it is legitimately absent).
 */
export async function getPositionAsOf(query: PositionAsOfQuery): Promise<PositionDetailDTO> {
  const orgId = query.orgId;
  if (typeof orgId !== "string" || orgId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "orgId must be a non-empty string");
  }
  if (typeof query.positionId !== "string" || query.positionId.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", "positionId must be a non-empty string");
  }
  return withOrgTransaction(orgId, async () => {
    await assertPositionFeature(db, orgId);
    const subject = await requireHrmPositionRead(db, orgId, query.actorId, query.positionId);
    validateVacancyQuery(query);
    const versions = (await loadAllVersions(db, orgId, [query.positionId])).get(query.positionId) ?? [];
    let resolved;
    try {
      resolved = resolveAsOf(
        versions.map(toRevision),
        { effective: query.effectiveDate, asKnown: query.knownAt },
      );
    } catch (error) {
      if (error instanceof NoRevisionError) {
        throw new HrmPositionError(
          "NOT_FOUND",
          `position ${subject.positionCode} covers no version at ${query.effectiveDate} as known at ${query.knownAt} — check the query dates`,
        );
      }
      throw error;
    }
    const funding = (await loadFundingRows(db, orgId, [query.positionId])).get(query.positionId) ?? [];
    const holderRows = (await loadHolderVersions(db, orgId, [query.positionId])).get(query.positionId) ?? [];
    // The per-record gate above owns position visibility; holders are
    // additionally filtered to the reader's legal-entity scope here.
    const allowed = await actorAllowedSubsidiaryIds(db, orgId, query.actorId);
    const row = buildRow({
      id: query.positionId,
      positionCode: subject.positionCode,
      revision: subject.revision,
      version: resolved.payload,
      funding,
      holderRows,
      allowed,
      query,
    });
    return {
      ...row,
      funding: funding.map((plan) => ({
        id: plan.id,
        periodId: plan.period_id,
        periodStartsOn: plan.period_starts_on,
        periodEndsOn: plan.period_ends_on,
        fundedFte: plan.funded_fte,
        fundingSourceId: plan.funding_source_id,
        amount: plan.amount,
        currency: plan.currency,
      })),
    };
  });
}
