import 'server-only'
import { sql } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import { moduleDrawerHref } from './txn-links'
import type { Authz } from './authz'
import { can } from './authz'
import { disabledDocKinds } from './documents'
import { isFeatureEnabled } from './features'
import { subsidiaryVisibleFilter } from './subsidiaries'

/**
 * Global search — one query fans out across every primary entity (contacts,
 * transactions, accounts, items, projects) in parallel and returns grouped,
 * ranked hits. Matching is trigram-fuzzy (`col % q`, typo-tolerant via pg_trgm)
 * OR substring (`ILIKE`), ranked by `similarity()`; a numeric query also matches
 * transaction totals and document numbers. Org-scoped and permission-filtered.
 *
 * The pg_trgm GIN indexes (migration 0016) make the `%` / ILIKE predicates and
 * the similarity ordering fast at scale.
 */

export type SearchType = 'transaction' | 'contact' | 'account' | 'item' | 'project'

export interface SearchHit {
  id: string
  type: SearchType
  title: string
  subtitle?: string
  href: string
  iconKey: string
  badge?: string
  amount?: string
}

export interface SearchGroup {
  type: SearchType
  labelKey: string
  hits: SearchHit[]
}

export interface SearchResponse {
  q: string
  groups: SearchGroup[]
  total: number
}

// Document kind → { human label, nav icon }. Mirrors txn-links' DOC_MODULE.
const DOC_META: Record<string, { label: string; icon: string }> = {
  vendor_bill: { label: 'Bill', icon: 'clipboard' },
  vendor_credit: { label: 'Vendor Credit', icon: 'clipboard' },
  customer_invoice: { label: 'Invoice', icon: 'clipboard-check' },
  customer_credit: { label: 'Credit Memo', icon: 'clipboard-check' },
  card_charge: { label: 'Card Charge', icon: 'building' },
  card_refund: { label: 'Card Refund', icon: 'building' },
  check: { label: 'Check', icon: 'building' },
  deposit: { label: 'Deposit', icon: 'building' },
  transfer: { label: 'Transfer', icon: 'building' },
  vendor_payment: { label: 'Payment', icon: 'check' },
  customer_payment: { label: 'Customer Payment', icon: 'check' },
  expense_report: { label: 'Expense', icon: 'scroll' },
  journal: { label: 'Journal', icon: 'journal' },
}

function docMeta(kind: string) {
  return DOC_META[kind] ?? { label: kind.replace(/_/g, ' '), icon: 'file' }
}

