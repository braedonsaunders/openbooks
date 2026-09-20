import "server-only";
import { z } from "zod";
import {
  listEnrollmentWindows,
  listEnrollments,
} from "@openbooks/engine/src/hrm/benefits/benefits-read.ts";
import { BenefitsError } from "@openbooks/engine/src/hrm/benefits/errors.ts";
import {
  listLeaveRequests,
  listLeaveTypes,
  timeBalanceAsOf,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";
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
    "Requisitions with headcount versus filled, the funnel per application with stages and offer state, and one opening pipeline with time-to-fill. Candidate contact PII never leaves through this tool, names only. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.recruiting.read"] },
  feature: "hrm",
  tier: "module",
  inputSchema: z.object({
    requisitionId: uuidInput.optional().describe("One opening in full (pipeline, funnel, applications); omit for the segment list"),
    segment: z.enum(requisitionSegments).optional().describe("List segment (default open)"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum openings to return (default 50)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const gated = await hrmFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { requisitionId?: string; segment?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    try {
      if (a.requisitionId) {
        const detail = await getRequisitionDetail({
          orgId: authz.user.orgId,
          actorId: authz.user.id,
          requisitionId: a.requisitionId,
        });
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
    "Construction-compliance pre-run flags by kind: ratio breaches, missing rates, unresolved comp classes, missing registrations, and fringe mismatches with lifecycle status. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["hrm.construction.read"] },
  feature: "hrmConstructionCompliance",
    status: z.enum(["open", "acknowledged", "resolved"]).optional().describe("Keep only this lifecycle status"),
    kind: z
      .enum(["ratio_breach", "missing_rate", "class_unresolved", "registration_missing", "fringe_mismatch"])
      .optional()
      .describe("Keep only this finding kind"),
    limit: z.number().int().min(1).max(200).optional().describe("Maximum findings to return (default 50)"),
    const gated = await constructionFeatureRefused(authz.user.orgId);
    if (gated) return gated;
    const a = raw as { status?: string; kind?: string; limit?: number };
      const findings = await listFindings(db, authz.user.orgId, authz.user.id, a.status ?? null);
      const kept = (a.kind ? findings.filter((finding) => finding.kind === a.kind) : findings).slice(0, Math.min(a.limit ?? 50, 200));
          findings: kept.map((finding) => ({
            id: finding.id,
            kind: finding.kind,
            projectId: finding.projectId,
            workedOn: finding.workedOn,
            employmentId: finding.employmentId,
            status: finding.status,
            recordedAt: finding.recordedAt,
          href: "/hrm/compliance",
        },
      };
    } catch (error) {
      return hrmRefusal(error);
    }
  },
};

// HR-15 end
// HR-16 begin: automation run/error status (0226). Read-only: recipes and
// the run log with errors, behind the automations switch and read grant.
const automationsStatus: AssistantToolDef = {
  name: "automations_status",
    "Automation recipes with status and the run log: recent runs and errors per recipe, newest first. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["automations.read"] },
  feature: "automations",
    status: z.enum(["queued", "running", "succeeded", "failed", "skipped_no_match", "simulated"]).optional().describe("Keep only runs in this status"),
    limit: z.number().int().min(1).max(100).optional().describe("Maximum runs to return (default 25)"),
    if (!(await isFeatureEnabled(authz.user.orgId, "automations"))) {
      return { ok: false, error: "automations_feature_disabled" };
    const a = raw as { status?: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 100);
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
          automations: automations.map((recipe) => ({
            id: recipe.id,
            name: recipe.name,
            status: recipe.status,
            version: recipe.version,
            triggerKind: (recipe.trigger as { kind?: string } | null)?.kind ?? null,
            lastRunAt: recipe.lastRunAt,
            errorMessage: recipe.errorMessage,
          runs,
      // Automation service refusals (permission, missing recipe) surface
      // with their message intact — hrmRefusal only maps HRM reads.
      return { ok: false, error: error instanceof Error ? error.message : "automations_status_failed" };
// HR-16 end

// HR-15: the core own-scope inbox tool rides after every slice tool.
HRM_TOOLS.push(inboxItems);
const hrmCertifiedPayroll: AssistantToolDef = {
  name: "hrm_certified_payroll",
  description:
    "Frozen certified payroll runs by project and week: pack format, lifecycle status, and amendment links. Read-only.",
  gate: { mode: "anyOf", perms: ["hrm.construction.read"] },
  feature: "hrmConstructionCompliance",
  tier: "module",
  inputSchema: z.object({
    projectId: z.string().optional().describe("Keep only this project's runs"),
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

export const HRM_TOOLS: AssistantToolDef[] = [hrmHeadcount, hrmEmploymentAsOf, hrmChangeRequests, hrmPositionsAsOf, hrmProcesses, hrmLeave, hrmRecruiting, hrmPerformanceCycles, hrmTurnover, hrmBenefits, hrmMe, automationsStatus,
  // HR-13 begin: read-only construction-compliance tools (generation,
  // approval, and finding transitions stay human-attested).
  hrmComplianceFindings, hrmCertifiedPayroll,
  // HR-13 end
];
