import { and, eq, sql } from "drizzle-orm";
import { resRequests, RESOURCING_REQUEST_SUBJECT_KIND } from "@openbooks/schema";
import { add, cmp, neg } from "../money/money.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import { lockProjectForScope } from "../organization/subsidiary-scope.ts";
import { db, withOrgTransaction, type SqlExecutor } from "../platform/db.ts";
import {
  routeNativeApproval,
  lockApprovalSubject,
  cancelNativeApprovals,
  readNativeApprovalDecision,
} from "../platform/approval-routing.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { MAX_AVAILABILITY_PERSON_WEEKS } from "./availability-read.ts";
import { ResourcingRefusal } from "./errors.ts";
import { upsertAssignment, validateAssignmentPlan } from "./assignments.ts";
import { assertSundayWindow, weeksBetween } from "./weeks.ts";

type RequestRow = typeof resRequests.$inferSelect;
type RequestWriteRow = RequestRow & Record<string, unknown>;
type RequestAuditLogWriteRow = { row_id: string } & Record<string, unknown>;
type RequestAuditRow = { id: string } & Record<string, unknown>;
type RequestTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

interface RequestWriteContext {
  orgId: string;
  actorId: string;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
}

type ResourceRequestCreateIdempotency = {
  id: string;
  requestId: string;
  match: Record<string, unknown>;
};

export type ResourceRequestSubject =
  { employeePartyId: string; jobTitle?: never } | { employeePartyId?: never; jobTitle: string };

export type ResourceRequestDraftInput = RequestWriteContext &
  ResourceRequestSubject & {
    projectId: string;
    firstWeek: unknown;
    lastWeek: unknown;
    hoursPerWeek: unknown;
    isBillable?: boolean;
    billItemId?: string | null;
    reason?: unknown;
    custom?: Record<string, unknown>;
  };

export type UpdateResourceRequestInput = ResourceRequestDraftInput & {
  requestId: string;
};

export interface ResourceRequestIdInput extends RequestWriteContext {
  requestId: string;
}

export interface CancelResourceRequestInput extends ResourceRequestIdInput {
  reason: unknown;
}

export interface ReleaseResourceRequestInput {
  approvalRunId?: string;
  orgId: string;
  actorId: string | null;
  allowedSubsidiaryIds: ReadonlySet<string> | null;
  requestId: string;
  outcome: "approved" | "rejected";
  comment?: string | null;
}

function refuse(
  status: 409 | 422,
  code: string,
  message: string,
  remedy: string,
  field?: string,
): never {
  throw new ResourcingRefusal(status, code, message, remedy, field);
}

async function withRequestWrite<T>(
  orgId: string,
  work: (tx: RequestTransaction) => Promise<T>,
  subjectId?: string,
): Promise<T> {
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      if (subjectId) await lockApprovalSubject(orgId, RESOURCING_REQUEST_SUBJECT_KIND, subjectId);
      await acquireOrgFeatureGateLock(tx, orgId);
      if (!(await lockAndCheckOrgFeature(tx, orgId, "resourceRequests"))) {
        refuse(
          409,
          "resource_requests_feature_disabled",
          "Resource requests are disabled for this organization",
          "turn Resource requests back on in Company Settings → Features",
        );
      }
      return work(tx);
    }),
  );
}

function requestWeeks(first: unknown, last: unknown): { firstWeek: string; lastWeek: string } {
  if (typeof first !== "string" || typeof last !== "string") {
    refuse(
      422,
      "resource_request_week_invalid",
      "resource request weeks must be civil dates",
      "choose Sunday dates for the request range",
      "firstWeek",
    );
  }
  let weekCount: number;
  try {
    weekCount = assertSundayWindow(first, last);
  } catch {
    refuse(
      422,
      "resource_request_week_invalid",
      "resource request weeks must start on Sunday, with the last week on or after the first",
      "choose Sunday dates in chronological order",
      first === last ? "firstWeek" : "lastWeek",
    );
  }
  if (weekCount > MAX_AVAILABILITY_PERSON_WEEKS) {
    refuse(
      422,
      "resource_request_range_too_large",
      `resource request covers ${weekCount} person-weeks; the limit is ${MAX_AVAILABILITY_PERSON_WEEKS} per request`,
      "choose a shorter date range and create separate requests for later weeks",
      "lastWeek",
    );
  }
  return { firstWeek: first, lastWeek: last };
}

