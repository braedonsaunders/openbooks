import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  requireHrmPositionManage,
  requirePositionManageForEmployer,
} from "./authorization.ts";
import { HRM_FEATURE_KEY } from "./employment-read.ts";
import {
  intervalsOverlap,
  makeEffectiveInterval,
  NoRevisionError,
  parseCivilDate,
  resolveAsOf,
} from "./temporal.ts";

/**
 * Canonical HRM position WRITE service: the funded establishment behind the
 * headcount plan (0192). Owns positions / position_versions / position_funding
 * writes plus the position_changes evidence ledger, in the 0184 write order
 * (close-then-insert-then-evidence in ONE transaction, deferred FKs, exact
 * before-images, txid-stamped aggregate event) and with every conditional
 * write asserting its affected row count.
 *
 * What this service never does:
 * - inherit assignment content from the position (or the reverse): title,
 *   department and location stay on the assignment version, and disagreement
 *   is a preflight warning carried in evidence, never a rewrite;
 * - reject funding outside 0..planned at storage: plans legitimately
 *   over- or under-fund, so the plan comparison is a named preflight
 *   refusal returned with the write, not a row rejection;
 * - approve employment-to-position assignment itself: that rides the
 *   employment change-request path (change-requests.ts), which calls back
 *   into recordPositionAssignmentEvent here inside its own transaction.
 *
 * Concurrency: every write locks or conditionally bumps the positions row,
 * and the employment-side position_assignment application locks the same
 * row before writing assignment versions — so closePosition's held-check
 * and a concurrent assignment serialize on the row lock instead of
 * racing past each other.
 */

export type HrmPositionCode =
  | "INVALID_INPUT"
  | "NOT_FOUND"
  | "BAD_STATE"
  | "STALE_REVISION"
  | "REFUSED"
  | "OVER_FILLED"
  | "UNDER_FUNDED";

export class HrmPositionError extends Error {
  readonly code: HrmPositionCode;
  constructor(code: HrmPositionCode, message: string) {
    super(message);
    this.name = "HrmPositionError";
    this.code = code;
  }
}

/**
 * Filled FTE exceeds planned FTE for the position. Carried as data on the
 * vacancy read (which must keep rendering a breached plan, never hide it);
 * constructed only by vacancyRefusalFor, never by hand.
 */
export class PositionOverfilledError extends HrmPositionError {
  declare readonly code: "OVER_FILLED";
  constructor(message: string) {
    super("OVER_FILLED", message);
    this.name = "PositionOverfilledError";
  }
}

/**
 * Filled FTE exceeds funded FTE for the position and period. Carried as
 * data on the vacancy read for the same reason; constructed only by
 * vacancyRefusalFor.
 */
export class PositionUnderfundedError extends HrmPositionError {
  declare readonly code: "UNDER_FUNDED";
  constructor(message: string) {
    super("UNDER_FUNDED", message);
    this.name = "PositionUnderfundedError";
  }
}

/** Lifecycle statuses storage pins (position_versions_status). */
export const POSITION_STATUSES = ["planned", "open", "filled", "frozen", "closed"] as const;
export type PositionStatus = (typeof POSITION_STATUSES)[number];

/**
 * Allowed status transitions. Closed is terminal: a retired establishment
 * never resurrects — open a new position instead. Closing itself goes
 * through closePosition, which proves no live holder first; revise refuses
 * a direct transition to closed and names that remedy.
 */
const POSITION_TRANSITIONS: Record<Exclude<PositionStatus, "closed">, readonly PositionStatus[]> = {
  planned: ["open", "frozen", "closed"],
  open: ["filled", "frozen", "closed"],
  filled: ["open", "frozen", "closed"],
  frozen: ["planned", "open", "closed"],
};

function requirePositionStatus(value: unknown): PositionStatus {
  if (typeof value !== "string" || !(POSITION_STATUSES as readonly string[]).includes(value)) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      `position status must be one of ${POSITION_STATUSES.join(", ")} — check the status value`,
    );
  }
  return value as PositionStatus;
}

// --- Exact decimal FTE math (no floating point) ------------------------------

/** FTE wire shape: numeric(7,4) as text, e.g. "1.0000". */
const FTE_PATTERN = /^(\d+)(?:\.(\d{1,4}))?$/;

/**
 * Parse an FTE decimal string to exact ten-thousandths (bigint). "1.5" and
 * "1.5000" are the same 15000n; anything else (negatives, NaN, scientific
 * notation, blanks) is refused by name. Never passes through Number: FTE
 * totals are sums, and float addition drifts.
 */
export function parseFte(value: unknown): bigint {
  if (typeof value !== "string") {
    throw new HrmPositionError(
      "INVALID_INPUT",
      "fte must be a decimal string with up to 4 fraction digits — check the supplied value",
    );
  }
  const match = FTE_PATTERN.exec(value);
  if (match === null || match[0] !== value) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      `fte ${value} is not a non-negative decimal with up to 4 fraction digits — use a plain decimal like 1.0000`,
    );
  }
  const whole = BigInt(match[1] ?? "0");
  const fraction = (match[2] ?? "").padEnd(4, "0");
  return whole * 10000n + BigInt(fraction);
}

/** Format ten-thousandths back to the stored 4dp shape ("15000n" → "1.5000"). */
export function formatFte(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 10000n;
  const fraction = (abs % 10000n).toString().padStart(4, "0");
  return `${negative ? "-" : ""}${whole.toString()}.${fraction}`;
}

export interface VacancyInputs {
  readonly plannedFte: string;
  readonly fundedFte: string;
  readonly filledFte: string;
}

