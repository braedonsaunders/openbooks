import type { DocArticle } from '../types'

export const netSuiteBridge: DocArticle = {
  slug: 'netsuite-extraction-bridge',
  title: 'NetSuite Extraction Bridge',
  category: 'integrations',
  order: 3,
  summary:
    'Install and operate the pull-based extraction bridge for exact migrations, daily mirrors, and proof-gated reconciliation.',
  updated: '2026-07-20',
  keywords: ['NetSuite', 'RESTlet', 'Map Reduce', 'SuiteCloud', 'SuiteQL', 'migration', 'mirror', 'trial balance'],
  related: ['migration-and-cutover', 'reconciliation-before-cutover', 'switching-from-enterprise-systems'],
  body: `# NetSuite Extraction Bridge

The connector uses an account-installed, read-only extraction bridge. It does
not attach Client Scripts, User Events, or workflows to transaction records.
OpenBooks initiates every request through an authenticated RESTlet, and a
Map/Reduce script handles partitioned bulk exports without adding work to
transaction entry or posting.

## Install the bridge

Deploy the versioned **OpenBooks Extraction Bridge** account customization
project with SuiteCloud Development Framework. The project creates:

- **OpenBooks Extraction Bridge**, a RESTlet control and query endpoint;
- **OpenBooks Bulk Export**, an on-demand Map/Reduce deployment; and
- a private **SuiteScripts/OpenBooks/Jobs** File Cabinet workspace.

Use the default script IDs shown in the connection workspace unless your
account administrator deliberately renamed the deployments.

## Integration role

Create a dedicated integration role with only the records and subsidiaries the
organization intends to migrate. It needs RESTlet and SuiteAnalytics query
access, File Cabinet access to the bridge workspace, accounting periods,
accounts, the required transaction and master-record permissions, **Accounting
Lists** for payment terms, and **Deleted Records** for tombstones.

The bridge never writes business transactions. Its only writes are temporary
export request and result files in its private workspace.

Vendor-bill and expense-report evidence is read through the same authenticated
bridge. Large PDFs and images are transferred in bounded chunks, allowing the
connector to preserve source files that exceed NetSuite's single-response
limit without making them public or adding account-specific scripts.

## Account field mappings

Standard records and fields are discovered without account-specific source
code. Enter optional **Account field mappings** JSON for custom concepts. The
supported keys are:

~~~json
{
  "projectForemanField": "custentity_example_foreman",
  "projectPurchaseOrderField": "custentity_example_po",
  "itemCategoryField": "custitem_example_category",
  "customerShortCodeField": "custentity_example_shortcode",
  "employeeBenefitsField": "custentity_example_benefits",
  "timeTypeRecord": "customrecord_example_time_type",
  "timeTypeMultiplierField": "custrecord_example_multiplier",
  "timeEntryTypeField": "custcol_example_time_type",
  "timeEntryFieldTicketNumberField": "custcol_example_field_ticket",
  "projectStatuses": {
    "Awarded": "awarded",
    "Substantially Complete": "substantially_complete"
  },
  "projectBillingTypes": {
    "FBM": "not_to_exceed"
  }
}
~~~

Mappings belong to the tenant connection. Never add an account's custom field
IDs to the shared connector.

**projectBillingTypes** overrides how a NetSuite **jobbillingtype** resolves to
a project type. By default **TM** imports as Time & Materials, and both
fixed-bid members, **FBI** and **FBM**, import as Fixed Price. NetSuite's stock
enum has no not-to-exceed member, so accounts that run budget or do-not-exceed
work often overload one of the fixed-bid members for it and carry the ceiling
in the job price. Map that member here so those jobs import as Not-to-Exceed
and bill time and materials up to the ceiling, instead of reporting the ceiling
as earned contract revenue. Valid targets are **time_and_materials**,
**fixed_price**, **cost_plus** and **not_to_exceed**.

## Daily mirror guarantees

Each mirror captures a source-clock upper boundary, re-reads transactions in a
fifteen-minute overlap window, retrieves deletion tombstones, rebuilds the
application graph, and verifies the resulting books. A run advances its cursor
only when all of these agree:

- trial balance by source account;
- debit-positive activity by account and posting month;
- every imported open AP and AR item;
- all transaction writes and source mappings; and
- every source deletion requiring resolution.

If any proof fails, the connection remains on its previous successful cursor.
The failed run retains diagnostics so the next attempt can be corrected and
replayed idempotently.
`,
}