function money(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const PER_GROUP = 6

/** Run the full multi-entity search. `q` should already be trimmed. */
export async function globalSearch(authz: Authz, rawQ: string): Promise<SearchResponse> {
  const q = rawQ.trim().slice(0, 80)
  if (q.length < 2) return { q, groups: [], total: 0 }

  const orgId = authz.user.orgId
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const numeric = /^\$?\s*[\d,]+(\.\d{1,2})?$/.test(q)
  const num = numeric ? Number(q.replace(/[^0-9.]/g, '')) : null

  // Permission gates per entity.
  const canTxn = can(authz, 'gl.read') || can(authz, 'ap.read') || can(authz, 'ar.read')
  const canContacts = can(authz, 'parties.read')
  const canAccounts = can(authz, 'gl.read')
  const canItems = can(authz, 'items.read')
  const canProjects = can(authz, 'projects.read') && await isFeatureEnabled(orgId, 'projects')

  // Subsidiary visibility rides alongside permissions: a restricted caller's
  // search must never surface records their lists would hide.
  const scope = authz.allowedSubsidiaryIds

  const [contacts, txns, accounts, items, projects] = await Promise.all([
    canContacts ? searchContacts(orgId, q, like, scope) : empty(),
    canTxn ? searchTransactions(orgId, q, like, num, scope) : empty(),
    canAccounts ? searchAccounts(orgId, q, like) : empty(),
    canItems ? searchItems(orgId, q, like) : empty(),
    canProjects ? searchProjects(orgId, q, like) : empty(),
  ])

  // Numeric queries most likely want a transaction; else contacts lead.
  const ordered: SearchGroup[] = numeric
    ? [group('transaction', 'transactions', txns), group('contact', 'contacts', contacts)]
    : [group('contact', 'contacts', contacts), group('transaction', 'transactions', txns)]
  ordered.push(
    group('account', 'accounts', accounts),
    group('item', 'items', items),
    group('project', 'projects', projects),
  )

  const groups = ordered.filter((g) => g.hits.length > 0)
  return { q, groups, total: groups.reduce((n, g) => n + g.hits.length, 0) }
}

function group(type: SearchType, labelKey: string, hits: SearchHit[]): SearchGroup {
  return { type, labelKey, hits }
}
async function empty(): Promise<SearchHit[]> {
  return []
}

async function searchContacts(
  orgId: string,
  q: string,
  like: string,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  // Parties are org-wide when their primary subsidiary is null — the exact
  // predicate the party lists use (`is null or = any(...)`).
  const scopeFilter = !scope
    ? sql``
    : scope.size
      ? sql`and (p.subsidiary_id is null or p.subsidiary_id = any(${`{${[...scope].join(',')}}`}::uuid[]))`
      : sql`and false`
  const r = (await db.execute(sql`
    select p.id, p.display_name, p.email, p.legal_name,
           exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id) as is_customer,
           exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.org_id = p.org_id) as is_vendor,
           exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id) as is_employee,
           greatest(similarity(p.display_name, ${q}), similarity(coalesce(p.legal_name, ''), ${q})) as sim
      from parties p
     where p.org_id = ${orgId}
       ${scopeFilter}
       and (p.display_name % ${q} or p.display_name ilike ${like}
            or p.legal_name % ${q} or p.email ilike ${like})
     order by sim desc, p.display_name
     limit ${PER_GROUP}`))
  return r.rows.map((row: any): SearchHit => ({
    id: row.id,
    type: 'contact',
    title: row.display_name,
    subtitle: row.email || row.legal_name || undefined,
    href: `/parties?party=${row.id}`,
    iconKey: row.is_employee ? 'clipboard-check' : 'users',
    badge: row.is_customer ? 'Customer' : row.is_vendor ? 'Vendor' : row.is_employee ? 'Employee' : undefined,
  }))
}

async function searchTransactions(
  orgId: string,
  q: string,
  like: string,
  num: number | null,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  // Amounts live on document_lines (documents.total is often 0). A numeric query
  // matches any transaction that HAS a line of that amount (±sign), and every
  // result shows the summed positive line total.
  // Candidate ids come from independent capped legs: document text, party-name
  // matches via parties→documents_party, and line amounts. A single OR
  // spanning both documents and the parties join forced a full hash join +
  // filter over every document in the tenant per keystroke. The line
  // subqueries carry an explicit org filter — the RLS policy's
  // current_setting() comparison is not sargable on its own. Note the amount
  // leg is a bounded scan by design: numeric_eq is not LEAKPROOF, so under
  // RLS a numeric predicate can never become a btree index condition — an
  // (org_id, amount) index cannot help any tenant-scoped query.
  const hiddenKinds = await disabledDocKinds(orgId)
  const hiddenKindFilter = hiddenKinds.length
    ? sql`and d.kind not in (${sql.join(hiddenKinds.map((value) => sql`${value}`), sql`, `)})`
    : sql``
  // Fail closed exactly like the documents lists (`d.subsidiary_id = any(...)`
  // — null-subsidiary documents are invisible to restricted callers).
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)
  const amtLeg =
    num != null
      ? sql`
        union
        (select dl.document_id as id from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
          where dl.org_id = ${orgId} and dl.amount in (${num}, ${-num}) ${hiddenKindFilter}${subsidiaryFilter}
          limit 200)`
      : sql``
  const amtExpr = sql`coalesce((select sum(dl.amount) from document_lines dl where dl.org_id = ${orgId} and dl.document_id = d.id and dl.amount > 0), d.total)`
  const numOrder = num != null ? sql`(${amtExpr} = ${num}) desc, ` : sql``
  const r = (await db.execute(sql`
    with cand as (
      (select d.id from documents d
        where d.org_id = ${orgId} ${hiddenKindFilter}${subsidiaryFilter}
          and (d.document_number % ${q} or d.document_number ilike ${like}
               or d.reference_number ilike ${like} or d.memo ilike ${like})
        order by d.created_at desc limit 200)
      union
      (select d.id from documents d
        where d.org_id = ${orgId} ${hiddenKindFilter}${subsidiaryFilter} and d.party_id in (
          select p.id from parties p where p.org_id = ${orgId} and p.display_name % ${q})
        order by d.created_at desc limit 200)${amtLeg}
    )
    select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status,
           pr.display_name as party_name,
           ${amtExpr} as amount,
           greatest(similarity(d.document_number, ${q}),
                    similarity(coalesce(d.reference_number, ''), ${q}),
                    similarity(coalesce(d.memo, ''), ${q}),
                    similarity(coalesce(pr.display_name, ''), ${q})) as sim
      from documents d
      join cand on cand.id = d.id
      left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id
     where true ${hiddenKindFilter}${subsidiaryFilter}
     order by ${numOrder}sim desc, d.created_at desc
     limit ${PER_GROUP + 2}`))
  return r.rows.map((row: any): SearchHit => {
    const meta = docMeta(row.kind)
    const href = moduleDrawerHref(row.kind, row.id)
    return {
      id: row.id,
      type: 'transaction',
      title: `${meta.label} ${row.document_number}`,
      subtitle: row.party_name || row.memo || undefined,
      href: href ?? `/journal?entry=${row.id}`,
      iconKey: meta.icon,
      badge: row.status && row.status !== 'posted' ? row.status : undefined,
      amount: money(row.amount),
    }
  })
}

