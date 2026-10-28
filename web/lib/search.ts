import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import type { Authz } from "./authz";
import { can } from "./authz";
import { disabledDocKinds } from "./documents.ts";
import { isFeatureEnabled } from "./features";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import { journalScopeWhere } from "./customization/entity-list-query/journal-entries";
import { expenseAccess } from "./expense-access";
import { searchParseOptions } from "./search-context";
import {
  parseSearchQuery,
  SCOPE_KINDS,
  scopeGroup,
  type ParsedSearch,
  type SearchScope,
} from "./search-query";
import {
  displayMoney,
  documentHits,
  journalHits,
  searchDocuments,
  searchJournalEntries,
} from "./search-transactions";
import type { RecentRef, SearchGroup, SearchHit, SearchResponse, SearchType } from "./search-types";
import {
  TRANSACTION_KINDS,
  transactionNavigationOnlyFeature,
  transactionModule,
} from "./txn-links";

/**
 * Global search over the core ledger records — contacts, transactions
 * (documents and journal entries), accounts, items and projects — in
 * parallel, grouped and ranked. A query is first read into constraints
 * (lib/search-query.ts): words, an amount, a date range, a lifecycle status
 * and a record scope, so "invoices over 1,000 from acme this year",
 * "inv:3668", "$7,298.08" and "overdue bills" all mean what they say. A
 * record must satisfy every constraint; a transaction is found by any of its
 * amounts (total, positive line sum, open balance, tax or a line) and by the
 * words of its number, references, memo and line descriptions.
 *
 * Contacts are also found through their people, addresses, phone
 * numbers and migrated-system ids; items through their barcodes and
 * customer part numbers. Org-scoped and permission-filtered on every leg.
 * The operational records, reports, settings and help that complete the
 * header search live in search-records.ts and search-catalog.ts.
 *
 * Row-level security decides the cost model. Pattern and similarity
 * operators are not LEAKPROOF, so under a tenant policy they never become
 * index conditions. The small master-data tables are matched directly;
 * transactions go through the derived search index, whose terms and amounts
 * are compared with equality and ranges (lib/search-transactions.ts).
 */

export type {
  SearchBadge,
  SearchGroup,
  SearchHit,
  SearchResponse,
  SearchType,
} from "./search-types";

type SearchContactRow = {
  id: string;
  display_name: string;
  email: string | null;
  legal_name: string | null;
  is_customer: boolean;
  is_vendor: boolean;
  is_employee: boolean;
  matched_contact: string | null;
};

type SearchAccountRow = { id: string; number: string | null; name: string; type: string };
type SearchItemRow = { id: string; code: string | null; name: string };
type SearchProjectRow = { id: string; code: string | null; name: string };

/** Hits per group in the header panel. */
export const PANEL_LIMIT = 6;
const PANEL_TRANSACTION_LIMIT = 8;

export interface GlobalSearchOptions {
  /** Hits per group (the header panel shows a few; the results page more). */
  limit?: number;
  /** Skip this many hits, for the results page's later pages. */
  offset?: number;
  /** Only these groups. */
  types?: readonly SearchType[];
}

// Master data (parties, accounts) is usable org-wide when its subsidiary is
// null — the canonical list predicate is `is null or = any(...)`, not the
// fail-closed document rule.
function masterDataSubsidiaryFilter(
  column: SQL,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): SQL {
  if (allowedSubsidiaryIds === null) return sql``;
  const ids = [...allowedSubsidiaryIds];
  if (ids.length === 0) return sql`and false`;
  return sql`and (${column} is null or ${column} = any(${`{${ids.join(",")}}`}::uuid[]))`;
}

function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

/**
 * A query written like a phone number ("(555) 123-4567", "+44 20 7946 0958")
 * also matches stored phone numbers digit for digit, whatever punctuation
 * either side used. Seven digits is the shortest local number; anything
 * shorter is far likelier an amount or a document number.
 */
