/** Framework-independent revision and correction policy shared by document adapters. */
import { sql, type SQL } from 'drizzle-orm'
import { documentRevisionCounterSql, isDocumentRevisionToken } from './revision.ts'

const DOCUMENT_REVISION_ALIAS = '__documentRevision'

/** Tables whose revision_seq counter is the optimistic-concurrency revision. */
const REVISION_TABLES = new Set(['documents', 'custom_records'])

/** Add the exact revision sidecar to reads backed by a revisioned table. */
export function documentRevisionProjection(table: string): SQL {
  return REVISION_TABLES.has(table)
    ? sql`, ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "__documentRevision"`
    : sql``
}

/**
 * Replace the driver's noncanonical timestamp value with the exact persisted
 * wire revision, preserving the established updated_at response field.
 * Non-revisioned records pass through untouched.
 */
export function normalizeDocumentRecordRevisions(
  table: string,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (!REVISION_TABLES.has(table)) return rows
  return rows.map((row) => {
    const revision = row[DOCUMENT_REVISION_ALIAS]
    if (!isDocumentRevisionToken(revision)) {
      throw new Error('document read did not return an exact persisted revision')
    }
    const record = { ...row }
    delete record[DOCUMENT_REVISION_ALIAS]
    return { ...record, updated_at: revision }
  })
}

export class DocumentEditError extends Error {
  status: number
  fieldErrors?: Record<string, string>
  constructor(status: number, message: string, fieldErrors?: Record<string, string>) {
    super(message)
    this.name = 'DocumentEditError'
    this.status = status
    this.fieldErrors = fieldErrors
  }
}

export const DOCUMENT_EDIT_VERSION_REQUIRED =
  'the document revision is required; reload and review the latest revision'

export const DOCUMENT_EDIT_REVISION_CONFLICT =
  'this document changed after you opened it; reload and review the latest revision'

const DOCUMENT_CORRECTION_CONFLICT =
  'this document already has a correction; continue that retained correction instead of creating a competing version'

/** Require the opaque revision token returned by loadDocument. */
export function requireDocumentEditRevision(value: unknown): string {
  if (!isDocumentRevisionToken(value)) {
    throw new DocumentEditError(409, DOCUMENT_EDIT_VERSION_REQUIRED)
  }
  return value
}

/**
 * Compare exact PostgreSQL revision text without lossy JavaScript Date parsing.
 *
 * Exact string equality is sound end to end because storage guarantees a
 * document's revision ADVANCES on every update: migration
 * 0167_document_revision_counter bumps the revision_seq counter on every
 * UPDATE at the database boundary — including writes that backdate the
 * updated_at display timestamp. Two committed revisions can therefore never
 * serialize to one token, so an equal-string match really does mean "nothing
 * changed since you read it".
 */
export function assertDocumentEditRevision(expected: unknown, actual: unknown): void {
  if (typeof expected !== 'string' || typeof actual !== 'string' || expected !== actual) {
    throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT)
  }
}

export function assertNoExistingDocumentCorrection(existingDocumentNumber: string | null): void {
  if (existingDocumentNumber !== null) {
    throw new DocumentEditError(409, DOCUMENT_CORRECTION_CONFLICT)
  }
}

/**
 * Keep the authoritative revision read and every dependent mutation inside one
 * transaction callback. The injected shape is intentionally tiny; production
 * supplies Drizzle's transaction + `select … for update`, and PostgreSQL-backed
 * regressions exercise this exact orchestration under competing connections.
 *
 * The locked row's revision must itself carry the exact canonical wire token
 * the documentRevisionCounterSql projection guarantees. String equality
 * between two equally lossy values — a driver-mapped Date coerced back to
 * text, PostgreSQL's default timestamp rendering, a truncated fractional
 * part — would otherwise authorize a write against a revision this system
 * can never have handed out, so a lock without an exact token fails closed
 * before any comparison runs.
 */
export async function runDocumentVersionedTransaction<
  Transaction,
  Locked extends { updatedAt: unknown },
  Result,
>(args: {
  expectedRevision: string
  transaction: (work: (tx: Transaction) => Promise<Result>) => Promise<Result>
  lock: (tx: Transaction) => Promise<Locked | null>
  mutate: (tx: Transaction, locked: Locked) => Promise<Result>
}): Promise<Result> {
  return args.transaction(async (tx) => {
    const locked = await args.lock(tx)
    if (!locked) throw new DocumentEditError(404, 'not found')
    if (!isDocumentRevisionToken(locked.updatedAt)) {
      throw new Error('document lock did not return an exact persisted revision')
    }
    assertDocumentEditRevision(args.expectedRevision, locked.updatedAt)
    return args.mutate(tx, locked)
  })
}

/**
 * Trimmed correction reason admissible on a posted-document amendment: the
 * same 8..500 btrim window the database enforces on every `reverses`
 * document_links edge (document_links_reversal_evidence CHECK), so a reason
 * this accepts can never detonate the link insert mid-transaction.
 */
export function validateCorrectionReason(value: string | undefined | null): string {
  const reason = value?.trim() ?? ''
  if (reason.length < 8 || reason.length > 500) {
    throw new DocumentEditError(422, 'A correction reason between 8 and 500 characters is required')
  }
  return reason
}

/**
 * The mandatory, immutable controller evidence every `reverses` document_links
 * edge must carry — `reason`, `requested_by`, and `requested_at` are not
 * optional metadata on a correction edge; the database refuses any row without
 * them (document_links_reversal_evidence CHECK) and submission of the
 * replacement stays gated on the linked void either way
 * (engine/src/flows/submit.ts). This is the same evidence the engine's own
 * correction writer records (engine/src/ledger/document-correction.ts); the web draft
 * path composes it instead of hand-rolling a bare edge. Fails closed: an edge
 * without admissible evidence cannot be constructed here at all.
 *
 * Exercised directly by engine policy tests and web compatibility tests.
 */
export function buildReversalLinkEvidence(input: {
  fromDocumentId: string
  toDocumentId: string
  reason: string | undefined | null
  requestedBy: string
}): {
  fromDocumentId: string
  toDocumentId: string
  linkType: 'reverses'
  reason: string
  requestedBy: string
  requestedAt: Date
} {
  if (!input.fromDocumentId || !input.toDocumentId) {
    throw new DocumentEditError(422, 'a reversal link requires both the replacement and the corrected document')
  }
  if (!input.requestedBy) {
    throw new DocumentEditError(422, 'a correction requires an attributable requester')
  }
  return {
    fromDocumentId: input.fromDocumentId,
    toDocumentId: input.toDocumentId,
    linkType: 'reverses',
    reason: validateCorrectionReason(input.reason),
    requestedBy: input.requestedBy,
    requestedAt: new Date(),
  }
}

