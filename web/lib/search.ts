import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/db.ts'
import type { Authz } from './authz'
import { can } from './authz'
import { disabledDocKinds } from './documents'
import { isFeatureEnabled } from './features'
import { subsidiaryVisibleFilter } from './subsidiaries'
import {
  moduleDrawerHref,
  TRANSACTION_KINDS,
  transactionNavigationOnlyFeature,
  transactionModule,
} from './txn-links'

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

type SearchContactRow = {
  id: string
  display_name: string
  email: string | null
  legal_name: string | null
  is_customer: boolean
  is_vendor: boolean
  is_employee: boolean
}

type SearchTransactionRow = {
  id: string
  kind: string
  document_number: string
  reference_number: string | null
  memo: string | null
  status: string | null
  project_id: string | null
  party_name: string | null
  amount: unknown
}

type SearchAccountRow = {
  id: string
  number: string | null
  name: string
  type: string
}

type SearchItemRow = {
  id: string
  code: string | null
  name: string
}

type SearchProjectRow = {
  id: string
  code: string | null
  name: string
}

// Master data (parties, accounts) is usable org-wide when its subsidiary is
// null — the canonical list predicate is `is null or = any(...)`, not the
// fail-closed document rule. There is no shared export for this variant yet;
// keep it next to its single consumer instead of forking subsidiaries.ts.
function masterDataSubsidiaryFilter(
  column: SQL,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): SQL {
  if (allowedSubsidiaryIds === null) return sql``
  const ids = [...allowedSubsidiaryIds]
  if (ids.length === 0) return sql`and false`
  return sql`and (${column} is null or ${column} = any(${`{${ids.join(',')}}`}::uuid[]))`
}

