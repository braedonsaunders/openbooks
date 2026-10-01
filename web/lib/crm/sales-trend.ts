import type { ReportCustomQuery, ReportRunResult } from "@openbooks/reports";
import type { SalesRepTrend } from "@openbooks/engine/crm/sales/contracts";
import { canonicalDecimal } from "@openbooks/engine/money/decimal";

/** Calendar months follow the organization's business day, including the current month. */
export function salesTrendMonths(today: string): string[] {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7)) - 1;
  return Array.from({ length: 12 }, (_, i) => {
    const date = new Date(0);
    date.setUTCFullYear(year, month - 11 + i, 1);
    return date.toISOString().slice(0, 10);
  });
}

export function salesTrendQuery(
  employeeId: string,
  today: string,
): ReportCustomQuery {
  return {
    entity: "sales_evidence",
    mode: "summarize",
    columns: [],
    breakouts: [
      { column: "effective_date", bin: "month" },
      { column: "currency" },
      { column: "metric" },
    ],
    measures: [{ fn: "sum", column: "amount" }],
    filters: {
      combinator: "and",
      rules: [
        { field: "employee_id", op: "eq", value: employeeId },
        {
          field: "effective_date",
          op: "gte",
          value: salesTrendMonths(today)[0]!,
        },
        { field: "effective_date", op: "lte", value: today },
      ],
    },
    limit: Number.MAX_SAFE_INTEGER,
  };
}

/** Use native drill scopes rather than parsing localized report month labels. */
export function salesTrendFromReport(
  today: string,
  report: ReportRunResult,
): SalesRepTrend {
  const months = salesTrendMonths(today);
  const points: SalesRepTrend["points"] = [];
  for (const group of report.groups) {
    for (const [index, row] of group.rows.entries()) {
      const scopes = group.rowKeys?.[index];
      const date = scopes?.find((scope) => scope.field === "effective_date");
      const currency = scopes?.find((scope) => scope.field === "currency");
      const metric = scopes?.find((scope) => scope.field === "metric");
      const amount =
        typeof row[3] === "string" ? canonicalDecimal(row[3], 4) : null;
      if (
        !date ||
        !("from" in date) ||
        !months.includes(date.from) ||
        !currency ||
        !("value" in currency) ||
        !/^[A-Z]{3}$/.test(currency.value) ||
        !metric ||
        !("value" in metric) ||
        (metric.value !== "closed_won" && metric.value !== "net_invoiced") ||
        amount === null
      ) {
        throw new Error(
          "Sales trend evidence is incomplete. Open the sales evidence report to review its source records.",
        );
      }
      points.push({
        month: date.from,
        currency: currency.value,
        metric: metric.value,
        amount,
      });
    }
  }
  return { months, points };
}
