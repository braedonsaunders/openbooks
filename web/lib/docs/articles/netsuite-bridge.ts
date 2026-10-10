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

## Connection mappings

Open **Sync → Connections**, edit the connection, and choose **Mappings**.
Standard accounts, items, entities and their references are matched by source
identity automatically. Optional mappings are grouped by concept: Projects,
Transaction lines, Items, People, Time types, Time entries, CRM and Taxes.

Choose custom fields by their source names using the searchable pickers.
For time types, select the source record first, then choose its multiplier
field from that record's children. Existing saved choices remain visible even
when source access is temporarily unavailable. Save a new connection before
opening its source-field choices. The integration role needs read access to
customization metadata.

For project statuses and billing types, choose the source value and its native
meaning, then select **Add value mapping**. Each saved mapping appears as a
pair of pills with a remove action. Unfinished rows must be added or discarded
before saving. In Taxes, choose the sales or purchase use and an accessible
source tax code. Missing required tax configuration refuses the transaction
with a diagnostic so the mapping can be corrected and the sync replayed.

## Transaction documents and files

In **Sync content**, enable **Sync transaction documents and files** to import
transaction attachments, including vendor bill PDFs and expense-report
receipts. The first enabled run inspects previously synced transactions as
well as new ones. Later runs download new or changed files when reliable
source modification markers are available. File Cabinet preserves versions
and links evidence to its matching native transaction without duplicate files.

The integration role needs access to the relevant transactions and File
Cabinet files. A denied or incomplete read is reported as a failed sync;
the connector does not advance a successful cursor past that refusal.
Disabling file sync preserves imported files and transaction links.

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
