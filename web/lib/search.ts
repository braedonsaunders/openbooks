import 'server-only'
import { sql, type SQL } from 'drizzle-orm'
import { db } from '@openbooks/engine/src/platform/db.ts'
import type { Authz } from './authz'
import { can } from './authz'
import { disabledDocKinds } from "./documents.ts";
import { isFeatureEnabled } from './features'
import { subsidiaryVisibleFilter } from './subsidiaries'
import { formatMoney } from '@openbooks/engine/src/money/money.ts'
import { JOURNAL_GL_NATIVE_ORIGINS, journalScopeWhere } from './customization/entity-list-query/journal-entries'
import { canonicalDecimal } from './exact-decimal'
import type { RecentRef, SearchGroup, SearchHit, SearchResponse, SearchType } from './search-types'
import {
  moduleDrawerHref,
  TRANSACTION_KINDS,
  transactionNavigationOnlyFeature,
  transactionModule,
} from './txn-links'

/**
 * Global search — one query fans out across every primary entity (contacts,
 * transactions, accounts, items, projects, journal entries) in parallel and
 * returns grouped, ranked hits. Matching is trigram-fuzzy (`col % q`,
 * typo-tolerant via pg_trgm) OR substring (`ILIKE`), ranked by
 * `similarity()`; a numeric query also matches transaction totals and
 * document numbers. An exact document/entry number always wins: it bypasses
 * the recency-capped fuzzy candidate legs (which can exclude an old exact
 * row on a large tenant) and orders first. Contacts are also found through
 * their people, phone numbers and migrated-system ids; documents through
 * their line descriptions and integrator references; items through their
 * barcodes and customer part numbers. Org-scoped and permission-filtered.
 * The operational records, reports, settings and help that complete the
 * header search live in search-records.ts and search-catalog.ts.
 *
 * The pg_trgm GIN indexes (the baseline's party, document, account, item
 * and project indexes, plus migration 0567's document-line and contact
 * indexes) make the `%` / ILIKE predicates and the similarity ordering fast
 * at scale.
 */

export type { SearchBadge, SearchGroup, SearchHit, SearchResponse, SearchType } from './search-types'

type SearchContactRow = {
  id: string
  display_name: string
  email: string | null
  legal_name: string | null
  is_customer: boolean
  is_vendor: boolean
  is_employee: boolean
  matched_contact: string | null
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
  line_match: string | null
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

/**
 * Display an amount from its stored decimal string — never through Number.
 * Beyond 2^53 a float rounds the very amount shown (9007199254740993
 * renders as …992), and grouping through toLocaleString is locale hostage.
 * Exact half-away rounding to cents (formatMoney) plus manual grouping is
 * deterministic everywhere.
 */
function money(v: unknown): string {
  if (typeof v !== 'string' && typeof v !== 'number') return ''
  let rounded: string
  try {
    rounded = formatMoney(v, 2)
  } catch {
    return ''
  }
  const negative = rounded.startsWith('-')
  const [whole = '', fraction = ''] = (negative ? rounded.slice(1) : rounded).split('.')
  return `${negative ? '-' : ''}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${fraction}`
}

/**
 * Exact amount reading for numeric search. Only strictly-formed shapes
 * count: plain digits or correctly grouped thousands, an optional $ prefix,
 * and at most two decimal places. A malformed comma ("1,2") is NOT a
 * number — stripping its comma invents 12 from a mark decimal-comma
 * locales read as 1.2 — so it stays a text query and never reaches the
 * amount leg. Values never cross Number: past 2^53 a float rounds the
 * amount the leg compares, so the leg binds the exact decimal string.
 */
function parseSearchAmount(q: string): string | null {
  const compact = q.trim().replace(/^\$\s*/, '')
  if (!/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{1,2})?$/.test(compact)) return null
  return canonicalDecimal(compact.replace(/,/g, ''), 2)
}

const PER_GROUP = 6

/**
 * What one search leg matches: the typed query, or — when the header search
 * re-resolves the reader's recently opened results — an explicit id list.
 * Both run through the same leg, so a recent result is visible exactly when
 * a fresh search could surface it.
 */
