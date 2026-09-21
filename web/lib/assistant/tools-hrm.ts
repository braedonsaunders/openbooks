import "server-only";
import { z } from "zod";
import {
  listEnrollmentWindows,
  listEnrollments,
} from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { CompensationError } from "@openbooks/engine/src/hrm/compensation/errors.ts";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";
import {
  listLeaveRequests,
  listLeaveTypes,
  timeBalanceAsOf,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";
import { HrmQualificationError } from "@openbooks/engine/src/hrm/qualifications/errors.ts";
// HR-19 begin: documents/surveys refusals (feature off, undeclared
// category, token replay, suppression) reach the caller intact — both
// error classes live in the documents errors module.
import { HrmDocumentsError, HrmSurveysError } from "@openbooks/engine/src/hrm/documents/errors.ts";
// HR-19 end
import { SelfServiceError } from "@openbooks/engine/src/hrm/self-service/actor.ts";
import { getMyProfile } from "@openbooks/engine/src/hrm/self-service/self-read.ts";
import {
  getMyBenefitsWorkspace,
  getMyReviewWorkspace,
} from "@openbooks/engine/src/hrm/self-service/my-work.ts";
import { HrmProcessError } from "@openbooks/engine/src/hrm/processes.ts";
import { getProcess, listProcesses } from "@openbooks/engine/src/hrm/processes-read.ts";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import {
  EmploymentReadError,
  findEmploymentsByParty,
  getEmploymentAsOf,
  getHeadcountAsOf,
  loadEmploymentChangeRequests,
} from "@openbooks/engine/src/hrm/employment-read.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
// HR-13 begin: construction read services for the two compliance tools.
import { listFindings } from "@openbooks/engine/src/hrm/construction/findings.ts";
import { listRuns } from "@openbooks/engine/src/hrm/construction/certified.ts";
import { HrmConstructionError } from "@openbooks/engine/src/hrm/construction/errors.ts";
// HR-13 end
import { HrmPerformanceError } from "@openbooks/engine/src/hrm/performance/errors.ts";
import {
  getCycleDetail,
  getRetentionOverview,
  getTurnover,
  listCycleProgress,
} from "@openbooks/engine/src/hrm/performance/performance-read.ts";
import { getVacancyAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { RecruitingError } from "@openbooks/engine/src/hrm/recruiting/errors.ts";
import {
  getRequisitionDetail,
  listRequisitions,
} from "@openbooks/engine/src/hrm/recruiting/recruiting-read.ts";
import { AmbiguousRevisionError, TemporalError } from "@openbooks/engine/src/hrm/temporal.ts";
import { listInbox } from "@openbooks/engine/src/inbox/index.ts";
import { inboxContext } from "../inbox-context";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import {
  compactRows,
  dateInput,
  orgToday,
  periodPresetInput,
  resolveToolRange,
  uuidInput,
} from "./tools-shared";

/**
 * HRM read/search tools for the agentic assistant. Every tool is
 * feature-gated on the hrm switchboard flag and permission-gated with the
 * same key the HRM routes and pages use (`hrm.employment.read` for the
 * employment tools, `hrm.position.read` for the headcount-plan tool).
 *
 * Every read reuses the canonical loaders in
 * engine/src/hrm/employment-read.ts — headcount as-of, episodes, the as-of
 * assignment resolution, and the 0185 change-request list — so the tools
 * resolve through the same temporal primitives and the same authorization
 * gate (requireHrmEmploymentRead / subsidiary scope) as the Employment tab.
 * Refusals computed by the read service (missing or ambiguous revision,
 * unknown or out-of-scope employment, disabled feature) surface as tool
 * refusals with their message intact — never empty results, never a throw.
 *
 * The one SQL in this file enumerates stable employment identities for the
 * org-wide change-request list (org + subsidiary scope, capped). Version and
 * request rows are never selected here: they come only from the loaders.
 * Authoring stays human-attested — there are no HRM write tools in this
 * slice, so nothing here can mutate an employment or a request.
 */

const HRM_FEATURE_OFF = "hrm_feature_disabled";

/**
 * Map a read-service refusal to a tool refusal with the message intact.
 * Unknown failures rethrow so executeAssistantTool reports tool_failed
 * instead of leaking internals — a computed refusal must reach the caller,
 * and anything else must stay private.
 */
export function hrmRefusal(error: unknown): ToolResult {
  if (
    error instanceof EmploymentReadError ||
    error instanceof HrmPositionError ||
    error instanceof HrmProcessError ||
    error instanceof LeaveError ||
    error instanceof RecruitingError ||
    error instanceof HrmPerformanceError ||
    // HR-13 begin: construction refusals reach the caller with their
    // message intact, like every other read-service refusal above.
    error instanceof HrmConstructionError ||
    // HR-13 end
    error instanceof BenefitsError ||
    error instanceof CompensationError ||
    // HR-14 begin: qualification refusals (feature off by name, evidence
    // required, unknown type) reach the caller with their message intact.
    error instanceof HrmQualificationError ||
    // HR-14 end
    // HR-19 begin: documents/surveys refusals reach the caller with
    // their message intact, like every other read-service refusal.
    error instanceof HrmDocumentsError ||
    error instanceof HrmSurveysError ||
    // HR-19 end

    error instanceof HrmAuthorizationError ||
    error instanceof TemporalError ||
    error instanceof SelfServiceError
  ) {
    return { ok: false, error: error.message };
  }
  throw error;
}

async function hrmFeatureRefused(orgId: string): Promise<ToolResult | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return { ok: false, error: HRM_FEATURE_OFF };
  return null;
}

const hrmHeadcount: AssistantToolDef = {
  name: "hrm_headcount",
  description:
    "Headcount as of a date (or preset) by employer subsidiary and department: in-service employments resolved through their effective versions, never a row count. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.employment.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    asOf: dateInput.optional().describe("Headcount as of this date; defaults to today"),
    period: periodPresetInput.optional().describe("Fiscal-calendar preset; the headcount is taken as of the preset's end date"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { asOf?: string; period?: string };
    // A preset names a range; headcount is a point, so the range end is the
    // as-of date — resolved server-side with the org's fiscal start month,
    // exactly like the report tools resolve their presets.
    let effectiveDate: string;
    if (a.period) {
      const range = await resolveToolRange(authz.user.orgId, { period: a.period });
      if ("error" in range) return { ok: false, error: range.error };
      effectiveDate = range.to;
    } else {
      effectiveDate = a.asOf ?? (await orgToday(authz.user.orgId));
    }
    try {
      const dto = await getHeadcountAsOf({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        effectiveDate,
        knownAt: new Date().toISOString(),
      });
      return {
        ok: true,
        data: {
          asOf: dto.effectiveDate,
          knownAt: dto.knownAt,
          total: dto.total,
          groups: dto.groups.map((group) => ({
            employerSubsidiaryId: group.employerSubsidiaryId,
            employerSubsidiaryName: group.employerSubsidiaryName,
            departmentId: group.departmentId,
            departmentName: group.departmentName,
            headcount: group.headcount,
          })),
          href: "/hrm",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmEmploymentAsOf: AssistantToolDef = {
  name: "hrm_employment_as_of",
  description:
    "One employment's effective version and assignments as of a date, with recorded-vs-effective stamps; missing or ambiguous revisions refuse with the remedy. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["hrm.employment.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("Employment to resolve; pass one of employmentId or partyId"),
    partyId: uuidInput.optional().describe("Worker party; resolves to its employment, refusing when none or several are visible"),
    asOf: dateInput.optional().describe("Effective date to resolve; defaults to today"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { employmentId?: string; partyId?: string; asOf?: string };
    const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
    try {
      let employmentId = a.employmentId ?? null;
      if (!employmentId && a.partyId) {
        // Party resolution is the aggregate half of the read gate (grant +
        // employer-subsidiary scope): out-of-scope employments are filtered,
        // never returned. Zero ids is a missing-employment refusal and more
        // than one is the caller's ambiguity to refuse — identity is per
        // employment, exactly as the read service documents.
        const ids = await findEmploymentsByParty({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          workerPartyId: a.partyId,
        });
        if (ids.length === 0) {
          throw new EmploymentReadError(
            `employment not found: party ${a.partyId} has no employment visible in this organization and legal-entity scope; check the party id or pass employmentId`,
          );
        }
        if (ids.length > 1) {
          throw new AmbiguousRevisionError(
            `${ids.length} employments are visible for party ${a.partyId}; employment identity is per employment — pass one employmentId`,
          );
        }
        employmentId = ids[0] ?? null;
      }
      if (!employmentId) return { ok: false, error: "employment_or_party_required" };
      const dto = await getEmploymentAsOf({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId,
        effectiveDate: asOf,
        knownAt: new Date().toISOString(),
      });
      return {
        ok: true,
        data: {
          employmentId: dto.employmentId,
          workerPartyId: dto.workerPartyId,
          employerSubsidiaryId: dto.employerSubsidiaryId,
          revision: dto.revision,
          asOf,
          version: dto.version,
          assignments: dto.assignments,
          href: "/hrm",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

/** 0185 lifecycle statuses: the CHECK the change-request table enforces. */
const changeRequestStatuses = ["draft", "pending_approval", "approved", "rejected", "withdrawn", "applied"] as const;

/** Stable employment identities in the caller's scope for the org-wide list. */
async function visibleEmploymentIds(
  orgId: string,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
  max: number,
): Promise<{ ids: string[]; truncated: boolean }> {
  // Identity enumeration only: a null employer is invisible (authorization
  // refuses such subjects, so the list twin excludes them rather than
  // leaking their ids). Versions and requests come from the loader below.
  const rows = (await db.execute<{ id: string }>(sql`
    select id::text as id
      from worker_employments
     where org_id = ${orgId}
       and employer_subsidiary_id is not null
       ${subsidiaryVisibleFilter(sql`employer_subsidiary_id`, allowedSubsidiaryIds)}
     order by id
     limit ${max + 1}`)).rows;
  return { ids: rows.slice(0, max).map((row) => row.id), truncated: rows.length > max };
}

const hrmChangeRequests: AssistantToolDef = {
  name: "hrm_change_requests",
  description:
    "Employment change requests with status, action/reason codes, applied verb, revision binding, and flow run: one employment's list, or every visible employment newest-first with an optional status filter. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.employment.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("One employment's requests; omit for every visible employment"),
    status: z.enum(changeRequestStatuses).optional().describe("Keep only this lifecycle status"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum requests to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { employmentId?: string; status?: (typeof changeRequestStatuses)[number]; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      // A named employment is authorized per record inside the loader, so a
      // missing, foreign-org, or out-of-scope id refuses uniformly instead
      // of returning an empty list pretending it does not exist.
      const scoped = a.employmentId
        ? { ids: [a.employmentId], truncated: false }
        : await visibleEmploymentIds(authz.user.orgId, authz.allowedSubsidiaryIds, 200);
      const collected: {
        employmentId: string;
        id: string;
        status: string;
        requestRevision: number;
        expectedEmploymentRevision: number;
        payloadSchemaVersion: string;
        reason: string | null;
        // HR-16 begin: 0227 classification carried from submit.
        action: string | null;
        reasonCode: string | null;
        appliedEmploymentChangeId: string | null;
        // HR-16 end
        submittedBy: string | null;
        submittedAt: string | null;
        flowRunId: string | null;
        appliedAt: string | null;
        appliedBy: string | null;
        appliedEmploymentRevision: number | null;
        createdAt: string;
        updatedAt: string;
      }[] = [];
      // Sequential, never parallel: one pinned client per loader call, the
      // same discipline the record boundary keeps inside its transaction.
      for (const employmentId of scoped.ids) {
        const requests = await loadEmploymentChangeRequests(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          employmentId,
        });
        for (const request of requests) {
          if (a.status && request.status !== a.status) continue;
          // Explicit projection: the decision snapshot stays in the record
          // read, so a future 0185 column cannot ride this list silently.
          collected.push({
            employmentId,
            id: request.id,
            status: request.status,
            requestRevision: request.requestRevision,
            expectedEmploymentRevision: request.expectedEmploymentRevision,
            payloadSchemaVersion: request.payloadSchemaVersion,
            reason: request.reason,
            // HR-16 begin
            action: request.action,
            reasonCode: request.reasonCode,
            appliedEmploymentChangeId: request.appliedEmploymentChangeId,
            // HR-16 end
            submittedBy: request.submittedBy,
            submittedAt: request.submittedAt,
            flowRunId: request.flowRunId,
            appliedAt: request.appliedAt,
            appliedBy: request.appliedBy,
            appliedEmploymentRevision: request.appliedEmploymentRevision,
            createdAt: request.createdAt,
            updatedAt: request.updatedAt,
          });
        }
      }
      // Newest first across employments (created_at is microsecond UTC text,
      // so lexicographic order is chronological; id breaks ties deterministically).
      collected.sort((x, y) => (y.createdAt < x.createdAt ? -1 : y.createdAt > x.createdAt ? 1 : x.id < y.id ? -1 : 1));
      // HR-16 begin: the applied event's verb (0227) resolves from the
      // employment_changes rows the loader already authorized, labels only —
      // one batched read, never per-row, and never the request table itself.
      const appliedIds = [...new Set(collected.map((row) => row.appliedEmploymentChangeId).filter((id): id is string => id !== null))];
      const verbByChange = new Map<string, string>();
      if (appliedIds.length > 0) {
        const verbs = (await db.execute<{ id: string; verb: string }>(sql`
          select id::text as id, verb from employment_changes
           where org_id = ${authz.user.orgId}::uuid and id = any(${appliedIds}::uuid[])
        `)).rows;
        for (const v of verbs) verbByChange.set(v.id, v.verb);
      }
      const page = compactRows(
        collected.map(({ appliedEmploymentChangeId, ...row }) => ({
          ...row,
          appliedVerb: appliedEmploymentChangeId ? (verbByChange.get(appliedEmploymentChangeId) ?? null) : null,
        })),
        { limit },
      );
      return {
        ok: true,
        data: {
          employmentId: a.employmentId ?? null,
          status: a.status ?? null,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated || scoped.truncated,
          requests: page.items,
          href: "/hrm",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmPositionsAsOf: AssistantToolDef = {
  name: "hrm_positions_as_of",
  description:
    "Positions with vacancy as of a date (or preset): planned versus funded versus filled FTE per position, department, and employer subsidiary, with over-filled and under-funded breaches named. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.position.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    asOf: dateInput.optional().describe("Vacancy as of this date; defaults to today"),
    period: periodPresetInput.optional().describe("Fiscal-calendar preset; the vacancy is taken as of the preset's end date"),
    status: z
      .enum(["planned", "open", "filled", "frozen", "closed"])
      .optional()
      .describe("Keep only this lifecycle status"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { asOf?: string; period?: string; status?: string };
    let effectiveDate: string;
    if (a.period) {
      const range = await resolveToolRange(authz.user.orgId, { period: a.period });
      if ("error" in range) return { ok: false, error: range.error };
      effectiveDate = range.to;
    } else {
      effectiveDate = a.asOf ?? (await orgToday(authz.user.orgId));
    }
    try {
      const dto = await getVacancyAsOf({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        effectiveDate,
        knownAt: new Date().toISOString(),
        ...(a.status ? { status: a.status } : {}),
      });
      return {
        ok: true,
        data: {
          asOf: dto.effectiveDate,
          knownAt: dto.knownAt,
          totals: dto.totals,
          byDepartment: dto.byDepartment.map((group) => ({
            departmentId: group.departmentId,
            departmentName: group.departmentName,
            employerSubsidiaryId: group.employerSubsidiaryId,
            employerSubsidiaryName: group.employerSubsidiaryName,
            positions: group.positions,
            plannedFte: group.plannedFte,
            fundedFte: group.fundedFte,
            filledFte: group.filledFte,
            vacantFte: group.vacantFte,
          })),
          positions: dto.positions.map((row) => ({
            id: row.id,
            positionCode: row.positionCode,
            title: row.version.title,
            status: row.version.status,
            departmentId: row.version.departmentId,
            employerSubsidiaryId: row.version.employerSubsidiaryId,
            plannedFte: row.vacancy.plannedFte,
            fundedFte: row.vacancy.fundedFte,
            filledFte: row.vacancy.filledFte,
            vacantFte: row.vacancy.vacantFte,
            refusal: row.vacancy.refusal,
            holders: row.holders,
          })),
          href: "/hrm/positions",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const processSegments = ["open", "overdue", "completed", "cancelled"] as const;

const hrmProcesses: AssistantToolDef = {
  name: "hrm_processes",
  description:
    "Process checklists with step status, owners, and due dates: one checklist in full, or every visible checklist in a segment with progress and next due. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.process.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    processId: uuidInput.optional().describe("One checklist in full; omit for the segment list"),
    segment: z.enum(processSegments).optional().describe("List segment (default open)"),
    employmentId: uuidInput.optional().describe("Keep only this employment's checklists"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum checklists to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as {
      processId?: string;
      segment?: (typeof processSegments)[number];
      employmentId?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      // One checklist in full: authorized per record inside the loader, so a
      // missing, foreign-org, or out-of-scope id refuses uniformly instead
      // of returning an empty object pretending it does not exist.
      if (a.processId) {
        const detail = await getProcess({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          processId: a.processId,
        });
        // Explicit projection: evidence actors and skip reasons are audit
        // facts and stay in the record read, so a future step column cannot
        // ride this tool silently.
        return {
          ok: true,
          data: {
            id: detail.id,
            kind: detail.kind,
            effectiveDate: detail.effectiveDate,
            status: detail.status,
            employmentId: detail.employmentId,
            workerName: detail.workerName,
            progress: detail.progress,
            steps: detail.steps.map((step) => ({
              id: step.id,
              position: step.position,
              title: step.title,
              ownerKind: step.ownerKind,
              dueOn: step.dueOn,
              required: step.required,
              evidenceKind: step.evidenceKind,
              status: step.status,
              overdue: step.overdue,
            })),
            href: "/hrm/processes",
          },
        };
      }
      const processes = await listProcesses({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        segment: a.segment ?? "open",
      });
      const kept = (a.employmentId
        ? processes.filter((process) => process.employmentId === a.employmentId)
        : processes
      ).map((process) => ({
        // Explicit projection: the worker party id stays in the record
        // read, so a future list column cannot ride this tool silently.
        id: process.id,
        kind: process.kind,
        effectiveDate: process.effectiveDate,
        status: process.status,
        employmentId: process.employmentId,
        workerName: process.workerName,
        required: process.required,
        doneRequired: process.doneRequired,
        overdueSteps: process.overdueSteps,
        nextDueOn: process.nextDueOn,
      }));
      const page = compactRows(kept, { limit });
      return {
        ok: true,
        data: {
          segment: a.segment ?? "open",
          employmentId: a.employmentId ?? null,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          processes: page.items,
          href: "/hrm/processes",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const leaveRequestStatuses = ["draft", "submitted", "approved", "rejected", "withdrawn", "cancelled"] as const;

const hrmLeave: AssistantToolDef = {
  name: "hrm_leave",
  description:
    "Leave requests with status and hours for one employment (or every visible employment), plus TIME balances per type as of a date; payroll banks stay in payroll tools. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.leave.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("One employment's requests and balances; omit for every visible employment"),
    status: z.enum(leaveRequestStatuses).optional().describe("Keep only this lifecycle status"),
    includeBalances: z.boolean().optional().describe("Include TIME balances per leave type (single employment only)"),
    asOf: dateInput.optional().describe("Balance date; defaults to today"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum requests to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as {
      employmentId?: string;
      status?: (typeof leaveRequestStatuses)[number];
      includeBalances?: boolean;
      asOf?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      // A named employment is authorized per record inside the loader, so a
      // missing, foreign-org, or out-of-scope id refuses uniformly instead
      // of returning an empty list pretending it does not exist.
      const scoped = a.employmentId
        ? { ids: [a.employmentId], truncated: false }
        : await visibleEmploymentIds(authz.user.orgId, authz.allowedSubsidiaryIds, 200);
      const collected: {
        employmentId: string;
        id: string;
        status: string;
        leaveTypeCode: string;
        startsOn: string;
        endsOn: string;
        hours: string;
      }[] = [];
      // Sequential, never parallel: one pinned client per loader call, the
      // same discipline the record boundary keeps inside its transaction.
      for (const employmentId of scoped.ids) {
        const requests = await listLeaveRequests({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          employmentId,
          ...(a.status ? { status: a.status } : {}),
        });
        for (const request of requests) {
          collected.push({
            employmentId,
            id: request.id,
            status: request.status,
            leaveTypeCode: request.leaveTypeCode,
            startsOn: request.startsOn,
            endsOn: request.endsOn,
            hours: request.hours,
          });
        }
      }
      // Newest start first across employments (id breaks ties deterministically).
      collected.sort((x, y) => (y.startsOn < x.startsOn ? -1 : y.startsOn > x.startsOn ? 1 : x.id < y.id ? -1 : 1));
      const page = compactRows(collected, { limit });
      // TIME balances are single-employment only: org-wide balances would
      // sum incommensurable policies into a precise-looking wrong number.
      // VALUE (payroll banks) is never read here — payroll tools own it.
      let balances: {
        leaveTypeCode: string;
        balance: string | null;
        unlimited: boolean;
        earned: string | null;
        carried: string;
        taken: string;
      }[] | null = null;
      if (a.includeBalances) {
        if (!a.employmentId) return { ok: false, error: "balances_need_employment" };
        const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
        const types = await listLeaveTypes(db, authz.user.orgId);
        balances = [];
        for (const type of types) {
          if (!type.isActive) continue;
          const read = await timeBalanceAsOf(db, authz.user.orgId, a.employmentId, type.id, asOf);
          balances.push({
            leaveTypeCode: type.code,
            balance: read.balance,
            unlimited: read.unlimited,
            earned: read.earned,
            carried: read.carried,
            taken: read.taken,
          });
        }
      }
      return {
        ok: true,
        data: {
          employmentId: a.employmentId ?? null,
          status: a.status ?? null,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated || scoped.truncated,
          requests: page.items,
          balances,
          href: "/hrm/leave",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const requisitionSegments = ["draft", "open", "on_hold", "filled", "cancelled"] as const;

const hrmRecruiting: AssistantToolDef = {
  name: "hrm_recruiting",
  description:
    "Requisitions with headcount versus filled, the funnel per application, one opening with time-to-fill, scorecard summaries, offer signature state, and posting status. Names only, never candidate contact PII. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.recruiting.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    requisitionId: uuidInput.optional().describe("One opening in full (pipeline, funnel, applications); omit for the segment list"),
    segment: z.enum(requisitionSegments).optional().describe("List segment (default open)"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum openings to return (default 50)"),
    // HR-18 begin: depth reads (names and states only, never PII). Each
    // refuses by name while its sub-switch is off.
    interviewId: uuidInput.optional().describe("Scorecard summary for one interview: per-attribute aggregates, counts, and missing seats by name"),
    offerId: uuidInput.optional().describe("One offer's signature state and version count"),
    includePostings: z.boolean().optional().describe("Include board posting status beside a requisitionId detail"),
    // HR-18 end
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as {
      requisitionId?: string;
      segment?: string;
      limit?: number;
      interviewId?: string;
      offerId?: string;
      includePostings?: boolean;
    };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      // HR-18 begin: scorecard summary (aggregate only, names of missing
      // seats — private notes never ride this shape).
      if (a.interviewId) {
        if (!(await isFeatureEnabled(authz.user.orgId, "hrmStructuredInterviews"))) {
          return { ok: false, error: "hrm_structured_interviews_feature_disabled" };
        }
        const { scorecardSummary } = await import(
          "@openbooks/engine/src/hrm/recruiting/scorecards.ts"
        );
        const summary = await scorecardSummary({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          interviewId: a.interviewId,
        });
        return { ok: true, data: { summary, href: "/hrm/recruiting" } };
      }
      // HR-18 end
      // HR-18 begin: offer signature state (state only, never the letter).
      if (a.offerId) {
        if (!(await isFeatureEnabled(authz.user.orgId, "hrmOfferSigning"))) {
          return { ok: false, error: "hrm_offer_signing_feature_disabled" };
        }
        const { offerSignatureState } = await import(
          "@openbooks/engine/src/hrm/recruiting/offers-signing.ts"
        );
        const state = await offerSignatureState({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          offerId: a.offerId,
        });
        return { ok: true, data: { ...state, href: "/hrm/recruiting" } };
      }
      // HR-18 end
      if (a.requisitionId) {
        const detail = await getRequisitionDetail({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          requisitionId: a.requisitionId,
        });
        // HR-18 begin: board posting status beside the detail (board, board
        // status, apply counts — never applicant PII). Refuses by name
        // while hrmJobBoards is off.
        let postings: { boardKey: string; status: string; applyCount: number }[] | undefined;
        if (a.includePostings === true) {
          if (!(await isFeatureEnabled(authz.user.orgId, "hrmJobBoards"))) {
            return { ok: false, error: "hrm_job_boards_feature_disabled" };
          }
          const { listPostings } = await import("@openbooks/engine/src/hrm/recruiting/postings.ts");
          postings = (
            await listPostings({
              orgId: authz.user.orgId,
              actorId: authz.user.id,
              requisitionId: a.requisitionId,
            })
          ).map((posting) => ({
            boardKey: posting.boardKey,
            status: posting.status,
            applyCount: posting.applyCount,
          }));
        }
        // HR-18 end
        return {
          ok: true,
          data: {
            id: detail.id,
            requisitionNumber: detail.requisitionNumber,
            title: detail.title,
            status: detail.status,
            headcount: detail.headcount,
            filledCount: detail.filledCount,
            timeToFillDays: detail.timeToFillDays,
            funnel: detail.funnel,
            applications: detail.applications.map((application) => ({
              id: application.id,
              candidate: application.candidate.displayName,
              stageKey: application.stageKey,
              stageName: application.stageName,
              status: application.status,
              appliedOn: application.appliedOn,
              lastEventKind: application.lastEventKind,
              interviewsCount: application.interviewsCount,
              liveOfferStatus: application.liveOfferStatus,
            })),
            ...(postings === undefined ? {} : { postings }),
            href: "/hrm/recruiting",
          },
        };
      }
      const segment = a.segment ?? "open";
      const openings = await listRequisitions({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        status: segment,
      });
      const page = compactRows(
        openings.map((row) => ({
          id: row.id,
          requisitionNumber: row.requisitionNumber,
          title: row.title,
          status: row.status,
          headcount: row.headcount,
          filledCount: row.filledCount,
          hiringManagerName: row.hiringManagerName,
          openedOn: row.openedOn,
        })),
        { limit },
      );
      return {
        ok: true,
        data: {
          segment,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          requisitions: page.items,
          href: "/hrm/recruiting",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const cycleStatuses = ["draft", "open", "calibrating", "closed"] as const;

const hrmPerformanceCycles: AssistantToolDef = {
  name: "hrm_performance_cycles",
  description:
    "Review cycles with self/manager progress, or one cycle in full with its privacy-scoped reviews. HR sees every cycle; structural viewers see their slice. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.performance.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    cycleId: uuidInput.optional().describe("One cycle in full; omit for the cycle list"),
    status: z.enum(cycleStatuses).optional().describe("Keep only this cycle status"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum cycles to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { cycleId?: string; status?: (typeof cycleStatuses)[number]; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      if (a.cycleId) {
        const detail = await getCycleDetail({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          cycleId: a.cycleId,
        });
        return {
          ok: true,
          data: {
            id: detail.id,
            name: detail.name,
            templateName: detail.templateName,
            periodStartOn: detail.periodStartOn,
            periodEndOn: detail.periodEndOn,
            status: detail.status,
            totalSelf: detail.totalSelf,
            submittedSelf: detail.submittedSelf,
            totalManager: detail.totalManager,
            submittedManager: detail.submittedManager,
            reviews: detail.reviews.map((review) => ({
              id: review.id,
              kind: review.kind,
              status: review.status,
              overallRating: review.overallRating,
              calibratedRating: review.calibratedRating,
            })),
            href: "/hrm/performance",
          },
        };
      }
      const cycles = await listCycleProgress({ orgId: authz.user.orgId, actorId: authz.user.id });
      const kept = cycles
        .filter((cycle) => !a.status || cycle.status === a.status)
        .map((cycle) => ({
          id: cycle.id,
          name: cycle.name,
          templateName: cycle.templateName,
          periodStartOn: cycle.periodStartOn,
          periodEndOn: cycle.periodEndOn,
          status: cycle.status,
          totalSelf: cycle.totalSelf,
          submittedSelf: cycle.submittedSelf,
          totalManager: cycle.totalManager,
          submittedManager: cycle.submittedManager,
        }));
      const page = compactRows(kept, { limit });
      return {
        ok: true,
        data: {
          status: a.status ?? null,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated,
          cycles: page.items,
          href: "/hrm/performance",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmTurnover: AssistantToolDef = {
  name: "hrm_turnover",
  description:
    "Attrition derived from employment history: trailing-twelve-months turnover with the regrettable count, or turnover per period and department. HR-only. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.retention.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    departmentId: uuidInput.optional().describe("Keep only this department"),
    periods: z
      .array(z.object({ start: dateInput, end: dateInput }))
      .min(1)
      .max(12)
      .optional()
      .describe("Explicit civil-date ranges; omit for the trailing-twelve-months overview"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { departmentId?: string; periods?: { start: string; end: string }[] };
    try {
      if (!a.periods) {
        const overview = await getRetentionOverview({ orgId: authz.user.orgId, actorId: authz.user.id });
        const trailing = overview.trailingTwelveMonths;
        return {
          ok: true,
          data: {
            periodStart: trailing?.periodStart ?? null,
            periodEnd: trailing?.periodEnd ?? null,
            headcountStart: trailing?.headcountStart ?? null,
            headcountEnd: trailing?.headcountEnd ?? null,
            terminations: trailing?.terminations ?? null,
            voluntary: trailing?.voluntary ?? null,
            involuntary: trailing?.involuntary ?? null,
            turnoverRate: trailing?.turnoverRate ?? null,
            regrettableLeavers: overview.regrettableLeavers,
            missingExitRecords: overview.missingExitRecords.length,
            exitRecordsWithoutInterview: overview.exitRecordsWithoutInterview.length,
            href: "/hrm/performance",
          },
        };
      }
      const turnover = await getTurnover({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        periods: a.periods,
        ...(a.departmentId ? { departmentId: a.departmentId } : {}),
      });
      return {
        ok: true,
        data: {
          periods: turnover.periods.map((row) => ({
            periodStart: row.periodStart,
            periodEnd: row.periodEnd,
            departmentId: row.departmentId,
            headcountStart: row.headcountStart,
            headcountEnd: row.headcountEnd,
            terminations: row.terminations,
            voluntary: row.voluntary,
            involuntary: row.involuntary,
            turnoverRate: row.turnoverRate,
            regrettableShare: row.regrettableShare,
            medianTenureDays: row.medianTenureDays,
          })),
          href: "/hrm/performance",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const enrollmentStatuses = ['elected', 'waived', 'pending_approval', 'active', 'ended', 'cancelled'] as const;

const hrmBenefits: AssistantToolDef = {
  name: 'hrm_benefits',
  description:
    'Benefit enrollment windows and elections for one employment (or every visible employment): window, plan, coverage tier, status, and stored per-period amounts. Read-only.',
  category: 'search',
  gate: { mode: 'anyOf', perms: ['hrm.benefits.read'] },
  feature: 'hrm',
  tier: 'module',
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("One employment's elections; omit for every visible employment"),
    windowId: uuidInput.optional().describe('Keep only this enrollment window'),
    status: z.enum(enrollmentStatuses).optional().describe('Keep only this lifecycle status'),
    limit: z.number().int().min(1).max(200).optional().describe('Maximum elections to return (default 50)'),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as {
      employmentId?: string;
      windowId?: string;
      status?: (typeof enrollmentStatuses)[number];
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      // Windows read org-wide through the loader's own aggregate gate;
      // elections resolve per employment through the same gate.
      const windows = await listEnrollmentWindows(db, authz.user.orgId, authz.user.id, {});
      const scoped = a.employmentId
        ? { ids: [a.employmentId], truncated: false }
        : await visibleEmploymentIds(authz.user.orgId, authz.allowedSubsidiaryIds, 200);
      const collected: {
        employmentId: string;
        id: string;
        status: string;
        planCode: string;
        coverageLevelKey: string | null;
        employeeAmountPerPeriod: string | null;
        employerAmountPerPeriod: string | null;
        currency: string;
      }[] = [];
      // Sequential, never parallel: one pinned client per loader call, the
      // same discipline the record boundary keeps inside its transaction.
      for (const employmentId of scoped.ids) {
        const elections = await listEnrollments(db, authz.user.orgId, authz.user.id, {
          employmentId,
          ...(a.windowId ? { windowId: a.windowId } : {}),
          ...(a.status ? { status: a.status } : {}),
        });
        for (const election of elections) {
          collected.push({
            employmentId,
            id: election.id,
            status: election.status,
            planCode: election.planCode,
            coverageLevelKey: election.coverageLevelKey,
            employeeAmountPerPeriod: election.employeeAmountPerPeriod,
            employerAmountPerPeriod: election.employerAmountPerPeriod,
            currency: election.currency,
          });
        }
        if (collected.length >= limit) break;
      }
      const page = compactRows(collected, { limit });
      return {
        ok: true,
        data: {
          employmentId: a.employmentId ?? null,
          status: a.status ?? null,
          total: page.total,
          returned: page.returned,
          truncated: page.truncated || scoped.truncated,
          windows: windows.map((window) => ({
            id: window.id,
            name: window.name,
            kind: window.kind,
            status: window.status,
          })),
          elections: page.items,
          href: '/hrm/benefits',
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmMe: AssistantToolDef = {
  name: "hrm_me",
  description:
    "The caller's own employment, reviews, and benefits: summary per own employment, owed self-assessments with shared reviews and goals, elections with open windows and dependents. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["hrm.self.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({}),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    try {
      // No employment parameter exists to forge: the read scopes by the
      // party behind the login, so a second person's rows can never be
      // returned no matter what the model puts in the (empty) input.
      const profile = await getMyProfile({ orgId: authz.user.orgId, actorId: authz.user.id });
      // Own reviews and benefits ride the same privacy scope as the Me
      // pages (shared reviews only, calibration stripped, own elections
      // with stored amounts) — a second person's rows can never appear.
      const [reviews, benefits] = await Promise.all([
        getMyReviewWorkspace({ orgId: authz.user.orgId, actorId: authz.user.id }),
        getMyBenefitsWorkspace({ orgId: authz.user.orgId, actorId: authz.user.id }),
      ]);
      return {
        ok: true,
        data: {
          displayName: profile.displayName,
          employments: profile.employments.map((summary) => ({
            employmentId: summary.employmentId,
            status: summary.status,
            jobTitle: summary.jobTitle,
            departmentName: summary.departmentName,
            employerName: summary.employerName,
            managerNames: [...summary.managerNames],
            serviceStart: summary.serviceStart,
          })),
          reviews: {
            cycles: reviews.cycles.map((group) => ({
                  name: group.name,
                  status: group.status,
                  selfOwed: group.mySelf
                    ? { status: group.mySelf.status, dueOn: group.mySelf.selfDueOn }
                    : null,
                  shared: group.sharedWithMe.map((shared) => ({
                    status: shared.status,
                    overallRating: shared.overallRating,
                  })),
                })),
                goals: reviews.goals.map((goal) => ({
                  title: goal.title,
                  status: goal.status,
                  progressPercent: goal.progressPercent,
                })),
                href: "/me/reviews",
              },
          benefits: {
                elections: benefits.elections.map((election) => ({
                  planCode: election.planCode,
                  planName: election.planName,
                  coverageLabel: election.coverageLabel,
                  status: election.status,
                  employeeAmountPerPeriod: election.employeeAmountPerPeriod,
                  currency: election.currency,
                })),
                openWindows: benefits.openWindows.map((window) => ({
                  name: window.name,
                  kind: window.kind,
                  closesOn: window.closesOn,
                })),
                dependents: benefits.dependents.map((dependent) => ({
                  displayName: dependent.displayName,
                  relationship: dependent.relationship,
                })),
                href: "/me/benefits",
              },
          href: "/me",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};


// HR-15 begin: the caller's own inbox items (own scope only, core surface).
const inboxItems: AssistantToolDef = {
  name: "inbox_items",
  description:
    "The caller's own inbox items: approvals, checklist steps, requests, reviews, and notices waiting on them, with links into the inbox. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["hrm.self.read"] },
  tier: "module",
  inputSchema: z.object({
    filter: z.enum(["all", "approvals", "my_tasks", "signatures", "notices", "overdue"]).optional().describe("Keep only this inbox filter (default all)"),
    limit: z.number().int().min(1).max(50).optional().describe("Maximum items to return (default 20)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { filter?: "all" | "approvals" | "my_tasks" | "signatures" | "notices" | "overdue"; limit?: number };
    const limit = Math.min(a.limit ?? 20, 50);
    try {
      // No subject parameter exists to forge: the read scopes by the login,
      // so another person's items can never be returned no matter what the
      // model puts in the (filter-only) input.
      const ctx = await inboxContext(authz);
      const kinds =
        a.filter === undefined || a.filter === "all" || a.filter === "overdue"
          ? undefined
          : a.filter === "approvals"
            ? (['flows_approval', 'expense_report'] as const)
            : a.filter === "my_tasks"
              ? (['hrm_process_step', 'hrm_leave_request', 'hrm_change_request', 'hrm_review', 'hrm_benefit_enrollment_window', 'hrm_qualification_alert', 'timesheet_week'] as const)
              : a.filter === "signatures"
                ? (['field_ticket_signature', 'document_signature'] as const)
                : (['notification'] as const);
      const items = await listInbox(ctx, kinds ? { kinds: [...kinds] } : undefined);
      const kept = (a.filter === "overdue" ? items.filter((item) => item.priority === "overdue") : items).slice(0, limit);
      return {
        ok: true,
        data: {
          total: kept.length,
          items: kept.map((item) => ({
            id: item.id,
            kind: item.kind,
            title: item.title,
            subtitle: item.subtitle,
            dueAt: item.dueAt,
            priority: item.priority,
            href: item.subjectHref,
            actions: item.actions.map((action) => action.key),
          })),
          href: "/inbox",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-13 begin: read-only construction-compliance tools. Generating a
// report, approving per-diem, and transitioning a finding are
// human-attested HR actions with no assistant write surface by design —
// these two tools read the flags and the frozen runs through the same
// services and gates as the Compliance page.
const HRM_CONSTRUCTION_FEATURE_OFF = "hrm_construction_feature_disabled";

async function constructionFeatureRefused(orgId: string): Promise<ToolResult | null> {
  if (!(await isFeatureEnabled(orgId, "hrmConstructionCompliance")))
    return { ok: false, error: HRM_CONSTRUCTION_FEATURE_OFF };
  return null;
}

const hrmComplianceFindings: AssistantToolDef = {
  name: "hrm_compliance_findings",
  description:
    "Construction-compliance pre-run flags by kind: ratio breaches, missing rates, unresolved comp classes, missing registrations, and fringe mismatches with lifecycle status. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.construction.read"] },
  feature: "hrmConstructionCompliance",
  tier: "module",
  inputSchema: z.object({
    status: z.enum(["open", "acknowledged", "resolved"]).optional().describe("Keep only this lifecycle status"),
    kind: z
      .enum(["ratio_breach", "missing_rate", "class_unresolved", "registration_missing", "fringe_mismatch"])
      .optional()
      .describe("Keep only this finding kind"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum findings to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await constructionFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { status?: string; kind?: string; limit?: number };
    try {
      const findings = await listFindings(db, authz.user.orgId, authz.user.id, a.status ?? null);
      const kept = (a.kind ? findings.filter((finding) => finding.kind === a.kind) : findings).slice(0, Math.min(a.limit ?? 50, 200));
      return {
        ok: true,
        data: {
          findings: kept.map((finding) => ({
            id: finding.id,
            kind: finding.kind,
            projectId: finding.projectId,
            workedOn: finding.workedOn,
            employmentId: finding.employmentId,
            status: finding.status,
            recordedAt: finding.recordedAt,
          })),
          href: "/hrm/compliance",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmCertifiedPayroll: AssistantToolDef = {
  name: "hrm_certified_payroll",
  description:
    "Frozen certified payroll runs by project and week: pack format, lifecycle status, and amendment links. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.construction.read"] },
  feature: "hrmConstructionCompliance",
  tier: "module",
  inputSchema: z.object({
    projectId: uuidInput.optional().describe("Keep only this project's runs"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum runs to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await constructionFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { projectId?: string; limit?: number };
    try {
      const runs = await listRuns(db, authz.user.orgId, authz.user.id, a.projectId ?? null);
      return {
        ok: true,
        data: {
          runs: runs.slice(0, Math.min(a.limit ?? 50, 200)).map((run) => ({
            id: run.id,
            projectId: run.projectId,
            weekEnding: run.weekEnding,
            status: run.status,
            formatKey: run.formatKey,
            amendsRunId: run.amendsRunId,
          })),
          href: "/hrm/compliance?section=certified",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-13 end

// HR-12 begin: compensation and pay-equity read tools. Bands and
// placement, cycle status, and plan status ride comp.read behind the
// hrmCompensation switch; the equity tool reports the latest frozen
// snapshot aggregates only (never per-person pay) behind
// hrmPayTransparency. Both absent when their switch is off.
const hrmCompensation: AssistantToolDef = {
  name: "hrm_compensation",
  description:
    "Pay bands and placement, merit cycle status, and headcount plan status: band ranges by level, where one employment sits in range, and which rounds and plans are live. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.compensation.read"] },
  feature: "hrmCompensation",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("One employment's band placement; omit for bands and rounds only"),
    asOf: dateInput.optional().describe("Placement as of this date; defaults to today"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmCompensation"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { employmentId?: string; asOf?: string };
    try {
      const { listPayBands } = await import("@openbooks/engine/src/hrm/compensation/bands.ts");
      const { listCycles } = await import("@openbooks/engine/src/hrm/compensation/cycles.ts");
      const { listPlans } = await import("@openbooks/engine/src/hrm/compensation/headcount-plans.ts");
      const { orgToday: todayOf } = await import("./tools-shared");
      const asOf = a.asOf ?? (await todayOf(authz.user.orgId));
      const [bands, cycles, plans] = await Promise.all([
        listPayBands({ orgId: authz.user.orgId, actorId: authz.user.id, asOf }),
        isFeatureEnabled(authz.user.orgId, "hrmMeritCycles").then((on) =>
          on ? listCycles({ orgId: authz.user.orgId, actorId: authz.user.id }) : [],
        ),
        isFeatureEnabled(authz.user.orgId, "hrmHeadcountPlans").then((on) =>
          on ? listPlans({ orgId: authz.user.orgId, actorId: authz.user.id }) : [],
        ),
      ]);
      let placement: { employmentId: string; placement: string; compaRatio: string | null } | null = null;
      if (a.employmentId) {
        try {
          const { compaRatioFor } = await import("@openbooks/engine/src/hrm/compensation/bands.ts");
          const placed = await compaRatioFor(authz.user.orgId, authz.user.id, a.employmentId, asOf);
          placement = { employmentId: a.employmentId, placement: placed.band ? placed.placement : "no_band", compaRatio: placed.compaRatio };
        } catch (error) {
          return hrmRefusal(error);
        }
      }
      return {
        ok: true,
        data: {
          asOf,
          bands: bands.map((b) => ({ levelId: b.levelId, currency: b.currency, basis: b.basis, min: b.min, target: b.target, max: b.max })),
          cycles: cycles.map((c) => ({ id: c.id, name: c.name, status: c.status, effectiveOn: c.effectiveOn })),
          plans: plans.map((p) => ({ id: p.id, name: p.name, status: p.status })),
          placement,
          href: "/hrm/compensation",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmPayEquity: AssistantToolDef = {
  name: "hrm_pay_equity",
  description:
    "Latest frozen pay-gap snapshot: org-level mean/median gaps and per-category gaps with joint-assessment flags. Aggregates only — never per-person pay. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.compensation.read"] },
  feature: "hrmPayTransparency",
  tier: "module",
  inputSchema: z.object({}),
  execute: async (raw, authz): Promise<ToolResult> => {
    void raw;
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmPayTransparency"))) return { ok: false, error: HRM_FEATURE_OFF };
    try {
      const { latestGapSnapshot } = await import("@openbooks/engine/src/hrm/compensation/pay-transparency.ts");
      const snapshot = await latestGapSnapshot({ orgId: authz.user.orgId, actorId: authz.user.id });
      if (!snapshot) return { ok: true, data: { snapshot: null, href: "/hrm/compensation/equity" } };
      return {
        ok: true,
        data: {
          snapshot: {
            asOf: snapshot.asOf,
            meanGapPct: snapshot.metrics.meanGapPct,
            medianGapPct: snapshot.metrics.medianGapPct,
            headcountA: snapshot.metrics.headcountA,
            headcountB: snapshot.metrics.headcountB,
            categories: snapshot.categories.map((c) => ({
              levelCode: c.levelCode,
              countA: c.countA,
              countB: c.countB,
              meanGapPct: c.meanGapPct,
              medianGapPct: c.medianGapPct,
              unexplainedGapPct: c.unexplainedGapPct,
              jointAssessmentDue: c.jointAssessmentDue,
            })),
          },
          href: "/hrm/compensation/equity",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-12 end

// HR-16 begin: automation run/error status (0226). Read-only: recipes and
// the run log with errors, behind the automations switch and read grant.
const automationsStatus: AssistantToolDef = {
  name: "automations_status",
  description:
    "Automation recipes with status and the run log: recent runs and errors per recipe, newest first. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["automations.read"] },
  feature: "automations",
  tier: "module",
  inputSchema: z.object({
    status: z.enum(["queued", "running", "succeeded", "failed", "skipped_no_match", "simulated"]).optional().describe("Keep only runs in this status"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum runs to return (default 25)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "automations"))) {
      return { ok: false, error: "automations_feature_disabled" };
    }
    const a = raw as { status?: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 100);
    try {
      const { listAutomations } = await import("@openbooks/engine/src/automations/services.ts");
      const automations = await listAutomations(authz.user.orgId, authz.user.id);
      const runs = (
        await db.execute<{
          id: string;
          automationId: string;
          status: string;
          version: number;
          subjectKind: string | null;
          error: unknown;
          createdAt: string;
        }>(sql`
          select r.id::text as id, r.automation_id::text as "automationId", r.status,
                 r.version, r.subject_kind as "subjectKind", r.error,
                 to_char(r.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
            from automation_runs r
           where r.org_id = ${authz.user.orgId}::uuid
             and (${a.status ?? null}::text is null or r.status = ${a.status ?? null}::text)
           order by r.created_at desc limit ${limit}
        `)
      ).rows;
      return {
        ok: true,
        data: {
          automations: automations.map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            status: recipe.status,
            version: recipe.version,
            triggerKind: (recipe.trigger as { kind?: string } | null)?.kind ?? null,
            lastRunAt: recipe.lastRunAt,
            errorMessage: recipe.errorMessage,
          })),
          runs,
          href: "/admin/automations",
        },
      };
    } catch (error) {
      // Automation service refusals (permission, missing recipe) surface
      // with their message intact — hrmRefusal only maps HRM reads.
      return { ok: false, error: error instanceof Error ? error.message : "automations_status_failed" };
    }
  },
};
// HR-16 end


// HR-14 begin: certification register and dispatch-readiness reads
// (0225). Both reuse the canonical qualification services behind the
// certifications read grant — never a parallel query. License numbers
// and free-text notes stay on the page and the report: the register
// tool answers what is held and when it lapses, which is what dispatch
// needs, without pulling identifiers through the conversation.
const hrmQualifications: AssistantToolDef = {
  name: "hrm_qualifications",
  description:
    "Held certifications and licenses: type and category, issuance and expiry, stored status with the live expiring/expired projection, and verification. License numbers stay on the page. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.certifications.read"] },
  feature: "hrmCertifications",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("Keep only this employment's qualifications"),
    typeId: uuidInput.optional().describe("Keep only this qualification type"),
    status: z
      .enum(["valid", "revoked", "pending_verification", "expiring", "expired"])
      .optional()
      .describe("Keep only this read status (expiring/expired are projected at read)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmCertifications"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { employmentId?: string; typeId?: string; status?: string };
    try {
      const { listQualifications } = await import("@openbooks/engine/src/hrm/qualifications/qualifications.ts");
      const held = await listQualifications(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: a.employmentId,
        typeId: a.typeId,
        status: a.status as "valid" | "revoked" | "pending_verification" | "expiring" | "expired" | undefined,
      });
      return {
        ok: true,
        data: {
          qualifications: held.map((q) => ({
            id: q.id,
            employmentId: q.employmentId,
            typeCode: q.type.code,
            typeName: q.type.name,
            category: q.type.category,
            issuedOn: q.issuedOn,
            expiresOn: q.expiresOn,
            status: q.status,
            verifiedAt: q.verifiedAt,
          })),
          href: "/hrm/qualifications",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmDispatchCheck: AssistantToolDef = {
  name: "hrm_dispatch_check",
  description:
    "Dispatch readiness for one worker on one subject: which required qualifications are met, which block, and which warn, as of a date. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.certifications.read"] },
  feature: "hrmDispatchGating",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("Worker employment to check"),
    subjectKind: z.enum(["project", "equipment", "position", "classification"]).optional().describe("What the worker would be assigned to"),
    subjectId: uuidInput.optional().describe("Id of the project, equipment, position, or classification"),
    on: dateInput.optional().describe("Check as of this date; defaults to today"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmDispatchGating"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { employmentId?: string; subjectKind?: string; subjectId?: string; on?: string };
    if (!a.employmentId) return { ok: false, error: "employment_required" };
    if (!a.subjectKind || !a.subjectId) return { ok: false, error: "subject_required" };
    try {
      const { checkAssignment } = await import("@openbooks/engine/src/hrm/qualifications/gating.ts");
      const verdict = await checkAssignment(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: a.employmentId,
        subjectKind: a.subjectKind as "project" | "equipment" | "position" | "classification",
        subjectId: a.subjectId,
        on: a.on,
      });
      const findings = verdict.ok ? verdict.warnings : [...verdict.blocking, ...verdict.warnings];
      return {
        ok: true,
        data: {
          allowed: verdict.ok,
          findings: findings.map((f) => ({
            typeCode: f.typeCode,
            typeName: f.typeName,
            severity: f.severity,
            reason: f.reason,
            detail: f.detail,
          })),
          href: "/hrm/qualifications",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-14 end

// HR-19 begin: documents, survey results, and org chart reads (0230).
// hrm_documents answers own (self-service) or manage scope: titles,
// statuses, and signer progress — never file bytes, tokens, or
// evidence. hrm_survey_results answers aggregate results only (the
// reader grant pattern: suppression already applied by the service),
// never respondent links. hrm_org_chart answers names, titles, and
// managers — never pay or private fields. All three are read-only.
const hrmDocuments: AssistantToolDef = {
  name: "hrm_documents",
  description:
    "HR documents: title, category, status, and signer progress. Own documents for self-service, everything with the read grant. File bytes, tokens, and evidence never leave. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.self.read"] },
  feature: "hrmDocuments",
  tier: "module",
  inputSchema: z.object({
    status: z
      .enum(["draft", "sent", "viewed", "partially_signed", "signed", "acknowledged", "declined", "voided", "expired"])
      .optional()
      .describe("Keep only this document status"),
    categoryKey: z.string().optional().describe("Keep only this declared category key"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmDocuments"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { status?: string; categoryKey?: string };
    try {
      const { listDocuments, listOwnDocuments } = await import(
        "@openbooks/engine/src/hrm/documents/documents.ts"
      );
      const manages = await import("@openbooks/engine/src/organization/actor-permissions.ts").then((m) =>
        m.actorHasPermission(db, authz.user.orgId, authz.user.id, "hrm.documents.read"),
      );
      const documents = manages
        ? await listDocuments({
            orgId: authz.user.orgId,
            actorId: authz.user.id,
            ...(a.status ? { status: a.status } : {}),
            ...(a.categoryKey ? { categoryKey: a.categoryKey } : {}),
          })
        : (
            await listOwnDocuments({ orgId: authz.user.orgId, actorId: authz.user.id })
          ).documents.filter(
            (d) => (!a.status || d.status === a.status) && (!a.categoryKey || d.categoryKey === a.categoryKey),
          );
      return {
        ok: true,
        data: {
          documents: documents.map((d) => ({
            id: d.id,
            title: d.title,
            categoryKey: d.categoryKey,
            status: d.status,
            sentAt: d.sentAt,
            completedAt: d.completedAt,
            expiresAt: d.expiresAt,
            legalHold: d.legalHold,
          })),
          href: "/hrm/documents",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmSurveyResults: AssistantToolDef = {
  name: "hrm_survey_results",
  description:
    "Survey aggregate results: participation, eNPS, driver scores, the suppression-marked heatmap, and the pulse trend. Aggregate only — respondent links never leave the service. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.surveys.manage"] },
  feature: "hrmSurveys",
  tier: "module",
  inputSchema: z.object({
    surveyId: uuidInput.describe("Survey to read aggregate results for"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmSurveys"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { surveyId?: string };
    if (!a.surveyId) return { ok: false, error: "survey_required" };
    try {
      const { getSurveyResults } = await import("@openbooks/engine/src/hrm/surveys/responses.ts");
      const results = await getSurveyResults({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        surveyId: a.surveyId,
      });
      return {
        ok: true,
        data: {
          surveyId: results.surveyId,
          status: results.status,
          invitations: results.invitations,
          responded: results.responded,
          participationPct: results.participationPct,
          enps: results.enps,
          drivers: results.drivers,
          heat: results.heat,
          trend: results.trend,
          comments: results.comments,
          href: "/hrm/surveys",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmOrgChart: AssistantToolDef = {
  name: "hrm_org_chart",
  description:
    "Org chart: the reporting tree with titles, departments, vacancies, and span of control as of a date, plus the directory. Names and titles only — never pay or private fields. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.self.read"] },
  feature: "hrmOrgChart",
  tier: "module",
  inputSchema: z.object({
    asOf: dateInput.optional().describe("Read the tree as of this date; defaults to today"),
    search: z.string().optional().describe("Keep directory entries matching this name, title, or department"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "hrmOrgChart"))) return { ok: false, error: HRM_FEATURE_OFF };
    const a = raw as { asOf?: string; search?: string };
    try {
      const { loadDirectory, loadOrgChart } = await import("@openbooks/engine/src/hrm/org-chart.ts");
      const { businessToday } = await import("@openbooks/engine/src/platform/business-date.ts");
      const asOf = a.asOf ?? (await businessToday(authz.user.orgId));
      const [chart, directory] = await Promise.all([
        loadOrgChart({ orgId: authz.user.orgId, actorId: authz.user.id, asOf }),
        loadDirectory({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          ...(a.search ? { search: a.search } : {}),
          limit: 200,
        }),
      ]);
      return {
        ok: true,
        data: {
          asOf: chart.asOf,
          headcount: chart.headcount,
          vacancies: chart.vacancies,
          layers: chart.layers,
          roots: chart.roots,
          directory,
          href: "/hrm/org-chart",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-19 end

// HR-17 begin: continuous-performance read tools. 1:1s and feedback read
// through the structural scope (own and reports) with the HR grant as
// the widening leg; calibration reads through the manage grant. Each
// sits behind its own sub-switch — off means the tool is absent, never
// an empty answer.
async function continuousFeatureRefused(orgId: string, key: string): Promise<ToolResult | null> {
  if (!(await isFeatureEnabled(orgId, "hrm"))) return { ok: false, error: HRM_FEATURE_OFF };
  if (!(await isFeatureEnabled(orgId, "hrmPerformance"))) return { ok: false, error: HRM_FEATURE_OFF };
  if (!(await isFeatureEnabled(orgId, key))) return { ok: false, error: HRM_FEATURE_OFF };
  return null;
}

const oneOnOneStatuses = ["scheduled", "held", "skipped", "cancelled"] as const;

const hrmOneOnOnes: AssistantToolDef = {
  name: "hrm_one_on_ones",
  description:
    "1:1 meetings for the caller and their reports: schedule, agenda, and status. Private items stay author-only. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.performance.read", "hrm.self.read"] },
  feature: "hrmOneOnOnes",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.optional().describe("Keep only meetings touching this employment"),
    status: z.enum(oneOnOneStatuses).optional().describe("Keep only this meeting status"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum meetings to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await continuousFeatureRefused(authz.user.orgId, "hrmOneOnOnes");
    if (gated) return gated;
    const a = raw as { employmentId?: string; status?: (typeof oneOnOneStatuses)[number]; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      const { listOneOnOnes } = await import(
        "@openbooks/engine/src/hrm/performance/one-on-ones.ts"
      );
      const ones = await listOneOnOnes({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(a.employmentId ? { employmentId: a.employmentId } : {}),
        ...(a.status ? { status: a.status } : {}),
      });
      return {
        ok: true,
        data: {
          oneOnOnes: ones.slice(0, limit).map((one) => ({
            id: one.id,
            managerName: one.managerName,
            reportName: one.reportName,
            scheduledAt: one.scheduledAt,
            status: one.status,
            openItems: one.items.filter((item) => item.status === "open").length,
            href: "/me/one-on-ones",
          })),
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const feedbackKinds = ["praise", "feedback", "request"] as const;

const hrmFeedback: AssistantToolDef = {
  name: "hrm_feedback",
  description:
    "Feedback in the caller's scope: praise, feedback, and requests filtered by the visibility matrix. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.performance.read", "hrm.self.read"] },
  feature: "hrmFeedback",
  tier: "module",
  inputSchema: z.object({
    subjectEmploymentId: uuidInput.optional().describe("Keep only feedback about this employment"),
    kind: z.enum(feedbackKinds).optional().describe("Keep only this feedback kind"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum rows to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await continuousFeatureRefused(authz.user.orgId, "hrmFeedback");
    if (gated) return gated;
    const a = raw as { subjectEmploymentId?: string; kind?: (typeof feedbackKinds)[number]; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      const { listFeedback } = await import("@openbooks/engine/src/hrm/performance/feedback.ts");
      const rows = await listFeedback({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(a.subjectEmploymentId ? { subjectEmploymentId: a.subjectEmploymentId } : {}),
      });
      return {
        ok: true,
        data: {
          feedback: rows
            .filter((row) => !a.kind || row.kind === a.kind)
            .slice(0, limit)
            .map((row) => ({
              id: row.id,
              subjectName: row.subjectName,
              kind: row.kind,
              visibility: row.visibility,
              body: row.body,
              recordedAt: row.recordedAt,
              href: "/me/one-on-ones",
            })),
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

const hrmCalibration: AssistantToolDef = {
  name: "hrm_calibration",
  description:
    "Calibration sessions over review cycles: entries with proposed beside calibrated ratings, and the missing list. HR-only. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.performance.manage"] },
  feature: "hrmCalibration",
  tier: "module",
  inputSchema: z.object({
    sessionId: uuidInput.optional().describe("One session in full; omit for the session list"),
    cycleId: uuidInput.optional().describe("Keep only sessions over this cycle"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await continuousFeatureRefused(authz.user.orgId, "hrmCalibration");
    if (gated) return gated;
    const a = raw as { sessionId?: string; cycleId?: string };
    try {
      const { getCalibrationSession, listCalibrationSessions } = await import(
        "@openbooks/engine/src/hrm/performance/calibration.ts"
      );
      if (a.sessionId) {
        const session = await getCalibrationSession({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          id: a.sessionId,
        });
        return {
          ok: true,
          data: {
            id: session.id,
            name: session.name,
            status: session.status,
            entries: session.entries.map((entry) => ({
              subjectName: entry.subjectName,
              proposedRating: entry.proposedRating,
              calibratedRating: entry.calibratedRating,
              potentialKey: entry.potentialKey,
            })),
            missing: session.missing.map((missing) => ({ status: missing.status, reason: missing.reason })),
            href: "/hrm/performance?tab=calibration",
          },
        };
      }
      const sessions = await listCalibrationSessions({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        ...(a.cycleId ? { cycleId: a.cycleId } : {}),
      });
      return {
        ok: true,
        data: {
          sessions: sessions.map((session) => ({
            id: session.id,
            name: session.name,
            status: session.status,
            href: "/hrm/performance?tab=calibration",
          })),
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};
// HR-17 end

// HR-15: the core own-scope inbox tool rides after every slice tool.
export const HRM_TOOLS: AssistantToolDef[] = [hrmHeadcount, hrmEmploymentAsOf, hrmChangeRequests, hrmPositionsAsOf, hrmProcesses, hrmLeave, hrmRecruiting, hrmPerformanceCycles, hrmTurnover, hrmBenefits, hrmMe, automationsStatus, hrmComplianceFindings, hrmCertifiedPayroll, hrmCompensation, hrmPayEquity, hrmQualifications, hrmDispatchCheck, hrmOneOnOnes, hrmFeedback, hrmCalibration, hrmDocuments, hrmSurveyResults, hrmOrgChart];
// HR-15: the core own-scope inbox tool rides after every slice tool.
HRM_TOOLS.push(inboxItems);


// HR-12 end
// HR-21 begin: AI rails tools. Every capability is a TOOL or a DETERMINISTIC
// service — the model phrases and drafts, the services compute. Each tool
// logs its decision to the governance ledger: mutating paths log inside
// their service, pure-read paths log here before returning.
import { AiRailsError as Hr21AiRailsError } from "@openbooks/engine/src/hrm/ai/errors.ts";

function hr21Refusal(error: unknown): ToolResult {
  if (error instanceof Hr21AiRailsError) return { ok: false, error: error.message };
  return hrmRefusal(error);
}

async function hr21FeatureRefused(orgId: string, key: string): Promise<ToolResult | null> {
  if (!(await isFeatureEnabled(orgId, key))) return { ok: false, error: HRM_FEATURE_OFF };
  return null;
}

const hrmExplainPay: AssistantToolDef = {
  name: "hrm_explain_pay",
  description:
    "Explain one payslip deterministically: gross by component with the input behind each line, deductions with treatments, employer cost, net, and the diff vs the previous payslip. Own payslips through self-service; anyone else's needs the payroll grant. Read-only; the trace cites record ids.",
  category: "read",
  gate: { mode: "anyOf", perms: ["hrm.self.read", "hrm.employment.read", "payroll.manage"] },
  feature: "hrmExplainPay",
  tier: "module",
  inputSchema: z.object({
    employmentId: uuidInput.describe("Employment whose payslip to explain"),
    stubId: uuidInput.optional().describe("One stub; omit for the latest calculated payslip"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hr21FeatureRefused(authz.user.orgId, "hrmExplainPay");
    if (gated) return gated;
    const a = raw as { employmentId: string; stubId?: string };
    try {
      const { explainPay } = await import("@openbooks/engine/src/hrm/ai/explain-pay.ts");
      const trace = await explainPay(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        employmentId: a.employmentId,
        stubId: a.stubId ?? null,
      });
      const cap = 100;
      const lines = [...trace.earnings, ...trace.deductions, ...trace.employerContributions];
      return {
        ok: true,
        data: {
          stubId: trace.stubId,
          payDate: trace.payDate,
          gross: trace.gross,
          netPay: trace.netPay,
          employerCost: trace.employerCost,
          lines: lines.slice(0, cap).map((l) => ({
            kind: l.kind,
            description: l.description,
            hours: l.hours,
            rate: l.rate,
            amount: l.amount,
            treatment: l.treatment,
          })),
          truncated: lines.length > cap,
          benefitInputs: trace.benefitInputs,
          leaveInputs: trace.leaveInputs,
          wageRates: trace.wageRates,
          diffVsPrevious: trace.diffVsPrevious,
          sources: trace.sources,
          href: "/me",
        },
        note: `Gross ${trace.gross}, net ${trace.netPay} — figures govern, wording explains.`,
      };
    } catch (error) {
      return hr21Refusal(error);
    }
  },
};

const anomalyActions = ["scan", "list", "transition", "compute_baselines"] as const;

const payrollAnomalies: AssistantToolDef = {
  name: "payroll_anomalies",
  description:
    "Deterministic pre-run payroll and timesheet checks: scan a period for anomaly flags, list flags with severity/kind/status filters, acknowledge/resolve/false-positive a flag with a reason, or recompute cohort baselines. Block severity refuses the pay-run finalize while open. Reads are read-only; transitions are human decisions recorded to the ledger.",
  category: "search",
  gate: { mode: "anyOf", perms: ["payroll.manage", "time.approve", "hrm.employment.read"] },
  feature: "hrmPayrollAnomalies",
  tier: "module",
  inputSchema: z.object({
    action: z.enum(anomalyActions).describe("scan a period, list flags, transition one flag, or recompute baselines"),
    periodFrom: dateInput.optional().describe("Scan/list period start (scan requires periodFrom and periodTo)"),
    periodTo: dateInput.optional().describe("Scan/list period end"),
    severity: z.enum(["info", "warn", "block"]).optional().describe("List filter: keep only this severity"),
    kind: z.enum(["terminated_with_pay", "duplicate_bank", "retro_spike", "net_pay_spike", "zero_hours_with_pay", "hours_spike", "missing_rate", "expired_rate", "prevailing_wage_missing", "apprentice_ratio_breach", "benefit_input_orphan", "leave_input_orphan", "negative_balance", "duplicate_entry", "geofence_outside", "unrounded", "custom"]).optional().describe("List filter: keep only this anomaly kind"),
    status: z.enum(["open", "acknowledged", "resolved", "false_positive"]).optional().describe("List filter (default open)"),
    employmentId: uuidInput.optional().describe("Keep only this employment's flags"),
    timeOnly: z.boolean().optional().describe("Scan timesheet-side rules only"),
    flagId: uuidInput.optional().describe("Transition target flag"),
    to: z.enum(["acknowledged", "resolved", "false_positive"]).optional().describe("Transition target status"),
    reason: z.string().min(1).max(500).optional().describe("Transition reason — required, the sentence the audit needs"),
    windowPeriods: z.number().int().min(2).max(24).optional().describe("Baseline recompute window (default 6)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hr21FeatureRefused(authz.user.orgId, "hrmPayrollAnomalies");
    if (gated) return gated;
    const a = raw as {
      action: (typeof anomalyActions)[number];
      periodFrom?: string;
      periodTo?: string;
      severity?: string;
      kind?: string;
      status?: string;
      employmentId?: string;
      timeOnly?: boolean;
      flagId?: string;
      to?: "acknowledged" | "resolved" | "false_positive";
      reason?: string;
      windowPeriods?: number;
    };
    try {
      const ai = await import("@openbooks/engine/src/hrm/ai/anomalies.ts");
      if (a.action === "scan") {
        if (!a.periodFrom || !a.periodTo) return { ok: false, error: "periodFrom and periodTo are required to scan" };
        const summary = await ai.scanAnomalies(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          periodFrom: a.periodFrom,
          periodTo: a.periodTo,
          options: a.timeOnly === true ? { timeOnly: true } : undefined,
        });
        return { ok: true, data: { ...summary, href: "/payroll/anomalies" } };
      }
      if (a.action === "list") {
        const flags = await ai.listFlags(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          periodFrom: a.periodFrom,
          periodTo: a.periodTo,
          severity: a.severity,
          kind: a.kind,
          status: a.status ?? "open",
          employmentId: a.employmentId,
        });
        const { logDecision } = await import("@openbooks/engine/src/hrm/ai/governance.ts");
        await logDecision(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          capabilityKey: "hrmPayrollAnomalies",
          subjectKind: "pay_period",
          subjectId: null,
          input: `listFlags ${a.periodFrom ?? ""}..${a.periodTo ?? ""}`,
          output: `${flags.length} flags listed`,
          outputSummary: `flag list shown (${flags.length} rows)`,
          sources: [],
          outcome: "shown",
          model: "payroll-anomalies-tool",
        });
        return { ok: true, data: { total: flags.length, flags: flags.slice(0, 50), href: "/payroll/anomalies" } };
      }
      if (a.action === "transition") {
        if (!a.flagId || !a.to || !a.reason) {
          return { ok: false, error: "flagId, to and reason are required to transition a flag" };
        }
        const flag = await ai.transitionFlag(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          flagId: a.flagId,
          to: a.to,
          reason: a.reason,
        });
        return { ok: true, data: { flag, href: "/payroll/anomalies" } };
      }
      const baselines = await ai.computeBaselines(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        windowPeriods: a.windowPeriods,
      });
      return { ok: true, data: { ...baselines, href: "/payroll/anomalies" } };
    } catch (error) {
      return hr21Refusal(error);
    }
  },
};

const draftKinds = [
  "job_description",
  "review_manager",
  "review_self",
  "onboarding_plan",
  "offer_letter_clauses",
] as const;

const aiDraft: AssistantToolDef = {
  name: "ai_draft",
  description:
    "Draft from evidence only: a job description from its requisition, a manager or self review from cycle goals and prior calibrated ratings, an onboarding plan from its template and precedents, or offer clauses from the offer and band. Sources the actor cannot read refuse the whole draft. Drafts never auto-submit — the human edits and files through the existing form.",
  category: "read",
  gate: {
    mode: "anyOf",
    perms: ["hrm.self.read", "hrm.performance.manage", "hrm.recruiting.read", "hrm.recruiting.manage", "hrm.process.read"],
  },
  feature: "hrmDrafting",
  tier: "module",
  inputSchema: z.object({
    kind: z.enum(draftKinds).describe("What to draft"),
    subjectId: uuidInput.describe("Requisition, review, process template, or offer id"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hr21FeatureRefused(authz.user.orgId, "hrmDrafting");
    if (gated) return gated;
    const a = raw as { kind: (typeof draftKinds)[number]; subjectId: string };
    try {
      const { draftWithEvidence } = await import("@openbooks/engine/src/hrm/ai/drafting.ts");
      const draft = await draftWithEvidence({
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        kind: a.kind,
        subjectId: a.subjectId,
      });
      return {
        ok: true,
        data: {
          kind: draft.kind,
          subjectId: draft.subjectId,
          text: draft.text,
          sources: draft.sources,
          biasFlags: draft.biasFlags,
        },
        note: "A draft, not a filing — edit and submit through the existing form.",
      };
    } catch (error) {
      return hr21Refusal(error);
    }
  },
};

const nlReport: AssistantToolDef = {
  name: "nl_report",
  description:
    "Answer a question with a validated report-engine definition (never SQL): preview runs it once under the caller's report permissions, save stores the draft for save-as-view. Invalid definitions are refused by name, never repaired silently.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  feature: "hrmNlReports",
  tier: "module",
  inputSchema: z.object({
    action: z.enum(["preview", "save"]).describe("Run once as a preview, or validate, save the draft and preview"),
    question: z.string().min(1).max(1000).describe("The question in plain language"),
    definitionJson: z.string().min(1).max(20000).describe("Candidate report definition as JSON (entity, mode, columns, breakouts, measures, filters, sorts, limit)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hr21FeatureRefused(authz.user.orgId, "hrmNlReports");
    if (gated) return gated;
    const a = raw as { action: "preview" | "save"; question: string; definitionJson: string };
    let candidate: unknown;
    try {
      candidate = JSON.parse(a.definitionJson);
    } catch {
      return { ok: false, error: "definitionJson must parse as JSON — resend the definition as JSON text" };
    }
    try {
      const { REPORT_ENTITY_MAP } = await import("@openbooks/reports");
      const { hiddenReportEntityKeys } = await import("../report-authz");
      const { canRunReportEntity } = await import("../report-authz");
      const { validateNlDefinition } = await import("@openbooks/engine/src/hrm/ai/nl-reports.ts");
      const hidden = new Set(await hiddenReportEntityKeys(authz));
      const catalog = Object.values(REPORT_ENTITY_MAP)
        .filter((e) => !hidden.has(e.key))
        .map((e) => ({
          key: e.key,
          columns: e.columns.map((c) => c.key),
          requiredPermission: e.requiredPermission ?? null,
        }));
      const callerPermissions = [...authz.permissions];
      // Preview-before-validate would execute an unchecked plan: validate
      // first so an unexecutable definition refuses before it ever runs.
      const definition = validateNlDefinition(candidate, catalog, callerPermissions);
      if (!(await canRunReportEntity(authz, { entity: definition.entity }))) {
        return { ok: false, error: "forbidden" };
      }
      const { executeReport } = await import("../custom-reports");
      const preview = await executeReport(authz.user.orgId, definition, 5);
      const rows = preview.groups.flatMap((g) => g.rows.slice(0, 5)).slice(0, 5);
      if (a.action === "preview") {
        const { logDecision } = await import("@openbooks/engine/src/hrm/ai/governance.ts");
        await logDecision(db, {
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          capabilityKey: "hrmNlReports",
          subjectKind: "nl_report_preview",
          subjectId: null,
          input: a.question,
          output: `entity=${definition.entity} mode=${definition.mode}`,
          outputSummary: `report preview from question (${definition.entity}, ${definition.mode})`,
          sources: [{ kind: "report_entity", id: definition.entity }],
          outcome: "shown",
          model: "nl-report-tool",
        });
        return {
          ok: true,
          data: { definition, previewRows: rows, href: "/reports" },
          note: "Preview only — nothing saved. Ask to save it as a view.",
        };
      }
      const { saveNlDraft } = await import("@openbooks/engine/src/hrm/ai/nl-reports.ts");
      const saved = await saveNlDraft(db, {
        orgId: authz.user.orgId,
        actorId: authz.user.id,
        question: a.question,
        candidate,
        catalog,
        callerPermissions,
      });
      return {
        ok: true,
        data: { draftId: saved.draftId, definition: saved.definition, previewRows: rows, href: "/reports" },
        note: "Draft saved — save it as a view from the report builder.",
      };
    } catch (error) {
      return hr21Refusal(error);
    }
  },
};

HRM_TOOLS.push(hrmExplainPay, payrollAnomalies, aiDraft, nlReport);
// HR-21 end