export interface VacancyResult {
  readonly plannedFte: string;
  readonly fundedFte: string;
  readonly filledFte: string;
  /** Planned minus filled; negative when over-filled — reported, never clamped. */
  readonly vacantFte: string;
  readonly overFilled: boolean;
  readonly underFunded: boolean;
  /** Funded above plan: legitimate (plans over-fund), reported, never refused. */
  readonly overFunded: boolean;
}

/**
 * Pure vacancy math over exact ten-thousandths. Clamping a negative vacancy
 * to zero would hide an over-filled establishment behind a tidy number, so
 * the negative is reported exactly.
 */
export function computeVacancy(inputs: VacancyInputs): VacancyResult {
  const planned = parseFte(inputs.plannedFte);
  const funded = parseFte(inputs.fundedFte);
  const filled = parseFte(inputs.filledFte);
  return {
    plannedFte: formatFte(planned),
    fundedFte: formatFte(funded),
    filledFte: formatFte(filled),
    vacantFte: formatFte(planned - filled),
    overFilled: filled > planned,
    underFunded: filled > funded,
    overFunded: funded > planned,
  };
}

/**
 * The coded refusal for a breached vacancy, over-filled first: an
 * establishment holding more than planned is the more urgent breach to
 * name. Each message names the remedy (revise the plan, fund the period,
 * or move the assignment). Returns null when the plan covers the holder.
 */
export function vacancyRefusalFor(
  positionCode: string,
  vacancy: VacancyResult,
): PositionOverfilledError | PositionUnderfundedError | null {
  if (vacancy.overFilled) {
    return new PositionOverfilledError(
      `position ${positionCode} holds ${vacancy.filledFte} FTE against ${vacancy.plannedFte} planned — revise the position to a larger planned FTE or move an assignment off it`,
    );
  }
  if (vacancy.underFunded) {
    return new PositionUnderfundedError(
      `position ${positionCode} holds ${vacancy.filledFte} FTE against ${vacancy.fundedFte} funded — fund the period or move an assignment off it`,
    );
  }
  return null;
}

// --- No-silent-inheritance preflight ------------------------------------------

export interface PositionContent {
  readonly title: string | null;
  readonly departmentId: string | null;
  readonly locationId: string | null;
}

/**
 * Compare an assignment version against the position version it names.
 * Only fields set on BOTH sides and disagreeing are warnings: a null
 * assignment title is uninherited content, not a disagreement, and must
 * never warn. Pure, so the assign path and the vacancy read report the
 * same warnings from the same comparison.
 */
export function positionDisagreements(
  positionCode: string,
  position: PositionContent,
  assignment: PositionContent,
): string[] {
  const warnings: string[] = [];
  if (
    assignment.title !== null &&
    assignment.title.trim().length > 0 &&
    position.title !== null &&
    assignment.title !== position.title
  ) {
    warnings.push(
      `assignment title ${JSON.stringify(assignment.title)} differs from position ${positionCode} title ${JSON.stringify(position.title)} — the assignment keeps its own title`,
    );
  }
  if (
    assignment.departmentId !== null &&
    position.departmentId !== null &&
    assignment.departmentId !== position.departmentId
  ) {
    warnings.push(
      `assignment department ${assignment.departmentId} differs from position ${positionCode} department ${position.departmentId} — the assignment keeps its own department`,
    );
  }
  if (
    assignment.locationId !== null &&
    position.locationId !== null &&
    assignment.locationId !== position.locationId
  ) {
    warnings.push(
      `assignment location ${assignment.locationId} differs from position ${positionCode} location ${position.locationId} — the assignment keeps its own location`,
    );
  }
  return warnings;
}

// --- DTOs ---------------------------------------------------------------------

export interface PositionVersionDTO {
  readonly versionId: string;
  readonly versionNo: number;
  readonly title: string;
  readonly departmentId: string | null;
  readonly locationId: string | null;
  readonly employerSubsidiaryId: string;
  readonly jobGrade: string | null;
  readonly plannedFte: string;
  readonly status: string;
  readonly effectiveFrom: string;
  readonly effectiveTo: string | null;
  readonly recordedAt: string;
  readonly recordedUntil: string | null;
}

export interface PositionFundingDTO {
  readonly id: string;
  readonly periodId: string;
  readonly fundedFte: string;
  readonly fundingSourceId: string | null;
  readonly amount: string | null;
  readonly currency: string | null;
}

export interface PositionDTO {
  readonly id: string;
  readonly orgId: string;
  readonly positionCode: string;
  readonly revision: number;
  readonly version: PositionVersionDTO;
}

export interface FundingPreflight {
  readonly code: "OVER_FUNDED" | "UNDER_FUNDED" | "NO_APPLICABLE_VERSION";
  readonly message: string;
}

export interface FundingWriteResult {
  readonly funding: PositionFundingDTO;
  /** The plan comparison, always reported; never blocks the write. */
  readonly preflight: FundingPreflight | null;
}

type PositionVersionRow = {
  id: string;
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
  before: unknown;
};

function toVersionDTO(row: PositionVersionRow): PositionVersionDTO {
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

// --- Input validation (fail fast, before any write) ---------------------------

function requireCode(code: unknown): string {
  if (typeof code !== "string" || code.trim().length === 0) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      "position code must be a non-blank string — name the establishment code",
    );
  }
  return code.trim();
}

function requireTitle(title: unknown): string {
  if (typeof title !== "string" || title.trim().length === 0) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      "position title must be a non-blank string — name the establishment title",
    );
  }
  return title.trim();
}