function requestReason(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== "string") {
    refuse(
      422,
      "resource_request_reason_invalid",
      "request reason must be text",
      "enter a short explanation or leave the reason blank",
      "reason",
    );
  }
  return raw.trim() || null;
}

type RequestAssignmentPlanInput = Pick<
  ResourceRequestDraftInput,
  | "orgId"
  | "actorId"
  | "allowedSubsidiaryIds"
  | "projectId"
  | "employeePartyId"
  | "jobTitle"
  | "hoursPerWeek"
  | "isBillable"
  | "billItemId"
>;

async function validateRequestAssignmentPlan(
  tx: SqlExecutor,
  input: RequestAssignmentPlanInput,
  range: { firstWeek: string; lastWeek: string },
) {
  const subject =
    input.employeePartyId !== undefined
      ? { employeePartyId: input.employeePartyId }
      : { jobTitle: input.jobTitle! };
  let normalized: Awaited<ReturnType<typeof validateAssignmentPlan>> | undefined;
  for (const weekStart of weeksBetween(range.firstWeek, range.lastWeek)) {
    normalized = await validateAssignmentPlan(tx, {
      orgId: input.orgId,
      actorId: input.actorId,
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      projectId: input.projectId,
      ...subject,
      weekStart,
      plannedHours: input.hoursPerWeek,
      isBillable: input.isBillable,
      billItemId: input.billItemId,
      source: "manual",
    });
  }
  if (!normalized) throw new Error("resource request validation produced no weekly plan");
  return normalized;
}

async function validateDraft(tx: SqlExecutor, input: ResourceRequestDraftInput) {
  const range = requestWeeks(input.firstWeek, input.lastWeek);
  const normalized = await validateRequestAssignmentPlan(tx, input, range);
  return {
    ...range,
    employeePartyId: input.employeePartyId ?? null,
    jobTitle: normalized.jobTitle,
    hoursPerWeek: normalized.plannedHours,
    isBillable: input.isBillable ?? true,
    billItemId: input.billItemId ?? null,
    reason: requestReason(input.reason),
  };
}

async function writeAudit(
  orgId: string,
  requestId: string,
  action: "insert" | "update",
  changes: Record<string, unknown>,
  actorId: string | null,
): Promise<void> {
  const rows = await db.execute<RequestAuditLogWriteRow>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, 'res_requests', ${requestId}, ${action}, ${JSON.stringify(changes)}::jsonb, ${actorId})
    returning row_id
  `);
  if ((rows.rowCount ?? 0) !== 1 || rows.rows.length !== 1) {
    throw new Error(
      `audit record for resource request ${requestId} wrote ${rows.rows.length} rows; expected exactly one`,
    );
  }
}

async function writeIdempotentCreateAudit(
  tx: SqlExecutor,
  input: {
    orgId: string;
    rowId: string;
    after: object;
    actorId: string;
    requestId: string;
    match: Record<string, unknown>;
  },
): Promise<void> {
  const result = await tx.execute<RequestAuditRow>(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id, request_id)
    values (${input.orgId}, 'res_requests', ${input.rowId}, 'insert',
      ${JSON.stringify({ before: null, after: input.after, match: input.match })}::jsonb,
      ${input.actorId}, ${input.requestId})
    returning id
  `);
  if ((result.rowCount ?? 0) !== 1 || result.rows.length !== 1) {
    throw new Error(
      `audit record for resource request ${input.rowId} wrote ${result.rows.length} rows; expected exactly one`,
    );
  }
}

function requestSnapshot(row: RequestRow): Record<string, unknown> {
  return {
    projectId: row.projectId,
    employeePartyId: row.employeePartyId,
    jobTitle: row.jobTitle,
    firstWeek: row.firstWeek,
    lastWeek: row.lastWeek,
    hoursPerWeek: row.hoursPerWeek,
    isBillable: row.isBillable,
    billItemId: row.billItemId,
    reason: row.reason,
    status: row.status,
    flowInstanceId: row.flowInstanceId,
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt,
    decisionComment: row.decisionComment,
    custom: row.custom,
  };
}

