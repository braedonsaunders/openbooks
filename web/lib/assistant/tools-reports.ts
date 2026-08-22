import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { db, withOrg } from "@openbooks/engine/src/db.ts";
import { REPORT_ENTITY_MAP } from "@openbooks/reports";
import { can, type Authz } from "../authz";
import {
  agingDetail,
  cashFlowIndirect,
  generalLedger,
  partnerStatement,
} from "../reports";
import { resolveDefinitionToExportData } from "../report-run";
import type { Translator } from "../report-pdf";
import { parseReportQuery } from "../report-filters";
import { resolvePeriod } from "../periods";
import { budgetScenarioOptions } from "../budget-report";
import { loadBudgetScenario } from "../budgets";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import {
  dateInput,
  uuidInput,
  capList,
  orgToday,
  periodPresetInput,
  rangeInputFields,
  resolveToolRange,
  type RangeArgs,
} from "./tools-shared";

/**
 * Reporting-surface tools: the saved-report catalog and runner (one execution
 * basis with the export route and the scheduler), the detail reports the
 * statement tools don't cover, reporting packages, schedules, and budgets.
 * Same doctrine as tools.ts: page permissions, capped lists, exact query layer.
 */

/** A definition over a permission-gated report entity (e.g. payroll wages) is
 *  hidden from users who could not run it anyway — mirrors the reports hub. */
function entityPermitted(authz: Authz, entity: string | null): boolean {
  const def = entity ? REPORT_ENTITY_MAP[entity] : undefined;
  return !def?.requiredPermission || can(authz, def.requiredPermission);
}

/** Reports render through next-intl when a request locale exists; background
 *  agent runs have none, so fall back to key-passthrough labels. */
async function reportTranslator(): Promise<Translator> {
  try {
    return (await getTranslations("reports")) as unknown as Translator;
  } catch {
    return (key: string) => key;
  }
}

const listReportDefinitions: AssistantToolDef = {
  name: "list_report_definitions",
  description:
    "List saved report definitions — built-in statements and custom report-studio reports — with id, name, type, and source entity. Use run_report to execute one. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    query: z.string().max(100).optional(),
    reportType: z.enum(["statement", "query"]).optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { query?: string; reportType?: "statement" | "query"; limit?: number };
    const limit = Math.min(a.limit ?? 50, 100);
    const like = a.query ? `%${a.query}%` : null;
    const rows = (await db.execute<{
        id: string; name: string; description: string | null; kind: string;
        report_type: string; slug: string | null; entity: string | null;
      }>(sql`
      select id, name, description, kind, coalesce(report_type, 'query') as report_type,
             slug, query->>'entity' as entity, updated_at
        from report_definitions
       where org_id = ${authz.user.orgId}
         ${a.reportType ? sql`and coalesce(report_type, 'query') = ${a.reportType}` : sql``}
         ${like ? sql`and name ilike ${like}` : sql``}
       order by updated_at desc
       limit 500
    `));
    const visible = rows.rows.filter((row) => entityPermitted(authz, row.entity));
    return {
      ok: true,
      data: {
        total: visible.length,
        returned: Math.min(visible.length, limit),
        truncated: visible.length > limit,
        definitions: visible.slice(0, limit).map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          kind: row.kind,
          reportType: row.report_type,
          entity: row.entity,
        })),
        href: "/reports",
      },
    };
  },
};

const MAX_REPORT_ROWS = 200;

const runReport: AssistantToolDef = {
  name: "run_report",
  description:
    "Execute any saved report definition (built-in statement or custom report-studio report) through the same resolver the export route and scheduler use, returning its title, summary figures, and tabular groups (rows capped). A `period` preset (fiscal-calendar-resolved) or custom date range overrides the definition's period. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    definitionId: uuidInput,
    period: periodPresetInput.optional(),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { definitionId: string };
    const orgId = authz.user.orgId;
    const def = (await db.execute<{ entity: string | null }>(sql`
      select query->>'entity' as entity from report_definitions
       where id = ${a.definitionId} and org_id = ${orgId}
    `));
    if (!def.rows[0]) return { ok: false, error: "report_not_found" };
    if (!entityPermitted(authz, def.rows[0].entity)) return { ok: false, error: "forbidden" };

    const p = new URLSearchParams();
    if (a.period && a.period !== "custom") {
      p.set("period", a.period);
    } else if (a.fromDate && a.toDate) {
      p.set("period", "custom");
      p.set("from", a.fromDate);
      p.set("to", a.toDate);
    }
    const q = parseReportQuery(p);
    const period = await resolvePeriod(q.period, {
      customFrom: a.fromDate,
      customTo: a.toDate,
      orgId,
    });
    const t = await reportTranslator();
    const data = await withOrg(orgId, () =>
      resolveDefinitionToExportData(orgId, a.definitionId, p, { orgId, t, period, query: q }),
    );
    // Cap total rows across groups so a full GL can't blow the context.
    let budget = MAX_REPORT_ROWS;
    let dropped = 0;
    const groups = data.groups.map((g) => {
      const kept = g.rows.slice(0, Math.max(budget, 0));
      dropped += g.rows.length - kept.length;
      budget -= kept.length;
      return { title: g.title, subtitle: g.subtitle, columns: g.columns, rows: kept };
    });
    return {
      ok: true,
      data: {
        title: data.title,
        dateRangeLabel: data.dateRangeLabel,
        summary: data.summary,
        truncated: dropped > 0,
        rowsDropped: dropped,
        groups,
        href: "/reports",
      },
      note: `${data.title} — ${data.dateRangeLabel}${dropped > 0 ? ` (${dropped} rows truncated)` : ""}`,
    };
  },
};