function requireUuid(field: string, value: unknown): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new HrmPositionError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
  return value;
}

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length === 0) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      "position writes carry a non-blank reason — record why the establishment changes",
    );
  }
  return reason.trim();
}

/**
 * Prove foreign references before writing: a department, location,
 * subsidiary or fiscal period from another organization (or a typo) is
 * refused with the field named — never left to a raw constraint violation.
 */
async function assertPositionRefs(
  exec: SqlExecutor,
  args: {
    orgId: string;
    departmentId?: string | null;
    locationId?: string | null;
    employerSubsidiaryId?: string | null;
    periodId?: string | null;
  },
): Promise<void> {
  const { orgId } = args;
  if (args.departmentId) {
    const found = (await exec.execute(sql`
      select 1 as one from departments where org_id = ${orgId} and id = ${args.departmentId}
    `)).rows[0];
    if (!found) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "the department is not visible in this organization — pick a department of this organization",
      );
    }
  }
  if (args.locationId) {
    const found = (await exec.execute(sql`
      select 1 as one from locations where org_id = ${orgId} and id = ${args.locationId}
    `)).rows[0];
    if (!found) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "the location is not visible in this organization — pick a location of this organization",
      );
    }
  }
  if (args.employerSubsidiaryId) {
    const found = (await exec.execute(sql`
      select 1 as one from subsidiaries where org_id = ${orgId} and id = ${args.employerSubsidiaryId}
    `)).rows[0];
    if (!found) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "the employer subsidiary is not visible in this organization — pick a subsidiary of this organization",
      );
    }
  }
  if (args.periodId) {
    const found = (await exec.execute(sql`
      select 1 as one from accounting_periods where org_id = ${orgId} and id = ${args.periodId}
    `)).rows[0];
    if (!found) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "the fiscal period is not visible in this organization — pick a period of this organization",
      );
    }
  }
}

async function livePositionVersions(
  exec: SqlExecutor,
  orgId: string,
  positionId: string,
): Promise<PositionVersionRow[]> {
  const rows = (await exec.execute<PositionVersionRow>(sql`
    select id, version_no, title, department_id, location_id,
           employer_subsidiary_id, job_grade, planned_fte::text as planned_fte,
           status,
           effective_from::text as effective_from,
           effective_to::text as effective_to,
           to_char(recorded_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_at,
           to_char(recorded_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as recorded_until,
           to_jsonb(position_versions) as before
      from position_versions
     where org_id = ${orgId} and position_id = ${positionId}
       and recorded_until is null
     order by version_no
  `)).rows;
  return rows;
}

/**
 * Overlap on the half-open effective grid. temporal.ts owns the semantics;
 * this is only the row-shape adapter so call sites never reimplement it.
 */
export function effectiveOverlaps(
  row: { effective_from: string; effective_to: string | null },
  start: string,
  end: string | null,
): boolean {
  return intervalsOverlap(
    {
      start: parseCivilDate(row.effective_from),
      end: row.effective_to === null ? null : parseCivilDate(row.effective_to),
    },
    { start: parseCivilDate(start), end: end === null ? null : parseCivilDate(end) },
  );
}

// --- Evidence and revision helpers --------------------------------------------

type ClosureElement = {
  table: string;
  identity: string;
  version_no: number;
  row_id: string;
  before: unknown;
};

async function insertPositionChange(
  exec: SqlExecutor,
  args: {
    orgId: string;
    positionId: string;
    revision: number;
    changeKind: string;
    priorSnapshot: Record<string, unknown>;
    closedVersions: ClosureElement[];
    reason: string;
    actorId: string;
  },
): Promise<string> {
  const inserted = (await exec.execute<{ id: string }>(sql`
    insert into position_changes
      (org_id, position_id, revision, change_kind,
       prior_snapshot, reason, recorded_source, recorded_by, closed_versions,
       created_by, updated_by)
    values (${args.orgId}, ${args.positionId}, ${args.revision},
            ${args.changeKind}, ${JSON.stringify(args.priorSnapshot)}::jsonb,
            ${args.reason}, 'user', ${args.actorId},
            ${JSON.stringify(args.closedVersions)}::jsonb, ${args.actorId}, ${args.actorId})
    returning id
  `)).rows[0];
  if (!inserted) {
    throw new HrmPositionError(
      "REFUSED",
      "the position change event was not written — nothing applied; retry the write",
    );
  }
  return inserted.id;
}

async function bumpPositionRevision(
  exec: SqlExecutor,
  args: { orgId: string; actorId: string; positionId: string; expected: number; next: number },
): Promise<void> {
  const bumped = (await exec.execute(sql`
    update positions
       set revision = ${args.next}, updated_by = ${args.actorId}, updated_at = now()
     where org_id = ${args.orgId} and id = ${args.positionId} and revision = ${args.expected}
    returning id
  `)).rows;
  if (bumped.length !== 1) {
    throw new HrmPositionError(
      "STALE_REVISION",
      "the position changed while the write was applying — this attempt applied nothing; reload and file again",
    );
  }
}

async function assertHrmFeature(exec: SqlExecutor, orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(exec, orgId, HRM_FEATURE_KEY))) {
    throw new HrmPositionError(
      "REFUSED",
      "hrm feature is disabled: enable it on Company Settings → Features before writing positions",
    );
  }
}

// --- Create --------------------------------------------------------------------

export interface CreatePositionQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly positionCode: unknown;
  readonly title: unknown;
  readonly departmentId?: unknown;
  readonly locationId?: unknown;
  readonly employerSubsidiaryId: unknown;
  readonly jobGrade?: unknown;
  readonly plannedFte?: unknown;
  readonly status?: unknown;
  readonly effectiveFrom: unknown;
  readonly effectiveTo?: unknown;
  readonly reason: unknown;
}

