import { sql } from "drizzle-orm";
import { db, withOrgTransaction, type SqlExecutor } from "../../platform/db.ts";
import { requireHrmBenefitsManage } from "../authorization.ts";
import { BenefitsError } from "./errors.ts";
import { windowsOverlap, type WindowShape } from "./benefits-math.ts";
import {
  assertHrmEnabled,
  requireActorId,
  requireCivilDate,
  requireId,
  requireOneRow,
  requireOrgId,
} from "./shared.ts";

/**
 * HRM enrollment-window service (HR-8).
 *
 * Windows bound when people may elect. Opening is refused for an inverted
 * range or an overlapping open window of the same kind and scope; closing
 * refuses every pending election with its own reasoned event — a pending
 * election is never silently dropped.
 */

export type EnrollmentWindowKind = "open_enrollment" | "new_hire" | "life_event";
export type EnrollmentWindowStatus = "draft" | "open" | "closed";

export interface EnrollmentWindowDTO {
  readonly id: string;
  readonly name: string;
  readonly kind: EnrollmentWindowKind;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly planYearStartOn: string;
  readonly appliesTo: { employer_subsidiary_id: string | null; department_id: string | null };
  readonly status: EnrollmentWindowStatus;
}

const WINDOW_COLUMNS = sql`id, name, kind,
  opens_on::text as "opensOn", closes_on::text as "closesOn",
  plan_year_start_on::text as "planYearStartOn",
  applies_to as "appliesTo", status`;

function toWindowDTO(row: Record<string, unknown>): EnrollmentWindowDTO {
  const kind = String(row.kind);
  if (kind !== "open_enrollment" && kind !== "new_hire" && kind !== "life_event") {
    throw new BenefitsError(
      "REFUSED",
      `enrollment window carries unknown kind ${JSON.stringify(kind)} — re-save it as open_enrollment, new_hire, or life_event`,
    );
  }
  const status = String(row.status);
  if (status !== "draft" && status !== "open" && status !== "closed") {
    throw new BenefitsError("REFUSED", "enrollment window carries an unknown status — re-save it as draft, open, or closed");
  }
  const applies = (row.appliesTo ?? {}) as Record<string, unknown>;
  return {
    id: String(row.id),
    name: String(row.name),
    kind,
    opensOn: String(row.opensOn).slice(0, 10),
    closesOn: String(row.closesOn).slice(0, 10),
    planYearStartOn: String(row.planYearStartOn).slice(0, 10),
    appliesTo: {
      employer_subsidiary_id:
        typeof applies.employer_subsidiary_id === "string" ? applies.employer_subsidiary_id : null,
      department_id: typeof applies.department_id === "string" ? applies.department_id : null,
    },
    status,
  };
}

async function loadWindow(
  exec: SqlExecutor,
  orgId: string,
  windowId: string,
): Promise<EnrollmentWindowDTO> {
  const row = requireOneRow(
    (
      await exec.execute<Record<string, unknown>>(sql`
        select ${WINDOW_COLUMNS} from hrm_enrollment_windows
         where org_id = ${orgId} and id = ${windowId}
      `)
    ).rows,
    "enrollment window",
  );
  return toWindowDTO(row);
}

/** Windows are Setup-shaped configuration: create rides the generic Setup CRUD. */
export async function getEnrollmentWindow(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly windowId: string;
}): Promise<EnrollmentWindowDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const windowId = requireId(query.windowId, "windowId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    return loadWindow(db, orgId, windowId);
  });
}

function toWindowShape(window: EnrollmentWindowDTO): WindowShape {
  return {
    kind: window.kind,
    opensOn: window.opensOn,
    closesOn: window.closesOn,
    employerSubsidiaryId: window.appliesTo.employer_subsidiary_id,
    departmentId: window.appliesTo.department_id,
  };
}

/**
 * Open a draft window. Refused when closes_on precedes opens_on, or when
 * another OPEN window of the same kind and scope overlaps — two open
 * windows covering the same people would accept competing elections.
 */
