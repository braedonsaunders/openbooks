import 'server-only'
import { sql } from 'drizzle-orm'
import { db, schema } from '@openbooks/engine/src/db.ts'
import { nextDocumentNumber } from './bills'
import { resolveOrgId } from './org-scope'
import { businessToday } from '@openbooks/engine/src/business-date.ts'
import { allowedSubsidiaryIds as resolveAllowedSubsidiaryIds } from './subsidiaries'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface CreateDraftJournalOptions {
  /** Explicit legal entity requested by the caller (omitted = choose a default). */
  subsidiaryId?: string | null
  /** null = unrestricted; a Set = the caller's authorized subsidiary scope. */
  allowedSubsidiaryIds?: ReadonlySet<string> | null
}

export type DraftJournalScopeErrorCode =
  | 'invalid_subsidiary'
  | 'subsidiary_not_allowed'
  | 'no_available_subsidiary'
  | 'ambiguous_subsidiary_scope'

/** Request-state refusal for an invalid or unresolved draft-journal scope. */
export class DraftJournalScopeError extends Error {
  readonly name = 'DraftJournalScopeError'

  constructor(
    public readonly code: DraftJournalScopeErrorCode,
    message: string,
  ) {
    super(message)
  }
}

/** Instant-into-draft: empty manual journal document (kind 'journal', JE- sequence). */
export async function createDraftJournal(
  orgId: string,
  userId: string,
  options: CreateDraftJournalOptions = {},
) {
  // Existing non-HTTP callers do not carry an authorization scope. Resolve it
  // from the actor so they cannot bypass the same invariant as this route.
  // Unrestricted roles resolve to null and retain the existing root behavior.
  const resolvedScope = options.allowedSubsidiaryIds === undefined
    ? await resolveAllowedSubsidiaryIds(userId, orgId)
    : options.allowedSubsidiaryIds
  const scope = resolvedScope === null
    ? null
    : new Set([...resolvedScope].map((id) => id.toLowerCase()))
  const requestedSubsidiaryId = options.subsidiaryId
  let subsidiary: { id: string; base_currency: string } | undefined

  if (requestedSubsidiaryId !== undefined && requestedSubsidiaryId !== null) {
    if (!UUID_RE.test(requestedSubsidiaryId)) {
      throw new DraftJournalScopeError('invalid_subsidiary', 'invalid subsidiary')
    }
    const normalizedSubsidiaryId = requestedSubsidiaryId.toLowerCase()
    if (scope !== null && !scope.has(normalizedSubsidiaryId)) {
      // Keep an out-of-scope entity indistinguishable from an unavailable one.
      throw new DraftJournalScopeError('subsidiary_not_allowed', 'not found')
    }
    const explicit = (await db.execute<{ id: string; base_currency: string }>(sql`
      select id, base_currency
        from subsidiaries
       where org_id = ${orgId} and id = ${normalizedSubsidiaryId}
         and is_active and not is_elimination`)).rows[0]
    if (!explicit) throw new DraftJournalScopeError('invalid_subsidiary', 'invalid subsidiary')
    subsidiary = explicit
  } else if (scope !== null) {
    // A restricted caller may auto-select only when the database confirms
    // exactly one active, non-elimination legal entity in its allowed set.
    const ids = [...scope].filter((id) => UUID_RE.test(id))
    if (ids.length === 0) {
      throw new DraftJournalScopeError('no_available_subsidiary', 'no available subsidiary')
    }
    const allowed = (await db.execute<{ id: string; base_currency: string }>(sql`
      select id, base_currency
        from subsidiaries
       where org_id = ${orgId} and is_active and not is_elimination
         and id = any(${`{${ids.join(',')}}`}::uuid[])`)).rows
    if (allowed.length === 0) {
      throw new DraftJournalScopeError('no_available_subsidiary', 'no available subsidiary')
    }
    if (allowed.length !== 1) {
      throw new DraftJournalScopeError(
        'ambiguous_subsidiary_scope',
        'a subsidiary must be selected when more than one legal entity is available',
      )
    }
    subsidiary = allowed[0]
  } else {
    const root = (await db.execute<{ id: string; base_currency: string }>(sql`
      select id, base_currency from subsidiaries where org_id = ${orgId} and parent_id is null`))
    subsidiary = root.rows[0]
    if (!subsidiary) throw new Error('org has no root subsidiary')
  }

  if (!subsidiary) throw new Error('no subsidiary selected')
  const documentNumber = await nextDocumentNumber(orgId, 'journal', 'JE-', subsidiary.id)
  const [doc] = await db
    .insert(schema.documents)
    .values({
      orgId,
      kind: 'journal',
      subsidiaryId: subsidiary.id,
      documentNumber,
      documentDate: await businessToday(orgId),
      currency: subsidiary.base_currency,
      subtotal: '0',
      taxTotal: '0',
      total: '0',
      createdBy: userId,
    })
    .returning({ id: schema.documents.id, documentNumber: schema.documents.documentNumber })
  return doc!
}

/** Full manual-journal payload for the drawer: header + signed lines. */
export async function loadJournalDoc(id: string, orgId?: string) {
  if (!UUID_RE.test(id)) return null
  const resolvedOrgId = await resolveOrgId(orgId)
  const doc = (await db.execute<Record<string, unknown>>(sql`
    select d.*, p.display_name as party_name, e.id as entry_id
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
     where d.id = ${id} and d.org_id = ${resolvedOrgId} and d.kind = 'journal'
  `))
  if (!doc.rows[0]) return null
  const lines = (await db.execute<Record<string, unknown>>(sql`
    select l.id, l.line_number, l.account_id, l.description, l.amount,
           l.party_id, l.department_id, l.project_id, l.subsidiary_id, l.extra_dims, l.custom
      from document_lines l
     where l.document_id = ${id} and l.org_id = ${resolvedOrgId}
     order by l.line_number
  `))
  return { doc: doc.rows[0], lines: lines.rows }
}
