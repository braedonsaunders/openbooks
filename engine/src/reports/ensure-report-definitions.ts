import { sql } from "drizzle-orm";
import {
  BUILT_IN_REPORT_DEFINITIONS,
  STANDARD_STATEMENT_DEFINITIONS,
  validateCustomQuery,
} from "@openbooks/reports";
import type { ReportCustomQuery } from "@openbooks/reports";
import { orgFeatureEnabled } from "../organization/org-feature-lock.ts";
import { db, withOrgTransaction } from "../platform/db.ts";

type CatalogReport = {
  slug: string;
  name: string;
  description: string;
  query: ReportCustomQuery;
};

const NONPROFIT_REPORTS: readonly CatalogReport[] = [
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
        { column: "fund_code" }, { column: "fund_name" }, { column: "restriction_class" }, { column: "base_currency" },
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
        { column: "origin" }, { column: "fund_code" }, { column: "restriction_class" }, { column: "base_currency" },
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

/**
 * Idempotently materialise the built-in + standard-statement report catalog as
 * `report_definitions` rows for one org. Keyed on `(org_id, slug)`; refreshes
 * name/description/spec while preserving row ids (and any schedules/runs FK'd to
 * them).
 *
 * ONLY rows this catalog still owns are refreshed. A slug collision is not
 * proof of ownership, and an unguarded upsert destroyed two kinds of real work:
 *
 *   - the PATCH API deliberately lets an org tune a seeded plan IN PLACE
 *     ("an org may tune a seeded plan") and leaves `kind = 'built_in'`, so the
 *     refresh silently reverted that edit with no audit row;
 *   - `uniqueReportSlug` only avoids collisions that exist AT CREATION TIME, so
 *     a catalog entry added later can land on an existing custom report's slug
 *     and overwrite a user-authored plan outright.
 *
 * Hence both guards. `kind = 'built_in'` keeps custom reports out; `updated_by
 * is null` keeps org-tuned ones out — this catalog is the only writer that
 * leaves `updated_by` NULL, so a non-null value means a person edited the row
 * and their edit outranks the seed. A definition that fails either guard is
 * left alone rather than captured: the catalog row simply does not materialise
 * under that slug, which is visible and recoverable, unlike silently
 * destroying the org's own work.
 *
 * The manual `seed-reports.ts` script seeds every org up front, but org
 * provisioning does not always run it — so slug→id resolution (e.g. the close
 * package delivery pipeline) calls this first to guarantee every catalog report
 * exists before rendering. A catalog typo fails loudly via validateCustomQuery.
 */
export async function ensureReportDefinitions(orgId: string): Promise<void> {
  for (const def of BUILT_IN_REPORT_DEFINITIONS) {
    const query = validateCustomQuery(def.query);
    await db.execute(sql`
      insert into report_definitions (org_id, kind, slug, name, description, query)
      values (${orgId}, 'built_in', ${def.slug}, ${def.name}, ${def.description}, ${JSON.stringify(query)}::jsonb)
      on conflict (org_id, slug) do update set
        name = excluded.name,
        description = excluded.description,
        query = excluded.query,
        updated_at = now()
      where report_definitions.kind = 'built_in' and report_definitions.updated_by is null
        and report_definitions.org_id = ${orgId}`);
  }
  for (const def of NONPROFIT_REPORTS) {
    const query = validateCustomQuery(def.query);
    await db.execute(sql`
      insert into report_definitions (org_id, kind, slug, name, description, query)
      values (${orgId}, 'built_in', ${def.slug}, ${def.name}, ${def.description}, ${JSON.stringify(query)}::jsonb)
      on conflict (org_id, slug) do update set
        name = excluded.name,
        description = excluded.description,
        query = excluded.query,
        updated_at = now()
      where report_definitions.kind = 'built_in' and report_definitions.updated_by is null
        and report_definitions.org_id = ${orgId}`);
  }
  for (const def of STANDARD_STATEMENT_DEFINITIONS) {
    const statement = { kind: def.statementKind, params: def.params ?? {} };
    await db.execute(sql`
      insert into report_definitions (org_id, kind, report_type, system, slug, name, description, query, statement)
      values (${orgId}, 'built_in', 'statement', true, ${def.slug}, ${def.name}, ${def.description}, null, ${JSON.stringify(statement)}::jsonb)
      on conflict (org_id, slug) do update set
        report_type = 'statement',
        system = true,
        name = excluded.name,
        description = excluded.description,
        query = null,
        statement = excluded.statement,
        updated_at = now()
      where report_definitions.kind = 'built_in' and report_definitions.updated_by is null
        and report_definitions.org_id = ${orgId}`);
  }
  const boardPackageFeatures = ["nonprofit", "fundAccounting", "functionalExpenses", "grantManagement"] as const;
  let boardPackageAvailable = true;
  for (const featureKey of boardPackageFeatures) {
    if (!(await orgFeatureEnabled(orgId, featureKey, db))) boardPackageAvailable = false;
  }
  if (boardPackageAvailable) {
    await withOrgTransaction(orgId, async () => {
      await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`nonprofit-board-package:${orgId}`}, 0))`);
      await db.execute(sql`
        insert into close_reporting_packages (org_id, name, description, reports, is_default, is_active)
        select ${orgId}, 'Nonprofit board package',
               'Board reporting across financial position, activities, functional expenses, cash flows, and grants.',
               ${JSON.stringify([
                 { slug: "statement-of-financial-position" },
                 { slug: "statement-of-activities" },
                 { slug: "functional-expense-matrix" },
                 { slug: "cash-flow-reconciliation" },
                 { slug: "grant-pipeline" },
               ])}::jsonb,
               false, true
         where not exists (
           select 1 from close_reporting_packages
            where org_id = ${orgId} and name = 'Nonprofit board package'
         )
      `);
    });
  }
}