type Match =
  | { kind: 'text'; q: string; like: string; amount: string | null; phoneDigits: string | null }
  | { kind: 'ids'; ids: string[] }

function textMatch(rawQ: string): Extract<Match, { kind: 'text' }> {
  const q = rawQ.trim().slice(0, 80)
  return {
    kind: 'text',
    q,
    like: `%${q.replace(/[%_\\]/g, (c) => `\\${c}`)}%`,
    amount: parseSearchAmount(q),
    phoneDigits: phoneSearchDigits(q),
  }
}

/**
 * A query written like a phone number ("(555) 123-4567", "+44 20 7946 0958")
 * also matches stored phone numbers digit for digit, whatever punctuation
 * either side used. Seven digits is the shortest local number; anything
 * shorter is far likelier an amount or a document number.
 */
function phoneSearchDigits(q: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(q)) return null
  const digits = q.replace(/[^0-9]/g, '')
  return digits.length >= 7 ? digits : null
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(',')}}`}::uuid[]`
}

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

type CoreLegs = {
  contacts: SearchHit[]
  transactions: SearchHit[]
  accounts: SearchHit[]
  items: SearchHit[]
  projects: SearchHit[]
}

/**
 * Run every core leg the reader is entitled to. `matchFor` names the match
 * per leg; a leg with no match (an id lookup naming none of its records) is
 * skipped entirely.
 */
async function coreLegs(
  authz: Authz,
  matchFor: (type: 'contact' | 'transaction' | 'account' | 'item' | 'project') => Match | null,
): Promise<CoreLegs> {
  const orgId = authz.user.orgId

  // Permission gates per entity.
  const transactionKinds = allowedTransactionKinds(authz)
  const contactMatch = can(authz, 'parties.read') ? matchFor('contact') : null
  const transactionMatch = matchFor('transaction')
  const accountMatch = can(authz, 'gl.read') ? matchFor('account') : null
  const itemMatch = can(authz, 'items.read') ? matchFor('item') : null
  const projectMatch = can(authz, 'projects.read') ? matchFor('project') : null
  const canProjects = projectMatch !== null && await isFeatureEnabled(orgId, 'projects')
  // Journal entries carry their own numbers in journal_entries; the gate is
  // the journal module's own read permission, like every other entity above.
  const journalPermission = transactionModule('journal')?.requiredPermission
  const canJournals = Boolean(transactionMatch && journalPermission && can(authz, journalPermission))

  // Subsidiary visibility rides alongside permissions: a restricted caller's
  // search must never surface records their lists would hide.
  const scope = authz.allowedSubsidiaryIds

  // One shared kind allowlist for the documents legs AND the journal exact
  // arm: an exact JE number for a subledger posting resolves only when the
  // caller holds the posting document's own module permission.
  const visibleKinds =
    transactionMatch && (transactionKinds.length > 0 || canJournals)
      ? visibleTransactionKinds(orgId, transactionKinds)
      : Promise.resolve([] as string[])

  const [contacts, txns, accounts, items, projects, journals] = await Promise.all([
    contactMatch ? searchContacts(orgId, contactMatch, scope) : empty(),
    transactionMatch && transactionKinds.length
      ? visibleKinds.then((kinds) => searchTransactions(orgId, transactionMatch, scope, kinds))
      : empty(),
    accountMatch ? searchAccounts(orgId, accountMatch, scope) : empty(),
    itemMatch ? searchItems(orgId, itemMatch) : empty(),
    canProjects && projectMatch ? searchProjects(orgId, projectMatch, scope) : empty(),
    canJournals && transactionMatch ? visibleKinds.then((kinds) => searchJournalEntries(orgId, transactionMatch, scope, kinds)) : empty(),
  ])
  return { contacts, transactions: [...txns, ...journals], accounts, items, projects }
}

