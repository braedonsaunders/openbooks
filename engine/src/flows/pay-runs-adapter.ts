import { sql } from "drizzle-orm";
import type { FlowSubjectProfile } from "@openbooks/forms-core";
import { db } from "../db.ts";
import type { FlowSubjectAdapter, FlowSubjectContext } from "./types.ts";
import { createDocumentsFlowAdapter } from "./documents-adapter.ts";
import { DOCUMENT_FIELDS, documentSubjectProfile } from "./subject-profiles.ts";

export const PAY_RUN_SUBJECT_KIND = "pay_run";

/**
 * The pay-run flow subject.
 *
 * A pay run IS a document (kind 'pay_run'), so it reuses the documents adapter
 * wholesale — lifecycle, gate release, posting, locking and the approvals
 * worklist all behave exactly as they do for a vendor bill. Only the authoring
 * vocabulary is payroll's own: an approver routes on gross/net pay, headcount,
 * pay date and run type, none of which live on the document header before the
 * run is committed (documents.total is written by commit, i.e. AFTER the
 * approval this subject exists to gate).
 *
 * The evidence package (payroll journal, payroll register, GL preview) is
 * attached to the run by the submit path and surfaced here as
 * `evidenceAttached` so a tenant can require it in a condition.
 */

const PAY_RUN_FIELDS = [
  { key: "payDate", label: "Pay date", type: "date" as const },
  { key: "periodStart", label: "Period start", type: "date" as const },
  { key: "periodEnd", label: "Period end", type: "date" as const },
  { key: "scheduleName", label: "Pay schedule", type: "text" as const },
  {
    key: "runType", label: "Run type", type: "enum" as const,
    options: [
      { value: "regular", label: "Regular" },
      { value: "bonus", label: "Off-cycle bonus" },
      { value: "termination", label: "Termination" },
    ],
  },
  {
    key: "runStatus", label: "Calculation status", type: "enum" as const,
    options: [
      { value: "draft", label: "Draft" },
      { value: "calculated", label: "Calculated" },
      { value: "committed", label: "Committed" },
    ],
  },
  { key: "grossTotal", label: "Gross pay", type: "number" as const },
  { key: "netTotal", label: "Net pay", type: "number" as const },
  { key: "employerCostTotal", label: "Employer cost", type: "number" as const },
  { key: "employeeCount", label: "Employees paid", type: "number" as const },
  { key: "evidenceAttached", label: "Evidence package attached", type: "bool" as const },
];

export const payRunSubjectProfile: FlowSubjectProfile = {
  ...documentSubjectProfile(PAY_RUN_SUBJECT_KIND),
  label: "Pay run",
  fields: [...DOCUMENT_FIELDS, ...PAY_RUN_FIELDS],
};

const documentsAdapter = createDocumentsFlowAdapter(PAY_RUN_SUBJECT_KIND);

export const payRunsFlowAdapter: FlowSubjectAdapter = {
  ...documentsAdapter,
  profile: payRunSubjectProfile,

  async loadContext(subjectId: string): Promise<FlowSubjectContext | null> {
    const base = await documentsAdapter.loadContext(subjectId);
    if (!base) return null;
    const run = (await db.execute<Record<string, unknown>>(sql`
      select r.period_start::text as period_start, r.period_end::text as period_end,
             r.pay_date::text as pay_date, r.run_status, r.run_type,
             r.gross_total, r.net_total, r.employer_cost_total, r.employee_count,
             s.name as schedule_name,
             exists (select 1 from file_attachments fa
                      where fa.org_id = r.org_id and fa.target_table = 'documents'
                        and fa.target_id = r.document_id) as evidence_attached
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
        left join pay_schedules s on s.id = r.pay_schedule_id and s.org_id = r.org_id
       where r.document_id = ${subjectId} and r.org_id = d.org_id
    `));
    const row = run.rows[0];
    if (!row) return base;
    return {
      ...base,
      values: {
        ...base.values,
        periodStart: row.period_start,
        periodEnd: row.period_end,
        payDate: row.pay_date,
        runStatus: row.run_status,
        runType: row.run_type,
        scheduleName: row.schedule_name,
        grossTotal: row.gross_total,
        netTotal: row.net_total,
        employerCostTotal: row.employer_cost_total,
        employeeCount: row.employee_count,
        evidenceAttached: row.evidence_attached === true,
      },
    };
  },

  label(subjectId: string, values: Record<string, unknown>): string {
    const number = values.documentNumber ? ` ${String(values.documentNumber)}` : "";
    const payDate = values.payDate ? ` — ${String(values.payDate)}` : "";
    return `Pay run${number}${payDate}` || subjectId;
  },

  deepLink(subjectId: string): string {
    return `/payroll/runs/${subjectId}`;
  },
};
