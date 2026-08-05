import type { DocArticle } from '../types'

export const migrateWithAConnector: DocArticle = {
  slug: 'migrate-with-a-connector',
  title: 'Migrate with a Connector',
  category: 'integrations',
  order: 0,
  summary:
    'Connect an existing accounting system, migrate its history, and mirror daily activity for parallel validation before cutover.',
  updated: '2026-07-21',
  keywords: [
    'migration',
    'connector',
    'sync',
    'mirror',
    'parallel run',
    'initial migration',
    'NetSuite',
    'QuickBooks',
    'Xero',
    'Odoo',
    'ERPNext',
    'Dynamics 365 Business Central',
    'cutover',
  ],
  related: [
    'migration-and-cutover',
    'reconciliation-before-cutover',
    'netsuite-extraction-bridge',
    'quickbooks-desktop-connector',
  ],
  body: `# Migrate with a Connector

A connector can replace spreadsheet exports and manual column mapping for a
supported source system. It imports historical data and then uses a daily
**mirror** to support parallel reconciliation before cutover.

Manual, file-based loading is still available for systems without a connector —
see **Data Imports** and **Migration and Cutover**. Use a connector when one is
available for the source system.

## Workspace location

Open **Settings → Administration → Migrations & Mirror**. This workspace is where
you add a source connection, run the initial migration, watch reconciliation, and
turn on the daily mirror. Each connection is shown as a card with its last run,
the date it has synced through, and its mirror schedule.

Managing connections is a privileged, administrator-level task.

## Supported sources

| Connector | Connects to | How it authenticates |
| --- | --- | --- |
| **NetSuite** | Oracle NetSuite | A read-only extraction bridge plus a dedicated token-based integration role |
| **QuickBooks Desktop** | QuickBooks Desktop (Windows) | Intuit's Web Connector; QuickBooks must be open for a run |
| **QuickBooks Online** | Intuit QuickBooks Online | OAuth with your Intuit app's Client ID and Secret |
| **Xero** | Xero | OAuth with your Xero app's Client ID and Secret |
| **Dynamics 365 Business Central** | Microsoft Dynamics 365 Business Central | OAuth with a Microsoft Entra (Azure AD) app — Client ID and Secret, tenant ID, and environment |
| **Odoo** | Odoo | Your Odoo URL, database, user, and an API key |
| **ERPNext** | ERPNext / Frappe | Your ERPNext URL and an API key and secret |

Every connector is **read-only** against the source — the migration never writes
back to, changes, or deletes anything in your current system.

## Connect the source

1. Choose **Add connection** and pick your source.
2. Enter its configuration. The most important field is the **History start
   date** — the earliest posting date to migrate. Set your base currency and any
   source-specific credentials the card asks for.
3. **Connect** (or, for OAuth sources, authorize the app; for QuickBooks Desktop,
   download and import the Web Connector file). Credentials are sealed per
   organization and are never returned by the platform.

NetSuite and QuickBooks Desktop have their own detailed setup guides — see
**NetSuite Extraction Bridge** and **QuickBooks Desktop Connector**.

## Run the initial migration

Choose **Run migration** on the connection card. The connector reads your
configured history and rebuilds it as native OpenBooks activity: the chart of
accounts, customers, vendors, employees, items, and every posting transaction as
a balanced entry that ties to the source. Use **Sync attachments** to bring over
source evidence (invoices, bills, receipts) where the connector supports it.

A migration run only succeeds after its proof gates pass — it never rounds a
source imbalance into balance. Refused transactions are listed in the run's
diagnostics for you to resolve.

## Mirror daily and run in parallel

After the initial migration passes validation, choose **Enable mirror**. A mirror
keeps OpenBooks aligned with the source on a schedule and supports parallel
comparison using current activity before cutover. Use **Mirror now** to run an
on-demand pull and **Pause mirror** to stop it.

Each mirror run:

- reads new and changed activity since the connection's cursor, re-reading a
  short overlap window so nothing straddling the boundary is missed;
- retrieves source **deletions** (tombstones) and surfaces them for review rather
  than silently voiding anything;
- rebuilds the affected records through the audited transaction engine, amending
  open-period changes while leaving closed periods immutable; and
- **verifies the books before advancing the cursor**.

A run advances its **synced-through** cursor only when every proof agrees:

- the trial balance by source account;
- debit-positive activity by account and posting month;
- every imported open AP and AR item; and
- all transaction writes, source mappings, and required deletions.

If any proof fails, the connection stays on its previous successful cursor and
keeps the diagnostics, so the next run can be corrected and safely replayed — a
retry recognizes the same source records instead of creating duplicates.

## Reconcile and cut over

The mirror maintains source alignment, but accountable owners retain
responsibility for cutover approval. Before go-live, review the evidence in **Reconciliation
Before Cutover** — ledger gates, subledger gates, and record-level sampling — and
have the accountable owners approve.

When all reconciliation gates pass:

1. announce and enforce the source posting cutoff;
2. run a final **Mirror now** to capture the last delta;
3. confirm the reconciliation gates one last time;
4. obtain accounting and operational approval;
5. **Pause mirror** and begin production entry in OpenBooks; and
6. retain the source read-only per your policy.

Deleting a connection removes only the link; migrated data is retained. Keep the
connection until no further source deltas are required.
`,
}