/** Run the full multi-entity search. `q` should already be trimmed. */
export async function globalSearch(authz: Authz, rawQ: string): Promise<SearchResponse> {
  const match = textMatch(rawQ)
  const q = match.q
  if (q.length < 2) return { q, groups: [], total: 0 }
  const numeric = match.amount !== null

  const legs = await coreLegs(authz, () => match)

  // Numeric queries most likely want a transaction; else contacts lead.
  // Journal entries ride inside the transactions group (each leg internally
  // exact-first) rather than growing a sixth group the palette would have
  // to learn. An exact document/entry number tops the merged group no
  // matter which leg produced it.
  const txnHits = exactNumberFirst(legs.transactions, q)
  const ordered: SearchGroup[] = numeric
    ? [group('transaction', 'transactions', txnHits), group('contact', 'contacts', legs.contacts)]
    : [group('contact', 'contacts', legs.contacts), group('transaction', 'transactions', txnHits)]
  ordered.push(
    group('account', 'accounts', legs.accounts),
    group('item', 'items', legs.items),
    group('project', 'projects', legs.projects),
  )

  const groups = ordered.filter((g) => g.hits.length > 0)
  return { q, groups, total: groups.reduce((n, g) => n + g.hits.length, 0) }
}

const CORE_TYPES = new Set<SearchType>(['contact', 'transaction', 'account', 'item', 'project'])

/**
 * Re-resolve recently opened core records under the reader's CURRENT
 * permissions and subsidiary scope. A reference the reader can no longer see
 * resolves to nothing; titles and amounts are read fresh, never replayed
 * from the browser.
 */
export async function resolveRecentCoreRecords(authz: Authz, refs: readonly RecentRef[]): Promise<SearchHit[]> {
  const idsByType = new Map<string, string[]>()
  for (const ref of refs) {
    if (!CORE_TYPES.has(ref.type)) continue
    idsByType.set(ref.type, [...(idsByType.get(ref.type) ?? []), ref.id])
  }
  if (idsByType.size === 0) return []
  const legs = await coreLegs(authz, (type) => {
    const ids = idsByType.get(type)
    return ids?.length ? { kind: 'ids', ids } : null
  })
  return [...legs.contacts, ...legs.transactions, ...legs.accounts, ...legs.items, ...legs.projects]
}

function group(type: SearchType, labelKey: string, hits: SearchHit[]): SearchGroup {
  return { type, labelKey, hits }
}

/**
 * Stable exact-first partition for merged transaction hits. Hit titles end
 * in the record's number (`<Module label> <document_number>`,
 * `Journal <entry_number>`), so an exact-number query lifts its record
 * above fuzzy neighbors from every leg. Otherwise a no-op.
 */
function exactNumberFirst(hits: SearchHit[], q: string): SearchHit[] {
  const suffix = ` ${q}`
  if (!hits.some((hit) => hit.title.endsWith(suffix))) return hits
  return [...hits.filter((hit) => hit.title.endsWith(suffix)), ...hits.filter((hit) => !hit.title.endsWith(suffix))]
}
async function empty(): Promise<SearchHit[]> {
  return []
}

/** A document's lifecycle status as a badge; posted is the norm and shows none. */
function statusBadge(status: string | null): SearchHit['badge'] {
  return status && status !== 'posted' ? { kind: 'status', value: status } : undefined
}

