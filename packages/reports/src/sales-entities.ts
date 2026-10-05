import type { ReportEntity } from "./entities";
const shared = {
  category: "crm" as const,
  featureKey: "salesManagement",
  requiredPermission: "crm.forecasts.read",
  currencyColumn: "currency",
};
const promotionShared = {
  category: "orders" as const,
  featureKey: "promotions",
  requiredPermission: "reports.read",
  currencyColumn: "currency",
};
const cashShared = {
  category: "orders" as const,
  featureKey: "cashSales",
  requiredPermission: "sales.cash.read",
  currencyColumn: "currency",
};
const channelShared = {
  category: "orders" as const,
  featureKey: "salesChannels",
  requiredPermission: "channels.read",
  currencyColumn: "currency",
};
export const SALES_REPORT_ENTITIES: ReportEntity[] = [
  {
    ...shared,
    key: "sales_evidence",
    label: "Sales evidence",
    description:
      "Immutable attributed sales credits and reversals, including historical attribution gaps.",
    from: "crm_sales_evidence e left join parties p on p.org_id=e.org_id and p.id=e.employee_id left join crm_sales_teams t on t.org_id=e.org_id and t.id=e.sales_team_id",
    orgColumn: "e.org_id",
    subsidiaryScope: { column: "e.subsidiary_id" },
    timeKey: "effective_date",
    columns: [
      { key: "id", label: "Evidence key", kind: "uuid", expr: "e.id" },
      {
        key: "source_id",
        label: "Source record",
        kind: "uuid",
        expr: "e.source_id",
      },
      {
        key: "source_kind",
        label: "Source kind",
        kind: "enum",
        expr: "e.source_kind",
        options: ["opportunity", "document"],
      },
      {
        key: "source_number",
        label: "Source number",
        kind: "text",
        expr: "e.source_number",
      },
      {
        key: "employee",
        label: "Employee",
        kind: "text",
        expr: "coalesce(p.display_name,'Unattributed')",
      },
      {
        key: "employee_id",
        label: "Employee key",
        kind: "uuid",
        expr: "e.employee_id",
      },
      { key: "team", label: "Team", kind: "text", expr: "t.name" },
      {
        key: "effective_date",
        label: "Effective date",
        kind: "date",
        expr: "e.effective_date",
      },
      {
        key: "metric",
        label: "Measure",
        kind: "enum",
        expr: "e.metric",
        options: ["closed_won", "net_invoiced"],
      },
      {
        key: "event_kind",
        label: "Event",
        kind: "enum",
        expr: "e.event_kind",
        options: ["credit", "reversal"],
      },
      { key: "currency", label: "Currency", kind: "text", expr: "e.currency" },
      {
        key: "amount",
        label: "Amount",
        kind: "money",
        expr: "e.amount",
        txnCurrency: true,
      },
    ],
  },
  {
    ...shared,
    key: "sales_quota_attainment",
    label: "Sales quota attainment",
    description:
      "Quota version, lifecycle, employee or team target, and actuals from immutable sales evidence in the target currency.",
    from: `crm_sales_quotas q left join parties p on p.org_id=q.org_id and p.id=q.employee_id left join crm_sales_teams t on t.org_id=q.org_id and t.id=q.sales_team_id left join lateral (select sum(e.amount) as actual from crm_sales_evidence e where e.org_id=q.org_id and e.subsidiary_id is not distinct from q.subsidiary_id and e.currency=q.currency and e.metric=q.metric and e.effective_date between q.period_start and q.period_end and ((q.employee_id is not null and e.employee_id=q.employee_id) or (q.sales_team_id is not null and e.sales_team_id=q.sales_team_id))) a on true`,
    orgColumn: "q.org_id",
    subsidiaryScope: { column: "q.subsidiary_id" },
    timeKey: "period_start",
    columns: [
      { key: "id", label: "Quota key", kind: "uuid", expr: "q.id" },
      { key: "name", label: "Quota", kind: "text", expr: "q.name" },
      {
        key: "target",
        label: "Target",
        kind: "text",
        expr: "coalesce(p.display_name,t.name)",
      },
      {
        key: "employee_id",
        label: "Employee key",
        kind: "uuid",
        expr: "q.employee_id",
      },
      {
        key: "sales_team_id",
        label: "Team key",
        kind: "uuid",
        expr: "q.sales_team_id",
      },
      {
        key: "parent_quota_id",
        label: "Parent quota",
        kind: "uuid",
        expr: "q.parent_quota_id",
      },
      {
        key: "supersedes_id",
        label: "Replaces quota",
        kind: "uuid",
        expr: "q.supersedes_id",
      },
      {
        key: "period_start",
        label: "Period start",
        kind: "date",
        expr: "q.period_start",
      },
      {
        key: "period_end",
        label: "Period end",
        kind: "date",
        expr: "q.period_end",
      },
      {
        key: "lifecycle",
        label: "Lifecycle",
        kind: "enum",
        expr: "q.lifecycle",
        options: [
          "draft",
          "pending_approval",
          "approved",
          "superseded",
          "closed",
        ],
      },
      {
        key: "metric",
        label: "Measure",
        kind: "enum",
        expr: "q.metric",
        options: ["closed_won", "net_invoiced"],
      },
      { key: "currency", label: "Currency", kind: "text", expr: "q.currency" },
      {
        key: "amount",
        label: "Target amount",
        kind: "money",
        expr: "q.amount",
        txnCurrency: true,
      },
      {
        key: "actual",
        label: "Actual",
        kind: "money",
        expr: "coalesce(a.actual,0)",
        txnCurrency: true,
      },
      {
        key: "attainment",
        label: "Attainment percent",
        kind: "number",
        expr: "case when q.amount=0 then null else coalesce(a.actual,0)*100/q.amount end",
      },
    ],
  },
  {
    ...promotionShared,
    key: "promotion_performance",
    label: "Promotion performance",
    description:
      "Discount lines carried by promotions, with the discount given and the gross and net revenue attached, by period and promotion.",
    // One row per promotion discount line. The lateral attachment prices the
    // parent document once: gross is the positively priced non-promotion
    // lines, net is gross plus every discount on the document.
    from: `document_lines dl join documents d on d.org_id=dl.org_id and d.id=dl.document_id join promotions p on p.org_id=dl.org_id and p.id=dl.promotion_id left join parties c on c.org_id=d.org_id and c.id=d.party_id left join lateral (select coalesce(sum(case when sib.promotion_id is null and sib.amount > 0 then sib.amount else 0 end),0) as gross, coalesce(sum(case when sib.promotion_id is not null then sib.amount else 0 end),0) as discounts from document_lines sib where sib.org_id=dl.org_id and sib.document_id=dl.document_id) doc on true`,
    orgColumn: "dl.org_id",
    subsidiaryScope: { column: "d.subsidiary_id" },
    timeKey: "document_date",
    defaultSort: { column: "document_date", direction: "desc" },
    columns: [
      { key: "promotion_code", label: "Promotion code", kind: "text", expr: "p.code" },
      { key: "promotion_name", label: "Promotion", kind: "text", expr: "p.name" },
      { key: "promotion_kind", label: "Promotion kind", kind: "enum", expr: "p.kind", options: ["percent", "amount", "free_shipping", "buy_x_get_y"] },
      { key: "document_date", label: "Document date", kind: "date", expr: "d.document_date" },
      { key: "document_number", label: "Document", kind: "text", expr: "d.document_number" },
      {
        key: "document_kind",
        label: "Document kind",
        kind: "enum",
        expr: "d.kind",
        options: ["quote", "sales_order", "customer_invoice"],
      },
      { key: "customer", label: "Customer", kind: "text", expr: "coalesce(c.display_name,'Unattributed')" },
      { key: "currency", label: "Currency", kind: "text", expr: "d.currency" },
      {
        key: "discount_given",
        label: "Discount given",
        kind: "money",
        expr: "-dl.amount",
        txnCurrency: true,
      },
      {
        key: "attached_gross",
        label: "Attached gross",
        kind: "money",
        expr: "doc.gross",
        txnCurrency: true,
      },
      {
        key: "attached_net",
        label: "Attached net",
        kind: "money",
        expr: "doc.gross+doc.discounts",
        txnCurrency: true,
      },
    ],
  },
  {
    ...cashShared,
    key: "cash_tenders",
    label: "Cash tenders",
    description:
      "How paid-at-sale totals settled — one row per tender with its method, settlement account or stored-value card, and amount — by period, method, and account.",
    // One row per tender. Amounts leave in document currency through the
    // currency's own minor units; every join stays inside the base
    // organization so a restricted subsidiary scope cannot leak rows.
    from: `document_tenders t join documents d on d.org_id=t.org_id and d.id=t.document_id left join parties c on c.org_id=t.org_id and c.id=d.party_id left join accounts a on a.org_id=t.org_id and a.id=t.account_id left join stored_value_accounts sva on sva.org_id=t.org_id and sva.id=t.stored_value_account_id left join currencies cur on cur.code=t.currency`,
    orgColumn: "t.org_id",
    subsidiaryScope: { column: "d.subsidiary_id" },
    timeKey: "document_date",
    defaultSort: { column: "document_date", direction: "desc" },
    columns: [
      { key: "document_date", label: "Document date", kind: "date", expr: "d.document_date" },
      { key: "document_number", label: "Document", kind: "text", expr: "d.document_number" },
      {
        key: "document_kind",
        label: "Document kind",
        kind: "enum",
        expr: "d.kind",
        options: ["cash_sale", "cash_refund"],
      },
      {
        key: "document_status",
        label: "Document status",
        kind: "enum",
        expr: "d.status",
        options: ["draft", "pending_approval", "approved", "posted", "voided"],
      },
      { key: "customer", label: "Customer", kind: "text", expr: "coalesce(c.display_name,'Walk-in')" },
      {
        key: "method",
        label: "Method",
        kind: "enum",
        expr: "t.kind",
        options: ["cash", "card", "bank_transfer", "wallet", "gateway", "stored_value", "other"],
      },
      { key: "method_label", label: "Method label", kind: "text", expr: "t.method_label" },
      { key: "account", label: "Account", kind: "text", expr: "a.name" },
      { key: "account_number", label: "Account number", kind: "text", expr: "a.number" },
      { key: "stored_value_last4", label: "Card …", kind: "text", expr: "sva.code_last4" },
      { key: "currency", label: "Currency", kind: "text", expr: "t.currency" },
      {
        key: "amount",
        label: "Amount",
        kind: "money",
        expr: "t.amount_minor::numeric / (10 ^ cur.minor_units)",
        txnCurrency: true,
      },
      { key: "reference", label: "Reference", kind: "text", expr: "t.reference" },
      { key: "external_ref", label: "Provider ref", kind: "text", expr: "t.external_ref" },
    ],
  },
  {
    ...channelShared,
    key: "channel_sales",
    label: "Channel sales",
    description:
      "Storefront orders by channel, day, item, location and tender — one row per order line with the order's posting status and document. The location is the summary's stock location for summarized orders, else the channel's single fulfilment location.",
    // One row per normalized order line. Stored minors are JSON strings, so
    // every money column scales through the shop currency's own minor units;
    // every join stays inside the base organization so a restricted
    // subsidiary scope cannot leak rows. Channel orders carry no subsidiary,
    // so this entity is org-scoped by design.
    from: `channel_orders o join sales_channels c on c.org_id=o.org_id and c.id=o.channel_id
      left join documents d on d.org_id=o.org_id and d.id=o.posting_document_id
      left join channel_daily_summaries s on s.org_id=o.org_id and s.id=o.summary_id
      left join stock_locations sl on sl.org_id=o.org_id and sl.id=s.stock_location_id
      left join locations loc on loc.org_id=o.org_id and loc.id=sl.location_id
      left join currencies cur on cur.code=o.shop_currency
      left join lateral jsonb_to_recordset(o.lines) as li(title text, sku text, quantity text, "priceMinor" text, "discountMinor" text) on true`,
    orgColumn: "o.org_id",
    defaultSort: { column: "ordered_day", direction: "desc" },
    columns: [
      { key: "channel", label: "Channel", kind: "text", expr: "c.name" },
      { key: "ordered_day", label: "Ordered day", kind: "date", expr: "o.ordered_at::date" },
      { key: "order_number", label: "Order", kind: "text", expr: "o.external_number" },
      { key: "customer", label: "Customer", kind: "text", expr: "coalesce(nullif(o.customer_email, ''), o.customer_name, '')" },
      { key: "currency", label: "Currency", kind: "text", expr: "o.shop_currency" },
      { key: "item", label: "Item", kind: "text", expr: "li.title" },
      { key: "sku", label: "Item code", kind: "text", expr: "li.sku" },
      { key: "quantity", label: "Quantity", kind: "number", expr: "li.quantity::numeric" },
      {
        key: "unit_price",
        label: "Unit price",
        kind: "money",
        expr: `li."priceMinor"::numeric / (10 ^ cur.minor_units)`,
        txnCurrency: true,
      },
      {
        key: "discount",
        label: "Discount",
        kind: "money",
        expr: `coalesce(li."discountMinor"::numeric, 0) / (10 ^ cur.minor_units)`,
        txnCurrency: true,
      },
      {
        key: "line_total",
        label: "Line total",
        kind: "money",
        expr: `(li."priceMinor"::numeric * li.quantity::numeric - coalesce(li."discountMinor"::numeric, 0)) / (10 ^ cur.minor_units)`,
        txnCurrency: true,
      },
      {
        key: "tenders",
        label: "Tenders",
        kind: "text",
        expr: `(select string_agg(distinct t->>'gateway', ', ') from jsonb_array_elements(o.tenders) as t)`,
      },
      {
        key: "location",
        label: "Location",
        kind: "text",
        expr: `coalesce(loc.name, (select l3.name from sales_channel_locations m join stock_locations l2 on l2.org_id=m.org_id and l2.id=m.stock_location_id join locations l3 on l3.org_id=m.org_id and l3.id=l2.location_id where m.org_id=o.org_id and m.channel_id=o.channel_id and m.fulfils_orders and m.stock_location_id is not null group by l3.name having count(*) = 1))`,
      },
      {
        key: "posting_status",
        label: "Posting status",
        kind: "enum",
        expr: "o.posting_status",
        options: ["pending", "posted", "summarized", "exception", "excluded"],
      },
      { key: "document_number", label: "Document", kind: "text", expr: "d.document_number" },
    ],
  },
  {
    ...channelShared,
    key: "order_economics",
    label: "Order economics",
    description:
      "Stored contribution-margin facts per channel order line — net revenue, discounts, actual issue cost, processor and marketplace fees, carrier labels, returns with restocking income, and allocated ad spend — with margin as formula measures, never stored ratios.",
    // One row per current margin fact. Only current facts read: restated
    // history stays in the table for audit, out of the sums. Every join
    // stays inside the base organization so a restricted subsidiary scope
    // cannot leak rows. Channel orders carry no subsidiary, so this entity
    // is org-scoped by design, like channel sales.
    from: `channel_order_economics f join channel_orders o on o.org_id=f.org_id and o.id=f.order_id and f.is_current
      join sales_channels c on c.org_id=f.org_id and c.id=f.channel_id
      join currencies cur on cur.code=f.currency`,
    orgColumn: "f.org_id",
    timeKey: "ordered_day",
    defaultSort: { column: "ordered_day", direction: "desc" },
    columns: [
      { key: "channel", label: "Channel", kind: "text", expr: "c.name" },
      { key: "ordered_day", label: "Ordered day", kind: "date", expr: "o.ordered_at::date" },
      { key: "order_number", label: "Order", kind: "text", expr: "o.external_number" },
      {
        key: "customer",
        label: "Customer",
        kind: "text",
        expr: "coalesce(nullif(o.customer_email, ''), o.customer_name, '')",
      },
      {
        key: "customer_cohort",
        label: "Customer cohort",
        kind: "enum",
        expr: `case
          when coalesce(o.customer_party_id::text, nullif(lower(o.customer_email), '')) is null then 'unidentified'
          when exists (select 1 from channel_orders o2
            where o2.org_id=o.org_id and o2.channel_id=o.channel_id and o2.ordered_at < o.ordered_at
              and coalesce(o2.customer_party_id::text, nullif(lower(o2.customer_email), '')) = coalesce(o.customer_party_id::text, nullif(lower(o.customer_email), ''))) then 'returning'
          else 'new' end`,
        options: ["new", "returning", "unidentified"],
      },
      {
        key: "region",
        label: "Region",
        kind: "text",
        expr: `coalesce(o.customer_address->>'province', o.customer_address->>'province_code', o.customer_address->>'region', o.customer_address->>'state', o.customer_address->>'city', '')`,
      },
      {
        key: "country",
        label: "Country",
        kind: "text",
        expr: `coalesce(o.customer_address->>'country', o.customer_address->>'country_code', '')`,
      },
      { key: "sku", label: "Item code", kind: "text", expr: "coalesce(f.sku, '')" },
      {
        key: "promotion",
        label: "Promotion",
        kind: "text",
        expr: "coalesce(nullif(f.promotion_code, ''), '(none)')",
      },
      { key: "line", label: "Order line", kind: "text", expr: "f.line_key" },
      {
        key: "component",
        label: "Cost component",
        kind: "enum",
        expr: "f.component",
        options: ["net_revenue", "discount", "cogs", "processor_fee", "shipping_label", "marketplace_fee", "stored_value_funding", "returns", "restocking_fee", "ad_spend"],
      },
      {
        key: "source",
        label: "Cost source",
        kind: "enum",
        expr: "f.source_kind",
        options: ["posting", "fulfilment", "label", "payout", "refund", "estimate", "import", "manual"],
      },
      {
        key: "costing",
        label: "Costing",
        kind: "enum",
        expr: "case when f.estimated then 'estimated' else 'settled' end",
        options: ["settled", "estimated"],
      },
      { key: "currency", label: "Currency", kind: "text", expr: "f.currency" },
      {
        key: "amount",
        label: "Amount",
        kind: "money",
        expr: "f.amount_minor::numeric / (10 ^ cur.minor_units)",
        txnCurrency: true,
      },
    ],
  },
];
