import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db, schema, withOrgTransaction } from '@openbooks/engine/src/db.ts'
import { cmp, normalizeMoney } from '@openbooks/engine/src/money.ts'
import { runRecordFlows } from '@openbooks/engine/src/flows/index.ts'
import { captureTransactionAuditSnapshot, recordTransactionAudit } from '@openbooks/engine/src/transaction-audit.ts'
import { promoteCrmAccount } from '@openbooks/engine/src/crm.ts'
import { computeBillTotals, computeBillTotalsWithProvider, nextDocumentNumber, persistLineTaxComponents, taxProfileMap, type BillLineInput } from './bills'
import { canonicalDecimal } from './exact-decimal'
import { DOC_KINDS, DOC_KIND_FEATURE, docKindConfig, type DocKindConfig } from './document-kinds'
import { featureEnabled, isFeatureEnabled, orgFeatureState } from './features'
import { loadFieldDefs, validateCustomValues } from './custom-fields'
import { segmentRegistry, validateExtraDims } from './segments'
import { resolveOrgId } from './org-scope'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { loadRequiredControlAccounts } from '@openbooks/engine/src/control-accounts.ts'
import { isDocumentRevisionToken } from './api/registry-data'
import { persistTaxQuote } from '@openbooks/engine/src/tax-rate-providers.ts'

/**
 * Unified line-based posting-document machinery.
 *
 * The `documents` table is a single supertype keyed by `kind`; the posting
 * engine (engine/src/posting.ts) holds the per-kind GL rules. The UI for
 * vendor bills, customer invoices, credit memos, card charges, checks, and
 * transfers is structurally identical — a header (party or funding source +
 * dates + memo) and a line grid (account + amount + tax + dimensions). This
 * module is the single source of truth for how each kind is loaded and
 * draft-created, so the drawer, the API, and the list pages never diverge.
 *
 * The kind configuration (client-safe) lives in lib/document-kinds.ts and is
 * re-exported here. The shared math (number sequences, tax computation,
 * tax-rate lookup) lives in lib/bills.ts and is re-exported here; it is fully
 * kind-agnostic.
 */

export { computeBillTotals, computeBillTotalsWithProvider, taxProfileMap, nextDocumentNumber, type BillLineInput } from './bills'
export {
  DOC_KINDS,
  DOC_KIND_FEATURE,
  AP_KINDS,
  AR_KINDS,
  BANK_KINDS,
  docKindConfig,
  createPermission,
  postPermission,
  readPermission,
  type DocKindConfig,
  type DocFamily,
  type PermNamespace,
} from './document-kinds'

/** False when this kind belongs to a Features switch that is off. */
export async function isDocKindEnabled(orgId: string, kind: string): Promise<boolean> {
  const feature = DOC_KIND_FEATURE[kind]
  if (!feature) return true
  return isFeatureEnabled(orgId, feature)
}

/** Optional-module kinds whose Features switch is off. Historical rows stay. */
export async function disabledDocKinds(orgId: string): Promise<string[]> {
  const state = await orgFeatureState(orgId)
  return Object.entries(DOC_KIND_FEATURE).flatMap(([kind, feature]) =>
    feature && !featureEnabled(state, feature) ? [kind] : [],
  )
}

// ---------------------------------------------------------------------------
// Draft creation + loading
// ---------------------------------------------------------------------------

/** Lossless wire representation for PostgreSQL's six-digit timestamptz. */
export function documentRevisionSql(column: SQL): SQL<string> {
  return sql<string>`to_char(
    ${column} at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'
  )`
}

const DOCUMENT_REVISION_ALIAS = '__documentRevision'

/** Add the exact revision sidecar only to reads backed by the documents table. */
export function documentRevisionProjection(table: string): SQL {
  return table === 'documents'
    ? sql`, ${documentRevisionSql(sql.raw('updated_at'))} as "__documentRevision"`
    : sql``
}

/**
 * Replace the driver's noncanonical timestamp value with the exact persisted
 * wire revision, preserving the established updated_at response field.
 * Non-document records pass through untouched.
 */