async function searchContacts(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  // Parties are org-wide when their primary subsidiary is null — the exact
  // predicate the party lists use (`is null or = any(...)`).
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope)
  let candidates: SQL
  let ranking: SQL
  let matchedContact: SQL
  if (match.kind === 'ids') {
    candidates = sql`select p.id from parties p where p.org_id = ${orgId} and p.id = any(${uuidArray(match.ids)})`
    ranking = sql`0`
    matchedContact = sql`null`
  } else {
    const { q, like, phoneDigits } = match
    // Independent capped legs keep each predicate on its own index: the
    // party name/email trigram indexes, the contact-person trigram indexes,
    // and the source-identity index for ids carried over from a migrated or
    // mirrored system. One OR across them would scan every party.
    const phoneLegs = phoneDigits
      ? sql`
        union
        (select p.id from parties p
          where p.org_id = ${orgId} ${subsidiaryFilter} and p.phone is not null
            and regexp_replace(p.phone, '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}
          limit 20)
        union
        (select c.party_id from contacts c
           join parties p on p.id = c.party_id and p.org_id = c.org_id
          where c.org_id = ${orgId} ${subsidiaryFilter}
            and (regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}
                 or regexp_replace(coalesce(c.mobile_phone, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`})
          limit 20)`
      : sql``
    candidates = sql`
      (select p.id from parties p
        where p.org_id = ${orgId} ${subsidiaryFilter}
          and (p.display_name % ${q} or p.display_name ilike ${like}
               or p.legal_name % ${q} or p.email ilike ${like})
        limit 50)
      union
      (select c.party_id from contacts c
         join parties p on p.id = c.party_id and p.org_id = c.org_id
        where c.org_id = ${orgId} ${subsidiaryFilter}
          and (c.name ilike ${like} or c.email ilike ${like})
        limit 50)
      union
      (select p.id from parties p
        where p.org_id = ${orgId} ${subsidiaryFilter}
          and p.custom -> 'source' ->> 'externalId' = ${q}
        limit 5)${phoneLegs}`
    ranking = sql`greatest(similarity(p.display_name, ${q}), similarity(coalesce(p.legal_name, ''), ${q}))`
    // A party found through one of its people names that person, so the
    // reader sees why "Jane" surfaced Acme Corp.
    matchedContact = sql`(select c.name from contacts c
       where c.org_id = p.org_id and c.party_id = p.id
         and (c.name ilike ${like} or c.email ilike ${like})
       order by c.is_primary desc, c.name limit 1)`
  }
  const r = (await db.execute<SearchContactRow>(sql`
    with party_cand as (${candidates})
    select p.id, p.display_name, p.email, p.legal_name,
           exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id) as is_customer,
           exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.org_id = p.org_id) as is_vendor,
           exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id) as is_employee,
           ${matchedContact} as matched_contact,
           ${ranking} as sim
      from parties p
      join party_cand on party_cand.id = p.id
     where p.org_id = ${orgId}
       ${subsidiaryFilter}
     order by sim desc, p.display_name
     limit ${PER_GROUP}`))
  return r.rows.map((row): SearchHit => ({
    id: row.id,
    type: 'contact',
    title: row.display_name,
    subtitle: row.matched_contact || row.email || row.legal_name || undefined,
    href: `/parties?party=${row.id}`,
    iconKey: row.is_employee ? 'clipboard-check' : 'users',
    badge: row.is_customer
      ? { kind: 'role', value: 'customer' }
      : row.is_vendor
        ? { kind: 'role', value: 'vendor' }
        : row.is_employee
          ? { kind: 'role', value: 'employee' }
          : undefined,
  }))
}

/**
 * The caller's POSITIVE kind allowlist: module permissions intersected with
 * domain feature gates (`DOC_KIND_FEATURE`, mirrored by disabledDocKinds)
 * and navigation-only gates (a module switch like Banking hides search/nav
 * while generic document APIs stay live). Shared by the documents legs and
 * the journal exact arm, so an exact JE number for a subledger posting
 * resolves only inside the posting module's own gate.
 */
async function visibleTransactionKinds(orgId: string, allowedKinds: string[]): Promise<string[]> {
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
  return allowedKinds.filter((kind) => {
    if (hiddenKindSet.has(kind)) return false
    const feature = transactionNavigationOnlyFeature(kind)
    return !feature || navigationFeatureEnabled.get(feature) === true
  })
}

async function searchTransactions(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
  visibleKinds: string[],
): Promise<SearchHit[]> {
  // Amounts live on document_lines (documents.total is often 0). A numeric query
  // matches any transaction that HAS a line of that amount (±sign), and every
  // result shows the summed positive line total.
  // Candidate ids come from independent capped legs: document text, party-name
  // matches via parties→documents_party, line descriptions, and line amounts.
  // A single OR spanning both documents and the parties join forced a full
  // hash join + filter over every document in the tenant per keystroke. The line
  // subqueries carry an explicit org filter — the RLS policy's
  // current_setting() comparison is not sargable on its own. Note the amount
  // leg is a bounded scan by design: numeric_eq is not LEAKPROOF, so under
  // RLS a numeric predicate can never become a btree index condition — an
  // (org_id, amount) index cannot help any tenant-scoped query.
  //
  // Visibility is the shared POSITIVE kind allowlist: every candidate leg
  // and the final sensitive-field read repeat the same allowlist — a shared
  // CTE alone would leak across module boundaries.
  if (visibleKinds.length === 0) return []
  const visibleKindFilter = sql`and d.kind in (${sql.join(visibleKinds.map((value) => sql`${value}`), sql`, `)})`
  // Fail closed exactly like the documents lists (`d.subsidiary_id = any(...)`
  // — null-subsidiary documents are invisible to restricted callers); parties
  // keep their org-wide-null master-data semantics.
  const documentSubsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)
  const partySubsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope)
  const resultPartySubsidiaryFilter = masterDataSubsidiaryFilter(sql`pr.subsidiary_id`, scope)
  const amtExpr = sql`coalesce((select sum(dl.amount) from document_lines dl where dl.org_id = ${orgId} and dl.document_id = d.id and dl.amount > 0), d.total)`

  if (match.kind === 'ids') {
    const r = (await db.execute<SearchTransactionRow>(sql`
      select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status, d.project_id,
             pr.display_name as party_name,
             ${amtExpr} as amount,
             null as line_match
        from documents d
        left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id ${resultPartySubsidiaryFilter}
       where d.org_id = ${orgId} ${visibleKindFilter}${documentSubsidiaryFilter}
         and d.id = any(${uuidArray(match.ids)})`))
    return transactionHits(r.rows)
  }

  const { q, like, amount } = match
  const amtLeg =
    amount != null
      ? sql`
        union
        (select dl.document_id as id from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
          where dl.org_id = ${orgId} and dl.amount in (${amount}::numeric, ${`-${amount}`}::numeric) ${visibleKindFilter}${documentSubsidiaryFilter}
          limit 200)`
      : sql``
  const numOrder = amount != null ? sql`(${amtExpr} = ${amount}::numeric) desc, ` : sql``
  // Exact document numbers bypass the recency-capped fuzzy legs: on a large
  // tenant the newest-200 cap can exclude an old exact row (and admit a
  // different neighbor set as new documents arrive), so an exact query
  // missed its record and ranked unstably. A channel's or integrator's own
  // reference for the document (its order, invoice or payment id) is an
  // exact number too. Equality carries the same kind and subsidiary
  // allowlists as every other leg.
  const exactLeg = sql`
        union
        (select d.id from documents d
          where d.org_id = ${orgId} ${visibleKindFilter}${documentSubsidiaryFilter}
            and (d.document_number = ${q} or d.external_ref = ${q})
          limit 5)`
  // Line descriptions name what was bought or sold ("forklift rental"),
  // which neither the number nor the header memo carries.
  const lineLeg = sql`
        union
        (select dl.document_id as id from document_lines dl
          join documents d on d.id = dl.document_id and d.org_id = dl.org_id
          where dl.org_id = ${orgId} and dl.description ilike ${like} ${visibleKindFilter}${documentSubsidiaryFilter}
          limit 200)`
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
        order by d.created_at desc limit 200)${lineLeg}${amtLeg}${exactLeg}
    )
    select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status, d.project_id,
           pr.display_name as party_name,
           ${amtExpr} as amount,
           (select dl.description from document_lines dl
             where dl.org_id = ${orgId} and dl.document_id = d.id and dl.description ilike ${like}
             order by dl.line_number limit 1) as line_match,
           greatest(similarity(d.document_number, ${q}),
                    similarity(coalesce(d.reference_number, ''), ${q}),
                    similarity(coalesce(d.memo, ''), ${q}),
                    similarity(coalesce(pr.display_name, ''), ${q})) as sim
      from documents d
      join cand on cand.id = d.id
      left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id ${resultPartySubsidiaryFilter}
     where true ${visibleKindFilter}${documentSubsidiaryFilter}
     order by (d.document_number = ${q} or d.external_ref = ${q}) desc, ${numOrder}sim desc, d.created_at desc
     limit ${PER_GROUP + 2}`))
  return transactionHits(r.rows)
}

