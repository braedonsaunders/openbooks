import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { documentRevisionCounterSql } from "@openbooks/engine/records/revision";
import { subsidiaryVisibleFilter } from "@openbooks/engine/organization/scope";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  ALL_EXPENSE_REPORTS,
  expenseOwnerPredicate,
  type ExpenseAccess,
} from "@openbooks/engine/records/expense-access";

/**
 * Recall eligibility for an expense report: a pending_approval
 * or approved-but-unposted report is editable via recall — Edit cancels the
 * open gates and returns it to draft. Only the submitter (or document
 * author for legacy rows with no recorded submitter) or an org admin may
 * recall; the recall action re-checks authoritatively. A report with a void
 * in flight stays with the void flow. Shared by the reports page and the
 * related-transaction drawer.
 */
export function canRecallExpenseReport(
  doc: {
    status?: unknown;
    submitted_by?: unknown;
    created_by?: unknown;
    void_requested_at?: unknown;
  },
  user: {
    id: string;
    roles: ReadonlyArray<{ key: string }>;
    isSuperAdmin?: boolean;
  },
): boolean {
  // The author fallback is legacy-only: once a submitter is recorded, the
  // creator (possibly a different person) must not see recall affordances
  // for another user's submission.
  const isSubmitter =
    doc.submitted_by === user.id || (doc.submitted_by == null && doc.created_by === user.id);
  return (
    (doc.status === "pending_approval" || doc.status === "approved") &&
    doc.void_requested_at == null &&
    (isSubmitter || user.isSuperAdmin === true || user.roles.some(({ key }) => key === "admin"))
  );
}

/**
 * One statement gives the drawer one MVCC snapshot of its header, lines and
 * exact revision. A later token lookup could bless stale content with a
 * concurrent writer's revision and defeat optimistic concurrency. Under
 * self-service access another employee's report reads as missing.
 */
export async function loadExpenseReport(
  id: string,
  orgId: string,
  allowedSubsidiaryIds?: ReadonlySet<string> | null,
  access: ExpenseAccess = ALL_EXPENSE_REPORTS,
) {
  const scope =
    allowedSubsidiaryIds === undefined
      ? sql``
      : subsidiaryVisibleFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds);
  const result = await db.execute<Record<string, unknown> & { __lines: Record<string, unknown>[] }>(
    sql`
    select d.*, ${documentRevisionCounterSql(sql`d.revision_seq`)} as updated_at,
           p.display_name as employee_name, e.id as entry_id,
           coalesce((
             select jsonb_agg(to_jsonb(line) order by line.line_number)
               from (
                 select l.id, l.line_number, l.account_id, l.description,
                        l.amount::text as amount, l.tax_code_id, l.tax_group_id,
                        l.tax_input_amount::text as tax_input_amount,
                        l.tax_amount::text as tax_amount, l.tax_overridden,
                        l.settlement_type, l.amortization_template_id,
                        l.amortization_start_on::text as amortization_start_on, l.amortization_end_on::text as amortization_end_on,
                        l.department_id, l.project_id, l.extra_dims, l.custom,
                        l.original_currency, l.original_amount::text as original_amount,
                        l.original_tax_amount::text as original_tax_amount,
                        l.original_fx_rate::text as original_fx_rate, l.original_fx_evidence
                   from document_lines l
                  where l.document_id = d.id and l.org_id = d.org_id
               ) line
           ), '[]'::jsonb) as "__lines"
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${orgId} and d.kind = 'expense_report' ${scope}
       and ${expenseOwnerPredicate(access, sql`d.party_id`)}
  `,
    "objects",
  );
  if (!result[0]) return null;
  const { __lines: lines, ...doc } = result[0];
  return { doc, lines };
}

/** The currency new expense reports are kept in: the organization base currency, or null when unset. */
export async function expenseReportCurrency(orgId: string): Promise<string | null> {
  return (
    (
      await db.execute<{ base_currency: string | null }>(
        sql`
    select base_currency from orgs where id = ${orgId}`,
        "objects",
      )
    )[0]?.base_currency ?? null
  );
}

/**
 * The unsaved-create seed for an expense report: the same `{ doc, lines }`
 * shape as loadExpenseReport, with no row behind it. Nothing is numbered or
 * written until the drawer's first Save POSTs /api/expenses. `employeeId`
 * seeds the employee for a self-service author.
 */
export async function blankExpenseReport(orgId: string, employeeId: string | null = null) {
  const [org, today, employee] = await Promise.all([
    db.execute<{ base_currency: string }>(
      sql`select base_currency from orgs where id = ${orgId}`,
      "objects",
    ),
    businessToday(orgId),
    employeeId
      ? db.execute<{ display_name: string }>(
          sql`select display_name from parties where id = ${employeeId} and org_id = ${orgId}`,
        )
      : Promise.resolve(null),
  ]);
  const doc: Record<string, unknown> = {
    id: "",
    org_id: orgId,
    kind: "expense_report",
    status: "draft",
    document_number: null,
    subsidiary_id: null,
    // A self-service report is always its author's own; the seed names them.
    party_id: employeeId,
    payment_card_id: null,
    employee_name: employee?.rows[0]?.display_name ?? null,
    entry_id: null,
    document_date: today,
    memo: null,
    currency: org[0]?.base_currency ?? "CAD",
    subtotal: "0",
    tax_total: "0",
    total: "0",
    updated_at: "",
    custom: {},
    extra_dims: {},
  };
  return { doc, lines: [] as Record<string, unknown>[] };
}
