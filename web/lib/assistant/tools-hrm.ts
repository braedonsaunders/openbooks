import "server-only";
import { z } from "zod";
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
import {
  listLeaveRequests,
  listLeaveTypes,
  timeBalanceAsOf,
} from "@openbooks/engine/src/hrm/leave-read.ts";
import { LeaveError } from "@openbooks/engine/src/hrm/leave-errors.ts";
import { HrmAuthorizationError } from "@openbooks/engine/src/hrm/authorization.ts";
import { HrmPositionError } from "@openbooks/engine/src/hrm/positions.ts";
import { getVacancyAsOf } from "@openbooks/engine/src/hrm/positions-read.ts";
import { AmbiguousRevisionError, TemporalError } from "@openbooks/engine/src/hrm/temporal.ts";
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
    error instanceof HrmAuthorizationError ||
    error instanceof TemporalError ||
    error instanceof LeaveError
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
    "Employment change requests with status, revision binding, and flow run: one employment's list, or every visible employment newest-first with an optional status filter. Read-only.",
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
      const page = compactRows(collected, { limit });
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
/** 0194 request lifecycle statuses: the CHECK the leave-request table enforces. */
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
      processId?: string;
      segment?: (typeof processSegments)[number];
      employmentId?: string;
      employmentId?: string;
      status?: (typeof leaveRequestStatuses)[number];
      includeBalances?: boolean;
      asOf?: string;
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

export const HRM_TOOLS: AssistantToolDef[] = [hrmHeadcount, hrmEmploymentAsOf, hrmChangeRequests, hrmPositionsAsOf, hrmProcesses];
export const HRM_TOOLS: AssistantToolDef[] = [hrmHeadcount, hrmEmploymentAsOf, hrmChangeRequests, hrmLeave];