function transactionHits(rows: SearchTransactionRow[]): SearchHit[] {
  // No generic journal fallback: a stored kind without an authorized native
  // module is dropped rather than linked into the wrong module's ledger view.
  return rows.flatMap((row): SearchHit[] => {
    const module = transactionModule(row.kind)
    const href = moduleDrawerHref(row.kind, row.id, { projectId: row.project_id })
    if (!module || !href) return []
    // A document found through one of its lines shows that line, so the
    // reader sees why "forklift" surfaced it.
    const context = row.line_match || row.memo
    return [{
      id: row.id,
      type: 'transaction',
      title: `${module.label} ${row.document_number}`,
      subtitle: (row.line_match && row.party_name ? `${row.party_name} · ${row.line_match}` : row.party_name || context) || undefined,
      href,
      iconKey: module.iconKey,
      badge: statusBadge(row.status),
      amount: money(row.amount),
    }]
  })
}

type SearchJournalEntryRow = {
  id: string
  entry_number: string
  memo: string | null
  status: string
  created_at: string
}

/**
 * Journal entries carry their own numbers (JE-…) in journal_entries, and
 * GL-native entries (closing, allocation, …) have no source document at
 * all — the documents legs can never surface them. Fuzzy matching stays
 * scoped exactly like the journal list (journal/pay_run backed entries
 * plus GL-native origins; entries posted from other subledgers stay
 * discoverable through their document). An exact entry number resolves its
 * entry — a dashboard-visible JE number must never search total zero —
 * but NEVER past the posting module's own gate: a linked entry resolves
 * only when its link scope (journal/pay_run, like the fuzzy leg) or the
 * linked document's kind in the caller's shared allowlist permits it, so a
 * gl.read-only caller cannot pull AP/other subledger memos by number.
 * Unlinked entries resolve under the journal gate alone (no owning module
 * exists to gate them through). The org + subsidiary doorway applies on
 * every arm. Hits open the shared journal-entry drawer directly. A recently
 * opened entry re-resolves under the exact arm's rule, since that is the
 * widest rule any search could have surfaced it under.
 */