function phoneSearchDigits(q: string): string | null {
  if (!/^\+?[\d\s().-]+$/.test(q)) return null;
  const digits = q.replace(/[^0-9]/g, "");
  return digits.length >= 7 ? digits : null;
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

/**
 * What one leg matches: the parsed query, or — when the header search
 * re-resolves the reader's recently opened results — an explicit id list.
 * Both run through the same leg, so a recent result is visible exactly when
 * a fresh search could surface it.
 */
type Match =
  | { kind: "text"; q: string; parsed: ParsedSearch; phoneDigits: string | null }
  | { kind: "ids"; ids: string[] };

type CoreType = "contact" | "transaction" | "account" | "item" | "project";

// Per-kind authorization comes from the native module's own read permission
// (single source in the nav registry): documents share one table, but access
// to one module must never make records from another module discoverable.
// Kinds without an authorizing module never enter the allowlist at all.
function allowedTransactionKinds(authz: Authz): string[] {
  return TRANSACTION_KINDS.filter((kind) => {
    const permission = transactionModule(kind)?.requiredPermission;
    return Boolean(permission && can(authz, permission));
  });
}

type CoreLegs = Record<CoreType, { hits: SearchHit[]; more: boolean }>;

const NONE = { hits: [] as SearchHit[], more: false };

/**
 * Which groups a parsed query can match. A record scope keeps its own group;
 * an amount, a date or a status only describes transactions.
 */
function queryGroups(parsed: ParsedSearch): Set<CoreType> {
  if (parsed.scopes.length > 0) {
    const groups = new Set<CoreType>();
    for (const scope of parsed.scopes) groups.add(scopeGroup(scope));
    return groups;
  }
  if (parsed.amount || parsed.dates || parsed.status) return new Set(["transaction"]);
  return new Set(["contact", "transaction", "account", "item", "project"]);
}

/** The document kinds a scoped query reads, or null for every kind. */
function scopedKinds(scopes: readonly SearchScope[]): Set<string> | null {
  const kinds = scopes.flatMap((scope) => SCOPE_KINDS[scope] ?? []);
  return kinds.length ? new Set(kinds) : null;
}

/**
 * Run every core leg the reader is entitled to. `matchFor` names the match
 * per leg; a leg with no match (an id lookup naming none of its records) is
 * skipped entirely.
 */
async function coreLegs(
  authz: Authz,
  matchFor: (type: CoreType) => Match | null,
  options: Required<Pick<GlobalSearchOptions, "limit" | "offset">> & { today: string },
): Promise<CoreLegs> {
  const orgId = authz.user.orgId;
  const transactionKinds = allowedTransactionKinds(authz);
  const contactMatch = can(authz, "parties.read") ? matchFor("contact") : null;
  const transactionMatch = matchFor("transaction");
  const accountMatch = can(authz, "gl.read") ? matchFor("account") : null;
  const itemMatch = can(authz, "items.read") ? matchFor("item") : null;
  const projectMatch = can(authz, "projects.read") ? matchFor("project") : null;
  const canProjects = projectMatch !== null && (await isFeatureEnabled(orgId, "projects"));
  // Journal entries carry their own numbers in journal_entries; the gate is
  // the journal module's own read permission, like every other entity above.
  const journalPermission = transactionModule("journal")?.requiredPermission;
  const journalInScope =
    transactionMatch?.kind !== "text" ||
    transactionMatch.parsed.scopes.length === 0 ||
    transactionMatch.parsed.scopes.includes("journal");
  const canJournals = Boolean(
    transactionMatch && journalInScope && journalPermission && can(authz, journalPermission),
  );

  // Subsidiary visibility rides alongside permissions: a restricted caller's
  // search must never surface records their lists would hide.
  const scope = authz.allowedSubsidiaryIds;

  // One shared kind allowlist for the documents legs AND the journal exact
  // arm: an exact JE number for a subledger posting resolves only when the
  // caller holds the posting document's own module permission.
  const visibleKinds =
    transactionMatch && (transactionKinds.length > 0 || canJournals)
      ? visibleTransactionKinds(orgId, transactionKinds)
      : Promise.resolve([] as string[]);
  // A self-service expense reader finds their own expense reports, and no
  // other employee's, beside whatever their module grants show.
  const ownExpenses =
    transactionMatch && !transactionKinds.includes("expense_report")
      ? await ownExpenseSearchScope(authz)
      : null;

  const documentsLeg = async (kinds: string[]) => {
    if (!transactionMatch) return NONE;
    if (transactionMatch.kind === "ids") {
      return {
        hits: await documentsByIds(orgId, transactionMatch.ids, scope, kinds, ownExpenses?.partyId),
        more: false,
      };
    }
    if (!kinds.length && !ownExpenses) return NONE;
    const narrowed = scopedKinds(transactionMatch.parsed.scopes);
    const readable = narrowed ? kinds.filter((kind) => narrowed.has(kind)) : kinds;
    const ownExpenseParty =
      ownExpenses && (!narrowed || narrowed.has("expense_report"))
        ? ownExpenses.partyId
        : undefined;
    if (!readable.length && ownExpenseParty === undefined) return NONE;
    const partiesByWord = can(authz, "parties.read")
      ? await partiesMatchingWords(orgId, transactionMatch.parsed, scope)
      : transactionMatch.parsed.words.map(() => []);
    return searchDocuments({
      orgId,
      q: transactionMatch.q,
      parsed: transactionMatch.parsed,
      scope,
      visibleKinds: readable,
      ownExpenseParty,
      partiesByWord,
      limit: options.limit,
      offset: options.offset,
      today: options.today,
    });
  };
  const journalsLeg = async (kinds: string[]) => {
    if (!canJournals || !transactionMatch) return [];
    if (transactionMatch.kind === "ids")
      return journalByIds(orgId, transactionMatch.ids, scope, kinds);
    if (options.offset > 0) return [];
    return searchJournalEntries({
      orgId,
      q: transactionMatch.q,
      parsed: transactionMatch.parsed,
      scope,
      visibleKinds: kinds,
      limit: options.limit,
    });
  };

  const [contacts, documents, journals, accounts, items, projects] = await Promise.all([
    contactMatch ? searchContacts(orgId, contactMatch, scope, options) : NONE,
    visibleKinds.then(documentsLeg),
    visibleKinds.then(journalsLeg),
    accountMatch ? searchAccounts(orgId, accountMatch, scope, options) : NONE,
    itemMatch ? searchItems(orgId, itemMatch, options) : NONE,
    canProjects && projectMatch ? searchProjects(orgId, projectMatch, scope, options) : NONE,
  ]);
  return {
    contact: contacts,
    // Journal entries ride inside the transactions group rather than a group
    // of their own; an exact number tops the merged group from either leg.
    transaction: { hits: [...documents.hits, ...journals], more: documents.more },
    account: accounts,
    item: items,
    project: projects,
  };
}

const GROUP_LABELS: Record<CoreType, string> = {
  contact: "contacts",
  transaction: "transactions",
  account: "accounts",
  item: "items",
  project: "projects",
};

/** Run the full multi-entity search. */
export async function globalSearch(
  authz: Authz,
  rawQ: string,
  options: GlobalSearchOptions = {},
): Promise<SearchResponse> {
  const q = rawQ.trim().slice(0, 200);
  if (q.length < 2) return { q, groups: [], total: 0 };
  const parseOptions = await searchParseOptions(authz.user.orgId);
  const parsed = parseSearchQuery(q, parseOptions);
  const phoneDigits = phoneSearchDigits(q);
  const groupsAllowed = queryGroups(parsed);
  // Digits written like a phone number find the party that has it, whatever
  // else they could also read as.
  if (phoneDigits && parsed.scopes.length === 0) groupsAllowed.add("contact");
  if (options.types) {
    for (const type of [...groupsAllowed])
      if (!options.types.includes(type)) groupsAllowed.delete(type);
  }
  // A query that is only structure ("$1,200", "overdue invoices") names no
  // words; the name-matching legs have nothing to look for.
  const nameLegsApply = parsed.words.length > 0;
  const match: Match = { kind: "text", q, parsed, phoneDigits };
  const limit = options.limit;
  const legs = await coreLegs(
    authz,
    (type) =>
      groupsAllowed.has(type) &&
      (type === "transaction" || nameLegsApply || (type === "contact" && match.phoneDigits))
        ? match
        : null,
    {
      limit: limit ?? PANEL_LIMIT,
      offset: options.offset ?? 0,
      today: parseOptions.today,
    },
  );
  if (limit === undefined) {
    legs.transaction.hits = legs.transaction.hits.slice(0, PANEL_TRANSACTION_LIMIT);
  }
  const transactions = {
    ...legs.transaction,
    hits: exactNumberFirst(legs.transaction.hits, q),
  };

  // Structured or numeric queries most likely want a transaction; else
  // contacts lead.
  const transactionFirst =
    Boolean(parsed.amount || parsed.dates || parsed.status) ||
    parsed.words.some((word) => word.amount);
  const order: CoreType[] = transactionFirst
    ? ["transaction", "contact", "account", "item", "project"]
    : ["contact", "transaction", "account", "item", "project"];
  const groups: SearchGroup[] = order
    .map((type) => {
      const leg = type === "transaction" ? transactions : legs[type];
      const group: SearchGroup = { type, labelKey: GROUP_LABELS[type], hits: leg.hits };
      if (leg.more) group.more = true;
      return group;
    })
    .filter((g) => g.hits.length > 0);
  return {
    q,
    groups,
    total: groups.reduce((n, g) => n + g.hits.length, 0),
    chips: parsed.chips,
  };
}

/** The parsed reading of a query, for sources outside the core legs. */
export async function parseQueryFor(authz: Authz, rawQ: string): Promise<ParsedSearch> {
  return parseSearchQuery(rawQ, await searchParseOptions(authz.user.orgId));
}

const CORE_TYPES = new Set<SearchType>(["contact", "transaction", "account", "item", "project"]);

/**
 * Re-resolve recently opened core records under the reader's CURRENT
 * permissions and subsidiary scope. A reference the reader can no longer see
 * resolves to nothing; titles and amounts are read fresh, never replayed
 * from the browser.
 */
export async function resolveRecentCoreRecords(
  authz: Authz,
  refs: readonly RecentRef[],
): Promise<SearchHit[]> {
  const idsByType = new Map<string, string[]>();
  for (const ref of refs) {
    if (!CORE_TYPES.has(ref.type)) continue;
    idsByType.set(ref.type, [...(idsByType.get(ref.type) ?? []), ref.id]);
  }
  if (idsByType.size === 0) return [];
  const legs = await coreLegs(
    authz,
    (type) => {
      const ids = idsByType.get(type);
      return ids?.length ? { kind: "ids", ids } : null;
    },
    { limit: PANEL_LIMIT, offset: 0, today: "" },
  );
  return [
    ...legs.contact.hits,
    ...legs.transaction.hits,
    ...legs.account.hits,
    ...legs.item.hits,
    ...legs.project.hits,
  ];
}

/**
 * Stable exact-first partition for merged transaction hits. Hit titles end
 * in the record's number (`<Module label> <document_number>`,
 * `Journal <entry_number>`), so an exact-number query lifts its record
 * above other matches from every leg. Otherwise a no-op.
 */
function exactNumberFirst(hits: SearchHit[], q: string): SearchHit[] {
  const suffix = ` ${q}`.toLowerCase();
  const exact = (hit: SearchHit) => hit.title.toLowerCase().endsWith(suffix);
  if (!hits.some(exact)) return hits;
  return [...hits.filter(exact), ...hits.filter((hit) => !exact(hit))];
}

/** Party ids whose names carry each word, by word index. */
async function partiesMatchingWords(
  orgId: string,
  parsed: ParsedSearch,
  scope: ReadonlySet<string> | null,
): Promise<string[][]> {
  const words = parsed.words;
  if (words.length === 0) return [];
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope);
  const rows = await db.execute<{ i: number; id: string }>(
    sql`
    select w.i::int as i, x.id from unnest(${`{${words
      .map((word) => `"${likePattern(word.text).replace(/["\\]/g, (c) => `\\${c}`)}"`)
      .join(",")}}`}::text[]) with ordinality w(pattern, i)
    cross join lateral (
      select p.id from parties p
       where p.org_id = ${orgId} ${subsidiaryFilter}
         and (p.display_name ilike w.pattern or p.legal_name ilike w.pattern or p.short_code ilike w.pattern)
       order by p.display_name limit 50) x`,
    "objects",
  );
  const byWord: string[][] = words.map(() => []);
  for (const row of rows) byWord[row.i - 1]?.push(row.id);
  return byWord;
}

