import { BUILT_IN_REPORT_DEFINITIONS } from "@openbooks/reports";
import type { ReportCustomQuery } from "@openbooks/reports";

type CatalogReport = {
  slug: string;
  name: string;
  description: string;
  query: ReportCustomQuery;
};

export const NONPROFIT_REPORTS: readonly CatalogReport[] = [
  {
    slug: "statement-of-financial-position",
    name: "Statement of financial position",
    description: "Posted balances by account, fund, base currency, and restriction class.",
    query: {
      entity: "fund_ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "account_number" }, { column: "account_name" }, { column: "account_type" },
        { column: "fund_code" }, { column: "restriction_class" }, { column: "base_currency" },
      ],
      measures: [{ fn: "sum", column: "amount", label: "Posted balance" }],
      filters: null,
      groupBy: null,
      limit: 10000,
    },
  },
  {
    slug: "statement-of-activities",
    name: "Statement of activities",
    description: "Posted revenue, expenses, and gross releases by restriction class.",
    query: {
      entity: "fund_ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "account_number" }, { column: "account_name" }, { column: "account_type" },
        { column: "origin" }, { column: "restriction_class" }, { column: "base_currency" },
      ],
      measures: [{ fn: "sum", column: "amount", label: "Posted activity" }],
      filters: { combinator: "and", rules: [{ field: "posting_date", op: "period_preset", value: "this_fiscal_year" }] },
      groupBy: null,
      limit: 10000,
    },
  },
  {
    slug: "functional-expense-matrix",
    name: "Functional expense matrix",
    description: "Posted expenses by natural account, function, and program.",
    query: {
      entity: "functional_ledger_lines",
      mode: "summarize",
      columns: [],
      breakouts: [
        { column: "account_number" }, { column: "account_name" }, { column: "functional_category" },
        { column: "program_key" }, { column: "mapping_status" }, { column: "base_currency" },
      ],
      measures: [{ fn: "sum", column: "amount", label: "Posted expense" }],
      filters: {
        combinator: "and",
        rules: [
          { field: "posting_date", op: "period_preset", value: "this_fiscal_year" },
          {
            combinator: "or",
            rules: [
              { field: "account_type", op: "contains", value: "expense" },
              { field: "account_type", op: "eq", value: "cogs" },
              { field: "account_type", op: "contains", value: "cost_of_goods" },
            ],
          },
        ],
      },
      groupBy: null,
      limit: 10000,
    },
  },
  {
    slug: "cash-flow-reconciliation",
    name: "Cash flow reconciliation",
    description: "Posted ledger movements with cash and net asset reconciliation detail.",
    query: {
      entity: "fund_ledger_lines",
      mode: "rows",
      columns: ["posting_date", "entry_number", "origin", "account_number", "account_name", "account_type", "fund_code", "restriction_class", "base_currency", "amount"],
      filters: { combinator: "and", rules: [{ field: "posting_date", op: "period_preset", value: "this_fiscal_year" }] },
      groupBy: null,
      limit: 10000,
    },
  },
  {
    slug: "grant-pipeline",
    name: "Grant pipeline",
    description: "Grant awards, sponsors, periods, status, and associated fund classification.",
    query: {
      entity: "grant_pipeline",
      mode: "rows",
      columns: ["grant_code", "grant_name", "sponsor_name", "sponsor_kind", "determination", "award_amount", "period_from", "period_to", "status", "fund_code", "fund_name", "restriction_class", "base_currency"],
      filters: null,
      groupBy: null,
      limit: 10000,
    },
  },
];

export const SEEDED_CATALOG_REPORTS: readonly CatalogReport[] = [
  ...BUILT_IN_REPORT_DEFINITIONS,
  ...NONPROFIT_REPORTS,
];
