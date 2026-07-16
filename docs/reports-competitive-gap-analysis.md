# OpenBooks Reports — Competitive Gap Analysis & Build-Out Plan

_Date: 2026-07-15_

Benchmarks the OpenBooks standard-report catalog against **NetSuite**, **ERPNext**, **Odoo
(Accounting)**, and **Bigcapital**, then lays out a prioritized plan to close the gaps. Every
external catalog was inventoried from primary sources (source code for ERPNext/Bigcapital/Odoo
community; Oracle documentation for NetSuite standard reports). The live NetSuite account
(`adminapp2 @ Rassaun Services Inc`) was reached via SuiteCloud CLI to confirm access — but note
that NetSuite **standard** reports are built-in application features, not SDF objects, so the
catalog is documentation-derived, not `object:list`-derived.

---

## 1. Executive summary

**The finding in one sentence:** OpenBooks already has a *fuller ERP data model than most of its
competitors' report catalogs assume* — full inventory costing, bank reconciliation, ASC-606 revenue
recognition, fixed-asset depreciation, a tax-return engine, time tracking, and multi-book — but its
**reports are ~90% general-ledger-centric**. The entire subledger reporting surface (sales,
purchases, inventory, tax, assets, revenue) is unbuilt *despite the data existing*. The gap is a
reporting-layer gap, not a data gap — which makes it unusually cheap to close.

**Scoreboard (standard reports that ship):**

| System | Standard reports | Notes |
|---|---:|---|
| NetSuite | ~150+ (many with Summary/Detail variants) | Broadest; much is feature/SuiteApp-gated |
| ERPNext | 138 | 52 accounting, 23 selling, 10 buying, 50 stock, 3 assets |
| Odoo (Enterprise) | ~30 marquee financial reports | All the good ones are Enterprise-only; community ships almost none |
| Bigcapital | 18 | Clean, focused GL + AR/AP + basic inventory/tax |
| **OpenBooks** | **~15 native + a custom studio** | Deep on GL/statements, drill-through, fiscal periods; thin everywhere else |

**Where OpenBooks already wins** (do not rebuild — build *on* these):
- **Fiscal-aware period engine** (~50 presets) — better than Bigcapital and community Odoo.
- **Matrix engine** with breakouts (dept/project/location/class/month/quarter), prior-period /
  prior-year **compare + variance**, and **cash/accrual basis** toggle — this is NetSuite
  "multi-column / comparative" parity already latent in the engine.
- **Drill-through** on every statement value down to journal lines with a rich entry flyout.
- **Custom report studio** + seeded built-in `ReportCustomQuery` definitions — a delivery channel
  that lets us ship many "summary" reports as *data, not code*.
- **PDF (two GAAP-styled themes) / XLSX / CSV / Print** already wired for every statement.

**The one cross-cutting blocker:** report **scheduling & email delivery is a stub** (schema + UI
exist, nothing delivers; no email infrastructure in the repo). Every competitor emails scheduled
reports. This is Tier-0.

---

## 2. OpenBooks current inventory (baseline)

**Native report pages** (`web/app/(app)/reports/`):

| Report | Area | Engine |
|---|---|---|
| Profit & Loss | Financial statement | matrix |
| Balance Sheet | Financial statement | matrix |
| Cash Flow | Financial statement | matrix |
| Trial Balance | Financial statement | matrix |
| General Ledger | Ledger | flat-table |
| Journal | Ledger | flat-table |
| A/R Aging (Summary + Detail toggle) | Receivables | bespoke |
| A/P Aging (Summary + Detail toggle) | Payables | bespoke |
| A/R Register | Receivables | flat-table |
| A/P Register | Payables | flat-table |
| Receivables (partner balances snapshot) | Receivables | bespoke |
| Payables (partner balances snapshot) | Payables | bespoke |
| Partner Statement | Receivables/Payables | bespoke |
| Budget vs Actual | Budgeting | matrix (budget) |
| Transaction Detail (drill target) | Ledger | flat-table |

**Seeded studio built-ins** (`packages/reports/src/built-ins.ts`): AP aging by vendor · Open AR by
customer · GL activity by account (FY) · Expense detail by department (FY).

**Plus:** a custom report **Studio** (entity-based query builder over `ledger_lines`,
`transactions`, `transaction_lines`), saved views, and fiscal-bin grouping.

**Cross-cutting capabilities:** period presets · dimension breakouts · compare/variance ·
cash vs accrual · drill-through · PDF/XLSX/CSV/Print · save views. **Scheduling = stub.**

