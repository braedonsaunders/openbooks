import type { ReportEntity } from "./entities";

const shared = {
  category: "general_ledger" as const,
  featureKey: "contractCosts",
  requiredPermission: "contract_costs.read",
  currencyColumn: "currency",
};

export const CONTRACT_COST_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "contract_cost_rollforward",
    label: "Contract cost roll-forward",
    description:
      "Capitalized contract costs per asset: capitalized, amortized to date, impaired to date, and closing carrying amount.",
    from: `contract_cost_assets a
      left join revenue_contracts c on c.org_id = a.org_id and c.id = a.revenue_contract_id
      left join parties customer on customer.id = a.customer_party_id
      left join parties rep on rep.id = a.rep_party_id
      left join currencies cur on cur.code = a.currency
      left join lateral (
        select coalesce(sum(amount_minor), 0)::numeric as amortized
          from contract_cost_amortization m
         where m.org_id = a.org_id and m.asset_id = a.id
      ) m on true
      left join lateral (
        select coalesce(sum(jl.amount), 0) as carrying
          from journal_lines jl
          join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
         where jl.org_id = a.org_id
           and jl.contributor_kind = 'contract_cost_asset'
           and jl.contributor_ref = a.id
           and je.status in ('posted', 'reversed')
      ) g on true`,
    orgColumn: "a.org_id",
    timeKey: "capitalized_on",
    columns: [
      { key: "id", label: "Asset key", kind: "uuid", expr: "a.id" },
      { key: "contract_number", label: "Contract", kind: "text", expr: "c.contract_number" },
      { key: "customer", label: "Customer", kind: "text", expr: "customer.display_name" },
      { key: "sales_rep", label: "Sales rep", kind: "text", expr: "rep.display_name" },
      { key: "cost_type", label: "Cost type", kind: "enum", expr: "a.cost_type", options: ["commission", "fulfilment"] },
      { key: "status", label: "Status", kind: "enum", expr: "a.status", options: ["active", "fully_amortized", "impaired", "expensed"] },
      { key: "capitalized_on", label: "Capitalized on", kind: "date", expr: "a.capitalized_on" },
      { key: "amort_start_on", label: "Amortize from", kind: "date", expr: "a.amort_start_on" },
      { key: "amort_end_on", label: "Amortize through", kind: "date", expr: "a.amort_end_on" },
      { key: "currency", label: "Currency", kind: "text", expr: "a.currency" },
      {
        key: "capitalized", label: "Capitalized", kind: "money",
        expr: "a.amount_minor::numeric / (10 ^ cur.minor_units)", txnCurrency: true,
      },
      {
        key: "amortized", label: "Amortized", kind: "money",
        expr: "m.amortized / (10 ^ cur.minor_units)", txnCurrency: true,
      },
      {
        key: "impaired", label: "Impaired", kind: "money",
        expr: `case when a.status = 'expensed' then 0 else (a.amount_minor::numeric - m.amortized) / (10 ^ cur.minor_units) - g.carrying end`,
        txnCurrency: true,
      },
      {
        key: "closing", label: "Closing balance", kind: "money",
        expr: "g.carrying", txnCurrency: true,
      },
    ],
  },
  {
    ...shared,
    key: "contract_cost_postings",
    label: "Contract cost postings",
    description:
      "Every capitalization, amortization and impairment line by period, from the tagged asset legs of the general ledger.",
    from: `journal_lines jl
      join journal_entries je on je.org_id = jl.org_id and je.id = jl.entry_id
        and je.status in ('posted','reversed')
      join accounting_periods p on p.org_id = jl.org_id and p.id = je.period_id
      join accounts acct on acct.org_id = jl.org_id and acct.id = jl.account_id
      left join contract_cost_assets a on a.org_id = jl.org_id and a.id = jl.contributor_ref
      left join revenue_contracts c on c.org_id = a.org_id and c.id = a.revenue_contract_id`,
    orgColumn: "jl.org_id",
    subsidiaryScope: { column: "jl.subsidiary_id" },
    bookScope: { column: "je.book_id" },
    timeKey: "posting_date",
    columns: [
      { key: "id", label: "Line key", kind: "uuid", expr: "jl.id" },
      { key: "period", label: "Period", kind: "text", expr: "p.name" },
      { key: "posting_date", label: "Posting date", kind: "date", expr: "je.posting_date" },
      {
        key: "event", label: "Event", kind: "enum", expr: "je.origin",
        options: ["contract_cost_capitalize", "contract_cost_amortization", "contract_cost_impairment"],
      },
      { key: "account", label: "Account", kind: "text", expr: "acct.code" },
      { key: "contract_number", label: "Contract", kind: "text", expr: "c.contract_number" },
      { key: "currency", label: "Currency", kind: "text", expr: "jl.currency" },
      { key: "amount", label: "Amount", kind: "money", expr: "jl.amount", txnCurrency: true },
      { key: "entry_id", label: "Journal entry", kind: "uuid", expr: "jl.entry_id" },
      { key: "asset_id", label: "Asset key", kind: "uuid", expr: "a.id" },
    ],
  },
];
