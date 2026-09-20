/**
 * Explicit-organization document reads and posting dependencies. No session,
 * framework, editor, or web imports: adapters supply the organization and enforce
 * permissions/feature/subsidiary access before exposing these results.
 */
import { sql } from 'drizzle-orm'
import { db } from '../platform/db.ts'
import { documentBalanceDueLateral } from '../records/balance-due.ts'
import { documentRevisionCounterSql } from '../records/revision.ts'
import { loadRequiredControlAccounts } from '../records/control-accounts.ts'
import type { DocumentEditCurrent } from './document-input.ts'
import { DocumentEditError } from '../records/document-edit-policy.ts'

function requireOrganization(orgId: string): void {
  if (typeof orgId !== 'string' || !orgId.trim()) {
    throw new DocumentEditError(422, 'organization id is required; supply the document organization explicitly')
  }
}

/** Posting deps for the shared document machinery. Fails closed: throws
 * ControlAccountsIncompleteError unless ar/ap/bank are configured, so a
 * half-configured org can never hand undefined account ids to the kernel. */
export async function controlDeps(orgId: string) {
  requireOrganization(orgId)
  return { control: await loadRequiredControlAccounts(orgId) }
}

/**
 * Full document payload for a drawer: header + lines. For open-item kinds
 * (invoices, credits) `applied` and `balance_due` (= total − applied) come
 * from the shared balance-due reader (engine/src/records/balance-due.ts), so the
 * drawer, the customer PDF, and dunning report the same figure by
 * construction. Both stay NULL until the document posts.
 */
export async function loadDocument(id: string, orgId: string) {
  requireOrganization(orgId)
  const doc = (await db.execute<Record<string, unknown> & { documentRevision: string }>(sql`
    select d.*, p.display_name as party_name, e.id as entry_id,
           ${documentRevisionCounterSql(sql.raw('d.revision_seq'))} as "documentRevision",
           ${sql`case when d.status = 'posted' then ap.applied end`} as applied,
           ${sql`case when d.status = 'posted' then d.total - ap.applied end`} as balance_due
      from documents d
      left join parties p on p.id = d.party_id and p.org_id = d.org_id
      left join journal_entries e on e.id = d.posted_entry_id and e.org_id = d.org_id
      ${documentBalanceDueLateral()}
     where d.id = ${id} and d.org_id = ${orgId}
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
           l.stock_location_id, l.extra_dims, l.custom,
           l.distribution_group_id, l.distribution_rule_id, l.distribution_version_id,
           l.distribution_locked, ar.name as distribution_rule_name
      from document_lines l
      left join allocation_rules ar on ar.id = l.distribution_rule_id and ar.org_id = l.org_id
     where l.document_id = ${id} and l.org_id = ${orgId}
     order by l.line_number
  `))
  return { doc: exactDocument, lines: lines.rows }
}

/** Exact edit snapshot used by every internal and external document writer. */
export async function loadDocumentEditCurrent(
  id: string,
  orgId: string,
): Promise<DocumentEditCurrent | null> {
  requireOrganization(orgId)
  const result = await db.execute<DocumentEditCurrent>(sql`
    select kind, status, total, tax_total as "taxTotal", party_id as "partyId",
           document_date as "documentDate",
           custom,
           ${documentRevisionCounterSql(sql.raw('revision_seq'))} as "updatedAt"
      from documents
     where id = ${id} and org_id = ${orgId}
  `)
  return result.rows[0] ?? null
}