async function searchContacts(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
  options: { limit: number; offset: number },
): Promise<{ hits: SearchHit[]; more: boolean }> {
  // Parties are org-wide when their primary subsidiary is null — the exact
  // predicate the party lists use (`is null or = any(...)`).
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`p.subsidiary_id`, scope);
  let where: SQL;
  let ranking: SQL;
  let matchedContact: SQL;
  let roleFilter = sql``;
  if (match.kind === "ids") {
    where = sql`p.id = any(${uuidArray(match.ids)})`;
    ranking = sql`0`;
    matchedContact = sql`null`;
  } else {
    const { q, parsed, phoneDigits } = match;
    const roles = parsed.scopes.filter(
      (scope) => scope === "customer" || scope === "vendor" || scope === "employee",
    );
    if (roles.length > 0) {
      roleFilter = sql`and (${sql.join(
        roles.map((role) =>
          role === "customer"
            ? sql`exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id)`
            : role === "vendor"
              ? sql`exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.org_id = p.org_id)`
              : sql`exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id)`,
        ),
        sql` or `,
      )})`;
    }
    // Every word must appear on the party: its names, code, email or
    // website, one of its people or an address. Tax identifiers are sealed
    // and never matched. A single word may also match a name fuzzily, so a
    // typo still finds the party.
    const wordConditions = parsed.words.map((word) => {
      const like = likePattern(word.text);
      return sql`(p.display_name ilike ${like} or p.legal_name ilike ${like} or p.short_code ilike ${like}
          or p.email ilike ${like} or p.website ilike ${like}
          or exists (select 1 from contacts c where c.org_id = p.org_id and c.party_id = p.id
                       and (c.name ilike ${like} or c.email ilike ${like}))
          or exists (select 1 from addresses a where a.org_id = p.org_id and a.party_id = p.id
                       and concat_ws(' ', a.line1, a.line2, a.city, a.region, a.postal_code) ilike ${like}))`;
    });
    const text = parsed.words.map((word) => word.text).join(" ");
    const fuzzy =
      text.length >= 3
        ? sql` or p.display_name % ${text} or coalesce(p.legal_name, '') % ${text}`
        : sql``;
    const phone = phoneDigits
      ? sql` or regexp_replace(coalesce(p.phone, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}
             or exists (select 1 from contacts c where c.org_id = p.org_id and c.party_id = p.id
                          and (regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}
                               or regexp_replace(coalesce(c.mobile_phone, ''), '[^0-9]', '', 'g') like ${`%${phoneDigits}%`}))`
      : sql``;
    const words = wordConditions.length ? sql.join(wordConditions, sql` and `) : sql`false`;
    where = sql`((${words})${fuzzy}${phone} or p.custom -> 'source' ->> 'externalId' = ${q})`;
    ranking = text
      ? sql`greatest(similarity(p.display_name, ${text}), similarity(coalesce(p.legal_name, ''), ${text}))`
      : sql`0`;
    // A party found through one of its people names that person, so the
    // reader sees why "Jane" surfaced Acme Corp.
    const firstLike = parsed.words[0] ? likePattern(parsed.words[0].text) : null;
    matchedContact = firstLike
      ? sql`(select c.name from contacts c
       where c.org_id = p.org_id and c.party_id = p.id
         and (c.name ilike ${firstLike} or c.email ilike ${firstLike})
         and not (p.display_name ilike ${firstLike})
       order by c.is_primary desc, c.name limit 1)`
      : sql`null`;
  }
  const r = await db.execute<SearchContactRow>(
    sql`
    select p.id, p.display_name, p.email, p.legal_name,
           exists (select 1 from customer_roles cr where cr.party_id = p.id and cr.org_id = p.org_id) as is_customer,
           exists (select 1 from vendor_roles vr where vr.party_id = p.id and vr.org_id = p.org_id) as is_vendor,
           exists (select 1 from employee_roles er where er.party_id = p.id and er.org_id = p.org_id) as is_employee,
           ${matchedContact} as matched_contact,
           ${ranking} as sim
      from parties p
     where p.org_id = ${orgId}
       ${subsidiaryFilter} ${roleFilter}
       and ${where}
     order by sim desc, p.display_name, p.id
     limit ${options.limit + 1} offset ${options.offset}`,
    "objects",
  );
  const rows = r.slice(0, options.limit);
  return {
    more: r.length > options.limit,
    hits: rows.map((row): SearchHit => ({
      id: row.id,
      type: "contact",
      title: row.display_name,
      subtitle: row.matched_contact || row.email || row.legal_name || undefined,
      href: `/parties?party=${row.id}`,
      iconKey: row.is_employee ? "clipboard-check" : "users",
      badge: row.is_customer
        ? { kind: "role", value: "customer" }
        : row.is_vendor
          ? { kind: "role", value: "vendor" }
          : row.is_employee
            ? { kind: "role", value: "employee" }
            : undefined,
    })),
  };
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
  const navigationFeatures = [
    ...new Set(
      allowedKinds.flatMap((kind) => {
        const feature = transactionNavigationOnlyFeature(kind);
        return feature ? [feature] : [];
      }),
    ),
  ];
  const [hiddenKinds, navigationFeatureStates] = await Promise.all([
    disabledDocKinds(orgId),
    Promise.all(
      navigationFeatures.map(
        async (feature) => [feature, await isFeatureEnabled(orgId, feature)] as const,
      ),
    ),
  ]);
  const hiddenKindSet = new Set(hiddenKinds);
  const navigationFeatureEnabled = new Map(navigationFeatureStates);
  return allowedKinds.filter((kind) => {
    if (hiddenKindSet.has(kind)) return false;
    const feature = transactionNavigationOnlyFeature(kind);
    return !feature || navigationFeatureEnabled.get(feature) === true;
  });
}