export function normalizeDocumentRecordRevisions(
  table: string,
  rows: Record<string, unknown>[],
): Record<string, unknown>[] {
  if (table !== 'documents') return rows
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

/** Resolve the org's base currency (used when minting a draft). */
async function orgBaseCurrency(orgId: string): Promise<string> {
  const r = (await db.execute<{ base_currency: string }>(
    sql`select base_currency from orgs where id = ${orgId}`,
  ))
  return r.rows[0]?.base_currency ?? 'CAD'
}

/** Posting deps for the shared document machinery. Fails closed: throws
 * ControlAccountsIncompleteError unless ar/ap/bank are configured, so a
 * half-configured org can never hand undefined account ids to the kernel. */
export async function controlDeps(orgId: string) {
  return { control: await loadRequiredControlAccounts(orgId) }
}

/** Instant-into-draft: mint an empty draft document for a kind, return id + number. */
export async function createDocumentDraft(
  orgId: string,
  userId: string,
  kind: string,
  options: { runFlows?: boolean; source?: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction' } = {},
) {
  const cfg = docKindConfig(kind)
  if (!cfg) throw new Error(`unknown document kind "${kind}"`)
  const currency = await orgBaseCurrency(orgId)
  const root = (await db.execute<{ id: string }>(sql`
    select id from subsidiaries where org_id = ${orgId} and parent_id is null`))
  const subsidiaryId = root.rows[0]?.id ?? null
  const documentNumber = await nextDocumentNumber(orgId, kind, cfg.numberPrefix, subsidiaryId)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind,
      subsidiaryId,
      documentNumber,
      documentDate: await businessToday(orgId),
      currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  // Settle on_create flows before returning. Internal create writers reload
  // the resulting row (including its exact revision) before applying caller
  // input; a flow mutation can therefore never turn initialization into a
  // tokenless update or leave the writer holding the insert-time snapshot.
  if (options.runFlows !== false) {
    await runRecordFlows({ kind: 'on_create', source: options.source ?? 'ui' }, kind, doc!.id, { orgId, userId })
  }
  return doc!
}

/**
 * Materialize the user's edited replacement as a draft while preserving the
 * posted source. The `reverses` link carries the mandatory reversal-audit
 * evidence (reason + requester + timestamp — see buildReversalLinkEvidence)
 * and blocks submission until the source's controlled void completes.
 */
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
 * correction writer records (engine/src/document-correction.ts); the web draft
 * path composes it instead of hand-rolling a bare edge. Fails closed: an edge
 * without admissible evidence cannot be constructed here at all.
 *
 * Pure — unit-tested directly in documents.test.ts.
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

export async function createPostedCorrectionDraft(
  sourceId: string,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
  options: { deferFlows?: boolean } = {},
): Promise<{ id: string; documentNumber: string }> {
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)
  const reason = body.amendmentReason?.trim() ?? ''
  if (reason.length < 8 || reason.length > 500) {
    throw new DocumentEditError(422, 'A correction reason between 8 and 500 characters is required')
  }

  const created = await withOrgTransaction(ctx.orgId, async () => runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; updatedAt: string },
    { id: string; documentNumber: string; kind: string }
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    // The source revision is authoritative only while this lock is held. The
    // caller's outer command transaction (when present) is reused, so the lock
    // spans every dependent replacement write.
    lock: async (tx) => (await tx.execute<{
      kind: string
      status: string
      updatedAt: string
    }>(sql`
      select kind, status,
             ${documentRevisionSql(sql.raw('updated_at'))} as "updatedAt"
       from documents
       where id = ${sourceId} and org_id = ${ctx.orgId}
       for update
    `)).rows[0] ?? null,
    mutate: async (tx, source) => {
      const existingCorrection = (await tx.execute<{ documentNumber: string }>(sql`
        select replacement.document_number as "documentNumber"
          from document_links link
          join documents replacement
            on replacement.id = link.from_document_id
           and replacement.org_id = link.org_id
         where link.org_id = ${ctx.orgId}
           and link.to_document_id = ${sourceId}
           and link.link_type = 'reverses'
         limit 1
      `)).rows[0]
      assertNoExistingDocumentCorrection(existingCorrection?.documentNumber ?? null)
      if (source.status !== 'posted') {
        throw new DocumentEditError(422, 'only a posted document can create a correcting replacement')
      }
      const replacement = await createDocumentDraft(ctx.orgId, ctx.userId, source.kind, {
        runFlows: false,
        source: ctx.source,
      })
      const row = await loadDocumentEditCurrent(replacement.id, ctx.orgId)
      if (!row) throw new Error(`replacement document ${replacement.id} disappeared during initialization`)
      await applyDocumentEdit(
        replacement.id,
        row,
        { ...body, expectedUpdatedAt: row.updatedAt },
        {
          ...ctx,
          source: 'posted_correction',
          runFlows: false,
        },
      )
      await db.execute(sql`
        update documents
           set custom = coalesce(custom, '{}'::jsonb) ||
             ${JSON.stringify({
               correctionOf: sourceId,
               correctionReason: reason,
             })}::jsonb,
               updated_at = greatest(
                 clock_timestamp(),
                 updated_at + interval '1 microsecond'
               ),
               updated_by = ${ctx.userId}
         where id = ${replacement.id} and org_id = ${ctx.orgId}
      `)
      await db.insert(schema.documentLinks).values({
        orgId: ctx.orgId,
        ...buildReversalLinkEvidence({
          fromDocumentId: replacement.id,
          toDocumentId: sourceId,
          reason,
          requestedBy: ctx.userId,
        }),
        createdBy: ctx.userId,
        updatedBy: ctx.userId,
      })
      await db.execute(sql`
        insert into audit_log
          (org_id, table_name, row_id, action, changes, actor_id, request_id)
        values (
          ${ctx.orgId}, 'documents', ${replacement.id}, 'insert',
          ${JSON.stringify({
            mode: 'posted_correction_draft',
            sourceDocumentId: sourceId,
            reason,
          })}::jsonb,
          ${ctx.userId}, 'posted_correction'
        )
      `)
      return { ...replacement, kind: source.kind }
    },
  }))
  // Flow plans may enqueue email or other externally visible work. Dispatch
  // only after the transaction that made the correction visible commits. A
  // caller that owns a wider transaction defers this until its own commit.
  if (!options.deferFlows) {
    await runPostedCorrectionDraftFlows(created.id, created.kind, ctx)
  }
  return { id: created.id, documentNumber: created.documentNumber }
}

