import { index, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { id, orgRef } from './helpers'

/** Immutable, author-owned proposals; install is a separate reviewed operation. */
export const extensionDrafts = pgTable('extension_drafts', {
  id: id(), orgId: orgRef(), createdBy: uuid('created_by').notNull(),
  extensionKey: text('extension_key').notNull(), bundle: jsonb('bundle').notNull(),
  contentHash: text('content_hash').notNull(), baseVersionId: uuid('base_version_id'),
  reason: text('reason').notNull(), status: text('status', { enum: ['draft', 'applied', 'discarded'] }).notNull().default('draft'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  appliedAt: timestamp('applied_at', { withTimezone: true }),
}, table => [index('extension_drafts_author').on(table.orgId, table.createdBy, table.createdAt)])