/**
 * Open a position: identity plus its first effective version, evidenced as
 * a non-closure 'created' event. Authority is checked against the DECLARED
 * employer (requirePositionManageForEmployer) — a create names no position
 * yet, so there is no subject to load.
 */
export async function createPosition(query: CreatePositionQuery): Promise<PositionDTO> {
  const orgId = requireUuid("orgId", query.orgId);
  const actorId = requireUuid("actorId", query.actorId);
  const positionCode = requireCode(query.positionCode);
  const title = requireTitle(query.title);
  const departmentId = query.departmentId === undefined || query.departmentId === null ? null : requireUuid("departmentId", query.departmentId);
  const locationId = query.locationId === undefined || query.locationId === null ? null : requireUuid("locationId", query.locationId);
  const employerSubsidiaryId = requireUuid("employerSubsidiaryId", query.employerSubsidiaryId);
  const jobGrade =
    query.jobGrade === undefined || query.jobGrade === null
      ? null
      : typeof query.jobGrade === "string" && query.jobGrade.trim().length > 0
        ? query.jobGrade.trim()
        : null;
  if (query.jobGrade !== undefined && query.jobGrade !== null && jobGrade === null) {
    throw new HrmPositionError("INVALID_INPUT", "job grade must be a non-blank string or null");
  }
  const plannedFte = formatFte(parseFte(query.plannedFte ?? "1"));
  const status = requirePositionStatus(query.status ?? "planned");
  const effectiveFrom: string = parseCivilDate(query.effectiveFrom);
  const effectiveTo: string | null =
    query.effectiveTo === undefined || query.effectiveTo === null
      ? null
      : parseCivilDate(query.effectiveTo);
  makeEffectiveInterval(effectiveFrom, effectiveTo);
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeature(db, orgId);
    await requirePositionManageForEmployer(db, orgId, actorId, employerSubsidiaryId);
    await assertPositionRefs(db, { orgId, departmentId, locationId, employerSubsidiaryId });
    const clash = (await db.execute(sql`
      select 1 as one from positions where org_id = ${orgId} and position_code = ${positionCode}
    `)).rows[0];
    if (clash) {
      throw new HrmPositionError(
        "BAD_STATE",
        `position code ${positionCode} already exists in this organization — pick a code that is not taken`,
      );
    }
    const nowRow = (await db.execute<{ now: Date }>(sql`select now() as now`)).rows[0];
    const recordedAt = nowRow?.now;
    if (!recordedAt) {
      throw new HrmPositionError("REFUSED", "the database clock is unreadable — retry the write");
    }
    const identity = (await db.execute<{ id: string }>(sql`
      insert into positions (org_id, position_code, created_by, updated_by)
      values (${orgId}, ${positionCode}, ${actorId}, ${actorId})
      returning id
    `)).rows[0];
    if (!identity) {
      throw new HrmPositionError(
        "REFUSED",
        "the position was not stored — no row was written; retry the write",
      );
    }
    await db.execute(sql`
      insert into position_versions
        (org_id, position_id, version_no, title, department_id, location_id,
         employer_subsidiary_id, job_grade, planned_fte, status,
         effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${identity.id}, 1, ${title}, ${departmentId}, ${locationId},
              ${employerSubsidiaryId}, ${jobGrade}, ${plannedFte}, ${status},
              ${effectiveFrom}::date, ${effectiveTo}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
    await insertPositionChange(db, {
      orgId,
      positionId: identity.id,
      revision: 1,
      changeKind: "created",
      priorSnapshot: {},
      closedVersions: [],
      reason,
      actorId,
    });
    const live = await livePositionVersions(db, orgId, identity.id);
    const first = live[0];
    if (!first) {
      throw new HrmPositionError(
        "REFUSED",
        "the created version cannot be read back — the write left nothing observable; retry the write",
      );
    }
    return { id: identity.id, orgId, positionCode, revision: 1, version: toVersionDTO(first) };
  });
}

// --- Revise / close -------------------------------------------------------------

export interface RevisePositionQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly positionId: unknown;
  readonly title?: unknown;
  readonly departmentId?: unknown;
  readonly locationId?: unknown;
  readonly employerSubsidiaryId?: unknown;
  readonly jobGrade?: unknown;
  readonly plannedFte?: unknown;
  readonly status?: unknown;
  readonly effectiveFrom?: unknown;
  readonly effectiveTo?: unknown;
  readonly reason: unknown;
}

/**
 * Revise a position: close every live version overlapping the successor
 * window onto one successor (close-first, 0184 order), evidenced with exact
 * before-images in one aggregate 'revised' event. A transition to closed
 * is refused here — closePosition proves no live holder first, and names
 * itself as the remedy.
 */
export async function revisePosition(query: RevisePositionQuery): Promise<PositionDTO> {
  const orgId = requireUuid("orgId", query.orgId);
  const actorId = requireUuid("actorId", query.actorId);
  const positionId = requireUuid("positionId", query.positionId);
  const reason = requireReason(query.reason);
  const status = query.status === undefined ? undefined : requirePositionStatus(query.status);
  if (status === "closed") {
    throw new HrmPositionError(
      "BAD_STATE",
      "a position closes only through closePosition, which proves no live primary assignment names it — revise everything else here",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeature(db, orgId);
    const subject = await requireHrmPositionManage(db, orgId, actorId, positionId);
    await db.execute(sql`
      set constraints position_versions_change_tenant_fkey deferred
    `);
    const live = await livePositionVersions(db, orgId, positionId);
    if (live.length === 0) {
      throw new HrmPositionError(
        "BAD_STATE",
        "this position has no live version to revise — check the position id",
      );
    }
    // Successor window: explicit when given, otherwise carried from the
    // single live slice. Several live slices with no explicit window is
    // ambiguous — the revision must name the window it changes.
    let windowStart: string;
    let windowEnd: string | null;
    if (query.effectiveFrom !== undefined || query.effectiveTo !== undefined) {
      const base = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
      windowStart = query.effectiveFrom === undefined ? base.effective_from : parseCivilDate(query.effectiveFrom);
      windowEnd =
        query.effectiveTo === undefined
          ? base.effective_to
          : query.effectiveTo === null
            ? null
            : parseCivilDate(query.effectiveTo);
      makeEffectiveInterval(windowStart, windowEnd);
    } else {
      if (live.length !== 1) {
        throw new HrmPositionError(
          "REFUSED",
          "this position holds several live slices and the revision names no effective window — name effectiveFrom/effectiveTo explicitly",
        );
      }
      windowStart = live[0]!.effective_from;
      windowEnd = live[0]!.effective_to;
    }
    const overlapping = live.filter((version) => effectiveOverlaps(version, windowStart, windowEnd));
    if (overlapping.length === 0) {
      throw new HrmPositionError(
        "REFUSED",
        "no live position version overlaps the revision window — reload the position and revise again",
      );
    }
    const base = overlapping.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    const departmentId =
      query.departmentId === undefined ? base.department_id : query.departmentId === null ? null : requireUuid("departmentId", query.departmentId);
    const locationId =
      query.locationId === undefined ? base.location_id : query.locationId === null ? null : requireUuid("locationId", query.locationId);
    const employerSubsidiaryId =
      query.employerSubsidiaryId === undefined
        ? base.employer_subsidiary_id
        : requireUuid("employerSubsidiaryId", query.employerSubsidiaryId);
    await assertPositionRefs(db, { orgId, departmentId, locationId, employerSubsidiaryId });
    const successor = {
      title: query.title === undefined ? base.title : requireTitle(query.title),
      departmentId,
      locationId,
      employerSubsidiaryId,
      jobGrade:
        query.jobGrade === undefined
          ? base.job_grade
          : query.jobGrade === null
            ? null
            : requireTitle(query.jobGrade),
      plannedFte: query.plannedFte === undefined ? base.planned_fte : formatFte(parseFte(query.plannedFte)),
      status: status ?? base.status,
    };
    for (const version of overlapping) {
      const allowed = POSITION_TRANSITIONS[version.status as Exclude<PositionStatus, "closed">];
      if (!allowed || !allowed.includes(successor.status as PositionStatus)) {
        throw new HrmPositionError(
          "BAD_STATE",
          `position ${subject.positionCode} version ${version.version_no} is ${version.status} — it cannot move to ${successor.status}; closed is terminal and every other move follows the lifecycle`,
        );
      }
    }
    if (
      overlapping.length === 1 &&
      overlapping[0]!.title === successor.title &&
      overlapping[0]!.department_id === successor.departmentId &&
      overlapping[0]!.location_id === successor.locationId &&
      overlapping[0]!.employer_subsidiary_id === successor.employerSubsidiaryId &&
      overlapping[0]!.job_grade === successor.jobGrade &&
      overlapping[0]!.planned_fte === successor.plannedFte &&
      overlapping[0]!.status === successor.status &&
      overlapping[0]!.effective_from === windowStart &&
      (overlapping[0]!.effective_to ?? null) === windowEnd
    ) {
      throw new HrmPositionError(
        "BAD_STATE",
        "the revision changes nothing — revise only when content, status, or dates actually change",
      );
    }
    const newRevision = subject.revision + 1;
    const nowRow = (await db.execute<{ now: Date }>(sql`select now() as now`)).rows[0];
    const recordedAt = nowRow?.now;
    if (!recordedAt) {
      throw new HrmPositionError("REFUSED", "the database clock is unreadable — retry the write");
    }
    const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;
    const changeId = await insertPositionChange(db, {
      orgId,
      positionId,
      revision: newRevision,
      changeKind: "revised",
      priorSnapshot: {
        closed: overlapping.map((version) => ({
          versionNo: version.version_no,
          title: version.title,
          status: version.status,
          effectiveFrom: version.effective_from,
          effectiveTo: version.effective_to,
        })),
      },
      closedVersions: overlapping.map((version) => ({
        table: "position_versions",
        identity: positionId,
        version_no: version.version_no,
        row_id: version.id,
        before: version.before,
      })),
      reason,
      actorId,
    });
    for (const version of overlapping) {
      const closed = (await db.execute(sql`
        update position_versions
           set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
               closed_by_change_id = ${changeId}
         where org_id = ${orgId} and id = ${version.id} and recorded_until is null
        returning id
      `)).rows;
      if (closed.length !== 1) {
        throw new HrmPositionError(
          "REFUSED",
          "a position version changed while the revision was applying — retry the write",
        );
      }
    }
    await db.execute(sql`
      insert into position_versions
        (org_id, position_id, version_no, title, department_id, location_id,
         employer_subsidiary_id, job_grade, planned_fte, status,
         effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${positionId}, ${successorNo},
              ${successor.title}, ${successor.departmentId}, ${successor.locationId},
              ${successor.employerSubsidiaryId}, ${successor.jobGrade},
              ${successor.plannedFte}, ${successor.status},
              ${windowStart}::date, ${windowEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
    await bumpPositionRevision(db, { orgId, actorId, positionId, expected: subject.revision, next: newRevision });
    const after = await livePositionVersions(db, orgId, positionId);
    const current = after.find((version) => version.version_no === successorNo);
    if (!current) {
      throw new HrmPositionError(
        "REFUSED",
        "the revised version cannot be read back — the write left nothing observable; retry the write",
      );
    }
    return { id: positionId, orgId, positionCode: subject.positionCode, revision: newRevision, version: toVersionDTO(current) };
  });
}

export interface ClosePositionQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly positionId: unknown;
  /** Civil date the closure takes effect; holders are checked as of this date. */
  readonly effectiveDate: unknown;
  readonly reason: unknown;
}