---

## 3. What the data model already supports (feasibility)

The reason this plan is cheap: the schema (`schema/src/`) already carries every subledger the
missing reports need. Feasibility is essentially "green" across the board.

| Domain | Tables already present | Reports it unlocks |
|---|---|---|
| Sales / Purchases | `documents`, `document_lines`, `items`, `parties` (customer/vendor/employee roles) | Sales/Purchase by customer/vendor/item/rep, registers, open orders |
| Inventory | `inventory_movements`, `cost_layers`, `cost_layer_consumptions`, `lots`, `serials`, `stock_counts`, `landed_cost_allocations`, `bom_components` | Valuation (summary/detail), activity/stock ledger, turnover, aging, count worksheet |
| Tax | `tax_codes`, `tax_groups`, `tax_group_members`, `tax_report_lines`, `documents.tax_total` | Sales tax liability, tax return (VAT/GST), sales/purchase by tax code |
| Fixed assets | `fixed_assets`, `asset_categories`, `depreciation_schedules`, `depreciation_schedule_lines`, `asset_events` | Asset register, depreciation schedule, additions/disposals |
| Revenue recognition | `revenue_contracts`, `recognition_rules`, `performance_obligations`, `recognition_schedules[_lines]` | Deferred revenue waterfall, rollforward, rev-rec forecast |
| Banking | `bank_statements`, `bank_statement_lines`, `reconciliations`, `reconciliation_matches`, `payment_runs` | Reconciliation summary/detail/history, deposit detail, payment register |
| Multi-currency | `currencies`, `fx_rates`, `journal_lines.txn_amount` vs base `amount` | Realized / unrealized FX gain-loss, CTA |
| Multi-book / intercompany | `accounting_books`, `intercompany_pairs` | Multi-book income statement, intercompany elimination, consolidated |
| Time / projects | `time_entries`, `project_tasks`, `labor_burden_rates` | Time & billing, unbilled time, project profitability |
| Budgets / allocations | `budget_scenarios`, `budget_lines`, `allocation_rules` | Budget income statement, project budget vs actual, allocation runs |