/** The employee whose expense reports a self-service reader may find, when expense reports are enabled. */
async function ownExpenseSearchScope(authz: Authz): Promise<{ partyId: string | null } | null> {
  const access = await expenseAccess(authz, "read");
  if (access?.scope !== "own") return null;
  if (
    !(await visibleTransactionKinds(authz.user.orgId, ["expense_report"])).includes(
      "expense_report",
    )
  )
    return null;
  return { partyId: access.partyId };
}

/** Recently opened documents, under the same kind allowlist and fence as a search. */
async function documentsByIds(
  orgId: string,
  ids: string[],
  scope: ReadonlySet<string> | null,
  visibleKinds: string[],
  ownExpenseParty?: string | null,
): Promise<SearchHit[]> {
  const ownExpenses = ownExpenseParty !== undefined;
  if (visibleKinds.length === 0 && !ownExpenses) return [];
  const kindAllowlist =
    visibleKinds.length > 0
      ? sql`d.kind in (${sql.join(
          visibleKinds.map((value) => sql`${value}`),
          sql`, `,
        )})`
      : sql`false`;
  const ownExpenseArm =
    ownExpenses && ownExpenseParty !== null
      ? sql` or (d.kind = 'expense_report' and d.party_id = ${ownExpenseParty})`
      : sql``;
  const r = await db.execute<Parameters<typeof documentHits>[0][number]>(
    sql`
    select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status, d.project_id,
           d.document_date::text as document_date,
           pr.display_name as party_name,
           coalesce((select sum(dl.amount) from document_lines dl where dl.org_id = ${orgId} and dl.document_id = d.id and dl.amount > 0), d.total) as amount,
           null as line_match, null as amount_source, null as amount_line, null as matched_amount
      from documents d
      left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id ${masterDataSubsidiaryFilter(sql`pr.subsidiary_id`, scope)}
     where d.org_id = ${orgId} and d.id = any(${uuidArray(ids)})
       and (${kindAllowlist}${ownExpenseArm})${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)}`,
    "objects",
  );
  return documentHits(r);
}