/**
 * Close a position: refused while a live primary assignment names it as of
 * the effective date — the holder must be unassigned first through a
 * position_assignment change request. The position row itself locks first
 * so a concurrent assignment application (which locks the same row before
 * writing) cannot slip a holder in under the check.
 */
export async function closePosition(query: ClosePositionQuery): Promise<PositionDTO> {
  const orgId = requireUuid("orgId", query.orgId);
  const actorId = requireUuid("actorId", query.actorId);
  const positionId = requireUuid("positionId", query.positionId);
  const effectiveDate: string = parseCivilDate(query.effectiveDate);
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeature(db, orgId);
    const subject = await requireHrmPositionManage(db, orgId, actorId, positionId);
    // Serialize against concurrent assignment applications on this row.
    const locked = (await db.execute(sql`
      select revision from positions
       where org_id = ${orgId} and id = ${positionId} for update
    `)).rows[0];
    if (!locked) {
      throw new HrmPositionError(
        "NOT_FOUND",
        "position not found in this organization — check the position id",
      );
    }
    const holders = (await db.execute<{ employment_id: string; assignment_key: string }>(sql`
      select av.employment_id::text as employment_id, a.assignment_key
        from employment_assignment_versions av
        join employment_assignments a on a.id = av.assignment_id and a.org_id = av.org_id
       where av.org_id = ${orgId} and av.position_id = ${positionId}
         and av.is_primary and av.recorded_until is null
         and av.effective_from <= ${effectiveDate}::date
         and (av.effective_to is null or av.effective_to > ${effectiveDate}::date)
       limit 1
    `)).rows[0];
    if (holders) {
      throw new HrmPositionError(
        "REFUSED",
        `position ${subject.positionCode} is still held by employment ${holders.employment_id} (assignment ${holders.assignment_key}) as of ${effectiveDate} — unassign the holder through a position_assignment change request before closing`,
      );
    }
    const live = await livePositionVersions(db, orgId, positionId);
    if (live.length === 0) {
      throw new HrmPositionError(
        "BAD_STATE",
        "this position has no live version to close — check the position id",
      );
    }
    if (live.every((version) => version.status === "closed")) {
      throw new HrmPositionError(
        "BAD_STATE",
        `position ${subject.positionCode} is already closed — closed is terminal; open a new position instead`,
      );
    }
    await db.execute(sql`
      set constraints position_versions_change_tenant_fkey deferred
    `);
    const newRevision = subject.revision + 1;
    const nowRow = (await db.execute<{ now: Date }>(sql`select now() as now`)).rows[0];
    const recordedAt = nowRow?.now;
    if (!recordedAt) {
      throw new HrmPositionError("REFUSED", "the database clock is unreadable — retry the write");
    }
    const successorNo = Math.max(...live.map((version) => version.version_no)) + 1;
    // Closure retires every live slice onto one closed successor bounded at
    // the effective date: history before the date stands, nothing after it.
    const changeId = await insertPositionChange(db, {
      orgId,
      positionId,
      revision: newRevision,
      changeKind: "closed",
      priorSnapshot: {
        effectiveDate,
        closed: live.map((version) => ({
          versionNo: version.version_no,
          title: version.title,
          status: version.status,
          effectiveFrom: version.effective_from,
          effectiveTo: version.effective_to,
        })),
      },
      closedVersions: live.map((version) => ({
        table: "position_versions",
        identity: positionId,
        version_no: version.version_no,
        row_id: version.id,
        before: version.before,
      })),
      reason,
      actorId,
    });
    for (const version of live) {
      const closed = (await db.execute(sql`
        update position_versions
           set recorded_until = ${recordedAt}, superseded_by = ${successorNo},
               closed_by_change_id = ${changeId}
         where org_id = ${orgId} and id = ${version.id} and recorded_until is null
        returning id
      `)).rows;
      if (closed.length !== 1) {
        throw new HrmPositionError(
          "REFUSED",
          "a position version changed while the close was applying — retry the write",
        );
      }
    }
    const newest = live.reduce((a, b) => (a.version_no > b.version_no ? a : b));
    // The closed successor covers the retired horizon: unbounded when any
    // live slice is unbounded, otherwise the furthest live end. A horizon
    // on or before the effective date is an empty interval and is refused
    // by name instead of tripping the storage range check.
    const horizonEnd: string | null = live.some((version) => version.effective_to === null)
      ? null
      : live.map((version) => version.effective_to as string).reduce((a, b) => (a > b ? a : b));
    if (horizonEnd !== null && horizonEnd <= effectiveDate) {
      throw new HrmPositionError(
        "BAD_STATE",
        `position ${subject.positionCode} already ends at ${horizonEnd} — close as of a date inside its live horizon`,
      );
    }
    await db.execute(sql`
      insert into position_versions
        (org_id, position_id, version_no, title, department_id, location_id,
         employer_subsidiary_id, job_grade, planned_fte, status,
         effective_from, effective_to, recorded_at, created_by, updated_by)
      values (${orgId}, ${positionId}, ${successorNo},
              ${newest.title}, ${newest.department_id}, ${newest.location_id},
              ${newest.employer_subsidiary_id}, ${newest.job_grade},
              ${newest.planned_fte}, 'closed',
              ${effectiveDate}::date, ${horizonEnd}::date,
              ${recordedAt}, ${actorId}, ${actorId})
    `);
    await bumpPositionRevision(db, { orgId, actorId, positionId, expected: subject.revision, next: newRevision });
    const after = await livePositionVersions(db, orgId, positionId);
    const current = after.find((version) => version.version_no === successorNo);
    if (!current) {
      throw new HrmPositionError(
        "REFUSED",
        "the closed version cannot be read back — the write left nothing observable; retry the write",
      );
    }
    return { id: positionId, orgId, positionCode: subject.positionCode, revision: newRevision, version: toVersionDTO(current) };
  });
}

