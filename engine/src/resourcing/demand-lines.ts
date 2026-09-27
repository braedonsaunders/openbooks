import { and, eq, sql } from "drizzle-orm";
import { resDemandLines } from "@openbooks/schema";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { decimalNullRefusal } from "../money/decimal-refusal.ts";
import { cmp } from "../money/money.ts";
import {
  lockScopeRow,
  ScopeNotFoundError,
} from "../organization/subsidiary-scope.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import { ResourcingRefusal } from "./errors.ts";
import { lockAndRequireResourcing } from "./feature.ts";
import { assertSundayWindow } from "./weeks.ts";

type DemandLineRow = typeof resDemandLines.$inferSelect;
type DemandLineInsert = typeof resDemandLines.$inferInsert;
type DepartmentStateRow = { id: string; is_active: boolean } & Record<string, unknown>;
type OpportunityIdRow = { id: string } & Record<string, unknown>;
type AuditIdRow = { id: string } & Record<string, unknown>;
type DemandTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

type DemandWriteContext = {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
};

export type DemandLineDraftInput = DemandWriteContext & {
  departmentId: string;
  jobTitle: unknown;
  firstWeek: unknown;
  lastWeek: unknown;
  hoursPerWeek: unknown;
  note?: unknown;
  opportunityId?: string | null;
  custom?: Record<string, unknown>;
};

export type UpdateDemandLineInput = DemandLineDraftInput & { demandLineId: string };

export type DemandLineCreateIdempotency = {
  id: string;
  requestId: string;
  match: Record<string, unknown>;
};

function refuse(code: string, message: string, remedy: string, field?: string): never {
  throw new ResourcingRefusal(422, code, message, remedy, field);
}

async function withDemandWrite<T>(
  orgId: string,
  work: (tx: DemandTransaction) => Promise<T>,
): Promise<T> {
  return withOrgTransaction(orgId, () => db.transaction(async (tx) => {
    await lockAndRequireResourcing(tx, orgId);
    return work(tx);
  }));
}

function validateWeeks(first: unknown, last: unknown): { firstWeek: string; lastWeek: string } {
  if (typeof first !== "string" || typeof last !== "string") {
    refuse("demand_week_invalid", "demand weeks must be civil dates", "choose Sunday dates for the demand range", "firstWeek");
  }
  assertSundayWindow(first, last);
  return { firstWeek: first, lastWeek: last };
}

function validateHours(raw: unknown): string {
  const hours = canonicalDecimal(raw, 4);
  if (hours === null) {
    refuse(
      "demand_hours_invalid",
      decimalNullRefusal("hoursPerWeek", "a number of hours", raw, 4),
      "enter hours as a decimal string with a period for decimals",
      "hoursPerWeek",
    );
  }
  if (cmp(hours, "0") <= 0 || cmp(hours, "168") > 0) {
    refuse(
      "demand_hours_out_of_range",
      "hours per week must be greater than zero and no more than 168",
      "enter a positive number of hours no greater than 168",
      "hoursPerWeek",
    );
  }
  return hours;
}

function validateJobTitle(raw: unknown): string {
  const jobTitle = typeof raw === "string" ? raw.trim() : "";
  if (!jobTitle) {
    refuse("demand_job_title_required", "a job title is required for demand", "enter the role this department needs", "jobTitle");
  }
  return jobTitle;
}

function validateNote(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    refuse("demand_note_invalid", "demand notes must be text", "enter a text note or leave it blank", "note");
  }
  return raw.trim() || null;
}

async function lockDepartments(
  tx: SqlExecutor,
  input: DemandWriteContext,
  departmentIds: string[],
): Promise<void> {
  const ids = [...new Set(departmentIds)].sort();
  for (const id of ids) {
    await lockScopeRow(tx, input.orgId, "department", id, input.allowedSubsidiaryIds, "share");
  }
  const activeRows = (await tx.execute<DepartmentStateRow>(sql`
    select id::text as id, is_active from departments
     where org_id = ${input.orgId} and id = any(${`{${ids.join(",")}}`}::uuid[])
     order by id
  `)).rows;
  if (activeRows.length !== ids.length) throw new Error("a department disappeared while its scope lock was held");
  const inactive = activeRows.find((row) => !row.is_active);
  if (inactive) {
    refuse(
      "demand_department_inactive",
      `department ${inactive.id} is inactive and cannot receive demand`,
      "reactivate the department in Company Settings → Setup → Dimensions → Departments, or choose an active department",
      "departmentId",
    );
  }
}

async function validateOpportunity(
  tx: SqlExecutor,
  orgId: string,
  opportunityId: string | null,
): Promise<void> {
  if (opportunityId === null) return;
  const opportunity = (await tx.execute<OpportunityIdRow>(sql`
    select id::text as id from crm_opportunities
     where org_id = ${orgId} and id = ${opportunityId} for share
  `)).rows[0];
  if (!opportunity) {
    refuse(
      "demand_opportunity_unknown",
      "the linked opportunity is not in this organization",
      "remove the opportunity link or choose an opportunity from this organization",
      "opportunityId",
    );
  }
}