/**
 * Recently opened journal entries re-resolve under the exact arm's rule,
 * since that is the widest rule any search could have surfaced them under.
 */
async function journalByIds(
  orgId: string,
  ids: string[],
  scope: ReadonlySet<string> | null,
  visibleKinds: string[],
): Promise<SearchHit[]> {
  const visibility = journalScopeWhere(orgId, scope);
  const linkedKindGate =
    visibleKinds.length === 0
      ? sql`and false`
      : sql`and d.kind in (${sql.join(
          visibleKinds.map((value) => sql`${value}`),
          sql`, `,
        )})`;
  const linkedDocSubsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope);
  const r = await db.execute<Parameters<typeof journalHits>[0][number]>(
    sql`
    select e.id, e.entry_number, e.memo, e.status, e.posting_date::text as posting_date,
           (select sum(l.amount) from journal_lines l where l.org_id = ${orgId} and l.entry_id = e.id and l.amount > 0) as amount,
           null as matched_cents
      from journal_entries e
     where ${visibility}
       and e.id = any(${uuidArray(ids)})
       and (not exists (select 1 from documents d
                         where d.posted_entry_id = e.id and d.org_id = e.org_id)
            or exists (select 1 from documents d
                        where d.posted_entry_id = e.id and d.org_id = e.org_id
                          and d.kind in ('journal', 'pay_run'))
            or exists (select 1 from documents d
                        where d.posted_entry_id = e.id and d.org_id = e.org_id
                          ${linkedDocSubsidiaryFilter} ${linkedKindGate}))`,
    "objects",
  );
  return journalHits(r);
}