// --- Funding --------------------------------------------------------------------

export interface WritePositionFundingQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly positionId: unknown;
  readonly periodId: unknown;
  readonly fundedFte: unknown;
  readonly fundingSourceId?: unknown;
  readonly amount?: unknown;
  readonly currency?: unknown;
  readonly reason: unknown;
}

type FundingRow = {
  id: string;
  period_id: string;
  funded_fte: string;
  funding_source_id: string | null;
  amount: string | null;
  currency: string | null;
};

function toFundingDTO(row: FundingRow): PositionFundingDTO {
  return {
    id: row.id,
    periodId: row.period_id,
    fundedFte: row.funded_fte,
    fundingSourceId: row.funding_source_id,
    amount: row.amount,
    currency: row.currency,
  };
}

/**
 * Write the funding plan for one (position, period): insert on first plan,
 * explicit UPDATE on a re-plan (a second row for the same period is never
 * a silent second plan — the unique key forbids it and the rewrite is
 * evidenced). Every write appends a non-closure 'funded' event carrying
 * the prior row and the plan comparison.
 *
 * The plan comparison is a PREFLIGHT, not a constraint: funded FTE outside
 * 0..planned is legitimate planning, so the write commits and the
 * comparison travels in the result — computed, named, and never silent.
 */
