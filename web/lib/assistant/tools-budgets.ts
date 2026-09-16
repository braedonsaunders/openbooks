import "server-only";
import { z } from "zod";
import { isFeatureEnabled } from "../features";
import { loadBudgetWorkspace, type BudgetDimensions } from "../budgets";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput } from "./tools-shared";

/**
 * Budget read tools for the agentic assistant. The workspace reader reuses
 * `loadBudgetWorkspace` — the exact loader the /budgets page renders — so the
 * assistant can never disagree with the screen. The page applies no
 * subsidiary scoping to planning cells, so neither does this tool; the gate
 * is the page's (`budgets.read` + the budgets feature). Scenario lifecycle
 * and variance live in `budget_vs_actual`; cell writes go through the
 * governed `update_budget_cells` application tool (draft scenarios only,
 * revision-concurrency checked).
 */

const dimInput = uuidInput.nullable().optional()
  .describe("Dimension slice, or null/omit for all values in this dimension");

const getBudgetWorkspace: AssistantToolDef = {
  name: "get_budget_workspace",
  description:
    "One budget scenario's planning worksheet slice: scenario header (status, fiscal year, revision — copy revision to expectedRevision for update_budget_cells), the year's periods, one account page with its per-period cell amounts and notes, plus the slice total. Paginate accounts with page/perPage; narrow with q or a dimension. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["budgets.read"] },
  feature: "budgets",
  inputSchema: z.object({
    scenarioId: uuidInput.describe("Budget scenario id (list scenarios with budget_vs_actual)"),
    q: z.string().max(100).optional().describe("Filter accounts by number or name"),
    page: z.number().int().min(1).max(10000).optional().describe("Account page, default 1"),
    perPage: z.number().int().min(1).max(100).optional().describe("Accounts per page, default 25"),
    departmentId: dimInput,
    projectId: dimInput,
    locationId: dimInput,
    classId: dimInput,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "budgets"))) {
      return { ok: false, error: "budgets_feature_disabled" };
    }
    const a = raw as {
      scenarioId: string; q?: string; page?: number; perPage?: number;
      departmentId?: string | null; projectId?: string | null;
      locationId?: string | null; classId?: string | null;
    };
    const dims: BudgetDimensions = {
      departmentId: a.departmentId ?? null,
      projectId: a.projectId ?? null,
      locationId: a.locationId ?? null,
      classId: a.classId ?? null,
    };
    const perPage = Math.min(a.perPage ?? 25, 100);
    const workspace = await loadBudgetWorkspace(a.scenarioId, authz.user.orgId, {
      q: a.q,
      page: a.page ?? 1,
      perPage,
      dims,
    });
    if (!workspace) return { ok: false, error: "budget_not_found" };
    return {
      ok: true,
      data: {
        scenario: {
          id: workspace.scenario.id,
          name: workspace.scenario.name,
          kind: workspace.scenario.kind,
          status: workspace.scenario.status,
          fiscalYear: workspace.scenario.fiscalYear,
          revision: workspace.scenario.revision,
          book: workspace.scenario.bookName,
          bookCode: workspace.scenario.bookCode,
        },
        periods: workspace.periods,
        totalAccounts: workspace.totalAccounts,
        returnedAccounts: workspace.accounts.length,
        truncated: workspace.totalAccounts > (a.page ?? 1) * perPage,
        page: workspace.page,
        perPage: workspace.perPage,
        sliceTotal: workspace.sliceTotal,
        accounts: workspace.accounts,
        cells: workspace.lines.map((line) => ({
          accountId: line.accountId,
          periodId: line.periodId,
          amount: line.amount,
          note: line.note,
        })),
        href: `/budgets?budget=${a.scenarioId}`,
      },
    };
  },
};

export const BUDGET_TOOLS: AssistantToolDef[] = [
  getBudgetWorkspace,
];