async function searchJournalEntries(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
  visibleKinds: string[],
): Promise<SearchHit[]> {
  // Subsidiary visibility is the canonical journal predicate — an entry is
  // visible when a LINE is visible (journalScopeWhere, shared with the
  // journal list) — never the header's subsidiary alone. A header in scope
  // whose lines are all out of scope must not disclose its memo here.
  const visibility = journalScopeWhere(orgId, scope)
  // The linked-document gate for the exact arm: the posting document must
  // be one the caller could open themselves — same kind allowlist and the
  // same document subsidiary fence the documents legs enforce.
  const linkedKindGate =
    visibleKinds.length === 0
      ? sql`and false`
      : sql`and d.kind in (${sql.join(visibleKinds.map((value) => sql`${value}`), sql`, `)})`
  const linkedDocSubsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)
  const exactArmLinkRule = sql`(not exists (select 1 from documents d
                            where d.posted_entry_id = e.id and d.org_id = e.org_id)
               or exists (select 1 from documents d
                           where d.posted_entry_id = e.id and d.org_id = e.org_id
                             and d.kind in ('journal', 'pay_run'))
               or exists (select 1 from documents d
                           where d.posted_entry_id = e.id and d.org_id = e.org_id
                             ${linkedDocSubsidiaryFilter} ${linkedKindGate}))`
  if (match.kind === 'ids') {
    const r = (await db.execute<SearchJournalEntryRow>(sql`
      select e.id, e.entry_number, e.memo, e.status, e.created_at
        from journal_entries e
       where ${visibility}
         and e.id = any(${uuidArray(match.ids)})
         and ${exactArmLinkRule}`))
    return journalHits(r.rows)
  }
  const { q, like } = match
  // UNION forbids expression ORDER BY, so the merged legs sit in a
  // subquery and the exact-first ordering applies outside it.
  const r = (await db.execute<SearchJournalEntryRow>(sql`
    select u.id, u.entry_number, u.memo, u.status, u.created_at from (
      select e.id, e.entry_number, e.memo, e.status, e.created_at
        from journal_entries e
       where ${visibility}
         and (e.entry_number % ${q} or e.entry_number ilike ${like} or e.memo ilike ${like})
         and (exists (select 1 from documents d
                       where d.posted_entry_id = e.id and d.org_id = e.org_id and d.kind in ('journal', 'pay_run'))
              or (not exists (select 1 from documents d
                               where d.posted_entry_id = e.id and d.org_id = e.org_id)
                  and e.origin in (${sql.join(JOURNAL_GL_NATIVE_ORIGINS.map((origin) => sql`${origin}`), sql`, `)})))
      union
      (select e.id, e.entry_number, e.memo, e.status, e.created_at
         from journal_entries e
        where ${visibility}
          and e.entry_number = ${q}
          and ${exactArmLinkRule}
        limit 5)
    ) u
     order by (u.entry_number = ${q}) desc, similarity(u.entry_number, ${q}) desc, u.created_at desc
     limit ${PER_GROUP}`))
  return journalHits(r.rows)
}