function money(v: unknown): string {
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

const PER_GROUP = 6

// Per-kind authorization comes from the native module's own read permission
// (single source in the nav registry): documents share one table, but access
// to one module must never make records from another module discoverable.
// Kinds without an authorizing module never enter the allowlist at all.
function allowedTransactionKinds(authz: Authz): string[] {
  return TRANSACTION_KINDS.filter((kind) => {
    const permission = transactionModule(kind)?.requiredPermission
    return Boolean(permission && can(authz, permission))
  })
}

/** Run the full multi-entity search. `q` should already be trimmed. */
export async function globalSearch(authz: Authz, rawQ: string): Promise<SearchResponse> {
  const q = rawQ.trim().slice(0, 80)
  if (q.length < 2) return { q, groups: [], total: 0 }

  const orgId = authz.user.orgId
  const like = `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`
  const numeric = /^\$?\s*[\d,]+(\.\d{1,2})?$/.test(q)
  const num = numeric ? Number(q.replace(/[^0-9.]/g, '')) : null

  // Permission gates per entity.
  const transactionKinds = allowedTransactionKinds(authz)
  const canContacts = can(authz, 'parties.read')
  const canAccounts = can(authz, 'gl.read')
  const canItems = can(authz, 'items.read')
  const canProjects = can(authz, 'projects.read') && await isFeatureEnabled(orgId, 'projects')

  // Subsidiary visibility rides alongside permissions: a restricted caller's
  // search must never surface records their lists would hide.
  const scope = authz.allowedSubsidiaryIds

  const [contacts, txns, accounts, items, projects] = await Promise.all([
    canContacts ? searchContacts(orgId, q, like, scope) : empty(),
    transactionKinds.length
      ? searchTransactions(orgId, q, like, num, transactionKinds, scope)
      : empty(),
    canAccounts ? searchAccounts(orgId, q, like, scope) : empty(),
    canItems ? searchItems(orgId, q, like) : empty(),
    canProjects ? searchProjects(orgId, q, like, scope) : empty(),
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
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope)
  const r = (await db.execute<SearchContactRow>(sql`
    select p.id, p.display_name, p.email, p.legal_name,
           exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id) as is_customer,
           exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.org_id = p.org_id) as is_vendor,
           exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id) as is_employee,
           greatest(similarity(p.display_name, ${q}), similarity(coalesce(p.legal_name, ''), ${q})) as sim
      from parties p
     where p.org_id = ${orgId}
       ${subsidiaryFilter}
       and (p.display_name % ${q} or p.display_name ilike ${like}
            or p.legal_name % ${q} or p.email ilike ${like})
     order by sim desc, p.display_name
     limit ${PER_GROUP}`))
  return r.rows.map((row): SearchHit => ({
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
  allowedKinds: string[],
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
  //
  // Visibility is a POSITIVE kind allowlist derived from the caller's module
  // permissions, intersected with domain feature gates (`DOC_KIND_FEATURE`,
  // mirrored by disabledDocKinds) and navigation-only gates (a module switch
  // like Banking hides search/nav while generic document APIs stay live).
  // Every candidate leg and the final sensitive-field read repeat the same
  // allowlist — a shared CTE alone would leak across module boundaries.
  const navigationFeatures = [...new Set(allowedKinds.flatMap((kind) => {
    const feature = transactionNavigationOnlyFeature(kind)
    return feature ? [feature] : []
  }))]
  const [hiddenKinds, navigationFeatureStates] = await Promise.all([
    disabledDocKinds(orgId),
    Promise.all(navigationFeatures.map(async (feature) => (
      [feature, await isFeatureEnabled(orgId, feature)] as const
    ))),
  ])
  const hiddenKindSet = new Set(hiddenKinds)
  const navigationFeatureEnabled = new Map(navigationFeatureStates)
  const visibleKinds = allowedKinds.filter((kind) => {
    if (hiddenKindSet.has(kind)) return false
    const feature = transactionNavigationOnlyFeature(kind)
    return !feature || navigationFeatureEnabled.get(feature) === true
  })
  if (visibleKinds.length === 0) return []
  const visibleKindFilter = sql`and d.kind in (${sql.join(visibleKinds.map((value) => sql`${value}`), sql`, `)})`
  // Fail closed exactly like the documents lists (`d.subsidiary_id = any(...)`
  // — null-subsidiary documents are invisible to restricted callers); parties
  // keep their org-wide-null master-data semantics.
  const documentSubsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)
  const partySubsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope)
  const resultPartySubsidiaryFilter = masterDataSubsidiaryFilter(sql`pr.subsidiary_id`, scope)
  const amtLeg =
    num != null
      ? sql`
        union
        (select dl.document_id as id from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
          where dl.org_id = ${orgId} and dl.amount in (${num}, ${-num}) ${visibleKindFilter}${documentSubsidiaryFilter}
          limit 200)`
      : sql``
  const amtExpr = sql`coalesce((select sum(dl.amount) from document_lines dl where dl.org_id = ${orgId} and dl.document_id = d.id and dl.amount > 0), d.total)`
  const numOrder = num != null ? sql`(${amtExpr} = ${num}) desc, ` : sql``
  const r = (await db.execute<SearchTransactionRow>(sql`
    with cand as (
      (select d.id from documents d
        where d.org_id = ${orgId} ${visibleKindFilter}${documentSubsidiaryFilter}
          and (d.document_number % ${q} or d.document_number ilike ${like}
               or d.reference_number ilike ${like} or d.memo ilike ${like})
        order by d.created_at desc limit 200)
      union
      (select d.id from documents d
        where d.org_id = ${orgId} ${visibleKindFilter}${documentSubsidiaryFilter} and d.party_id in (
          select p.id from parties p where p.org_id = ${orgId} ${partySubsidiaryFilter} and p.display_name % ${q})
        order by d.created_at desc limit 200)${amtLeg}
    )
    select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status, d.project_id,
           pr.display_name as party_name,
           ${amtExpr} as amount,
           greatest(similarity(d.document_number, ${q}),
                    similarity(coalesce(d.reference_number, ''), ${q}),
                    similarity(coalesce(d.memo, ''), ${q}),
                    similarity(coalesce(pr.display_name, ''), ${q})) as sim
      from documents d
      join cand on cand.id = d.id
      left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id ${resultPartySubsidiaryFilter}
     where true ${visibleKindFilter}${documentSubsidiaryFilter}
     order by ${numOrder}sim desc, d.created_at desc
     limit ${PER_GROUP + 2}`))
  // No generic journal fallback: a stored kind without an authorized native
  // module is dropped rather than linked into the wrong module's ledger view.
  return r.rows.flatMap((row): SearchHit[] => {
    const module = transactionModule(row.kind)
    const href = moduleDrawerHref(row.kind, row.id, { projectId: row.project_id })
    if (!module || !href) return []
    return [{
      id: row.id,
      type: 'transaction',
      title: `${module.label} ${row.document_number}`,
      subtitle: row.party_name || row.memo || undefined,
      href,
      iconKey: module.iconKey,
      badge: row.status && row.status !== 'posted' ? row.status : undefined,
      amount: money(row.amount),
    }]
  })
}

async function searchAccounts(
  orgId: string,
  q: string,
  like: string,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`subsidiary_id`, scope)
  const r = (await db.execute<SearchAccountRow>(sql`
    select id, number, name, type from accounts
     where org_id = ${orgId} and not is_summary
       ${subsidiaryFilter}
       and (name % ${q} or name ilike ${like} or number ilike ${like})
     order by similarity(name, ${q}) desc, number nulls last
     limit ${PER_GROUP}`))
  return r.rows.map((row): SearchHit => ({
    id: row.id,
    type: 'account',
    title: `${row.number ? `${row.number} · ` : ''}${row.name}`,
    subtitle: row.type,
    href: `/accounts?accountRegister=${row.id}`,
    iconKey: 'layers',
  }))
}

async function searchItems(orgId: string, q: string, like: string): Promise<SearchHit[]> {
  const r = (await db.execute<SearchItemRow>(sql`
    select id, code, name from items
     where org_id = ${orgId} and (name % ${q} or name ilike ${like} or code ilike ${like})
     order by similarity(name, ${q}) desc, name
     limit ${PER_GROUP}`))
  return r.rows.map((row): SearchHit => ({
    id: row.id,
    type: 'item',
    title: row.name,
    subtitle: row.code || undefined,
    href: `/items?item=${row.id}`,
    iconKey: 'grid',
  }))
}

async function searchProjects(
  orgId: string,
  q: string,
  like: string,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  // Project records behave like documents: restricted callers see only their
  // subsidiaries (no org-wide null escape hatch).
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`subsidiary_id`, scope)
  const r = (await db.execute<SearchProjectRow>(sql`
    select id, code, name from projects
     where org_id = ${orgId} ${subsidiaryFilter}
       and (name % ${q} or name ilike ${like} or code ilike ${like})
     order by similarity(name, ${q}) desc, name
     limit ${PER_GROUP}`))
  return r.rows.map((row): SearchHit => ({
    id: row.id,
    type: 'project',
    title: row.name,
    subtitle: row.code || undefined,
    href: `/projects?project=${row.id}`,
    iconKey: 'timer',
  }))
}