async function searchAccounts(orgId: string, q: string, like: string): Promise<SearchHit[]> {
  const r = (await db.execute(sql`
    select id, number, name, type from accounts
     where org_id = ${orgId} and not is_summary
       and (name % ${q} or name ilike ${like} or number ilike ${like})
     order by similarity(name, ${q}) desc, number nulls last
     limit ${PER_GROUP}`))
  return r.rows.map((row: any): SearchHit => ({
    id: row.id,
    type: 'account',
    title: `${row.number ? `${row.number} · ` : ''}${row.name}`,
    subtitle: row.type,
    href: `/accounts?accountRegister=${row.id}`,
    iconKey: 'layers',
  }))
}

async function searchItems(orgId: string, q: string, like: string): Promise<SearchHit[]> {
  const r = (await db.execute(sql`
    select id, code, name from items
     where org_id = ${orgId} and (name % ${q} or name ilike ${like} or code ilike ${like})
     order by similarity(name, ${q}) desc, name
     limit ${PER_GROUP}`))
  return r.rows.map((row: any): SearchHit => ({
    id: row.id,
    type: 'item',
    title: row.name,
    subtitle: row.code || undefined,
    href: `/items?item=${row.id}`,
    iconKey: 'grid',
  }))
}

async function searchProjects(orgId: string, q: string, like: string): Promise<SearchHit[]> {
  const r = (await db.execute(sql`
    select id, code, name from projects
     where org_id = ${orgId} and (name % ${q} or name ilike ${like} or code ilike ${like})
     order by similarity(name, ${q}) desc, name
     limit ${PER_GROUP}`))
  return r.rows.map((row: any): SearchHit => ({
    id: row.id,
    type: 'project',
    title: row.name,
    subtitle: row.code || undefined,
    href: `/projects/${row.id}`,
    iconKey: 'timer',
  }))
}
