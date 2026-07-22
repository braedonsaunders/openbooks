import type { DocArticle } from "../types";

export const laborPricing: DocArticle = {
  slug: "labor-pricing",
  title: "Labor Pricing",
  category: "projects",
  order: 4,
  summary:
    "Configure multi-currency labor selling rates, overtime tiers, markups, applicability, dimension scopes, negotiated terms, and project or customer assignments.",
  updated: "2026-07-21",
  keywords: [
    "labour",
    "labor",
    "price",
    "selling rate",
    "rate card",
    "markup",
    "materials",
    "transaction type",
    "currency",
    "overtime",
  ],
  related: ["labor-costing", "item-rates", "project-types"],
  body: `# Labor Pricing

**Administration → Labor Pricing** is the selling-price workspace for labor
and project work. It is separate from **Labor costing**, which answers what an
hour costs the company through wages, burden, posting, and payroll true-up.
The workspace is available when the **Projects** feature is enabled.

Every rate card is an effective-dated version of a shared item price book. The
card retains its own **Currency**, regular and time-type prices, assignments,
dimension scopes, adjustments, and negotiated terms. Customer and project
assignments may resolve by usage date or lock to the project start date.

## Multi-currency prices

The card currency is explicit and editable. When the tenant or its active
subsidiaries have more than one configured currency, all configured currencies
are available in the selector. Approval snapshots the source price, currency,
FX rate, resolved rate-card version, and converted amount on the time entry so
later configuration changes never rewrite a transaction.

## Edit a rate card

Select a card to open the standard record drawer. Its three record controls are
**Edit**, **Actions**, and **Fullscreen**. The drawer also provides the shared
**Attachments** and **Audit** tabs.

Choose **Edit** to change the same configuration record in place. Header fields,
dimension scopes, item/time-type prices, adjustments, applicability, and terms
become editable without creating another revision. **Save** writes a complete
before/after audit event. Previously approved or posted transactions remain
unchanged because they retain their snapshotted rate evidence.

Administrators can choose **Actions → Customize** to open the form designer.
The labor-rate-card form uses the same reusable layout system as other record
drawers: built-in header fields can be moved, hidden, renamed, grouped, or made
required, and tenant-defined custom header fields can be added. The item-rate
grid uses the standard editable-table placement and honours visible line
columns from the selected form.

## Dimension scopes

A card with no scopes is available across the organization. Add one or more
scopes for **Department**, **Subsidiary**, **Location**, **Class**, **Trade**,
**Job title**, or a flexible **Other** value. Persisted dimensions display their
tenant names in view and edit modes—never internal UUIDs. Hierarchical
dimensions can include their descendants.

## Adjustments and applicability

Adjustments are general commercial rules rather than permanent one-off fields.
The supported categories are **Markup**, **Travel**, **Allowance**, **Minimum**,
**Surcharge**, and **Other**. Calculations may be percentage, fixed amount, per
hour, per day, distance, time, or informational text; presentation can be
included in the rate, a separate invoice line, or informational.

An adjustment with no applicability rows applies to the **Whole card**. Add any
number of applicability rows to target one or more of:

- a named **Item**, **Item type**, or **Item category**;
- a **Transaction type**;
- **Department**, **Subsidiary**, **Location**, **Class**, **Trade**, or
  **Job title**;
- a **Project** or **Customer**;
- a flexible **Other** value.

For example, a material markup is a **Markup** adjustment whose applicability
is **Item category · Materials**. A fuel surcharge may target an item category,
a transaction type, or several dimensions. This target-row model deliberately
avoids adding a database column for each future commercial condition.

## Search and history

The card list supports URL-backed search and pagination. The drawer’s **Audit**
tab shows in-place updates, and **Attachments** stores customer schedules and
supporting rate sheets against the card. Imported source identifiers remain in
the migration provenance tables; day-to-day users see resolved names.
`,
};