const generalLedgerTool: AssistantToolDef = {
  name: "general_ledger",
  description:
    "General ledger for a posting-date range: per-account opening balance, posted lines in date order with running balance, and closing balance. Scope to one account with accountId; unscoped runs return more accounts with fewer lines each. For relative periods pass a `period` preset (fiscal-calendar-resolved). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read", "gl.read"] },
  inputSchema: z.object({
    ...rangeInputFields,
    accountId: uuidInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { accountId?: string };
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const r = await generalLedger(range.from, range.to, {
      accountId: a.accountId,
      orgId: authz.user.orgId,
      maxLines: a.accountId ? MAX_REPORT_ROWS : 1000,
    });
    const perAccountCap = a.accountId ? MAX_REPORT_ROWS : 10;
    const { items: accounts, truncated: accountsTruncated } = capList(r.accounts, 50);
    return {
      ok: true,
      data: {
        periodLabel: range.label,
        from: r.from,
        to: r.to,
        truncated: r.truncated || accountsTruncated,
        accounts: accounts.map((acct) => ({
          id: acct.id,
          number: acct.number,
          name: acct.name,
          type: acct.type,
          opening: acct.opening,
          closing: acct.closing,
          lineCount: acct.lines.length,
          linesTruncated: acct.lines.length > perAccountCap,
          lines: acct.lines.slice(0, perAccountCap),
        })),
        href: `/reports/general-ledger?period=custom&from=${range.from}&to=${range.to}`,
      },
    };
  },
};

const agingDetailTool: AssistantToolDef = {
  name: "aging_detail",
  description:
    "Open-item aging detail — one row per open document with reference, due date, age in days, bucket, and open amount, plus bucket totals that tie to the aging summary. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  inputSchema: z.object({
    side: z.enum(["ar", "ap"]),
    asOf: dateInput.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { side: "ar" | "ap"; asOf?: string; limit?: number };
    if (!can(authz, a.side === "ar" ? "ar.read" : "ap.read")) {
      return { ok: false, error: "forbidden" };
    }
    const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
    const r = await agingDetail(a.side, asOf, undefined, authz.user.orgId);
    const limit = Math.min(a.limit ?? 100, 200);
    return {
      ok: true,
      data: {
        side: a.side,
        asOf: r.asOf,
        totals: r.totals,
        totalItems: r.rows.length,
        truncated: r.rows.length > limit,
        items: r.rows.slice(0, limit),
        href: `/reports/aging?side=${a.side}&view=detail&asOf=${asOf}`,
      },
    };
  },
};

const cashFlowIndirectTool: AssistantToolDef = {
  name: "cash_flow_indirect",
  description:
    "Indirect-method cash flow statement for a posting-date range: net income, non-cash adjustments, per-account working-capital movements, investing and financing sections, FX effect, and net change in cash. For relative periods pass a `period` preset (fiscal-calendar-resolved). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ ...rangeInputFields }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const range = await resolveToolRange(authz.user.orgId, raw as RangeArgs);
    if ("error" in range) return { ok: false, error: range.error };
    const r = await cashFlowIndirect(range.from, range.to, undefined, authz.user.orgId);
    return {
      ok: true,
      data: {
        periodLabel: range.label,
        fromDate: range.from,
        toDate: range.to,
        ...r,
        adjustments: capList(r.adjustments, 50).items,
        workingCapital: capList(r.workingCapital, 50).items,
        investing: capList(r.investing, 50).items,
        financing: capList(r.financing, 50).items,
        href: `/reports/cash-flow-indirect?period=custom&from=${range.from}&to=${range.to}`,
      },
    };
  },
};