/** Create a draft resource request after applying the assignment writer's validation. */
export async function createResourceRequest(
  input: ResourceRequestDraftInput,
  idempotency?: ResourceRequestCreateIdempotency,
): Promise<RequestRow> {
  return withRequestWrite(input.orgId, async (tx) => {
    const values = await validateDraft(tx, input);
    let request: RequestRow;
    if (idempotency) {
      const result = await tx.execute<RequestWriteRow>(sql`
        insert into res_requests (
          id, org_id, project_id, employee_party_id, job_title, first_week, last_week,
          hours_per_week, is_billable, bill_item_id, reason, custom, status, created_by, updated_by
        ) values (
          coalesce(${idempotency?.id ?? null}::uuid, public.uuid_generate_v7()), ${input.orgId},
          ${input.projectId}, ${values.employeePartyId}, ${values.jobTitle}, ${values.firstWeek},
          ${values.lastWeek}, ${values.hoursPerWeek}, ${values.isBillable}, ${values.billItemId},
          ${values.reason}, ${JSON.stringify(input.custom ?? {})}::jsonb, 'draft', ${input.actorId}, ${input.actorId}
        ) returning id, org_id as "orgId", project_id as "projectId",
          employee_party_id as "employeePartyId", job_title as "jobTitle",
          first_week::text as "firstWeek", last_week::text as "lastWeek",
          hours_per_week::text as "hoursPerWeek", is_billable as "isBillable",
          bill_item_id as "billItemId", reason, status, decided_by as "decidedBy",
          decided_at as "decidedAt", decision_comment as "decisionComment",
          flow_instance_id as "flowInstanceId", custom, created_at as "createdAt",
          created_by as "createdBy", updated_at as "updatedAt", updated_by as "updatedBy"
      `);
      if ((result.rowCount ?? 0) !== 1 || !result.rows[0]) {
        throw new Error(
          `resource request creation wrote ${result.rows.length} rows; expected exactly one`,
        );
      }
      request = result.rows[0];
      await writeIdempotentCreateAudit(tx, {
        orgId: input.orgId,
        rowId: request.id,
        after: request,
        actorId: input.actorId,
        requestId: idempotency.requestId,
        match: idempotency.match,
      });
    } else {
      const rows = await tx
        .insert(resRequests)
        .values({
          orgId: input.orgId,
          projectId: input.projectId,
          employeePartyId: values.employeePartyId,
          jobTitle: values.jobTitle,
          firstWeek: values.firstWeek,
          lastWeek: values.lastWeek,
          hoursPerWeek: values.hoursPerWeek,
          isBillable: values.isBillable,
          billItemId: values.billItemId,
          reason: values.reason,
          custom: input.custom ?? {},
          status: "draft",
          createdBy: input.actorId,
          updatedBy: input.actorId,
        })
        .returning();
      if (rows.length !== 1)
        throw new Error(
          `resource request creation wrote ${rows.length} rows; expected exactly one`,
        );
      request = rows[0]!;
      await writeAudit(
        input.orgId,
        request.id,
        "insert",
        { after: requestSnapshot(request) },
        input.actorId,
      );
    }
    return request;
  });
}

