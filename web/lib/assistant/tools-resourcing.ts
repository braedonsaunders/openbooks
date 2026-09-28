import "server-only";
import { z } from "zod";
import { can, type Authz } from "../authz";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { compactRows, uuidInput } from "./tools-shared";
import { ResourcingRefusal } from "@openbooks/engine/src/resourcing/errors.ts";
import { businessToday } from "@openbooks/engine/src/platform/business-date.ts";
import { defaultListView, type FilterClause } from "@openbooks/customization";
import { loadAssignmentDrawerData } from "../resourcing/assignment-drawer.ts";
import { loadDemandWeeks } from "../resourcing/demand.ts";
import { loadRetainerKpis } from "../resourcing/retainer-kpis.ts";
import {
  loadBench,
  loadResourcingBoard,
  loadRolloffs,
} from "../resourcing/queries.ts";
import { readEntityListPage } from "../list/entity-reader.ts";

/**
 * Resourcing read tools for the agentic assistant. Every tool calls the SAME
 * landed loader the native surfaces call — `loadAssignmentDrawerData` (the
 * assignment drawer), the `resourcing_assignment` / `resourcing_request` /
 * `retainer` entity sources through the shared entity reader (the native
 * lists), `loadDemandWeeks` (demand view), `loadRetainerKpis` with the engine
 * `balanceOf` policy (retainers KPIs), `loadResourcingBoard` (staffing
 * board), `loadBench` + `loadRolloffs` (bench summary) — under the same
 * gates: the `resourcing` feature (plus `resourceRequests` for requests and
 * `retainerBilling` for retainers, exactly as their pages require) plus the
 * matching read grant, rechecked at execution. Tenant and subsidiary scope
 * pass through untouched; a tool cannot widen its caller. All tools are
 * read-only; there is no booking, release, or drawdown writer here.
 */

const ASSIGNMENTS_HREF = "/resourcing/assignments";
const REQUESTS_HREF = "/resourcing/requests";
const DEMAND_HREF = "/resourcing/demand";
const RETAINERS_HREF = "/resourcing/retainers";
const BOARD_HREF = "/resourcing/board";

const sundayInput = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD")
  .describe("Sunday starting the week (YYYY-MM-DD)");

const FEATURE_LABEL: Record<string, string> = {
  resourcing: "Resourcing",
  resourceRequests: "Resource requests",
  retainerBilling: "Retainer billing",
};

type ResourcingDependencies = {
  isFeatureEnabled: typeof isFeatureEnabled;
  readEntityListPage: typeof readEntityListPage;
  loadAssignmentDrawerData: typeof loadAssignmentDrawerData;
  loadDemandWeeks: typeof loadDemandWeeks;
  loadRetainerKpis: typeof loadRetainerKpis;
  loadResourcingBoard: typeof loadResourcingBoard;
  loadBench: typeof loadBench;
  loadRolloffs: typeof loadRolloffs;
  businessToday: typeof businessToday;
};