export async function openEnrollmentWindow(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly windowId: string;
}): Promise<EnrollmentWindowDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const windowId = requireId(query.windowId, "windowId");
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const window = await loadWindow(db, orgId, windowId);
    if (window.status !== "draft") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrollment window ${window.name} is ${window.status} — only a draft opens; a closed window never reopens`,
      );
    }
    if (window.closesOn < window.opensOn) {
      throw new BenefitsError(
        "REFUSED",
        `enrollment window ${window.name} closes ${window.closesOn} before it opens ${window.opensOn} — correct the dates in Company setup before opening`,
      );
    }
    const shape = toWindowShape(window);
    const open = (
      await db.execute<Record<string, unknown>>(sql`
        select ${WINDOW_COLUMNS} from hrm_enrollment_windows
         where org_id = ${orgId} and status = 'open' and kind = ${window.kind} and id <> ${windowId}
      `)
    ).rows.map(toWindowDTO);
    for (const other of open) {
      if (windowsOverlap(shape, toWindowShape(other))) {
        throw new BenefitsError(
          "REFUSED",
          `enrollment window ${window.name} overlaps open window ${other.name} of the same kind and scope — close ${other.name} first so one window covers these people`,
        );
      }
    }
    const updated = (
      await db.execute<Record<string, unknown>>(sql`
        update hrm_enrollment_windows
           set status = 'open', updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${windowId} and status = 'draft'
        returning ${WINDOW_COLUMNS}
      `)
    ).rows;
    return toWindowDTO(requireOneRow(updated, "opening the enrollment window"));
  });
}

/**
 * Close an open window. Every pending_approval election in the window
 * becomes cancelled WITH its own reasoned event — never silently dropped.
 * One transaction: the status flip and every cancellation land together.
 */
export async function closeEnrollmentWindow(query: {
  readonly orgId: string;
  readonly actorId: string;
  readonly windowId: string;
  readonly reason: string;
}): Promise<EnrollmentWindowDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const windowId = requireId(query.windowId, "windowId");
  const reason =
    typeof query.reason === "string" && query.reason.trim().length > 0 ? query.reason.trim() : null;
  if (!reason) {
    throw new BenefitsError(
      "INVALID_INPUT",
      "closing a window needs a reason — it is recorded on every pending election the closure refuses",
    );
  }
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    const window = await loadWindow(db, orgId, windowId);
    if (window.status !== "open") {
      throw new BenefitsError(
        "BAD_STATE",
        `enrollment window ${window.name} is ${window.status} — only an open window closes`,
      );
    }
    const closed = (
      await db.execute<Record<string, unknown>>(sql`
        update hrm_enrollment_windows
           set status = 'closed', updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and id = ${windowId} and status = 'open'
        returning ${WINDOW_COLUMNS}
      `)
    ).rows;
    const result = toWindowDTO(requireOneRow(closed, "closing the enrollment window"));
    const pending = (
      await db.execute<{ id: string }>(sql`
        update hrm_benefit_enrollments
           set status = 'cancelled', updated_by = ${actorId}, updated_at = now()
         where org_id = ${orgId} and window_id = ${windowId} and status = 'pending_approval'
        returning id
      `)
    ).rows;
    for (const row of pending) {
      await db.execute(sql`
        insert into hrm_benefit_events (org_id, enrollment_id, kind, reason, actor, created_by)
        values (${orgId}, ${row.id}, 'cancelled',
                ${`window ${window.name} closed before approval: ${reason}`}, ${actorId}, ${actorId})
      `);
    }
    return result;
  });
}

export interface CreateEnrollmentWindowQuery {
  readonly orgId: string;
  readonly actorId: string;
  readonly name: string;
  readonly kind: string;
  readonly opensOn: string;
  readonly closesOn: string;
  readonly planYearStartOn: string;
  readonly employerSubsidiaryId?: string | null;
  readonly departmentId?: string | null;
}

/**
 * Create a draft window. Scope targets are proven visible in the org —
 * an unknown subsidiary or department is refused at save, so a window
 * that can never apply is never saved as applicable (0193 rule).
 */
export async function createEnrollmentWindow(query: CreateEnrollmentWindowQuery): Promise<EnrollmentWindowDTO> {
  const orgId = requireOrgId(query.orgId);
  const actorId = requireActorId(query.actorId);
  const name =
    typeof query.name === "string" && query.name.trim().length > 0 ? query.name.trim() : null;
  if (!name) {
    throw new BenefitsError("INVALID_INPUT", "a window carries a name — record which enrolment round this is");
  }
  const kind = query.kind;
  if (kind !== "open_enrollment" && kind !== "new_hire" && kind !== "life_event") {
    throw new BenefitsError(
      "INVALID_INPUT",
      "window kind is one of open_enrollment, new_hire, life_event — the kind decides who may elect",
    );
  }
  const opensOn = requireCivilDate(query.opensOn, "opensOn");
  const closesOn = requireCivilDate(query.closesOn, "closesOn");
  const planYearStartOn = requireCivilDate(query.planYearStartOn, "planYearStartOn");
  if (closesOn < opensOn) {
    throw new BenefitsError(
      "INVALID_INPUT",
      `window closes ${closesOn} before it opens ${opensOn} — correct the dates before saving`,
    );
  }
  const employerSubsidiaryId = query.employerSubsidiaryId ?? null;
  const departmentId = query.departmentId ?? null;
  return withOrgTransaction(orgId, async () => {
    await requireHrmBenefitsManage(db, orgId, actorId);
    await assertHrmEnabled(db, orgId);
    if (employerSubsidiaryId !== null) {
      const sub = (
        await db.execute(sql`select id from subsidiaries where org_id = ${orgId} and id = ${employerSubsidiaryId}`)
      ).rows;
      if (sub.length !== 1) {
        throw new BenefitsError(
          "REFUSED",
          "the window names an employer subsidiary outside this organization — scope it to a subsidiary of this org, or leave it org-wide",
        );
      }
    }
    if (departmentId !== null) {
      const dept = (
        await db.execute(sql`select id from departments where org_id = ${orgId} and id = ${departmentId}`)
      ).rows;
      if (dept.length !== 1) {
        throw new BenefitsError(
          "REFUSED",
          "the window names a department outside this organization — scope it to a department of this org, or leave it org-wide",
        );
      }
    }
const inserted = requireOneRow(
      (
        await db.execute<Record<string, unknown>>(sql`
          insert into hrm_enrollment_windows
            (org_id, name, kind, opens_on, closes_on, plan_year_start_on, applies_to, status, created_by, updated_by)
          values (${orgId}, ${name}, ${kind}, ${opensOn}::date, ${closesOn}::date,
                  ${planYearStartOn}::date,
                  jsonb_build_object('employer_subsidiary_id', ${employerSubsidiaryId}::uuid,
                                     'department_id', ${departmentId}::uuid),
                  'draft', ${actorId}, ${actorId})
          returning ${WINDOW_COLUMNS}
        `)
      ).rows,
      "creating the enrollment window",
    );
    return toWindowDTO(inserted);
  });
}
