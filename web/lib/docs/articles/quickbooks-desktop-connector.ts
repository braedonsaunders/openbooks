import type { DocArticle } from '../types'

export const quickBooksDesktopConnector: DocArticle = {
  slug: 'quickbooks-desktop-connector',
  title: 'QuickBooks Desktop Connector',
  category: 'integrations',
  order: 3,
  summary:
    'Install and operate the read-only QuickBooks Web Connector bridge for migrations, historical mirrors, and ledger reconciliation.',
  updated: '2026-07-19',
  keywords: ['QuickBooks Desktop', 'Web Connector', 'QWC', 'qbXML', 'migration', 'mirror', 'trial balance', 'Windows'],
  body: `# QuickBooks Desktop Connector

The QuickBooks Desktop connector is a read-only bridge built on Intuit's
**QuickBooks Web Connector** and **qbXML**. The Windows computer initiates every
HTTPS connection to OpenBooks, so you do not open an inbound Windows firewall
port or expose the company file as a network share.

QuickBooks must be open while the initial authorization and each capture run.
The company may remain open for ordinary use: the connector only issues read
queries and the downloaded configuration declares **IsReadOnly**.

---

## Before you begin

You need:

- QuickBooks Desktop and QuickBooks Web Connector installed on the same Windows
  computer;
- the company file open with no modal dialog displayed;
- a QuickBooks administrator for the one-time authorization;
- an HTTPS OpenBooks deployment reachable from that Windows computer; and
- the earliest posting date you want to migrate.

QuickBooks Desktop editions are region-specific. Choose the connection's
**QuickBooks region** to match the installed edition and set its actual
**Base currency**. Test US, Canadian, UK, Australian, and New Zealand files with
their matching regional QuickBooks or compatible regional desktop installation;
a company file from one region generally cannot be opened by another region's
executable. The bridge refuses a capture when Web Connector reports a region
different from the connection setting.

## Create and authorize the connection

1. Open **Settings → Administration → Migrations & Mirror** and choose **Add connection**.
2. Select **QuickBooks Desktop**.
3. Enter the **History start date**, **QuickBooks region**, **Base currency**,
   and a strong **Web Connector password**. Leave **Company file path** blank to
   use the company that is open when the connector runs, or enter the full
   Windows path to bind this connection to one file.
4. Save the connection, then choose **Download Web Connector** on its card.
5. On the QuickBooks computer, open the downloaded **.QWC** file. Accept the
   application certificate in QuickBooks as the administrator and permit access
   whenever the company file is open.
6. In QuickBooks Web Connector, enter the same password and select its checkbox.
   Choose **Update Selected** once. The connection card should then show a recent
   Web Connector contact.

The password is sealed per tenant and is never returned by the API. The **.QWC**
file contains the connection-specific username and endpoint but never contains
the password.

## Run a migration

Choose **Run migration** on the connection card, then keep QuickBooks and Web
Connector open. Web Connector polls every five minutes; choose **Update Selected**
to start immediately. The card reports completed and total qbXML requests while
the worker waits.

A capture reads the complete configured history in calendar-month chunks, plus
the chart of accounts, customers, vendors, employees, items, preferences, company
information, and an accrual-basis trial balance. Monthly chunks keep an individual
report response bounded even for a large company file.

OpenBooks imports every posting transaction as a balanced **journal transaction**
identified by the source **TxnID**. It preserves posting date, reference number,
memo, account, amount, and the customer or vendor on AR/AP lines when QuickBooks
reports it. This connector intentionally prioritizes an exact, reconcilable GL;
it does not currently recreate QuickBooks invoice/bill layouts or payment
application links as native transaction forms.

The run succeeds only after both gates pass:

- the account-by-account accrual trial balance matches; and
- debit-positive activity matches for every account and posting month.

An unmapped account, a transaction with fewer than two mapped lines, or any
out-of-balance transaction is refused and listed in the run diagnostics. The
connector never rounds a source imbalance into balance.

## Mirrors and historical changes

A QuickBooks Desktop mirror performs a complete read-only recapture from the
configured history date. This costs more than a timestamp-only pull, but it
detects an edit or deletion anywhere in historical data, including changes made
to transactions dated before the last successful run.

Existing imported transactions are compared idempotently. Open-period changes
are amended through the audited transaction engine; closed-period impact remains
immutable. Source deletions are reported for review and are never silently
voided. Keep automated mirrors disabled until you have measured the full-capture
duration for the company file.

## Security and retention

- Web Connector authenticates with a connection-specific username and a
  tenant-sealed password.
- Session tickets expire and an interrupted sent request is safely returned to
  the queue.
- Only one active capture is retained per connection; starting a new capture
  cancels an older unfinished capture.
- Raw qbXML responses are hashed for integrity and erased after the migration
  worker parses them. Capture metadata and hashes remain for diagnosis.
- The connector never writes to QuickBooks and never needs direct access to the
  **.QBW** or **.TLG** file.

## Troubleshooting

**Web Connector has not connected yet** — confirm the **.QWC** file was imported,
the password was entered, the row is checked, and the OpenBooks URL is reachable
from Windows over HTTPS.

**QuickBooks could not start** — open the intended company manually, dismiss any
modal dialog, then choose **Update Selected** again.

**Wrong company file** — set the connection's **Company file path** to the full
Windows **.QBW** path, re-download the **.QWC** file, and import it again.

**Capture timed out** — keep QuickBooks and Web Connector running, verify the
card's contact time is advancing, and retry. Large first-time histories can run
for hours.

**Trial balance or monthly activity differs** — review refused transactions and
account mapping first. Do not cut over until both reconciliation gates pass.
`,
}