async function validateDraft(
  tx: SqlExecutor,
  input: DemandLineDraftInput,
  departmentIds = [input.departmentId],
) {
  await lockDepartments(tx, input, departmentIds);
  const range = validateWeeks(input.firstWeek, input.lastWeek);
  const jobTitle = validateJobTitle(input.jobTitle);
  const hoursPerWeek = validateHours(input.hoursPerWeek);
  const note = validateNote(input.note);
  const opportunityId = input.opportunityId ?? null;
  await validateOpportunity(tx, input.orgId, opportunityId);
  return {
    ...range,
    departmentId: input.departmentId,
    jobTitle,
    hoursPerWeek,
    note,
    opportunityId,
    custom: input.custom ?? {},
  };
}

function snapshot(row: DemandLineRow): Record<string, unknown> {
  return {
    departmentId: row.departmentId,
    jobTitle: row.jobTitle,
    firstWeek: row.firstWeek,
    lastWeek: row.lastWeek,
    hoursPerWeek: row.hoursPerWeek,
    note: row.note,
    opportunityId: row.opportunityId,
    custom: row.custom,
  };
}

async function writeAudit(
  tx: SqlExecutor,
  input: { orgId: string; rowId: string; actorId: string; action: "insert" | "update" | "delete"; changes: Record<string, unknown>; requestId?: string },
): Promise<void> {
  const result = await tx.execute<AuditIdRow>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (
      ${input.orgId}, 'res_demand_lines', ${input.rowId}, ${input.action},
      ${JSON.stringify(input.changes)}::jsonb, ${input.actorId}, ${input.requestId ?? null}
    ) returning id
  `);
  if ((result.rowCount ?? 0) !== 1 || result.rows.length !== 1) {
    throw new Error(`demand line audit wrote ${result.rows.length} rows; expected exactly one`);
  }
}

/** Store a manual or opportunity-linked staffing ask with its audit evidence. */
export async function createDemandLine(
  input: DemandLineDraftInput,
  idempotency?: DemandLineCreateIdempotency,
): Promise<DemandLineRow> {
  return withDemandWrite(input.orgId, async (tx) => {
    const values = await validateDraft(tx, input);
    const insert: DemandLineInsert = {
      ...(idempotency ? { id: idempotency.id } : {}),
      orgId: input.orgId,
      departmentId: values.departmentId,
      jobTitle: values.jobTitle,
      firstWeek: values.firstWeek,
      lastWeek: values.lastWeek,
      hoursPerWeek: values.hoursPerWeek,
      note: values.note,
      opportunityId: values.opportunityId,
      custom: values.custom,
      createdBy: input.actorId,
      updatedBy: input.actorId,
    };
    const rows = await tx.insert(resDemandLines).values(insert).returning();
    if (rows.length !== 1) throw new Error(`demand line creation wrote ${rows.length} rows; expected exactly one`);
    const row = rows[0]!;
    await writeAudit(tx, {
      orgId: input.orgId,
      rowId: row.id,
      actorId: input.actorId,
      action: "insert",
      changes: {
        before: null,
        after: snapshot(row),
        ...(idempotency ? { match: idempotency.match } : {}),
      },
      requestId: idempotency?.requestId,
    });
    return row;
  });
}

/** Replace a demand line after locking its current row and department scope. */
export async function updateDemandLine(input: UpdateDemandLineInput): Promise<DemandLineRow> {
  return withDemandWrite(input.orgId, async (tx) => {
    const current = (await tx.select().from(resDemandLines).where(and(
      eq(resDemandLines.orgId, input.orgId),
      eq(resDemandLines.id, input.demandLineId),
    )).for("update"))[0];
    if (!current) throw new ScopeNotFoundError();
    const values = await validateDraft(tx, input, [current.departmentId, input.departmentId]);
    const rows = await tx.update(resDemandLines).set({
      departmentId: values.departmentId,
      jobTitle: values.jobTitle,
      firstWeek: values.firstWeek,
      lastWeek: values.lastWeek,
      hoursPerWeek: values.hoursPerWeek,
      note: values.note,
      opportunityId: values.opportunityId,
      custom: values.custom,
      updatedBy: input.actorId,
      updatedAt: new Date(),
    }).where(and(
      eq(resDemandLines.orgId, input.orgId),
      eq(resDemandLines.id, input.demandLineId),
    )).returning();
    if (rows.length !== 1) throw new Error(`demand line update wrote ${rows.length} rows; expected exactly one`);
    const updated = rows[0]!;
    await writeAudit(tx, {
      orgId: input.orgId,
      rowId: updated.id,
      actorId: input.actorId,
      action: "update",
      changes: { before: snapshot(current), after: snapshot(updated) },
    });
    return updated;
  });
}

/** Delete one visible demand line and preserve the before-image in its audit. */
export async function deleteDemandLine(
  input: DemandWriteContext & { demandLineId: string },
): Promise<void> {
  return withDemandWrite(input.orgId, async (tx) => {
    const current = (await tx.select().from(resDemandLines).where(and(
      eq(resDemandLines.orgId, input.orgId),
      eq(resDemandLines.id, input.demandLineId),
    )).for("update"))[0];
    if (!current) throw new ScopeNotFoundError();
    await lockDepartments(tx, input, [current.departmentId]);
    const rows = await tx.delete(resDemandLines).where(and(
      eq(resDemandLines.orgId, input.orgId),
      eq(resDemandLines.id, input.demandLineId),
    )).returning();
    if (rows.length !== 1) throw new Error(`demand line deletion wrote ${rows.length} rows; expected exactly one`);
    await writeAudit(tx, {
      orgId: input.orgId,
      rowId: current.id,
      actorId: input.actorId,
      action: "delete",
      changes: { before: snapshot(current), after: null },
    });
  });
}