export function createResourcingTools(deps: ResourcingDependencies): AssistantToolDef[] {
async function featureOff(authz: Authz, feature: string, code: string): Promise<ToolResult | null> {
  // Only an authoritative false disables: authority lookup failures rethrow
  // and never masquerade as a disabled feature.
  if (!(await deps.isFeatureEnabled(authz.user.orgId, feature))) {
    return { ok: false, error: `${code}: turn on ${FEATURE_LABEL[feature] ?? feature} under Company Settings → Features` };
  }
  return null;
}

/** Engine refusals reach the operator with their remedy; anything else stays a short message. */
function loaderFailure(error: unknown): ToolResult {
  if (error instanceof ResourcingRefusal) return { ok: false, error: `${error.code}: ${error.remedy}` };
  if (error instanceof Error) return { ok: false, error: error.message.slice(0, 300) };
  return { ok: false, error: "tool_failed" };
}

function readerFailure(result: { error: string; remedy: string }): ToolResult {
  return { ok: false, error: `${result.error}: ${result.remedy}` };
}

const pageInput = {
  sort: z.string().max(60).optional().describe("Sort key from the native list; unknown keys refuse"),
  page: z.number().int().min(1).optional().describe("1-based page; defaults to 1"),
  perPage: z.number().int().min(1).max(100).optional().describe("Rows per page, max 100"),
  q: z.string().max(120).optional().describe("Free-text search as in the native list"),
};

const getAssignment: AssistantToolDef = {
  name: "get_resourcing_assignment",
  tier: "module",
  description:
    "One assignment with capacity evidence and approved actuals: subject, week, hours, booking, billable, net capacity, absences, time entries. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourcing",
  inputSchema: z.object({
    assignmentId: uuidInput.describe("Assignment id from list_resourcing_assignments"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { assignmentId: string };
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourcing", "resourcing_feature_disabled");
    if (off) return off;
    if (!a.assignmentId) return { ok: false, error: "assignment_id_required: pass the assignment id from list_resourcing_assignments" };
    let drawer;
    try {
      drawer = await deps.loadAssignmentDrawerData({
        orgId: authz.user.orgId,
        allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
        assignmentId: a.assignmentId,
      });
    } catch (error) {
      return loaderFailure(error);
    }
    if (!drawer || !drawer.assignment) return { ok: false, error: "resourcing_assignment_not_found: the assignment is unavailable or outside your subsidiary scope" };
    const { people, projects, items, tasks, ...rest } = drawer;
    return { ok: true, data: { ...rest, href: ASSIGNMENTS_HREF } };
  },
};

const listAssignments: AssistantToolDef = {
  name: "list_resourcing_assignments",
  tier: "module",
  description:
    "Planned project bookings filterable by project, status, booking (soft/hard), and week window. Same rows, order, and scope as the native assignments list. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourcing",
  inputSchema: z.object({
    projectId: uuidInput.optional().describe("Only assignments on this project"),
    status: z.string().max(40).optional().describe("Assignment status, e.g. active or released"),
    booking: z.enum(["soft", "hard"]).optional().describe("Only soft or hard bookings"),
    weekFrom: sundayInput.optional().describe("Only weeks starting on or after this Sunday"),
    weekTo: sundayInput.optional().describe("Only weeks starting on or before this Sunday"),
    ...pageInput,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourcing", "resourcing_feature_disabled");
    if (off) return off;
    const a = raw as { projectId?: string; status?: string; booking?: "soft" | "hard"; weekFrom?: string; weekTo?: string; sort?: string; page?: number; perPage?: number; q?: string };
    const filters: FilterClause[] = [];
    if (a.status !== undefined) filters.push({ key: "state", operator: "eq", value: a.status });
    if (a.booking !== undefined) filters.push({ key: "booking", operator: "eq", value: a.booking });
    if (a.projectId !== undefined) filters.push({ key: "project_id", operator: "eq", value: a.projectId });
    if (a.weekFrom !== undefined) filters.push({ key: "week_start", operator: "gte", value: a.weekFrom });
    if (a.weekTo !== undefined) filters.push({ key: "week_start", operator: "lte", value: a.weekTo });
    const result = await deps.readEntityListPage({
      recordType: "resourcing_assignment",
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      filters,
      q: a.q,
      sort: a.sort,
      page: a.page,
      perPage: a.perPage,
    });
    if (!result.ok) return readerFailure(result);
    const paged = compactRows(result.rows);
    return {
      ok: true,
      data: { ...paged, assignments: paged.items, filteredTotal: result.filteredTotal, page: result.page, perPage: result.perPage, sort: result.sort, dir: result.dir, href: ASSIGNMENTS_HREF },
    };
  },
};

const listRequests: AssistantToolDef = {
  name: "list_resource_requests",
  tier: "module",
  description:
    "Project staffing requests with status and weekly ask, filterable by project and status. Same rows and scope as the native requests list. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourceRequests",
  inputSchema: z.object({
    projectId: uuidInput.optional().describe("Only requests on this project"),
    status: z.string().max(40).optional().describe("Request status, e.g. draft, submitted, or approved"),
    ...pageInput,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourceRequests", "resource_requests_feature_disabled");
    if (off) return off;
    const a = raw as { projectId?: string; status?: string; sort?: string; page?: number; perPage?: number; q?: string };
    const filters: FilterClause[] = [];
    if (a.status !== undefined) filters.push({ key: "status", operator: "eq", value: a.status });
    if (a.projectId !== undefined) filters.push({ key: "project_id", operator: "eq", value: a.projectId });
    const result = await deps.readEntityListPage({
      recordType: "resourcing_request",
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      filters,
      q: a.q,
      sort: a.sort,
      page: a.page,
      perPage: a.perPage,
    });
    if (!result.ok) return readerFailure(result);
    const paged = compactRows(result.rows);
    return {
      ok: true,
      data: { ...paged, requests: paged.items, filteredTotal: result.filteredTotal, page: result.page, perPage: result.perPage, sort: result.sort, dir: result.dir, href: REQUESTS_HREF },
    };
  },
};

const staffingDemand: AssistantToolDef = {
  name: "get_staffing_demand",
  tier: "module",
  description:
    "Staffing demand lines expanded into Sunday weeks with live opportunity weighting: manual asks at full weight, pipeline asks weighted by CRM probability. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourcing",
  inputSchema: z.object({
    firstSunday: sundayInput.describe("First Sunday in the window"),
    lastSunday: sundayInput.describe("Last Sunday in the window (at most 53 weeks)"),
    departmentId: uuidInput.optional().describe("Only this department"),
    jobTitle: z.string().trim().min(1).max(120).optional().describe("Only this job title"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { firstSunday: string; lastSunday: string; departmentId?: string; jobTitle?: string };
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourcing", "resourcing_feature_disabled");
    if (off) return off;
    if (!a.firstSunday || !a.lastSunday) return { ok: false, error: "demand_window_required: pass the first and last Sundays of the window" };
    try {
      const weeks = await deps.loadDemandWeeks(authz.user.orgId, authz.allowedSubsidiaryIds, {
        firstSunday: a.firstSunday,
        lastSunday: a.lastSunday,
        departmentId: a.departmentId,
        jobTitle: a.jobTitle,
      });
      const paged = compactRows(weeks);
      return { ok: true, data: { ...paged, demand: paged.items, href: DEMAND_HREF } };
    } catch (error) {
      return loaderFailure(error);
    }
  },
};

const listRetainers: AssistantToolDef = {
  name: "list_retainers",
  tier: "module",
  description:
    "Prepaid retainers filterable by state, with terms and customer. Balances come from get_retainer_balances. Same rows and scope as the native list. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["retainers.read"] },
  feature: "retainerBilling",
  inputSchema: z.object({
    state: z.string().max(40).optional().describe("Retainer state, e.g. draft, active, or exhausted"),
    ...pageInput,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!can(authz, "retainers.read")) return { ok: false, error: "forbidden: retainers.read is required" };
    const off = await featureOff(authz, "retainerBilling", "retainer_billing_feature_disabled");
    if (off) return off;
    const a = raw as { state?: string; sort?: string; page?: number; perPage?: number; q?: string };
    const filters: FilterClause[] = [];
    if (a.state !== undefined) filters.push({ key: "state", operator: "eq", value: a.state });
    const result = await deps.readEntityListPage({
      recordType: "retainer",
      orgId: authz.user.orgId,
      actorId: authz.user.id,
      allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
      filters,
      q: a.q,
      sort: a.sort,
      page: a.page,
      perPage: a.perPage,
    });
    if (!result.ok) return readerFailure(result);
    const paged = compactRows(result.rows);
    return {
      ok: true,
      data: { ...paged, retainers: paged.items, filteredTotal: result.filteredTotal, page: result.page, perPage: result.perPage, sort: result.sort, dir: result.dir, href: RETAINERS_HREF },
    };
  },
};

const retainerBalances: AssistantToolDef = {
  name: "get_retainer_balances",
  tier: "module",
  description:
    "Retainer balances per currency through the engine balance policy (total minus posted drawdowns), plus the count expiring within 30 days. Never cross-currency totaled. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["retainers.read"] },
  feature: "retainerBilling",
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (!can(authz, "retainers.read")) return { ok: false, error: "forbidden: retainers.read is required" };
    const off = await featureOff(authz, "retainerBilling", "retainer_billing_feature_disabled");
    if (off) return off;
    try {
      const today = await deps.businessToday(authz.user.orgId);
      const kpis = await deps.loadRetainerKpis(authz.user.orgId, authz.allowedSubsidiaryIds, today);
      return { ok: true, data: { ...kpis, href: RETAINERS_HREF } };
    } catch (error) {
      return loaderFailure(error);
    }
  },
};

const staffingBoard: AssistantToolDef = {
  name: "get_staffing_board",
  tier: "module",
  description:
    "Weekly hard and soft bookings with available capacity and demand evidence for staffable people. Same page the staffing board renders. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourcing",
  inputSchema: z.object({
    firstSunday: sundayInput.describe("First Sunday in the window"),
    lastSunday: sundayInput.describe("Last Sunday in the window"),
    projectId: uuidInput.optional().describe("Only this project"),
    departmentId: uuidInput.optional().describe("Only this department"),
    jobTitle: z.string().trim().min(1).max(120).optional().describe("Only this job title"),
    page: z.number().int().min(1).optional().describe("People page; defaults to 1"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { firstSunday: string; lastSunday: string; projectId?: string; departmentId?: string; jobTitle?: string; page?: number };
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourcing", "resourcing_feature_disabled");
    if (off) return off;
    if (!a.firstSunday || !a.lastSunday) return { ok: false, error: "board_window_required: pass the first and last Sundays of the window" };
    try {
      const board = await deps.loadResourcingBoard(authz.user.orgId, authz.allowedSubsidiaryIds, {
        firstSunday: a.firstSunday,
        lastSunday: a.lastSunday,
        projectId: a.projectId,
        departmentId: a.departmentId,
        jobTitle: a.jobTitle,
        page: a.page,
      });
      const rows = compactRows(board.rows);
      return { ok: true, data: { ...rows, assignments: rows.items, forecast: board.forecast, people: board.people, peopleTotal: board.total, boardPage: board.page, excludedGenericAssignmentCount: board.excludedGenericAssignmentCount, href: BOARD_HREF } };
    } catch (error) {
      return loaderFailure(error);
    }
  },
};

const benchSummary: AssistantToolDef = {
  name: "get_bench_summary",
  tier: "module",
  description:
    "Bench summary: people with unbenched capacity and people rolling off, over the same window the board reads. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["resourcing.read"] },
  feature: "resourcing",
  inputSchema: z.object({
    firstSunday: sundayInput.describe("First Sunday in the window"),
    lastSunday: sundayInput.describe("Last Sunday in the window"),
    projectId: uuidInput.optional().describe("Only this project"),
    departmentId: uuidInput.optional().describe("Only this department"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { firstSunday: string; lastSunday: string; projectId?: string; departmentId?: string };
    if (!can(authz, "resourcing.read")) return { ok: false, error: "forbidden: resourcing.read is required" };
    const off = await featureOff(authz, "resourcing", "resourcing_feature_disabled");
    if (off) return off;
    if (!a.firstSunday || !a.lastSunday) return { ok: false, error: "bench_window_required: pass the first and last Sundays of the window" };
    try {
      const options = { firstSunday: a.firstSunday, lastSunday: a.lastSunday, projectId: a.projectId, departmentId: a.departmentId };
      const [bench, rolloffs] = await Promise.all([
        deps.loadBench(authz.user.orgId, authz.allowedSubsidiaryIds, options),
        deps.loadRolloffs(authz.user.orgId, authz.allowedSubsidiaryIds, options),
      ]);
      const benched = compactRows(bench);
      const rolled = compactRows(rolloffs);
      return { ok: true, data: { bench: benched.items, benchTotal: benched.total, rolloffs: rolled.items, rolloffsTotal: rolled.total, href: BOARD_HREF } };
    } catch (error) {
      return loaderFailure(error);
    }
  },
};

return [
  getAssignment,
  listAssignments,
  listRequests,
  staffingDemand,
  listRetainers,
  retainerBalances,
  staffingBoard,
  benchSummary,
];
}

export const RESOURCING_TOOLS: AssistantToolDef[] = createResourcingTools({
  isFeatureEnabled, readEntityListPage, loadAssignmentDrawerData, loadDemandWeeks, loadRetainerKpis,
  loadResourcingBoard, loadBench, loadRolloffs, businessToday,
});
