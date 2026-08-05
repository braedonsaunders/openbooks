import type { DocArticle } from '../types'

export const auditLog: DocArticle = {
  slug: 'audit-log',
  title: 'Audit Log',
  category: 'administration',
  order: 4,
  summary: 'Search immutable business events and inspect readable field changes, record snapshots, and ledger impact.',
  updated: '2026-07-19',
  keywords: ['audit', 'history', 'changes', 'before', 'after', 'ledger impact', 'evidence'],
  body: `# Audit Log

The Audit Log is the organization-scoped, append-only history of changes to
business records and administrative configuration. It identifies when an event
occurred, who or what initiated it, the action, the record type, and the affected
record.

Users need **View the audit log** permission to open it from **Settings →
Administration → Audit Log**.

## Find an event

Use search to find a record type, user, or exact record reference. Filters narrow
the list by record type, user, action, or date range. The results remain paginated
and the active filters stay in the URL so a filtered view can be bookmarked.

Each list row contains only a concise event summary. Select any row to open the
event drawer; audit evidence is never displayed as raw JSON in the list.

## Read event details

The **Changes** tab compares the previous and new values field by field. Red
cells show the earlier value and green cells show the resulting value. Event
context such as the source, mode, and reason appears below the comparison,
followed by immutable event and request identifiers.

For posted transaction amendments and deletions, the drawer also provides:

- **Before** — the complete transaction and general-ledger snapshot immediately
  before the event.
- **After** — the complete resulting snapshot. A deletion explicitly states that
  no after snapshot exists.

Nested objects are shown as key-value sections. Collections such as transaction
and journal lines are collapsed into individually labelled items so large events
remain scannable while preserving every recorded value.

## Interpret system events

An event attributed to **system** was produced by an automated or integration
path rather than an interactive user. Review the event context and request ID to
identify the originating process. The audit entry itself cannot be edited or
deleted.
`,
}
