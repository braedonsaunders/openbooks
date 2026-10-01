import { sql } from 'drizzle-orm'
import { bigint, boolean, check, customType, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { id, orgRef } from './helpers'

const bytea = customType<{ data: Uint8Array; driverData: Uint8Array }>({ dataType: () => 'bytea' })
const jobColumns = () => ({ orgId: orgRef(), jobId: uuid('job_id').notNull() })

/** Durable operator requests; domain writes and their checkpoints share a transaction. */
export const dataTransferJobs = pgTable('data_transfer_jobs', {
  id: id(), orgId: orgRef(), actorId: uuid('actor_id').notNull(), kind: text('kind').notNull(),
  resourceKey: text('resource_key').notNull(), format: text('format').notNull(), fileName: text('file_name').notNull(),
  state: text('state').notNull(), revision: integer('revision').notNull().default(1),
  byteCount: bigint('byte_count', { mode: 'number' }).notNull().default(0),
  uploadedBytes: bigint('uploaded_bytes', { mode: 'number' }).notNull().default(0),
  totalRows: bigint('total_rows', { mode: 'number' }).notNull().default(0),
  processedRows: bigint('processed_rows', { mode: 'number' }).notNull().default(0),
  scope: jsonb('scope').notNull(), options: jsonb('options').notNull().default({}),
  headers: jsonb('headers').notNull().default([]), fields: jsonb('fields').notNull().default([]), sample: jsonb('sample').notNull().default([]),
  outcome: jsonb('outcome').notNull().default({ created: 0, updated: 0, failed: 0, errors: [] }),
  preview: jsonb('preview').notNull().default({ created: 0, updated: 0, failed: 0, errors: [] }),
  approvalHash: text('approval_hash'), schemaHash: text('schema_hash'), sourceHash: text('source_hash'),
  cancelRequested: boolean('cancel_requested').notNull().default(false), error: text('error'), failedPhase: text('failed_phase'),
  claimToken: uuid('claim_token'), claimUntil: timestamp('claim_until', { withTimezone: true }),
  requestKey: uuid('request_key').notNull(), requestHash: text('request_hash').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  unique().on(t.orgId, t.id), unique().on(t.orgId, t.actorId, t.requestKey),
  index('data_transfer_jobs_dispatch').on(t.state, t.claimUntil, t.updatedAt).where(sql`${t.state} in ('parsing','previewing','committing','exporting')`),
  index('data_transfer_jobs_org_history').on(t.orgId, t.actorId, t.createdAt.desc(), t.id),
  check('data_transfer_jobs_kind_check', sql`${t.kind} in ('import','export')`),
  check('data_transfer_jobs_format_check', sql`${t.format} in ('csv','xlsx','json')`),
  check('data_transfer_jobs_state_check', sql`${t.state} in ('uploading','parsing','mapping','previewing','ready','committing','exporting','completed','failed','cancelled')`),
  check('data_transfer_jobs_counts_check', sql`${t.byteCount}>=0 and ${t.uploadedBytes}>=0 and ${t.totalRows}>=0 and ${t.processedRows}>=0`),
])

/** Checksummed 4 MiB parts keep both upload and download memory bounded. */
export const dataTransferChunks = pgTable('data_transfer_chunks', {
  ...jobColumns(), direction: text('direction').notNull(), partNo: integer('part_no').notNull(), data: bytea('data').notNull(), sha256: text('sha256').notNull(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.jobId, t.direction, t.partNo] }),
  foreignKey({ columns: [t.orgId, t.jobId], foreignColumns: [dataTransferJobs.orgId, dataTransferJobs.id] }).onDelete('cascade'),
  check('data_transfer_chunks_direction_check', sql`${t.direction} in ('source','output')`),
  check('data_transfer_chunks_part_no_check', sql`${t.partNo}>=0`),
  check('data_transfer_chunks_data_check', sql`octet_length(${t.data}) between 1 and 4194304`),
  check('data_transfer_chunks_sha256_check', sql`length(${t.sha256})=64`),
])
export const dataTransferRows = pgTable('data_transfer_rows', {
  ...jobColumns(), rowNo: bigint('row_no', { mode: 'number' }).notNull(), data: jsonb('data').notNull(), keys: jsonb('keys').notNull().default([]),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.jobId, t.rowNo] }),
  foreignKey({ columns: [t.orgId, t.jobId], foreignColumns: [dataTransferJobs.orgId, dataTransferJobs.id] }).onDelete('cascade'),
  check('data_transfer_rows_row_no_check', sql`${t.rowNo}>0`), check('data_transfer_rows_data_check', sql`jsonb_typeof(${t.data})='object'`),
])
export const dataTransferKeys = pgTable('data_transfer_keys', {
  ...jobColumns(), keyHash: text('key_hash').notNull(), rowNo: bigint('row_no', { mode: 'number' }).notNull(),
}, (t) => [
  primaryKey({ columns: [t.orgId, t.jobId, t.keyHash, t.rowNo] }),
  index('data_transfer_keys_source_row').on(t.orgId, t.jobId, t.rowNo),
  foreignKey({ columns: [t.orgId, t.jobId, t.rowNo], foreignColumns: [dataTransferRows.orgId, dataTransferRows.jobId, dataTransferRows.rowNo] }).onDelete('cascade'),
])
export const dataTransferIssues = pgTable('data_transfer_issues', {
  ...jobColumns(), phase: text('phase').notNull(), rowNo: bigint('row_no', { mode: 'number' }).notNull(),
  severity: text('severity').notNull(), message: text('message').notNull(), field: text('field'),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.jobId], foreignColumns: [dataTransferJobs.orgId, dataTransferJobs.id] }).onDelete('cascade'),
  index('data_transfer_issues_page').on(t.orgId, t.jobId, t.phase, t.rowNo),
  check('data_transfer_issues_phase_check', sql`${t.phase} in ('preview','commit')`),
  check('data_transfer_issues_severity_check', sql`${t.severity} in ('error','warning')`),
])
/** Append-only lifecycle evidence includes the approved source and checkpoint. */
export const dataTransferEvents = pgTable('data_transfer_events', {
  id: id(), ...jobColumns(), actorId: uuid('actor_id').notNull(),
  occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(), action: text('action').notNull(),
  beforeState: text('before_state'), afterState: text('after_state').notNull(), revision: integer('revision').notNull(), evidence: jsonb('evidence').notNull().default({}),
}, (t) => [
  foreignKey({ columns: [t.orgId, t.jobId], foreignColumns: [dataTransferJobs.orgId, dataTransferJobs.id] }).onDelete('cascade'),
  index('data_transfer_events_job').on(t.orgId, t.jobId, t.occurredAt, t.id),
])