/** Replace the proposal on a draft; submitted requests are frozen under Flows. */
export async function updateResourceRequestDraft(
  input: UpdateResourceRequestInput,
): Promise<RequestRow> {
  return withRequestWrite(input.orgId, async (tx) => {
    const current = (
      await tx
        .select()
        .from(resRequests)
        .where(and(eq(resRequests.orgId, input.orgId), eq(resRequests.id, input.requestId)))
        .for("update")
    )[0];
    if (!current)
      refuse(
        409,
        "resource_request_unknown",
        `resource request ${input.requestId} is not visible`,
        "reload the resource request",
        "requestId",
      );
    await lockProjectForScope(
      tx,
      input.orgId,
      current.projectId,
      input.allowedSubsidiaryIds,
      "share",
    );
    if (current.status !== "draft") {
      refuse(
        409,
        "resource_request_not_draft",
        `a ${current.status} resource request is frozen`,
        "edit a draft request or create a new request",
        "requestId",
      );
    }
    const values = await validateDraft(tx, input);
    const rows = await tx
      .update(resRequests)
      .set({
        projectId: input.projectId,
        employeePartyId: values.employeePartyId,
        jobTitle: values.jobTitle,
        firstWeek: values.firstWeek,
        lastWeek: values.lastWeek,
        hoursPerWeek: values.hoursPerWeek,
        isBillable: values.isBillable,
        billItemId: values.billItemId,
        reason: values.reason,
        ...(input.custom === undefined ? {} : { custom: input.custom }),
        updatedBy: input.actorId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(resRequests.orgId, input.orgId),
          eq(resRequests.id, input.requestId),
          eq(resRequests.status, "draft"),
        ),
      )
      .returning();
    if (rows.length !== 1)
      throw new Error(`resource request update wrote ${rows.length} rows; expected exactly one`);
    const updated = rows[0]!;
    await writeAudit(
      input.orgId,
      updated.id,
      "update",
      {
        before: requestSnapshot(current),
        after: requestSnapshot(updated),
      },
      input.actorId,
    );
    return updated;
  });
}

/** Submit a draft to the authored approval flow and persist its gated run. */
export async function submitResourceRequest(input: ResourceRequestIdInput): Promise<RequestRow> {
  return withRequestWrite(
    input.orgId,
    async (tx) => {
      const nativeScope = await lockActorCommandAuthority(
        db,
        input.orgId,
        input.actorId,
        null,
        "resourcing.manage",
      );
      const current = (
        await tx
          .select()
          .from(resRequests)
          .where(and(eq(resRequests.orgId, input.orgId), eq(resRequests.id, input.requestId)))
          .for("update")
      )[0];
      if (!current)
        refuse(
          409,
          "resource_request_unknown",
          `resource request ${input.requestId} is not visible`,
          "reload the resource request",
          "requestId",
        );
      await lockProjectForScope(
        tx,
        input.orgId,
        current.projectId,
        input.allowedSubsidiaryIds,
        "share",
      );
      await lockProjectForScope(tx, input.orgId, current.projectId, nativeScope, "share");
      if (current.status !== "draft") {
        refuse(
          409,
          "resource_request_not_draft",
          `a ${current.status} resource request cannot be submitted`,
          "submit a draft request",
          "requestId",
        );
      }
      const range = requestWeeks(current.firstWeek, current.lastWeek);
      const subject = current.employeePartyId
        ? { employeePartyId: current.employeePartyId }
        : { jobTitle: current.jobTitle! };
      await validateRequestAssignmentPlan(
        tx,
        {
          orgId: input.orgId,
          actorId: input.actorId,
          allowedSubsidiaryIds:
            nativeScope === null
              ? input.allowedSubsidiaryIds
              : input.allowedSubsidiaryIds === null
                ? nativeScope
                : new Set([...nativeScope].filter((id) => input.allowedSubsidiaryIds!.has(id))),
          projectId: current.projectId,
          ...subject,
          hoursPerWeek: current.hoursPerWeek,
          isBillable: current.isBillable,
          billItemId: current.billItemId,
        },
        range,
      );
      const routing = await routeNativeApproval({
        orgId: input.orgId,
        actorId: input.actorId,
        subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
        subjectId: input.requestId,
      });
      const rows = await tx
        .update(resRequests)
        .set({
          status: "submitted",
          flowInstanceId: routing.gatingRunId,
          updatedBy: input.actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resRequests.orgId, input.orgId),
            eq(resRequests.id, input.requestId),
            eq(resRequests.status, "draft"),
          ),
        )
        .returning();
      if (rows.length !== 1)
        throw new Error("resource request submission did not update one draft row");
      await writeAudit(
        input.orgId,
        input.requestId,
        "update",
        {
          before: requestSnapshot(current),
          after: requestSnapshot(rows[0]!),
        },
        input.actorId,
      );
      if (routing.policy.kind === "ungated") {
        await releaseResourceRequest({
          ...input,
          outcome: "approved",
          comment: "Released by the tenant's zero-gate Flow policy",
        });
        const released = (
          await tx
            .select()
            .from(resRequests)
            .where(and(eq(resRequests.orgId, input.orgId), eq(resRequests.id, input.requestId)))
        )[0];
        if (!released || released.status !== "approved")
          throw new Error("Resource request release is not visible through its native reader.");
        return released;
      }
      return rows[0]!;
    },
    input.requestId,
  );
}