/** Every word on the record's name or number, or one fuzzy name match. */
function nameMatch(match: Extract<Match, { kind: "text" }>, name: SQL, extra: SQL[]): SQL {
  const words = match.parsed.words.map((word) => {
    const like = likePattern(word.text);
    return sql`(${name} ilike ${like}${sql.join(
      extra.map((column) => sql` or ${column} ilike ${like}`),
      sql``,
    )})`;
  });
  const text = match.parsed.words.map((word) => word.text).join(" ");
  const fuzzy = text.length >= 3 ? sql` or ${name} % ${text}` : sql``;
  return sql`((${words.length ? sql.join(words, sql` and `) : sql`false`})${fuzzy})`;
}

function nameText(match: Match): string {
  return match.kind === "text" ? match.parsed.words.map((word) => word.text).join(" ") : "";
}

async function searchAccounts(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
  options: { limit: number; offset: number },
): Promise<{ hits: SearchHit[]; more: boolean }> {
  const subsidiaryFilter = masterDataSubsidiaryFilter(sql`subsidiary_id`, scope);
  const predicate =
    match.kind === "ids"
      ? sql`id = any(${uuidArray(match.ids)})`
      : nameMatch(match, sql`name`, [sql`number`]);
  const text = nameText(match);
  const order =
    match.kind === "ids"
      ? sql`number nulls last`
      : sql`(number = ${match.q}) desc, similarity(name, ${text}) desc, number nulls last`;
  const r = await db.execute<SearchAccountRow>(
    sql`
    select id, number, name, type from accounts
     where org_id = ${orgId} and not is_summary
       ${subsidiaryFilter}
       and ${predicate}
     order by ${order}, id
     limit ${options.limit + 1} offset ${options.offset}`,
    "objects",
  );
  return {
    more: r.length > options.limit,
    hits: r.slice(0, options.limit).map((row): SearchHit => ({
      id: row.id,
      type: "account",
      title: `${row.number ? `${row.number} · ` : ""}${row.name}`,
      subtitle: row.type,
      href: `/accounts?accountRegister=${row.id}`,
      iconKey: "layers",
    })),
  };
}

async function searchItems(
  orgId: string,
  match: Match,
  options: { limit: number; offset: number },
): Promise<{ hits: SearchHit[]; more: boolean }> {
  // A scanned barcode (GTIN/UPC/EAN) or a customer's own part number names
  // the item exactly; each resolves through its unique per-org index.
  const where =
    match.kind === "ids"
      ? sql`i.id = any(${uuidArray(match.ids)})`
      : sql`(${nameMatch(match, sql`i.name`, [sql`i.code`, sql`i.description`])}
          or exists (select 1 from item_identifiers ii where ii.org_id = i.org_id and ii.item_id = i.id and ii.value = ${match.q})
          or exists (select 1 from customer_item_refs cr where cr.org_id = i.org_id and cr.item_id = i.id and cr.customer_sku = ${match.q}))`;
  const text = nameText(match);
  const order =
    match.kind === "ids"
      ? sql`i.name`
      : sql`(i.code = ${match.q}) desc, similarity(i.name, ${text}) desc, i.name`;
  const r = await db.execute<SearchItemRow>(
    sql`
    select i.id, i.code, i.name from items i
     where i.org_id = ${orgId} and ${where}
     order by ${order}, i.id
     limit ${options.limit + 1} offset ${options.offset}`,
    "objects",
  );
  return {
    more: r.length > options.limit,
    hits: r.slice(0, options.limit).map((row): SearchHit => ({
      id: row.id,
      type: "item",
      title: row.name,
      subtitle: row.code || undefined,
      href: `/items?item=${row.id}`,
      iconKey: "grid",
    })),
  };
}