function journalHits(rows: SearchJournalEntryRow[]): SearchHit[] {
  return rows.map((row): SearchHit => ({
    id: row.id,
    type: 'transaction',
    title: `Journal ${row.entry_number}`,
    subtitle: row.memo || undefined,
    href: `/journal?journalEntry=${row.id}`,
    iconKey: 'journal',
    badge: statusBadge(row.status),
  }))
}

async function searchAccounts(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`subsidiary_id`, scope)
  const predicate = match.kind === 'ids'
    ? sql`id = any(${uuidArray(match.ids)})`
    : sql`(name % ${match.q} or name ilike ${match.like} or number ilike ${match.like})`
  const order = match.kind === 'ids' ? sql`number nulls last` : sql`similarity(name, ${match.q}) desc, number nulls last`
  const r = (await db.execute<SearchAccountRow>(sql`
    select id, number, name, type from accounts
     where org_id = ${orgId} and not is_summary
       ${subsidiaryFilter}
       and ${predicate}
     order by ${order}
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

async function searchItems(orgId: string, match: Match): Promise<SearchHit[]> {
  // A scanned barcode (GTIN/UPC/EAN) or a customer's own part number names
  // the item exactly; each resolves through its unique per-org index.
  const candidates = match.kind === 'ids'
    ? sql`select id from items where org_id = ${orgId} and id = any(${uuidArray(match.ids)})`
    : sql`
      (select id from items
        where org_id = ${orgId} and (name % ${match.q} or name ilike ${match.like} or code ilike ${match.like})
        limit 50)
      union
      (select item_id as id from item_identifiers where org_id = ${orgId} and value = ${match.q})
      union
      (select item_id as id from customer_item_refs where org_id = ${orgId} and customer_sku = ${match.q} limit 5)`
  const order = match.kind === 'ids' ? sql`i.name` : sql`similarity(i.name, ${match.q}) desc, i.name`
  const r = (await db.execute<SearchItemRow>(sql`
    with item_cand as (${candidates})
    select i.id, i.code, i.name from items i
      join item_cand on item_cand.id = i.id
     where i.org_id = ${orgId}
     order by ${order}
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
  match: Match,
  scope: ReadonlySet<string> | null,
): Promise<SearchHit[]> {
  // Project records behave like documents: restricted callers see only their
  // subsidiaries (no org-wide null escape hatch).
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`subsidiary_id`, scope)
  const predicate = match.kind === 'ids'
    ? sql`id = any(${uuidArray(match.ids)})`
    : sql`(name % ${match.q} or name ilike ${match.like} or code ilike ${match.like})`
  const order = match.kind === 'ids' ? sql`name` : sql`similarity(name, ${match.q}) desc, name`
  const r = (await db.execute<SearchProjectRow>(sql`
    select id, code, name from projects
     where org_id = ${orgId} ${subsidiaryFilter}
       and ${predicate}
     order by ${order}
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