/** Cancel a draft or submitted request and cancel any still-open approval work. */
export async function cancelResourceRequest(
  input: CancelResourceRequestInput,
): Promise<RequestRow> {
  return withRequestWrite(
    input.orgId,
    async (tx) => {
      const nativeScope = await lockActorCommandAuthority(
        db,
        input.orgId,
        input.actorId,
        null,
        "resourcing.manage",
      );
      const reason = requestReason(input.reason);
      if (!reason)
        refuse(
          422,
          "resource_request_cancel_reason_required",
          "cancelling a resource request requires a reason",
          "enter why the request is being cancelled",
          "reason",
        );
      const current = (
        await tx
          .select()
          .from(resRequests)
          .where(and(eq(resRequests.orgId, input.orgId), eq(resRequests.id, input.requestId)))
          .for("update")
      )[0];
      if (!current)
        refuse(
          409,
          "resource_request_unknown",
          `resource request ${input.requestId} is not visible`,
          "reload the resource request",
          "requestId",
        );
      await lockProjectForScope(
        tx,
        input.orgId,
        current.projectId,
        input.allowedSubsidiaryIds,
        "share",
      );
      await lockProjectForScope(tx, input.orgId, current.projectId, nativeScope, "share");
      if (current.status !== "draft" && current.status !== "submitted") {
        refuse(
          409,
          "resource_request_not_cancellable",
          `a ${current.status} resource request cannot be cancelled`,
          "cancel a draft or submitted request",
          "requestId",
        );
      }
      if (current.status === "submitted")
        await cancelNativeApprovals({
          orgId: input.orgId,
          actorId: input.actorId,
          subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
          subjectId: input.requestId,
        });
      const rows = await tx
        .update(resRequests)
        .set({
          status: "cancelled",
          decisionComment: reason,
          updatedBy: input.actorId,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(resRequests.orgId, input.orgId),
            eq(resRequests.id, input.requestId),
            eq(resRequests.status, current.status),
          ),
        )
        .returning();
      if (rows.length !== 1)
        throw new Error("resource request cancellation did not update one row");
      await writeAudit(
        input.orgId,
        input.requestId,
        "update",
        {
          before: requestSnapshot(current),
          after: requestSnapshot(rows[0]!),
        },
        input.actorId,
      );
      return rows[0]!;
    },
    input.requestId,
  );
}

