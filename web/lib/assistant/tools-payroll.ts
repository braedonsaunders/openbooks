import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { payRunReadiness, payrollSetupState } from "@openbooks/engine/src/payroll-readiness.ts";
import { orgYearEndFilings } from "@openbooks/engine/src/payroll-yearend.ts";
import { entitlementBalances } from "@openbooks/engine/src/payroll-entitlements.ts";
import { payrollRemittanceSummary } from "@openbooks/engine/src/payroll-remittance.ts";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, uuidInput, num, capList } from "./tools-shared";

/**
 * Payroll read/search tools for the agentic assistant. Every tool is
 * feature-gated on the payroll switchboard flag and permission-gated with the
 * same keys the payroll pages use.
 *
 * COUNTRY-AGNOSTIC: these tools build only on the pack-declared registry
 * surface (orgYearEndFilings, payrollSetupState, payRunReadiness,
 * payrollRemittanceSummary) — no country-named engine export is imported and
 * no jurisdiction is special-cased here. Government identification numbers
 * (sealed on the profile) are never selected or returned.
 */

const PAY_RUN_SELECT = sql`
  select r.document_id, d.document_number, d.status as document_status, d.currency,
         r.pay_schedule_id, s.name as schedule_name,
         r.period_start::text as period_start, r.period_end::text as period_end,
         r.pay_date::text as pay_date, r.tax_year, r.run_status,
         r.gross_total, r.net_total, r.employer_cost_total, r.employee_count
    from pay_runs r
    join documents d on d.id = r.document_id
    left join pay_schedules s on s.id = r.pay_schedule_id`;

function payRunRow(r: Record<string, unknown>) {
  return {
    documentId: r.document_id,
    documentNumber: r.document_number,
    documentStatus: r.document_status,
    currency: r.currency,
    payScheduleId: r.pay_schedule_id,
    scheduleName: r.schedule_name,
    periodStart: r.period_start,
    periodEnd: r.period_end,
    payDate: r.pay_date,
    taxYear: r.tax_year,
    runStatus: r.run_status,
    grossTotal: num(r.gross_total),
    netTotal: num(r.net_total),
    employerCostTotal: num(r.employer_cost_total),
    employeeCount: r.employee_count == null ? null : Number(r.employee_count),
  };
}