export async function runPostedCorrectionDraftFlows(
  correctionId: string,
  kind: string,
  ctx: DocumentEditContext,
): Promise<void> {
  await runRecordFlows(
    { kind: 'on_create', source: ctx.source },
    kind,
    correctionId,
    { orgId: ctx.orgId, userId: ctx.userId },
  )
}

/**
 * Full document payload for a drawer: header + lines. For open-item kinds
 * (invoices, credits) the applied amount is summed from un-reversed
 * applications against the posted entry's control open-item line, and
 * `balance_due` = total − applied.
 *
 * `target_transaction_amount`, NOT `amount`: `documents.total` is in the
 * document's TRANSACTION currency while `applications.amount` is the
 * base-currency carrying amount. Subtracting one from the other produced a
 * meaningless number for every FX document — the drawer showed a balance in
 * neither currency, and an FX invoice could read as paid while still open.
 * The transaction leg is the one denominated in the same currency as the
 * total (same fix as engine/src/dunning.ts).
 */
export async function loadDocument(id: string, orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute<Record<string, unknown> & { documentRevision: string }>(sql`
    select d.*, p.display_name as party_name, e.id as entry_id,
           ${documentRevisionSql(sql.raw('d.updated_at'))} as "documentRevision",
           ${sql`case when d.status = 'posted' then ap.applied end`} as applied,
           ${sql`case when d.status = 'posted' then d.total - ap.applied end`} as balance_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      left join lateral (
        select coalesce(sum(a.target_transaction_amount), 0) as applied
          from journal_lines jl
          join applications a on a.org_id = jl.org_id and a.to_line_id = jl.id and a.unapplied_at is null
         where jl.org_id = d.org_id and jl.entry_id = d.posted_entry_id and jl.is_open_item
      ) ap on true
     where d.id = ${id} and d.org_id = ${resolvedOrgId}
  `))
  const loaded = doc.rows[0]
  if (!loaded) return null
  // node-postgres maps timestamptz to JavaScript Date, which discards the
  // microseconds PostgreSQL retains. Keep the public `updated_at` shape, but
  // replace its lossy Date with the exact canonical token used by OCC.
  const { documentRevision, ...document } = loaded
  const exactDocument: Record<string, unknown> = {
    ...document,
    updated_at: documentRevision,
  }
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.line_number, l.account_id, l.item_id, l.description, l.quantity, l.unit,
           l.unit_price, l.amount, l.cost_rate, l.bill_rate, l.cost_amount, l.bill_amount, l.is_billable,
           l.tax_code_id, l.tax_group_id, l.tax_input_amount, l.tax_amount,
           l.tax_overridden, l.department_id, l.project_id, l.location_id, l.class_id,
           l.stock_location_id, l.extra_dims, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `))
  return { doc: exactDocument, lines: lines.rows }
}

// ---------------------------------------------------------------------------
// Shared edit service — the single source of truth for writing a posting
// document's header + lines. Both the interactive drawer route
// (app/api/documents/[id]/route.ts) and the public REST writer
// (lib/api/writers.ts) call this, so an API edit gets the exact same custom-
// field validation, GL re-materialization, transaction audit, CRM promotion,
// and on_update flows the UI does — no duplicated, drifting write logic.
// ---------------------------------------------------------------------------

/** A line as accepted on a document edit (built-ins + dimensions + custom). */
export interface DocumentLineInput extends BillLineInput {
  itemId?: string | null
  quantity?: string | null
  unit?: string | null
  unitPrice?: string | null
  /** Line entity: the customer/vendor/employee this line belongs to. */
  partyId?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  /** Warehouse used by inventory receipt or issue effects for this line. */
  stockLocationId?: string | null
  extraDims?: Record<string, string | null>
  custom?: Record<string, unknown>
}

/** The header + lines payload for a document edit. Every field is optional; an
 *  absent key leaves the stored value untouched (partial patch). */
export interface DocumentEditInput {
  /** Required evidence for every posted-document amendment. Not persisted on
   * the document; stored only in the immutable before/after audit envelope. */
  amendmentReason?: string
  /** Optimistic concurrency token from documents.updated_at. Required when
   * editing any existing document. A newly minted, still-private draft is the
   * sole initialization path that may omit it. */
  expectedUpdatedAt?: string
  partyId?: string | null
  paymentCardId?: string | null
  documentDate?: string
  dueDate?: string | null
  referenceNumber?: string | null
  memo?: string | null
  postingDate?: string | null
  departmentId?: string | null
  projectId?: string | null
  locationId?: string | null
  classId?: string | null
  extraDims?: Record<string, string | null>
  subsidiaryId?: string | null
  expectedPayDate?: string | null
  paymentHoldReason?: string | null
  internalNotes?: string | null
  billingMethod?: string | null
  isFinalInvoice?: boolean
  currency?: string
  custom?: Record<string, unknown>
  lines?: DocumentLineInput[]
}

/** The pre-edit snapshot a caller loads under its own org scope. */
export type DocumentEditCurrent = {
  kind: string
  status: string
  total: string
  taxTotal: string
  partyId: string | null
  documentDate: string
  updatedAt: string
};

/** Exact edit snapshot used by every internal and external document writer. */
export async function loadDocumentEditCurrent(
  id: string,
  orgId: string,
): Promise<DocumentEditCurrent | null> {
  const result = await db.execute<DocumentEditCurrent>(sql`
    select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
           document_date as "documentDate",
           ${documentRevisionSql(sql.raw('updated_at'))} as "updatedAt"
      from documents
     where id = ${id} and org_id = ${orgId}
  `)
  return result.rows[0] ?? null
}

export interface DocumentEditContext {
  orgId: string
  userId: string
  /** Provenance recorded on the transaction audit + flow events. */
  source: 'ui' | 'api' | 'mcp' | 'assistant' | 'posted_correction'
  /** Fire on_update record flows after the edit commits (default true). */
  runFlows?: boolean
}

/** Exact numeric(19,4) money string, or null when the value is not canonical. */
function exactMoney(value: unknown): string | null {
  const exact = canonicalDecimal(value, 4)
  if (exact === null) return null
  try {
    return normalizeMoney(exact)
  } catch {
    return null
  }
}

/** A validation/period failure with the HTTP status the callers should return. */
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

const DOCUMENT_EDIT_REVISION_CONFLICT =
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
 * document's revision ADVANCES on every update: this module's writers bump
 * with greatest(clock_timestamp(), updated_at + interval '1 microsecond'),
 * and migration 0013_document_revision_monotonic rewrites any other writer's
 * byte-identical repeat forward at the database boundary. Two committed
 * revisions can therefore never serialize to one token, so an equal-string
 * match really does mean "nothing changed since you read it" — and a
 * millisecond-truncated token from a lossy reader fails the six-digit
 * requireDocumentEditRevision format instead of silently comparing equal.
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
 * the documentRevisionSql projection guarantees. String equality between two
 * equally lossy values — a driver-mapped Date coerced back to text,
 * PostgreSQL's default timestamp rendering, a truncated fractional part —
 * would otherwise authorize a write against a revision this system can never
 * have handed out, so a lock without an exact token fails closed before any
 * comparison runs.
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

type DocumentTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0]

/**
 * Draft-line validation for the generic editor. The save path used to FILTER
 * OUT every line without a positive amount, so a credit-memo leg, a discount
 * line, or a zero memo line silently vanished on any edit and the totals were
 * recomputed without it — silent data loss on a financial document. The tax
 * engine computes signed bases (engine/src/tax.ts), so negative and zero
 * lines are legitimate and pass through to computeBillTotals untouched; the
 * only rejections are what the calculator provably cannot use — a missing
 * account, or an amount that is not an exact decimal within ledger scale —
 * and each rejection names its line so the editor can point at the cell.
 *
 * Pure — unit-tested directly in documents.test.ts.
 */
export function validateEditableDocumentLines(lines: DocumentLineInput[]): DocumentLineInput[] {
  return lines.map((l, i) => {
    const n = i + 1
    if (!l.accountId) {
      throw new DocumentEditError(422, `Line ${n}: an account is required`)
    }
    if (l.amount === undefined || l.amount === null || String(l.amount).trim() === '') {
      throw new DocumentEditError(422, `Line ${n}: an amount is required`)
    }
    if (exactMoney(l.amount) === null) {
      throw new DocumentEditError(
        422,
        `Line ${n}: "${l.amount}" is not a valid amount — enter an exact decimal of at most 4 decimal places`,
      )
    }
    return l
  })
}

/**
 * A document-layer signature of everything that shapes a posting document's GL
 * impact. Comparing before vs after a save tells us whether the edit was
 * GL-affecting WITHOUT assuming the stored entry was produced by our own
 * posting rules (migrated docs carry the source system's GL). Non-GL edits
 * (memo, reference #) leave this unchanged and never touch the ledger.
 */
/**
 * Apply a header + lines edit to a draft posting document. Approval snapshots
 * and posted history are immutable; rejected records return to draft before
 * editing, and posted corrections use controlled reversals/adjustments.
 *
 * Callers own auth + status/lock guards; this owns validation, the write, GL,
 * audit, and flows.
 */
export async function applyDocumentEdit(
  id: string,
  current: DocumentEditCurrent,
  body: DocumentEditInput,
  ctx: DocumentEditContext,
): Promise<void> {
  const cfg = docKindConfig(current.kind)
  if (!cfg) throw new DocumentEditError(422, `kind "${current.kind}" is not editable`)
  if (current.status !== 'draft') {
    throw new DocumentEditError(
      422,
      `a ${current.status} document cannot be edited — return it to draft or create a controlled correction`,
    )
  }
  const { orgId, userId } = ctx

  // Every call edits a row that already exists. Internal create/correction
  // paths read its exact persisted token first; no row shape may authorize a
  // missing revision.
  const expectedRevision = requireDocumentEditRevision(body.expectedUpdatedAt)

  // Kinds with a party role (vendor/customer) must keep a party — an explicit
  // null would strand the document without the entity its posting depends on.
  if (cfg.partyRole && body.partyId === null) {
    throw new DocumentEditError(422, `a ${current.kind} requires a ${cfg.partyRole}; the party cannot be removed`)
  }
  if (body.subsidiaryId !== undefined && body.subsidiaryId !== null) {
    const subsidiary = (await db.execute(sql`
      select 1 from subsidiaries
       where id = ${body.subsidiaryId} and org_id = ${orgId}
         and is_active and not is_elimination`))
    if (!subsidiary.rows.length) throw new DocumentEditError(422, 'invalid subsidiary')
  }
  if (body.currency !== undefined && !(await isFeatureEnabled(orgId, 'multiCurrency'))) {
    throw new DocumentEditError(404, 'not found')
  }
  let currency: string | undefined
  if (body.currency !== undefined) {
    const code = String(body.currency).trim().toUpperCase()
    if (!/^[A-Z]{3}$/.test(code)) throw new DocumentEditError(422, 'invalid currency')
    const found = (await db.execute(sql`select 1 from currencies where code = ${code}`)) as { rows: unknown[] }
    if (!found.rows[0]) throw new DocumentEditError(422, 'invalid currency')
    currency = code
  }

  // custom-field validation (header + line) against the live definitions
  // applyDocumentEdit can participate in a caller-owned transaction (posted
  // correction initialization). Do not overlap queries on that one pinned
  // node-postgres client; concurrent client.query calls are unsupported and
  // can reorder protocol messages under load.
  const headerDefs = await loadFieldDefs('documents', current.kind)
  const lineDefs = await loadFieldDefs('document_lines', current.kind)
  const segments = await segmentRegistry(orgId)
  const headerDims = body.extraDims === undefined ? null : validateExtraDims(body.extraDims, segments)
  if (headerDims && !headerDims.ok) throw new DocumentEditError(422, headerDims.error!)
  let headerCustom: Record<string, unknown> | null = null
  if (body.custom !== undefined) {
    const v = validateCustomValues(headerDefs, body.custom)
    if (!v.ok) throw new DocumentEditError(422, Object.values(v.errors)[0]!, v.errors)
    headerCustom = v.cleaned
  }

  // Pre-validate + prepare lines before touching the DB, so a bad line fails
  // without a partial write.
  let totals: { subtotal: string; taxTotal: string; total: string } | null = null
  let preparedLines:
    | { accountId: string; itemId: string | null; description: string | null; quantity: string | null; unit: string | null; unitPrice: string | null; amount: string; taxCodeId: string | null; taxGroupId: string | null; taxInputAmount: string; taxAmount: string; taxOverridden: boolean; taxComponents: ReturnType<typeof computeBillTotals>['lines'][number]['taxComponents']; providerQuote?: ReturnType<typeof computeBillTotals>['lines'][number]['providerQuote']; partyId: string | null; departmentId: string | null; projectId: string | null; locationId: string | null; classId: string | null; stockLocationId: string | null; extraDims: Record<string, string>; custom: Record<string, unknown> }[]
    | null = null
  if (body.lines) {
    // Charge lines are NOT editable through the generic line editor, and this
    // has to be refused at the service boundary rather than by the drawer
    // hiding the controls (which is all that stopped it before).
    //
    // The generic path replaces lines by delete-and-reinsert with the shared
    // column set. A project charge or field ticket line also carries an
    // immutable rate snapshot (rate_version_id, base_quantity, cost/bill
    // amounts, the charge_rate_components rows keyed to the line id) and now
    // the equipment unit and its OPERATOR. Re-inserting through the generic
    // shape silently drops every one of them: the customer's billable value
    // becomes zero, the rate components orphan, and the operator's equipment
    // incentive quietly stops being payable. Those lines have their own
    // writers (createProjectCharge / addTicketLine) and must go through them.
    if (current.kind === 'project_charge' || current.kind === 'field_ticket') {
      throw new DocumentEditError(
        422,
        `${current.kind} lines carry an immutable rate snapshot and cannot be edited here; ` +
          `change them on the source record`,
      )
    }
    // Validate, don't filter. The old `filter((l) => l.accountId && cmp(l.amount, '0') > 0)`
    // dropped negative and zero lines before the totals were computed, so any
    // edit of a document carrying one rewrote it without that line — the
    // credit-memo leg disappeared and the balance silently moved. Every line
    // the caller sent now either reaches computeBillTotals exactly as
    // submitted (the tax engine handles signed bases) or fails closed with a
    // 422 naming the offending line.
    const computed = await computeBillTotalsWithProvider(
      validateEditableDocumentLines(body.lines),
      await taxProfileMap(orgId, body.documentDate ?? current.documentDate),
      {
        orgId,
        kind: current.kind,
        currency: currency ?? (await db.execute<{ currency: string }>(sql`
          select currency from documents where id = ${id} and org_id = ${orgId}`)).rows[0]?.currency ?? await orgBaseCurrency(orgId),
        documentDate: body.documentDate ?? current.documentDate,
        partyId: body.partyId !== undefined ? body.partyId : current.partyId,
      },
    )
    totals = {
      subtotal: normalizeMoney(computed.subtotal),
      taxTotal: normalizeMoney(computed.taxTotal),
      total: normalizeMoney(computed.total),
    }
    // A transfer moves one amount between two accounts; its two legs carry the
    // same amount, so the document total is that amount — NOT the summed legs.
    if (current.kind === 'transfer' && computed.lines.length > 0) {
      const amt = normalizeMoney(computed.lines[0]!.amount)
      totals = { subtotal: amt, taxTotal: '0.0000', total: amt }
    }
    preparedLines = []
    for (let i = 0; i < computed.lines.length; i++) {
      const l = computed.lines[i]! as (typeof computed.lines)[number] & DocumentLineInput
      const lv = validateCustomValues(lineDefs, l.custom)
      if (!lv.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${Object.values(lv.errors)[0]}`, lv.errors)
      const lineDims = validateExtraDims(l.extraDims ?? {}, segments)
      if (!lineDims.ok) throw new DocumentEditError(422, `Line ${i + 1}: ${lineDims.error}`)
      let unitPrice: string | null = null
      if (l.unitPrice != null && String(l.unitPrice).trim() !== '') {
        unitPrice = exactMoney(l.unitPrice)
        if (unitPrice === null) {
          throw new DocumentEditError(422, `Line ${i + 1}: unit price is not a valid amount`)
        }
      }
      const amount = exactMoney(l.amount)
      if (amount === null) {
        throw new DocumentEditError(422, `Line ${i + 1}: amount is not a valid amount`)
      }
      preparedLines.push({
        accountId: l.accountId!,
        itemId: l.itemId ?? null,
        description: l.description ?? null,
        quantity: l.quantity ?? null,
        unit: l.unit ?? null,
        unitPrice,
        amount,
        taxCodeId: l.taxCodeId ?? null,
        taxGroupId: l.taxGroupId ?? null,
        taxInputAmount: l.taxInputAmount,
        taxAmount: l.taxAmount,
        taxOverridden: l.taxOverridden === true,
        taxComponents: l.taxComponents,
        providerQuote: l.providerQuote,
        partyId: l.partyId ?? null,
        departmentId: l.departmentId ?? null,
        projectId: l.projectId ?? null,
        locationId: l.locationId ?? null,
        classId: l.classId ?? null,
        stockLocationId: l.stockLocationId ?? null,
        extraDims: lineDims.cleaned,
        custom: lv.cleaned,
      })
    }
  }

  // Filled under the document lock for line-level flow change detection.
  let oldLines: {
    lineNumber: number
    accountId: string | null
    departmentId: string | null
    projectId: string | null
    amount: string
  }[] = []

  // All writes + the GL-Impact re-materialization happen in one transaction, so
  // a GL edit into a closed period rolls the whole edit back (nothing partial).
  // The row lock and exact revision comparison are the first operations in that same
  // transaction: a concurrent writer cannot slip between the check and the
  // header/line replacement.
  await runDocumentVersionedTransaction<
    DocumentTransaction,
    { kind: string; status: string; updatedAt: string },
    void
  >({
    expectedRevision,
    transaction: (work) => db.transaction(work),
    lock: async (tx) => (await tx.execute<{
        kind: string
        status: string
        updatedAt: string
      }>(sql`
        select kind, status,
               ${documentRevisionSql(sql.raw('updated_at'))} as "updatedAt"
          from documents
         where id = ${id} and org_id = ${orgId}
         for update
      `)).rows[0] ?? null,
    mutate: async (tx, locked) => {
      if (locked.kind !== current.kind) throw new DocumentEditError(409, DOCUMENT_EDIT_REVISION_CONFLICT)
      if (locked.status !== 'draft') {
        throw new DocumentEditError(
          422,
          `a ${locked.status} document cannot be edited — return it to draft or create a controlled correction`,
        )
      }

      const auditBefore = await captureTransactionAuditSnapshot(tx, id, ctx.orgId)
      oldLines = ((await tx.execute<{
        lineNumber: number
        accountId: string | null
        departmentId: string | null
        projectId: string | null
        amount: string
      }>(sql`
        select line_number as "lineNumber", account_id as "accountId", department_id as "departmentId",
               project_id as "projectId", amount
          from document_lines
         where document_id = ${id} and org_id = ${ctx.orgId}
         order by line_number
      `))).rows

      if (preparedLines) {
        await tx.execute(sql`delete from document_lines where document_id = ${id} and org_id = ${orgId}`)
        for (let i = 0; i < preparedLines.length; i++) {
          const l = preparedLines[i]!
          const inserted = (await tx.execute<{ id: string }>(sql`
            insert into document_lines (org_id, document_id, line_number, account_id, item_id, description,
                                        quantity, unit, unit_price, amount, tax_code_id, tax_group_id, tax_input_amount,
                                        tax_amount, tax_overridden,
                                        party_id, department_id, project_id, location_id, class_id,
                                        stock_location_id, extra_dims, custom)
            values (${orgId}, ${id}, ${i + 1}, ${l.accountId}, ${l.itemId}, ${l.description},
                    ${l.quantity ?? '1'}, ${l.unit}, ${l.unitPrice ?? l.amount}, ${l.amount},
                    ${l.taxCodeId}, ${l.taxGroupId}, ${l.taxInputAmount}, ${l.taxAmount}, ${l.taxOverridden},
                    ${l.partyId}, ${l.departmentId}, ${l.projectId}, ${l.locationId}, ${l.classId},
                    ${l.stockLocationId}, ${JSON.stringify(l.extraDims)}::jsonb, ${JSON.stringify(l.custom)})
            returning id
          `))
          await persistLineTaxComponents(tx, {
            orgId,
            documentLineId: inserted.rows[0]!.id,
            components: l.taxComponents,
            actorId: userId,
          })
          if (l.providerQuote) {
            await persistTaxQuote(
              orgId,
              l.providerQuote.providerConfigId,
              { ...l.providerQuote.request, documentLineId: inserted.rows[0]!.id },
              l.providerQuote.result,
              userId,
              tx,
            )
            await tx.execute(sql`
              update tax_rate_provider_configs
                 set last_attempt_at = now(), last_success_at = now(), last_error = null
               where id = ${l.providerQuote.providerConfigId} and org_id = ${orgId}
            `)
          }
        }
      }

      await tx.execute(sql`
        update documents set
          party_id = ${body.partyId !== undefined ? body.partyId : sql`party_id`},
          payment_card_id = ${body.paymentCardId !== undefined ? body.paymentCardId : sql`payment_card_id`},
          document_date = coalesce(${body.documentDate ?? null}, document_date),
          due_date = ${body.dueDate !== undefined ? body.dueDate : sql`due_date`},
          reference_number = ${body.referenceNumber !== undefined ? body.referenceNumber : sql`reference_number`},
          memo = ${body.memo !== undefined ? body.memo : sql`memo`},
          posting_date = ${body.postingDate !== undefined ? body.postingDate : sql`posting_date`},
          department_id = ${body.departmentId !== undefined ? body.departmentId : sql`department_id`},
          project_id = ${body.projectId !== undefined ? body.projectId : sql`project_id`},
          location_id = ${body.locationId !== undefined ? body.locationId : sql`location_id`},
          class_id = ${body.classId !== undefined ? body.classId : sql`class_id`},
          extra_dims = ${headerDims ? JSON.stringify(headerDims.cleaned) : sql`extra_dims`}::jsonb,
          subsidiary_id = ${body.subsidiaryId !== undefined ? body.subsidiaryId : sql`subsidiary_id`},
          expected_pay_date = ${body.expectedPayDate !== undefined ? body.expectedPayDate : sql`expected_pay_date`},
          payment_hold_reason = ${body.paymentHoldReason !== undefined ? body.paymentHoldReason : sql`payment_hold_reason`},
          internal_notes = ${body.internalNotes !== undefined ? body.internalNotes : sql`internal_notes`},
          billing_method = ${body.billingMethod !== undefined ? body.billingMethod : sql`billing_method`},
          is_final_invoice = ${body.isFinalInvoice !== undefined ? body.isFinalInvoice : sql`is_final_invoice`},
          currency = ${currency !== undefined ? currency : sql`currency`},
          custom = coalesce(${headerCustom ? JSON.stringify(headerCustom) : null}::jsonb, custom),
          subtotal = coalesce(${totals?.subtotal ?? null}, subtotal),
          tax_total = coalesce(${totals?.taxTotal ?? null}, tax_total),
          total = coalesce(${totals?.total ?? null}, total),
          updated_at = greatest(
            clock_timestamp(),
            updated_at + interval '1 microsecond'
          ),
          updated_by = ${userId}
        where id = ${id} and org_id = ${orgId}
      `)

      const effectivePartyId = body.partyId !== undefined ? body.partyId : current.partyId
      if (effectivePartyId && ['customer_invoice', 'customer_credit', 'customer_payment'].includes(current.kind)) {
        await promoteCrmAccount(tx, {
          orgId,
          partyId: effectivePartyId,
          actorId: userId,
          toStage: 'customer',
          sourceKind: current.kind,
          sourceId: id,
        })
      }

      if (auditBefore) {
        const auditAfter = await captureTransactionAuditSnapshot(tx, id, ctx.orgId)
        if (!auditAfter) throw new Error(`document ${id} disappeared during amendment`)
        await recordTransactionAudit(tx, {
          orgId,
          documentId: id,
          action: 'update',
          actorId: userId,
          source: ctx.source,
          reason: body.amendmentReason?.trim(),
          before: auditBefore,
          after: auditAfter,
        })
      }
    },
  })

  // on_update flows fire AFTER the edit commits (unless the caller opts out).
  // The edit-shape data rides on the EVENT (previousTotal / totalChanged /
  // changedFields / changedLineFields). runRecordFlows never throws into the
  // caller and cannot veto the saved edit; it is awaited so it runs inside the
  // caller's RLS org scope.
  if (ctx.runFlows === false) return
  const newTotal = totals?.total ?? current.total
  const newTaxTotal = totals?.taxTotal ?? current.taxTotal
  const changedFields: string[] = []
  if (cmp(newTotal, current.total) !== 0) changedFields.push('total')
  if (cmp(newTaxTotal, current.taxTotal) !== 0) changedFields.push('taxTotal')
  if (body.partyId !== undefined && body.partyId !== current.partyId) changedFields.push('partyId')
  const changedLineFields = new Set<string>()
  if (preparedLines) {
    const maxLen = Math.max(oldLines.length, preparedLines.length)
    for (let i = 0; i < maxLen; i++) {
      const o = oldLines[i]
      const n = preparedLines[i]
      if (!o || !n) {
        changedLineFields.add('accountId').add('departmentId').add('projectId').add('amount')
        break
      }
      if (o.accountId !== n.accountId) changedLineFields.add('accountId')
      if ((o.departmentId ?? null) !== (n.departmentId ?? null)) changedLineFields.add('departmentId')
      if ((o.projectId ?? null) !== (n.projectId ?? null)) changedLineFields.add('projectId')
      if (cmp(o.amount, n.amount) !== 0) changedLineFields.add('amount')
    }
  }
  await runRecordFlows(
    {
      kind: 'on_update',
      source: ctx.source,
      previousTotal: current.total,
      totalChanged: cmp(newTotal, current.total) !== 0,
      changedFields,
      changedLineFields: [...changedLineFields],
      old: { total: current.total, taxTotal: current.taxTotal },
    },
    current.kind,
    id,
    { orgId, userId },
  )
}