/** Release a gate decision atomically with its hard weekly assignment rows. */
export async function releaseResourceRequest(input: ReleaseResourceRequestInput): Promise<void> {
  try {
    await withRequestWrite(
      input.orgId,
      async (tx) => {
        if (!input.actorId)
          refuse(
            422,
            "resource_request_actor_required",
            "A native resource request decision needs an acting user",
            "Submit the request through Flows",
          );
        const nativeScope = await lockActorCommandAuthority(
          db,
          input.orgId,
          input.actorId,
          null,
          "resourcing.manage",
        );
        const current = (
          await tx
            .select()
            .from(resRequests)
            .where(and(eq(resRequests.orgId, input.orgId), eq(resRequests.id, input.requestId)))
            .for("update")
        )[0];
        if (!current)
          refuse(
            409,
            "resource_request_unknown",
            `resource request ${input.requestId} is not visible`,
            "reload the resource request",
            "requestId",
          );
        await lockProjectForScope(
          tx,
          input.orgId,
          current.projectId,
          input.allowedSubsidiaryIds,
          "share",
        );
        await lockProjectForScope(tx, input.orgId, current.projectId, nativeScope, "share");
        if (current.status !== "submitted") {
          refuse(
            409,
            "resource_request_not_submitted",
            `resource request ${input.requestId} is ${current.status}`,
            "decide a submitted resource request",
            "requestId",
          );
        }

        const decision = await readNativeApprovalDecision({
          orgId: input.orgId,
          actorId: input.actorId,
          subjectKind: RESOURCING_REQUEST_SUBJECT_KIND,
          subjectId: input.requestId,
          outcome: input.outcome,
          approvalRunId: input.approvalRunId,
        });
        const proof = (
          await tx.execute<{ valid: boolean }>(
            sql`select public.flow_subject_decision_authorized(r.org_id,'resourcing_request',r.id,${input.actorId},public.resourcing_request_approval_fingerprint(r),${input.outcome}) as valid from res_requests r where r.org_id=${input.orgId} and r.id=${input.requestId}`,
            "objects",
          )
        )[0];
        if (!proof?.valid || (input.approvalRunId ? !decision : input.outcome !== "approved"))
          refuse(
            422,
            "resource_request_flow_decision_required",
            "This resource request has no complete current Flow decision",
            "Submit its current terms and complete the configured gates",
          );
        requestWeeks(current.firstWeek, current.lastWeek);

        const assignmentIds: string[] = [];
        const overallocations: string[] = [];
        if (input.outcome === "approved") {
          const subject = current.employeePartyId
            ? { employeePartyId: current.employeePartyId }
            : { jobTitle: current.jobTitle! };
          for (const weekStart of weeksBetween(current.firstWeek, current.lastWeek)) {
            const created = await upsertAssignment({
              orgId: input.orgId,
              actorId: input.actorId,
              allowedSubsidiaryIds:
                nativeScope === null
                  ? input.allowedSubsidiaryIds
                  : input.allowedSubsidiaryIds === null
                    ? nativeScope
                    : new Set([...nativeScope].filter((id) => input.allowedSubsidiaryIds!.has(id))),
              projectId: current.projectId,
              ...subject,
              weekStart,
              plannedHours: current.hoursPerWeek,
              isBillable: current.isBillable,
              billItemId: current.billItemId,
              booking: "hard",
              source: "request",
              requestId: current.id,
            });
            if (
              created.assignment.source !== "request" ||
              created.assignment.requestId !== current.id
            ) {
              throw new Error("request approval assignment is missing its request provenance");
            }
            assignmentIds.push(created.assignment.id);
            const totals = created.weeklyTotals;
            if (
              totals?.netCapacity !== null &&
              totals?.netCapacity !== undefined &&
              cmp(totals.hardHours, totals.netCapacity) > 0
            ) {
              const excess = add(totals.hardHours, neg(totals.netCapacity));
              const label = current.employeePartyId ?? current.jobTitle ?? "resource";
              overallocations.push(
                `${weekStart}: ${label} has ${totals.hardHours} hard hours against ${totals.netCapacity} net capacity hours (${excess} over after approval)`,
              );
            }
          }
          if (assignmentIds.length === 0)
            throw new Error("approved resource request generated no weekly assignments");
        }

        const commentParts = [input.comment?.trim() || null];
        if (input.outcome === "approved" && overallocations.length > 0) {
          commentParts.push(`Capacity context: ${overallocations.join("; ")}`);
        }
        const decisionComment =
          commentParts.filter((part): part is string => part !== null).join("\n") || null;
        const rows = await tx
          .update(resRequests)
          .set({
            status: input.outcome,
            decidedBy: input.actorId || null,
            decidedAt: new Date(),
            decisionComment,
            updatedBy: input.actorId || null,
            updatedAt: new Date(),
          })
          .where(
            and(
              eq(resRequests.orgId, input.orgId),
              eq(resRequests.id, input.requestId),
              eq(resRequests.status, "submitted"),
            ),
          )
          .returning();
        if (rows.length !== 1)
          throw new Error("resource request release did not update one submitted row");
        await writeAudit(
          input.orgId,
          input.requestId,
          "update",
          {
            before: requestSnapshot(current),
            after: requestSnapshot(rows[0]!),
            assignmentIds,
          },
          input.actorId || null,
        );
      },
      input.requestId,
    );
  } catch (error) {
    if (error instanceof ResourcingRefusal) {
      throw new ResourcingRefusal(
        error.status,
        error.code,
        `${error.message}; ${error.remedy}`,
        error.remedy,
        error.field,
      );
    }
    throw error;
  }
}