const listPayRuns: AssistantToolDef = {
  name: "list_pay_runs",
  description:
    "List pay runs (newest pay date first): document number/status, schedule, period, pay date, tax year, run status, gross/net/employer-cost totals, and employee count. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["payroll.read"] },
  inputSchema: z.object({ limit: z.number().int().min(1).max(200).optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    const runs = (await db.execute(sql`
      ${PAY_RUN_SELECT}
       where r.org_id = ${authz.user.orgId}
       order by r.pay_date desc, d.document_number desc
       limit ${limit}
    `)) as unknown as { rows: Record<string, unknown>[] };
    return {
      ok: true,
      data: { returned: runs.rows.length, runs: runs.rows.map(payRunRow), href: "/payroll/runs" },
    };
  },
};

const getPayRun: AssistantToolDef = {
  name: "get_pay_run",
  description:
    "One pay run's detail: document/schedule/period facts and totals, plus the run's readiness pre-flight (blockers and warnings with stable codes, affected employees, and the in-scope employee count). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["payroll.read"] },
  inputSchema: z.object({ documentId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { documentId: string };
    const runs = (await db.execute(sql`
      ${PAY_RUN_SELECT}
       where r.org_id = ${authz.user.orgId} and r.document_id = ${a.documentId}
    `)) as unknown as { rows: Record<string, unknown>[] };
    const run = runs.rows[0];
    if (!run) return { ok: false, error: "pay_run_not_found" };
    const readiness = await payRunReadiness(authz.user.orgId, a.documentId);
    const items = capList(
      readiness.items.map((item) => ({
        severity: item.severity,
        code: item.code,
        detail: item.detail,
        href: item.href,
        employees: capList(item.employees, 20),
      })),
      50,
    );
    return {
      ok: true,
      data: {
        run: payRunRow(run),
        readiness: {
          blockers: readiness.blockers,
          warnings: readiness.warnings,
          included: readiness.included,
          items: items.items,
          truncated: items.truncated,
        },
        href: `/payroll/runs/${a.documentId}`,
      },
    };
  },
};

const payrollYearEnd: AssistantToolDef = {
  name: "payroll_year_end",
  description:
    "Payroll filings for a tax year, one section per filing declared by the org's installed payroll packs: label, cadence (annual, quarterly, or separation), population rows (capped), totals, whether a per-employee slip and an electronic file are available, and any named population refusal. Annual/quarterly filings live on /payroll/year-end; separation filings (the ROE) are per-employee-event documents on /payroll/separations. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["payroll.read"] },
  inputSchema: z.object({ taxYear: z.number().int().min(2000).max(2100) }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { taxYear: number };
    const sections = await orgYearEndFilings(authz.user.orgId, a.taxYear);
    return {
      ok: true,
      data: {
        taxYear: a.taxYear,
        sections: sections.map((s) => {
          const rows = capList(s.data.rows, 50);
          return {
            country: s.country,
            key: s.key,
            label: s.label,
            cadence: s.cadence,
            // A separation filing is an employee-event document — its home is
            // the Separations surface, never the year-end page.
            href: s.cadence === "separation" ? "/payroll/separations" : "/payroll/year-end",
            description: s.description,
            installed: s.installed,
            populationRefusal: s.populationRefusal,
            hasSlip: s.hasSlip,
            download: s.download,
            downloadRefusal: s.downloadRefusal,
            columns: s.data.columns,
            rowCount: s.data.rows.length,
            rows: rows.items,
            truncated: rows.truncated,
            totals: s.data.totals ?? [],
          };
        }),
        href: "/payroll/year-end",
      },
    };
  },
};

const payrollSetupStatus: AssistantToolDef = {
  name: "payroll_setup_status",
  description:
    "Org-level payroll configuration state: installed payroll country packs and every setup check the run pre-flight verifies (stable code, severity, pass/fail, and where to resolve it), with blocker and warning counts. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["payroll.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const state = await payrollSetupState(authz.user.orgId);
    const checks = capList(state.checks, 50);
    return {
      ok: true,
      data: {
        installedCountries: state.installedCountries,
        blockers: state.blockers,
        warnings: state.warnings,
        checks: checks.items,
        truncated: checks.truncated,
        href: "/admin/setup/payroll",
      },
    };
  },
};

const listPayrollEmployees: AssistantToolDef = {
  name: "list_payroll_employees",
  description:
    "List employees with a payroll profile, optionally filtered by name: employee, pay schedule, payroll country pack and region, pay basis, active flag, filing account number, stub delivery, and payment method. Withholding elections and government identification numbers are never returned. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["payroll.manage"] },
  inputSchema: z.object({
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { query?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    const like = a.query ? `%${a.query}%` : null;
    // Summary columns only — the confidential election facts (claim amounts,
    // exemptions, additional withholding) and the sealed government-id
    // columns on this table are deliberately not selected.
    const rows = (await db.execute(sql`
      select prof.id, prof.employee_party_id, p.display_name as employee_name,
             prof.pay_schedule_id, s.name as schedule_name, prof.country, prof.province,
             prof.pay_basis, prof.is_active, prof.stub_delivery, prof.payment_method,
             prof.vacation_method, fa.account_number as filing_account_number
        from employee_payroll_profiles prof
        join parties p on p.id = prof.employee_party_id and p.org_id = prof.org_id
        left join pay_schedules s on s.id = prof.pay_schedule_id
        left join payroll_filing_accounts fa on fa.id = prof.filing_account_id
       where prof.org_id = ${authz.user.orgId}
         ${like ? sql` and p.display_name ilike ${like}` : sql``}
       order by p.display_name
       limit ${limit}
    `)) as unknown as { rows: Record<string, unknown>[] };
    return {
      ok: true,
      data: {
        returned: rows.rows.length,
        employees: rows.rows.map((r) => ({
          profileId: r.id,
          employeePartyId: r.employee_party_id,
          name: r.employee_name,
          payScheduleId: r.pay_schedule_id,
          scheduleName: r.schedule_name,
          country: r.country,
          region: r.province,
          payBasis: r.pay_basis,
          isActive: r.is_active,
          filingAccountNumber: r.filing_account_number,
          stubDelivery: r.stub_delivery,
          paymentMethod: r.payment_method,
          vacationMethod: r.vacation_method,
        })),
        href: "/payroll",
      },
    };
  },
};

const payrollEntitlements: AssistantToolDef = {
  name: "payroll_entitlements",
  description:
    "One employee's entitlement plan balances as of a date (default today): per-plan balance in the plan's unit plus the money and hours views at the current wage, limits with over/near-limit flags, and the last movement date. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["payroll.read"] },
  inputSchema: z.object({
    employeePartyId: uuidInput,
    asOfDate: dateInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { employeePartyId: string; asOfDate?: string };
    const exists = (await db.execute(sql`
      select display_name from parties
       where org_id = ${authz.user.orgId} and id = ${a.employeePartyId}
    `)) as unknown as { rows: { display_name: string }[] };
    if (!exists.rows[0]) return { ok: false, error: "employee_not_found" };
    const balances = await entitlementBalances(authz.user.orgId, a.employeePartyId, a.asOfDate);
    const capped = capList(
      balances.map((b) => ({
        planId: b.plan.id,
        planCode: b.plan.code,
        planName: b.plan.name,
        unit: b.plan.unit,
        direction: b.plan.direction,
        balance: num(b.balance),
        balanceMoney: b.balanceMoney == null ? null : num(b.balanceMoney),
        balanceHours: b.balanceHours == null ? null : num(b.balanceHours),
        wage: b.wage == null ? null : num(b.wage),
        maxBalance: b.limit?.maxBalance == null ? null : num(b.limit.maxBalance),
        overLimit: b.overLimit,
        nearLimit: b.nearLimit,
        lastMovementDate: b.lastMovementDate,
      })),
      50,
    );
    return {
      ok: true,
      data: {
        employeePartyId: a.employeePartyId,
        employeeName: exists.rows[0].display_name,
        asOf: a.asOfDate ?? new Date().toISOString().slice(0, 10),
        balances: capped.items,
        truncated: capped.truncated,
        href: "/payroll",
      },
    };
  },
};

const payrollRemittances: AssistantToolDef = {
  name: "payroll_remittances",
  description:
    "Accrued-but-unremitted payroll withholdings and employer contributions by remittance destination for pay dates in a range: per-destination component lines with amounts, filing account, period gross payroll and employee count, and any remittance bills already raised. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["payroll.read"] },
  inputSchema: z.object({ fromDate: dateInput, toDate: dateInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "payroll"))) {
      return { ok: false, error: "payroll_feature_disabled" };
    }
    const a = raw as { fromDate: string; toDate: string };
    const groups = await payrollRemittanceSummary(authz.user.orgId, {
      from: a.fromDate,
      to: a.toDate,
    });
    const capped = capList(
      groups.map((g) => {
        const components = capList(
          g.components.map((c) => ({
            code: c.code,
            name: c.name,
            kind: c.kind,
            accountLabel: c.accountLabel,
            amount: num(c.amount),
          })),
          50,
        );
        const bills = capList(g.existingBills, 20);
        return {
          partyId: g.partyId,
          partyName: g.partyName,
          filingAccountNumber: g.filingAccount.accountNumber,
          filingAccountName: g.filingAccount.name,
          total: num(g.total),
          grossPayroll: num(g.grossPayroll),
          employeeCount: g.employeeCount,
          components: components.items,
          componentsTruncated: components.truncated,
          existingBills: bills.items.map((b) => ({
            documentId: b.documentId,
            documentNumber: b.documentNumber,
            status: b.status,
            total: num(b.total),
          })),
        };
      }),
      50,
    );
    return {
      ok: true,
      data: {
        fromDate: a.fromDate,
        toDate: a.toDate,
        groups: capped.items,
        truncated: capped.truncated,
        href: "/payroll",
      },
    };
  },
};

export const PAYROLL_TOOLS: AssistantToolDef[] = [
  listPayRuns,
  getPayRun,
  payrollYearEnd,
  payrollSetupStatus,
  listPayrollEmployees,
  payrollEntitlements,
  payrollRemittances,
];