async function searchProjects(
  orgId: string,
  match: Match,
  scope: ReadonlySet<string> | null,
  options: { limit: number; offset: number },
): Promise<{ hits: SearchHit[]; more: boolean }> {
  // Project records behave like documents: restricted callers see only their
  // subsidiaries (no org-wide null escape hatch).
  const subsidiaryFilter = subsidiaryVisibleFilter(sql`subsidiary_id`, scope);
  const predicate =
    match.kind === "ids"
      ? sql`id = any(${uuidArray(match.ids)})`
      : nameMatch(match, sql`name`, [sql`code`]);
  const text = nameText(match);
  const order =
    match.kind === "ids"
      ? sql`name`
      : sql`(code = ${match.q}) desc, similarity(name, ${text}) desc, name`;
  const r = await db.execute<SearchProjectRow>(
    sql`
    select id, code, name from projects
     where org_id = ${orgId} ${subsidiaryFilter}
       and ${predicate}
     order by ${order}, id
     limit ${options.limit + 1} offset ${options.offset}`,
    "objects",
  );
  return {
    more: r.length > options.limit,
    hits: r.slice(0, options.limit).map((row): SearchHit => ({
      id: row.id,
      type: "project",
      title: row.name,
      subtitle: row.code || undefined,
      href: `/projects?project=${row.id}`,
      iconKey: "timer",
    })),
  };
}

export { displayMoney };

/** One labelled fact in a hit's preview; the client renders the label in the reader's language. */
export type SearchPreviewField = {
  labelKey: string;
  value: string;
  kind?: "money" | "date" | "status" | "text";
};

export interface SearchPreview {
  hit: SearchHit;
  fields: SearchPreviewField[];
  /** A document's or entry's first lines. */
  lines?: { description: string; amount: string }[];
  /** How many lines it has in all. */
  lineCount?: number;
}

/**
 * The facts a hit's preview shows. The reference first re-resolves through
 * the same legs a search uses, so a preview exists exactly when a search
 * could have surfaced the record; every further read stays inside the
 * reader's organization and fences.
 */