export async function writePositionFunding(query: WritePositionFundingQuery): Promise<FundingWriteResult> {
  const orgId = requireUuid("orgId", query.orgId);
  const actorId = requireUuid("actorId", query.actorId);
  const positionId = requireUuid("positionId", query.positionId);
  const periodId = requireUuid("periodId", query.periodId);
  const fundedFte = formatFte(parseFte(query.fundedFte));
  const fundingSourceId =
    query.fundingSourceId === undefined || query.fundingSourceId === null
      ? null
      : requireUuid("fundingSourceId", query.fundingSourceId);
  const amountRaw = query.amount === undefined || query.amount === null ? null : query.amount;
  const currencyRaw = query.currency === undefined || query.currency === null ? null : query.currency;
  if ((amountRaw === null) !== (currencyRaw === null)) {
    throw new HrmPositionError(
      "INVALID_INPUT",
      "a cost plan carries amount and currency together — set both or neither",
    );
  }
  let amount: string | null = null;
  let currency: string | null = null;
  if (amountRaw !== null && currencyRaw !== null) {
    if (typeof amountRaw !== "string" || !/^\d+(\.\d{1,4})?$/.test(amountRaw)) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "plan amount must be a non-negative decimal with up to 4 fraction digits — check the supplied value",
      );
    }
    if (typeof currencyRaw !== "string" || !/^[A-Z]{3}$/.test(currencyRaw)) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "plan currency must be a 3-letter ISO code like USD — check the supplied value",
      );
    }
    amount = amountRaw;
    currency = currencyRaw;
  }
  const reason = requireReason(query.reason);
  return withOrgTransaction(orgId, async () => {
    await assertHrmFeature(db, orgId);
    const subject = await requireHrmPositionManage(db, orgId, actorId, positionId);
    await assertPositionRefs(db, { orgId, periodId });
    const period = (await db.execute<{ starts_on: string; ends_on: string }>(sql`
      select starts_on::text as starts_on, ends_on::text as ends_on
        from accounting_periods where org_id = ${orgId} and id = ${periodId}
    `)).rows[0];
    if (!period) {
      throw new HrmPositionError(
        "INVALID_INPUT",
        "the fiscal period is not visible in this organization — pick a period of this organization",
      );
    }
    // Plan comparison against the version covering the period start. No
    // covering version is itself an explicit preflight outcome — funding a
    // period the establishment does not cover is plannable, but the
    // comparison cannot be computed, and "no comparison" must be said.
    const live = await livePositionVersions(db, orgId, positionId);
    let preflight: FundingPreflight | null = null;
    try {
      const covering = resolveAsOf(
        live.map((version) => ({
          effective: {
            start: parseCivilDate(version.effective_from),
            end: version.effective_to === null ? null : parseCivilDate(version.effective_to),
          },
          recordedAt: version.recorded_at,
          recordedUntil: version.recorded_until,
          payload: version,
        })),
        { effective: period.starts_on, asKnown: new Date().toISOString() },
      );
      const planned = parseFte(covering.payload.planned_fte);
      const funded = parseFte(fundedFte);
      if (funded > planned) {
        preflight = {
          code: "OVER_FUNDED",
          message: `position ${subject.positionCode} is funded ${fundedFte} FTE against ${covering.payload.planned_fte} planned for this period — the plan over-funds and still applies`,
        };
      } else if (funded < planned) {
        preflight = {
          code: "UNDER_FUNDED",
          message: `position ${subject.positionCode} is funded ${fundedFte} FTE against ${covering.payload.planned_fte} planned for this period — the plan under-funds and still applies`,
        };
      }
    } catch (error) {
      // Only an uncovered period start lands here. Any other failure
      // (ambiguous chain, unreadable stamps) is a real refusal and
      // propagates — a funding write must never swallow it into a preflight.
      if (!(error instanceof NoRevisionError)) throw error;
      preflight = {
        code: "NO_APPLICABLE_VERSION",
        message: `position ${subject.positionCode} has no version covering the period start — the plan applies with no plan comparison`,
      };
    }
    const newRevision = subject.revision + 1;
    const prior = (await db.execute<FundingRow>(sql`
      select id, period_id::text as period_id, funded_fte::text as funded_fte,
             funding_source_id::text as funding_source_id,
             amount::text as amount, currency
        from position_funding
       where org_id = ${orgId} and position_id = ${positionId} and period_id = ${periodId}
    `)).rows[0];
    let written: FundingRow | undefined;
    if (prior) {
      written = (await db.execute<FundingRow>(sql`
        update position_funding
           set funded_fte = ${fundedFte}, funding_source_id = ${fundingSourceId},
               amount = ${amount}, currency = ${currency},
               updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${prior.id}
        returning id, period_id::text as period_id, funded_fte::text as funded_fte,
                  funding_source_id::text as funding_source_id,
                  amount::text as amount, currency
      `)).rows[0];
    } else {
      written = (await db.execute<FundingRow>(sql`
        insert into position_funding
          (org_id, position_id, period_id, funded_fte, funding_source_id,
           amount, currency, created_by, updated_by)
        values (${orgId}, ${positionId}, ${periodId}, ${fundedFte}, ${fundingSourceId},
                ${amount}, ${currency}, ${actorId}, ${actorId})
        returning id, period_id::text as period_id, funded_fte::text as funded_fte,
                  funding_source_id::text as funding_source_id,
                  amount::text as amount, currency
      `)).rows[0];
    }
    if (!written) {
      throw new HrmPositionError(
        "REFUSED",
        "the funding row was not stored — no row was written; retry the write",
      );
    }
    await insertPositionChange(db, {
      orgId,
      positionId,
      revision: newRevision,
      changeKind: "funded",
      priorSnapshot: {
        periodId,
        prior: prior
          ? {
              fundedFte: prior.funded_fte,
              fundingSourceId: prior.funding_source_id,
              amount: prior.amount,
              currency: prior.currency,
            }
          : null,
        preflight,
      },
      closedVersions: [],
      reason,
      actorId,
    });
    await bumpPositionRevision(db, { orgId, actorId, positionId, expected: subject.revision, next: newRevision });
    return { funding: toFundingDTO(written), preflight };
  });
}