// ---------------------------------------------------------------------------
// Picker option loaders (shared by every list page's drawer hydration)
// ---------------------------------------------------------------------------

export type Opt = {
  id: string
  display_name?: string
  number?: string
  name?: string
  code?: string
  rate?: string
  label?: string
  last_four?: string
  network?: string
  liability_account_id?: string
  /** Party pickers carry the party's primary subsidiary (drafts default to it). */
  subsidiary_id?: string | null
  tax_components?: import('@openbooks/engine/src/tax.ts').TaxComponentConfig[]
};

export async function partyOptions(role: 'vendor' | 'customer', orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const filter =
    role === 'vendor'
      ? sql`exists (select 1 from vendor_roles vr
                     where vr.org_id = p.org_id
                       and vr.party_id = p.id
                       and vr.is_active)`
      : sql`exists (select 1 from customer_roles cr
                     where cr.org_id = p.org_id
                       and cr.party_id = p.id
                       and cr.is_active)`
  const r = (await db.execute<Opt>(sql`
    select p.id, p.display_name, p.subsidiary_id from parties p
     where p.org_id = ${resolvedOrgId} and ${filter} and p.is_active
     order by p.display_name limit 2000
  `))
  return r.rows
}

export async function accountOptions(cfg: DocKindConfig, orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const typeFilter = cfg.accountTypes
    ? sql` and a.type in (${sql.join(cfg.accountTypes.map((ty) => sql`${ty}`), sql`, `)})`
    : sql``
  const r = (await db.execute<Opt>(sql`
    select id, number, name from accounts a
     where a.org_id = ${resolvedOrgId} and a.is_active and not a.is_summary ${typeFilter}
     order by a.number nulls last
  `))
  return r.rows
}

