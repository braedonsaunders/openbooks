import type { DocArticle } from "../types";

export const chartOfAccountsGovernance: DocArticle = {
  slug: "chart-of-accounts-governance",
  title: "Account Merges, Accounting Contexts and Segment Dependencies",
  category: "accounting",
  order: 7,
  summary:
    "Merge a duplicate account into a surviving one with a previewed reclass, present reports under localized account numbers and names, and restrict segment values to allowed combinations.",
  updated: "2026-10-11",
  keywords: [
    "merge accounts",
    "account merge",
    "accounting context",
    "local gaap",
    "statutory chart",
    "localized account",
    "segment dependency",
    "filtered by",
    "cascading segment",
  ],
  related: ["chart-of-accounts-and-dimensions", "period-close", "financial-reports"],
  body: `# Account Merges, Accounting Contexts and Segment Dependencies

Three switches in **Company Settings → Features** govern the chart of
accounts beyond its everyday maintenance: **Account merges**, **Accounting
contexts** and **Segment dependencies**. Each is off until a company turns it
on; turning one off keeps every record it created.

## Account merges

Use a merge when two accounts mean the same thing — a duplicate created by an
import, or two accounts the chart no longer needs to separate. Open the
account to retire, choose **Merge into…**, pick the surviving account and the
effective date, and **Preview merge**. Merging needs chart authority
(gl.manage), posting authority (gl.post) and access to every subsidiary,
because the chart is shared.

### What the preview refuses

The preview lists every reason the merge cannot run yet, each with its
remedy. A merge is refused when:

- the accounts differ in type, currency restriction, consolidation
  elimination, reconcilability or FX revaluation treatment;
- the surviving account is inactive, a summary account, already merged, or
  sits beneath the source in the chart;
- the source is a summary account (move its children instead);
- the surviving account is not available to a subsidiary the source is used
  in;
- the source carries open receivable or payable items, unreconciled bank
  lines, or an unsigned reconciliation;
- documents awaiting approval, approved documents, payment runs in progress,
  pending fund releases or a published allocation rule still use the source;
- the source has postings dated after the effective date, no accounting
  period covers that date, or the period is closed for a book or subsidiary;
- a foreign-currency balance cannot be moved at a positive exchange rate
  (revalue it or post an adjusting entry first), or the surviving account
  requires a dimension the balance lacks;
- the source and survivor hold different subledger control roles.

### What the merge does

When nothing refuses, the preview shows every consequence, and confirming
applies exactly that preview (if anything changed in between, you are asked
to review the refreshed preview). In one transaction OpenBooks:

1. moves configuration that drives future postings — item and category
   accounts, tax codes, customer and vendor accounts, open subledger records,
   draft documents, saved report filters, bank rules and control-account
   roles — to the surviving account, recording each change in the audit log
   with the before and after account;
2. moves draft journal lines and child accounts under the survivor;
3. posts one balanced reclass journal entry per accounting book and
   subsidiary, dated the effective date, that credits the source and debits
   the survivor on the same currency, exchange rate and dimensions. Balance
   sheet accounts move their cumulative balance; profit and loss accounts move
   the balance of the fiscal year of the effective date, because earlier years
   are already closed into retained earnings;
4. records the merge and marks the source merged: inactive, permanently, with
   the survivor, date, user and reason.

Posted history is never rewritten: earlier lines keep the source account.
The surviving account's register includes the merged account's history, and
the reclass nets to zero across the two, so the register reads as one
continuous history. A merged account refuses every new posting and every new
reference from any screen, import, script or integration, naming the
survivor; a document posted earlier to the merged account is corrected with a
journal entry on the surviving account rather than voided.

### Approval

Merges follow your **Accounting event** flows in Flows. When an enabled
Accounting event flow exists, confirming a merge submits it for approval
instead of applying it; once approved, **Apply approved merge** on the
**Merges** tab of the chart of accounts applies it against an unchanged
preview. The **Merges** tab lists every executed merge and every proposal.

## Accounting contexts

An accounting context presents the chart under localized account numbers and
names — for example a local statutory chart beside your group chart. Manage
contexts under **Setup → Accounting contexts**: each context has **Defaults**
(the subsidiaries, or the countries, that report under it) and **Localized
accounts** (a localized number and/or name per account, effective from a date
and optionally only for one subsidiary). Localized accounts can be imported
from a CSV file through **Data → Import**.

The trial balance, general ledger, profit and loss, balance sheet and the
account register can be run under a context with the **Accounting context**
control in the report filter bar: the subsidiary's default context, the base
chart, or a named context. Exports and scheduled runs use the same setting.
Accounts show and sort by their localized number and name as of the report
date; an account the context does not localize keeps its base number and name
and is marked † on the report. Two accounts may not share a localized number
in one context and scope at the same time — setup refuses it, and a report
refuses a context where it would otherwise occur.

## Segment dependencies

A segment dependency allows a value of one segment only together with listed
values of another (controlling) segment — for example class "Field" only with
departments "Operations" or "Service". Either side can be a custom segment or a
built-in dimension (subsidiary, department, class, location, project). Open the
segment under **Setup → Segments** and use its **Dependencies** tab: each row
allows one controlling value for one value, optionally between two dates; a
value with no rows stays unrestricted.

Rules apply on the transaction date. Document lines offer only the allowed
values, saving a document refuses a line that breaks a rule, and the posting
engine refuses it from every source — screens, the API, imports, scripts and
scheduled jobs — naming the line and the allowed values. Reversals and account
merge reclasses reproduce existing postings and are not re-checked; posted
history is never re-evaluated. **Setup → Dependency exceptions** lists the
open documents whose lines break a rule, so a newly added rule can be worked
through before those documents post.
`,
};
