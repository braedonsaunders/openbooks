import "server-only";
import { z } from "zod";
import { isFeatureEnabled } from "../features";
import { PROJECT_RANK_SORTS, rankProjects, type ProjectRankSort } from "../project-ranking";
import type { AssistantToolDef, ToolResult } from "./types";

/**
 * Portfolio-level project tools. `project_profitability` (tools.ts) answers
 * for ONE project in full detail; this file answers across the whole job
 * list in a single call so the model can rank, filter, and page instead of
 * walking projects one at a time.
 */

const rankProjectsTool: AssistantToolDef = {
  name: "rank_projects",
  tier: "core",
  description:
    "Rank and filter the whole project (job) portfolio in one call: per-project contract value, cost budget, posted cost, posted revenue, margin, margin %, committed PO cost, budget overrun, and unbilled contract, with the TOTAL matching count and paging. Use this for 'worst projects', 'over budget', 'largest fixed-price contracts', 'negative margin', or any portfolio ranking — never call project_profitability per project to build a list. Defaults: status active, projects with posted activity, sorted worst margin first. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["projects.read", "reports.read"] },
  feature: "projects",
  inputSchema: z.object({
    statuses: z.array(z.string().max(40)).max(10).optional()
      .describe("Project statuses to include (active, awarded, substantially_complete, closed, cancelled); default ['active']. Pass several for a wider portfolio."),
    billingMethod: z.string().max(40).optional()
      .describe("Filter by the project type's billing method key (e.g. fixed_price, time_and_materials, cost_plus)."),
    query: z.string().max(100).optional().describe("Match project name or code"),
    customerQuery: z.string().max(100).optional().describe("Match customer name"),
    negativeMarginOnly: z.boolean().optional().describe("Only projects whose posted revenue < posted cost"),
    overBudgetOnly: z.boolean().optional().describe("Only projects with a cost budget where cost + committed exceeds it"),
    withActivityOnly: z.boolean().optional().describe("Default true: drop projects with no posted cost or revenue"),
    sort: z.enum(PROJECT_RANK_SORTS).optional().describe("Default margin_asc (worst margin first)"),
    limit: z.number().int().min(1).max(100).optional().describe("Default 25"),
    offset: z.number().int().min(0).max(5000).optional().describe("Rows to skip for paging (default 0)"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "projects"))) return { ok: false, error: "projects_feature_disabled" };
    const a = raw as {
      statuses?: string[];
      billingMethod?: string;
      query?: string;
      customerQuery?: string;
      negativeMarginOnly?: boolean;
      overBudgetOnly?: boolean;
      withActivityOnly?: boolean;
      sort?: ProjectRankSort;
      limit?: number;
      offset?: number;
    };
    const limit = Math.min(a.limit ?? 25, 100);
    const statuses = a.statuses?.length ? a.statuses : ["active"];
    const ranking = await rankProjects(
      authz.user.orgId,
      {
        statuses,
        billingMethod: a.billingMethod,
        query: a.query,
        customerQuery: a.customerQuery,
        negativeMarginOnly: a.negativeMarginOnly,
        overBudgetOnly: a.overBudgetOnly,
        withActivityOnly: a.withActivityOnly,
        sort: a.sort,
        limit,
        offset: a.offset,
      },
      authz.allowedSubsidiaryIds,
    );
    const returned = ranking.rows.length;
    return {
      ok: true,
      note:
        `${ranking.total} project(s) match these filters (statuses: ${statuses.join(", ")}` +
        `${a.negativeMarginOnly ? "; negative margin only" : ""}${a.overBudgetOnly ? "; over budget only" : ""}` +
        `${(a.withActivityOnly ?? true) ? "; with posted activity" : ""}); returning ${returned}` +
        (ranking.total > (a.offset ?? 0) + returned ? " — page with offset for more." : ".") +
        " The total counts matches of THIS query, not all projects." +
        " committedCost excludes direct subcontract commitments; call project_profitability for one project's full detail.",
      data: {
        total: ranking.total,
        returned,
        truncated: ranking.total > (a.offset ?? 0) + returned,
        offset: a.offset ?? 0,
        sort: a.sort ?? "margin_asc",
        statuses,
        projects: ranking.rows.map((row) => ({ ...row, href: `/projects?project=${row.id}` })),
        href: "/projects",
      },
    };
  },
};

export const PROJECT_TOOLS: AssistantToolDef[] = [rankProjectsTool];