**Conclusion:** there is no report in the competitive set (short of CRM-pipeline/opportunity
analytics, which OpenBooks doesn't model) that OpenBooks *can't* build from data it already stores.

---

## 4. Gap matrix by functional area

Legend: ✅ shipped · 🟡 partial / studio-only · ❌ missing · —  not applicable to product scope.
"Feasible" = data model supports it today.

### 4.1 Financial statements
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Balance Sheet | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Balance Sheet **Detail** | ❌ | ✅ | 🟡 | ❌ | ❌ | ✅ |
| Comparative Balance Sheet | 🟡 (engine) | ✅ | ❌ | ❌ | 🟡 | ✅ (UI) |
| Income Statement (P&L) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Income Statement **Detail** | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Comparative / Multi-column P&L | 🟡 (engine) | ✅ | ❌ | ❌ | 🟡 | ✅ (UI) |
| Cash Flow Statement | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Trial Balance | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Post-Closing Trial Balance | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Executive Summary / KPI overview | ❌ | 🟡 | ❌ | ✅ | ❌ | ✅ |
| Financial Ratios | ❌ | ❌ | ✅ | ❌ | ❌ | ✅ |
| Consolidated / Multi-book statements | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |

### 4.2 Ledger & audit
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| General Ledger | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Journal | ✅ | ✅ | 🟡 | ✅ | ✅ | — |
| Transaction Detail | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| Voucher-wise / running balance | 🟡 | ✅ | ✅ | ❌ | ❌ | ✅ |
| GL integrity / invalid-entry checks | ❌ | 🟡 | ✅ | ✅ (hash) | ❌ | ✅ |

### 4.3 Receivables / Payables
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| A/R & A/P Aging (Summary + Detail) | ✅ | ✅ | ✅ | ✅ | ✅ | — |
| A/R & A/P Register | ✅ | ✅ | ✅ | ✅ | 🟡 | — |
| Customer / Vendor **Ledger Summary** | 🟡 (statement) | ✅ | ✅ | ✅ | ✅ | ✅ |
| Customer / Vendor Balance Summary | ✅ (partners) | ✅ | ✅ | ✅ | ✅ | — |
| Open Invoices / Open Bills | 🟡 | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Payment History by Invoice/Payment | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Customer Credit / Limit balance | ❌ | 🟡 | ✅ | ❌ | ❌ | ✅ |

### 4.4 Sales / Purchases
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Sales by Customer (Summary/Detail) | ❌ | ✅ | ✅ | ✅ | 🟡 | ✅ |
| Sales by Item | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Sales by Rep / Team | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Sales Register / Item-wise Sales Register | 🟡 (AR reg) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Purchase by Vendor / Item | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Purchase Register / Item-wise | 🟡 (AP reg) | ✅ | ✅ | ❌ | ❌ | ✅ |
| Open Sales Orders / Purchase Orders | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Gross Profit / Margin | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Sales/Purchase Trends | 🟡 (studio) | 🟡 | ✅ | ✅ | ❌ | ✅ |

### 4.5 Tax
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Sales Tax Liability (by agency / item) | ❌ | ✅ | 🟡 | ✅ | ✅ | ✅ |
| Tax Return (VAT/GST) | ❌ | ✅ | 🟡 | ✅ | ❌ | ✅ |
| Sales/Purchase grouped by Tax Code | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Withholding / 1099 | ❌ | 🟡 | ✅ | ✅ | ❌ | ✅ |

### 4.6 Inventory
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Inventory Valuation (Summary/Detail) | ❌ | ✅ | ✅ | 🟡 | ✅ | ✅ |
| Inventory Activity / Stock Ledger | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Stock Balance / on-hand by location | ❌ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Inventory Turnover / Days-on-hand | ❌ | ✅ | 🟡 | ❌ | ❌ | ✅ |
| Stock Aging | ❌ | 🟡 | ✅ | ❌ | ❌ | ✅ |
| Physical Count Worksheet | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Landed Cost | ❌ | 🟡 | ✅ | ❌ | ❌ | ✅ |
| Lot/Serial Traceability | ❌ | 🟡 | ✅ | ✅ | ❌ | ✅ |

### 4.7 Assets / Revenue / Banking / FX
| Report | OB | NetSuite | ERPNext | Odoo(E) | BigCap | Feasible |
|---|:--:|:--:|:--:|:--:|:--:|:--:|
| Fixed Asset Register | ❌ | ✅ | ✅ | ❌ | ❌ | ✅ |
| Depreciation Schedule / Ledger | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Deferred Revenue Waterfall / Rollforward | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Deferred Expense / Amortization Forecast | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Bank Reconciliation (Summary/Detail/History) | ❌ | ✅ | ✅ | ✅ | ❌ | ✅ |
| Realized / Unrealized FX Gain-Loss | ❌ | ✅ | ❌ | ✅ | ❌ | ✅ |
| Budget vs Actual | ✅ | ✅ | ✅ | ✅ | ❌ | — |
| Project / Job Profitability | ✅ _(shipped 2026-07-15)_ | ✅ | ✅ | ✅ | ❌ | — |

---

## 5. Build-out plan

Sequenced by **value ÷ cost**, exploiting the existing engines. Three delivery mechanisms, cheapest
first:

- **(A) Seeded studio built-in** — a `ReportCustomQuery` in `built-ins.ts` + a hub card. ~1 file,
  no new SQL. Good for any "summarize by dimension" report.
- **(B) Flat-table report** — a query fn in `reports.ts` + page + export adapter, following the
  `generalLedger`/`journalReport`/`register` pattern. For registers, activity, detail listings.
- **(C) Matrix / bespoke** — extend `statement-matrix.ts` or write a purpose-built view. For
  statements, tax returns, waterfalls, reconciliations, depreciation.

### Tier 0 — Unblock delivery (do first; everything depends on it)
1. **Report scheduling + email pipeline.** Build the missing worker that processes
   `report_schedules`, renders the existing PDF, and emails it (add an email provider —
   Resend/SMTP). Extend schema so **native statements** schedule (nullable `definition_id` +
   `statement_kind`/`params`, or schedule saved_reports). Add "Schedule" to statement pages.
   _Without this, no report is "enterprise-complete."_ (C)

### Tier 1 — Statement completeness + core subledger registers (highest daily-use value)
2. **Balance Sheet Detail** and **Income Statement Detail** — reuse the drill query
   (`transactionDetail`) under each account row. (C, small — engine exists)
3. **Comparative / multi-column** statement UI — the matrix already computes prior-period,
   prior-year and variance; expose N-period columns in the filter bar. (C, mostly UI)
4. **Sales by Customer / Item / Rep** and **Purchase by Vendor / Item** — ship as **(A) seeded
   built-ins** first (near-zero code via `summarize` over `transaction_lines`), promote the popular
   ones to dedicated pages later.
5. **Sales Register** & **Purchase Register** (document-level, with tax/net columns) — (B), mirrors
   the existing AR/AP register pattern but keyed on `documents`.
6. **Customer / Vendor Ledger Summary** (opening/invoiced/paid/closing) — (B), generalizes the
   existing Partner Statement.

### Tier 2 — Tax (compliance must-have; the engine is already in schema)
7. **Sales Tax Liability** (by agency / by tax code) — (C) over `tax_report_lines` + `documents`.
8. **Tax Return (VAT/GST)** driven by `tax_report_lines` mapping — (C). This is a genuine
   differentiator vs Bigcapital and community Odoo.
9. **Sales / Purchase grouped by tax code** — (A) seeded built-in.

### Tier 3 — Inventory (data fully present; large ERPNext/NetSuite parity gap)
10. **Inventory Valuation Summary + Detail** — (C) over `cost_layers` / `inventory_movements`.
11. **Inventory Activity / Stock Ledger** — (B) flat-table over `inventory_movements`.
12. **Stock Balance by item/location**, **Inventory Turnover**, **Stock Aging** — (A)/(B).
13. **Physical Count Worksheet** from `stock_counts` — (B).

### Tier 4 — Assets & Revenue (schemas exist; strong enterprise signal)
14. **Fixed Asset Register** + **Depreciation Schedule** from `fixed_assets` /
    `depreciation_schedules`. (B/C)
15. **Deferred Revenue Waterfall + Rollforward** from `recognition_schedules`. (C)
16. **Deferred Expense / Amortization Forecast**. (C)

### Tier 5 — Banking, FX & analytics
17. **Bank Reconciliation Summary / Detail / History** from `reconciliations`. (C)
18. **Realized / Unrealized FX Gain-Loss** from `fx_rates` + `txn_amount` vs base. (C)
19. **Gross Profit / Profitability by dimension** and **Executive Summary** KPI page. (A + one page)
20. **Financial Ratios** (ERPNext-style, derived from statements). (C small)

### Tier 6 — Consolidation, audit & niche
21. **Consolidated / Multi-book Income Statement & Balance Sheet**; **Intercompany Elimination**
    from `accounting_books` / `intercompany_pairs`. (C)
22. **1099 vendor report**, **Post-Closing Trial Balance**, GL **integrity/invalid-entry** checks,
    **Voucher-wise balance**. (A/B)

### Shipped ahead of sequence
- **Project Profitability** (`/reports/project-profitability`) — per-project revenue, COGS, gross
  profit, expenses, net and margin from `journal_lines.project_id`, plus approved job hours from
  `time_entries`. Each row drills into the P&L filtered on that project; full PDF/XLSX/CSV export.
  Money ties out exactly to the canonical P&L. This is the first job-costing report and the anchor
  for a future **Projects** report group (project budget vs actual, WIP / over-under billing,
  unbilled time, estimate-vs-actual by task).

### Sequencing note
Tiers 1–3 alone move OpenBooks from ~15 reports to **~40–45**, covering the daily-use set that
NetSuite/ERPNext customers actually run — and a large fraction ships through mechanism (A) as seeded
data, not new code. Recommend Tier 0 + Tier 1 as the first milestone, Tier 2 (tax) close behind for
compliance credibility.

---

## 6. Method & caveats
- **Bigcapital / ERPNext / Odoo-community**: inventoried directly from source (shallow clones of the
  GitHub repos; report definitions read from service modules / report-folder JSON / report actions).
- **Odoo Enterprise**: the marquee financial reports (`account_reports`) are proprietary and absent
  from the community repo — enumerated from official Odoo documentation and labeled Enterprise.
- **NetSuite**: standard reports are built-in app features, **not** SDF/`object:list` objects.
  SuiteCloud CLI confirmed live account access (`adminapp2`); the catalog itself is from Oracle's
  NetSuite Applications Help. Several NetSuite reports (Revenue Recognition, Fixed Assets, some Tax)
  are SuiteApp/feature-gated.
- Report **counts are not apples-to-apples**: NetSuite inflates via Summary/Detail variants; ERPNext
  includes many stock-integrity diagnostic reports; Bigcapital counts only true financial statements.
  The **gap matrix (§4), not the scoreboard, is the actionable artifact.**