export async function taxCodeOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const profiles = await taxProfileMap(resolvedOrgId)
  const r = (await db.execute<Opt>(sql`
    select tc.id, tc.code, tc.name, coalesce(tr.rate_percent, 0) as rate
      from tax_codes tc
      left join lateral (
        select rate_percent from tax_rates
         where org_id = ${resolvedOrgId} and tax_code_id = tc.id and effective_from <= now()
         order by effective_from desc limit 1) tr on true
     where tc.org_id = ${resolvedOrgId} and tc.is_active order by tc.code
  `))
  return r.rows.map((row) => ({ ...row, tax_components: profiles.codes.get(row.id) ?? [] }))
}

export async function taxGroupOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const profiles = await taxProfileMap(resolvedOrgId)
  const result = (await db.execute<Opt>(sql`
    select id, code, name from tax_groups
     where org_id = ${resolvedOrgId} and is_active order by code
  `))
  return result.rows.map((row) => ({ ...row, tax_components: profiles.groups.get(row.id) ?? [] }))
}

export async function dimensionOptions(orgId?: string) {
  const resolvedOrgId = await resolveOrgId(orgId)
  const [departments, projects, locations, classes, registry] = await Promise.all([
    db.execute(sql`select id, name from departments where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`select id, name from projects where org_id = ${resolvedOrgId} and is_active order by name limit 2000`),
    db.execute(sql`select id, name from locations where org_id = ${resolvedOrgId} and is_active order by name`),
    db.execute(sql`select id, name from classes where org_id = ${resolvedOrgId} and is_active order by name`),
    segmentRegistry(resolvedOrgId),
  ])
  return {
    departments: departments.rows as Opt[],
    projects: projects.rows as Opt[],
    locations: locations.rows as Opt[],
    classes: classes.rows as Opt[],
    segments: registry.filter((segment) => segment.sourceKind === 'custom'),
    builtinSegments: registry.filter((segment) => segment.sourceKind === 'builtin'),
  }
}

/** Active catalog items (for the optional line `item` column). */
export async function itemOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<Opt>(sql`
    select id, code, name from items where org_id = ${resolvedOrgId} and is_active order by coalesce(code, name), name limit 2000
  `))
  return r.rows
}

/** Active corporate cards (for card_charge / card_refund funding source). */
export async function cardOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<any>(sql`
    select pc.id, pc.label, pc.last_four, pc.network, pc.liability_account_id, p.display_name as holder
      from payment_cards pc
      left join parties p on p.id = pc.holder_party_id and p.org_id = pc.org_id
     where pc.org_id = ${resolvedOrgId} and pc.is_active
     order by pc.label
  `))
  return r.rows.map((c) => ({
    id: c.id,
    label: c.last_four ? `${c.label}` : c.label,
    display_name: c.last_four ? `${c.network ?? ''} •••• ${c.last_four} — ${c.holder ?? ''}`.trim() : c.label,
    last_four: c.last_four,
    network: c.network,
    liability_account_id: c.liability_account_id,
  }))
}

/** Reconcilable bank accounts (for check funding source + transfer legs). */
export async function bankAccountOptions(orgId?: string): Promise<Opt[]> {
  const resolvedOrgId = await resolveOrgId(orgId)
  const r = (await db.execute<Opt>(sql`
    select id, number, name from accounts
     where org_id = ${resolvedOrgId} and is_active and not is_summary and reconcilable and type = 'asset_bank'
     order by number nulls last
  `))
  return r.rows
}