export async function searchPreview(authz: Authz, ref: RecentRef): Promise<SearchPreview | null> {
  if (!CORE_TYPES.has(ref.type)) return null;
  const [hit] = await resolveRecentCoreRecords(authz, [ref]);
  if (!hit) return null;
  const orgId = authz.user.orgId;
  const scope = authz.allowedSubsidiaryIds;
  const fields: SearchPreviewField[] = [];
  const add = (labelKey: string, value: unknown, kind?: SearchPreviewField["kind"]) => {
    if (value === null || value === undefined || value === "") return;
    fields.push({ labelKey, value: String(value), kind });
  };
  if (ref.type === "transaction" && hit.href.startsWith("/journal")) {
    const [entry] = await db.execute<{
      entry_number: string;
      posting_date: string;
      status: string;
      memo: string | null;
    }>(
      sql`select entry_number, posting_date::text as posting_date, status, memo
            from journal_entries where org_id = ${orgId} and id = ${ref.id}`,
      "objects",
    );
    if (!entry) return null;
    add("date", entry.posting_date, "date");
    add("status", entry.status, "status");
    add("memo", entry.memo);
    const lineScope =
      scope === null
        ? sql``
        : sql`and l.subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[])`;
    const lines = await db.execute<{ description: string; amount: unknown; n: number }>(
      sql`select concat_ws(' · ', a.number, a.name) || coalesce(' — ' || l.memo, '') as description, l.amount,
                 count(*) over () as n
            from journal_lines l join accounts a on a.org_id = l.org_id and a.id = l.account_id
           where l.org_id = ${orgId} and l.entry_id = ${ref.id} ${lineScope}
           order by l.amount desc, l.id limit 6`,
      "objects",
    );
    return {
      hit,
      fields,
      lines: lines.map((line) => ({
        description: line.description,
        amount: displayMoney(line.amount),
      })),
      lineCount: Number(lines[0]?.n ?? 0),
    };
  }
  if (ref.type === "transaction") {
    const [doc] = await db.execute<{
      document_date: string;
      due_date: string | null;
      status: string;
      currency: string;
      total: unknown;
      open_balance: unknown;
      tax_total: unknown;
      memo: string | null;
      reference_number: string | null;
    }>(
      sql`select document_date::text as document_date, due_date::text as due_date, status, currency,
                 total, open_balance, tax_total, memo, reference_number
            from documents where org_id = ${orgId} and id = ${ref.id}`,
      "objects",
    );
    if (!doc) return null;
    add("date", doc.document_date, "date");
    add("due", doc.due_date, "date");
    add("status", doc.status, "status");
    add("total", `${displayMoney(doc.total)} ${doc.currency}`, "money");
    if (doc.open_balance !== null && displayMoney(doc.open_balance) !== "0.00")
      add("open", `${displayMoney(doc.open_balance)} ${doc.currency}`, "money");
    if (displayMoney(doc.tax_total) !== "0.00") add("tax", displayMoney(doc.tax_total), "money");
    add("reference", doc.reference_number);
    add("memo", doc.memo);
    const lines = await db.execute<{ description: string | null; amount: unknown; n: number }>(
      sql`select coalesce(nullif(dl.description, ''), i.name) as description, dl.amount, count(*) over () as n
            from document_lines dl left join items i on i.org_id = dl.org_id and i.id = dl.item_id
           where dl.org_id = ${orgId} and dl.document_id = ${ref.id}
           order by dl.line_number limit 6`,
      "objects",
    );
    return {
      hit,
      fields,
      lines: lines.map((line) => ({
        description: line.description ?? "",
        amount: displayMoney(line.amount),
      })),
      lineCount: Number(lines[0]?.n ?? 0),
    };
  }
  if (ref.type === "contact") {
    const [party] = await db.execute<{
      email: string | null;
      phone: string | null;
      website: string | null;
      short_code: string | null;
      address: string | null;
    }>(
      sql`select p.email, p.phone, p.website, p.short_code,
                 (select concat_ws(', ', nullif(a.line1, ''), nullif(a.city, ''), nullif(a.region, ''), nullif(a.postal_code, ''))
                    from addresses a where a.org_id = p.org_id and a.party_id = p.id
                   order by a.is_default_billing desc, a.created_at limit 1) as address
            from parties p where p.org_id = ${orgId} and p.id = ${ref.id}`,
      "objects",
    );
    if (!party) return null;
    add("code", party.short_code);
    add("email", party.email);
    add("phone", party.phone);
    add("website", party.website);
    add("address", party.address);
    // Open balances only from the documents the reader's own modules show.
    const visible = new Set(allowedTransactionKinds(authz));
    const fence = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope);
    for (const [kind, labelKey] of [
      ["customer_invoice", "receivable"],
      ["vendor_bill", "payable"],
    ] as const) {
      if (!visible.has(kind)) continue;
      const [open] = await db.execute<{ total: unknown; n: number }>(
        sql`select sum(d.open_balance) as total, count(*)::int as n from documents d
             where d.org_id = ${orgId} and d.party_id = ${ref.id} and d.kind = ${kind}
               and d.status = 'posted' and d.open_balance > 0 ${fence}`,
        "objects",
      );
      if (open && open.n > 0) add(labelKey, displayMoney(open.total), "money");
    }
    return { hit, fields };
  }
  if (ref.type === "item") {
    const [item] = await db.execute<{
      code: string | null;
      kind: string;
      category: string | null;
      description: string | null;
      default_rate: unknown;
      unit: string | null;
    }>(
      sql`select code, kind, category, description, default_rate, unit from items where org_id = ${orgId} and id = ${ref.id}`,
      "objects",
    );
    if (!item) return null;
    add("code", item.code);
    add("kind", item.kind);
    add("category", item.category);
    if (item.default_rate !== null)
      add(
        "rate",
        `${displayMoney(item.default_rate)}${item.unit ? ` / ${item.unit}` : ""}`,
        "money",
      );
    add("description", item.description);
    return { hit, fields };
  }
  if (ref.type === "project") {
    const [project] = await db.execute<{
      code: string | null;
      status: string | null;
      customer: string | null;
    }>(
      sql`select p.code, p.status, c.display_name as customer from projects p
            left join parties c on c.org_id = p.org_id and c.id = p.customer_id
           where p.org_id = ${orgId} and p.id = ${ref.id}`,
      "objects",
    );
    if (!project) return null;
    add("code", project.code);
    add("status", project.status, "status");
    add("customer", project.customer);
    return { hit, fields };
  }
  if (ref.type === "account") {
    const [account] = await db.execute<{
      number: string | null;
      type: string;
      description: string | null;
    }>(
      sql`select number, type, description from accounts where org_id = ${orgId} and id = ${ref.id}`,
      "objects",
    );
    if (!account) return null;
    add("number", account.number);
    add("accountType", account.type);
    add("description", account.description);
    return { hit, fields };
  }
  return { hit, fields };
}