// --- Employment-side assignment callback ------------------------------------------

/**
 * Position-side evidence for an employment assignment that landed through
 * the change-request path. Called INSIDE the employment apply transaction
 * (change-requests.ts), after the employment_changes event exists: writes a
 * non-closure 'assigned' event (plus an 'unassigned' event on the prior
 * position when the assignment moves between positions) carrying the
 * employment, the slot, the prior link and the no-silent-inheritance
 * warnings, then bumps the position revision.
 *
 * The bump takes the positions row lock, which is also the serialization
 * closePosition relies on: an assignment landing while a close checks
 * holders queues on this lock, so the check cannot miss it.
 */
export async function recordPositionAssignmentEvent(
  exec: SqlExecutor,
  args: {
    orgId: string;
    actorId: string;
    /** Target position; null = pure unassignment off the prior position. */
    positionId: string | null;
    employmentId: string;
    assignmentKey: string;
    priorPositionId: string | null;
    disagreementWarnings: string[];
    reason: string;
    /** Locked revision of the target position; ignored for pure unassign. */
    positionRevision: number;
  },
): Promise<void> {
  if (args.positionId !== null) {
    await insertPositionChange(exec, {
      orgId: args.orgId,
      positionId: args.positionId,
      revision: args.positionRevision + 1,
      changeKind: "assigned",
      priorSnapshot: {
        employmentId: args.employmentId,
        assignmentKey: args.assignmentKey,
        priorPositionId: args.priorPositionId,
        disagreementWarnings: args.disagreementWarnings,
      },
      closedVersions: [],
      reason: args.reason,
      actorId: args.actorId,
    });
  }
  if (args.priorPositionId !== null && args.priorPositionId !== args.positionId) {
    const priorRow = (await exec.execute<{ revision: number }>(sql`
      select revision from positions where org_id = ${args.orgId} and id = ${args.priorPositionId}
    `)).rows[0];
    if (priorRow) {
      await insertPositionChange(exec, {
        orgId: args.orgId,
        positionId: args.priorPositionId,
        revision: priorRow.revision + 1,
        changeKind: "unassigned",
        priorSnapshot: {
          employmentId: args.employmentId,
          assignmentKey: args.assignmentKey,
          movedToPositionId: args.positionId,
        },
        closedVersions: [],
        reason: args.reason,
        actorId: args.actorId,
      });
      await bumpPositionRevision(exec, {
        orgId: args.orgId,
        actorId: args.actorId,
        positionId: args.priorPositionId,
        expected: priorRow.revision,
        next: priorRow.revision + 1,
      });
    }
  }
  if (args.positionId !== null) {
    await bumpPositionRevision(exec, {
      orgId: args.orgId,
      actorId: args.actorId,
      positionId: args.positionId,
      expected: args.positionRevision,
      next: args.positionRevision + 1,
    });
  }
}