const partnerStatementTool: AssistantToolDef = {
  name: "partner_statement",
  description:
    "Account statement for a single customer or vendor over a date range: opening balance, dated activity with running balance, closing balance, and an aged summary as of the end date. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  inputSchema: z.object({
    partyId: uuidInput,
    side: z.enum(["ar", "ap"]),
    ...rangeInputFields,
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { partyId: string; side: "ar" | "ap" };
    if (!can(authz, a.side === "ar" ? "ar.read" : "ap.read")) {
      return { ok: false, error: "forbidden" };
    }
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const r = await partnerStatement(a.partyId, authz.user.orgId, {
      from: range.from,
      to: range.to,
      side: a.side,
    });
    const { items: lines, truncated } = capList(r.lines);
    return {
      ok: true,
      data: { ...r, lines, truncated, href: `/reports/partner-statement?party=${a.partyId}&side=${a.side}` },
      note: `${r.party.name ?? "party"}: opening ${r.opening}, closing ${r.closing}`,
    };
  },
};

const listReportSchedules: AssistantToolDef = {
  name: "list_report_schedules",
  description:
    "List scheduled report deliveries: definition, cadence, run time, timezone, recipients, next run, and active flag. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ definitionId: uuidInput.optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { definitionId?: string };
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select s.id, s.definition_id, d.name as definition_name, s.cadence,
             s.day_of_week, s.day_of_month, s.hour, s.minute, s.timezone,
             s.recipient_emails, s.next_run_at, s.active
        from report_schedules s
        left join report_definitions d on d.id = s.definition_id and d.org_id = s.org_id
       where s.org_id = ${authz.user.orgId}
         ${a.definitionId ? sql`and s.definition_id = ${a.definitionId}` : sql``}
       order by s.next_run_at
       limit 200
    `));
    return { ok: true, data: { schedules: rows.rows, href: "/reports" } };
  },
};

const listReportingPackages: AssistantToolDef = {
  name: "list_reporting_packages",
  description:
    "List period-close reporting packages: name, the reports each package bundles (with saved parameter overrides), recipients, delivery cadence, and default/active flags. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["close.read"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const rows = (await db.execute<{
        id: string; name: string; description: string | null;
        reports: unknown; recipients: unknown; delivery: unknown;
        is_default: boolean; is_active: boolean;
      }>(sql`
      select id, name, description, reports, recipients, delivery, is_default, is_active
        from close_reporting_packages
       where org_id = ${authz.user.orgId}
       order by is_default desc, name
       limit 100
    `));
    return {
      ok: true,
      data: {
        packages: rows.rows.map((row) => ({
          id: row.id,
          name: row.name,
          description: row.description,
          reports: row.reports,
          recipients: row.recipients,
          delivery: row.delivery,
          isDefault: row.is_default,
          isActive: row.is_active,
        })),
        href: "/close",
      },
    };
  },
};

const listBudgetScenarios: AssistantToolDef = {
  name: "list_budget_scenarios",
  description:
    "List non-archived budget and forecast scenarios: id, name, fiscal year, kind, and approval status. Use budget_vs_actual for variance analysis of one scenario. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["budgets.read"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "budgets"))) {
      return { ok: false, error: "budgets_feature_disabled" };
    }
    const scenarios = await budgetScenarioOptions(authz.user.orgId);
    return { ok: true, data: { scenarios, href: "/budgets" } };
  },
};

const getBudgetScenario: AssistantToolDef = {
  name: "get_budget_scenario",
  description:
    "One budget or forecast scenario's detail: book, fiscal year, kind, approval status, revision, and lifecycle timestamps. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["budgets.read"] },
  inputSchema: z.object({ scenarioId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "budgets"))) {
      return { ok: false, error: "budgets_feature_disabled" };
    }
    const a = raw as { scenarioId: string };
    const scenario = await loadBudgetScenario(a.scenarioId, authz.user.orgId);
    if (!scenario) return { ok: false, error: "budget_scenario_not_found" };
    return { ok: true, data: { ...scenario, href: `/budgets?scenario=${scenario.id}` } };
  },
};

export const REPORTING_TOOLS: AssistantToolDef[] = [
  listReportDefinitions,
  runReport,
  generalLedgerTool,
  agingDetailTool,
  cashFlowIndirectTool,
  partnerStatementTool,
  listReportSchedules,
  listReportingPackages,
  listBudgetScenarios,
  getBudgetScenario,
];
