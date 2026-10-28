import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { formatMoney } from "@openbooks/engine/money/money";
import {
  journalScopeWhere,
  JOURNAL_GL_NATIVE_ORIGINS,
} from "./customization/entity-list-query/journal-entries";
import { subsidiaryVisibleFilter } from "./subsidiaries";
import type { ParsedSearch, SearchStatus, SearchWord } from "./search-query";
import type { SearchHit, SearchMatch } from "./search-types";
import { moduleDrawerHref, transactionModule } from "./txn-links";

/**
 * Transaction search: documents and journal entries.
 *
 * Under row-level security only equality and range comparisons can use an
 * index, so documents are found through the derived search index (0015):
 * a word is a range of "C"-collated terms, an amount a range of cents. Every
 * query runs in two steps. Candidate legs — the most selective word through
 * the term index, the parties whose names carry that word, the amount range,
 * exact numbers, and date or status windows — each return a capped,
 * newest-first set of ids, side by side. One final read then applies every
 * constraint of the query to those candidates (all words, the amount, the
 * dates, the status and the scope) under the same kind allowlist and
 * subsidiary fence, ranks them, and reads the fields a hit shows.
 *
 * A hit says why it matched: the line whose description or amount matched,
 * or which of the document's amounts (total, open balance, tax) did.
 */

export interface TransactionSearchInput {
  orgId: string;
  q: string;
  parsed: ParsedSearch;
  /** Subsidiary scope of the reader (null = unrestricted). */
  scope: ReadonlySet<string> | null;
  /** Document kinds the reader may see, already narrowed to the query's scope. */
  visibleKinds: string[];
  /** Set for a self-service expense reader: their own expense reports are also visible. */
  ownExpenseParty?: string | null;
  /** Party ids whose names match each word, by word index. */
  partiesByWord: string[][];
  limit: number;
  offset: number;
  today: string;
}

export interface TransactionSearchResult {
  hits: SearchHit[];
  /** Whether more hits exist past this page among the candidates. */
  more: boolean;
}

type DocumentRow = {
  id: string;
  kind: string;
  document_number: string;
  reference_number: string | null;
  memo: string | null;
  status: string | null;
  project_id: string | null;
  document_date: string | null;
  party_name: string | null;
  amount: unknown;
  line_match: string | null;
  amount_source: string | null;
  amount_line: string | null;
  matched_amount: unknown;
};

const CANDIDATE_CAP = 500;
const EXPANSION_CAP = 40;

/** The exclusive upper bound of every string that starts with `prefix`, in code point order. */
export function prefixUpperBound(prefix: string): string {
  const points = [...prefix];
  const last = points.pop()!;
  const code = last.codePointAt(0)!;
  return code >= 0x10ffff
    ? `${prefix}\u{10ffff}`
    : `${points.join("")}${String.fromCodePoint(code + 1)}`;
}

function likePattern(text: string): string {
  return `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`;
}

function uuidArray(ids: readonly string[]): SQL {
  return sql`${`{${ids.join(",")}}`}::uuid[]`;
}

function textArray(values: readonly string[]): SQL {
  return sql`${`{${values.map((value) => `"${value.replace(/["\\]/g, (c) => `\\${c}`)}"`).join(",")}}`}::text[]`;
}

function kindList(kinds: readonly string[]): SQL {
  return sql.join(
    kinds.map((kind) => sql`${kind}`),
    sql`, `,
  );
}

/** Display an amount from its stored decimal string — never through Number. */
export function displayMoney(v: unknown): string {
  if (typeof v !== "string" && typeof v !== "number") return "";
  let rounded: string;
  try {
    rounded = formatMoney(v, 2);
  } catch {
    return "";
  }
  const negative = rounded.startsWith("-");
  const [whole = "", fraction = ""] = (negative ? rounded.slice(1) : rounded).split(".");
  return `${negative ? "-" : ""}${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}.${fraction}`;
}

function centsToDecimal(cents: string): string {
  const padded = cents.padStart(3, "0");
  return `${padded.slice(0, -2)}.${padded.slice(-2)}`;
}

/** The word most likely to be rare: the one with the longest index term. */
function drivingWord(words: SearchWord[]): number {
  let best = -1;
  let bestLength = -1;
  words.forEach((word, index) => {
    const length = Math.max(...word.terms.map((term) => term.length));
    if (length >= bestLength) {
      best = index;
      bestLength = length;
    }
  });
  return best;
}

/** A predicate on a term column: equality for an exact word, a prefix range otherwise. */
function termPredicate(column: SQL, term: string, exact: boolean): SQL {
  return exact
    ? sql`${column} = ${term}`
    : sql`${column} >= ${term} and ${column} < ${prefixUpperBound(term)}`;
}

/** The lifecycle predicate a status word stands for, on documents `d`. */
function statusPredicate(status: SearchStatus, today: string): SQL {
  switch (status) {
    case "open":
      return sql`coalesce(d.open_balance, 0) > 0 and d.status not in ('voided', 'rejected')`;
    case "overdue":
      return sql`coalesce(d.open_balance, 0) > 0 and d.status not in ('voided', 'rejected') and d.due_date < ${today}::date`;
    case "paid":
      return sql`d.open_balance = 0 and d.status = 'posted'`;
    case "draft":
      return sql`d.status = 'draft'`;
    case "pending":
      return sql`d.status = 'pending_approval'`;
    case "voided":
      return sql`d.status = 'voided'`;
    case "posted":
      return sql`d.status = 'posted'`;
  }
}

export async function searchDocuments(
  input: TransactionSearchInput,
): Promise<TransactionSearchResult> {
  const { orgId, q, parsed, scope, ownExpenseParty, partiesByWord } = input;
  const ownExpenses = ownExpenseParty !== undefined;
  const visibleKinds = input.visibleKinds;
  if (visibleKinds.length === 0 && !ownExpenses) return { hits: [], more: false };

  // The same POSITIVE kind allowlist and fail-closed subsidiary fence on
  // every candidate leg and on the final read, so no leg ever names a
  // document outside the reader's modules or legal entities.
  const kindAllowlist =
    visibleKinds.length > 0 ? sql`d.kind in (${kindList(visibleKinds)})` : sql`false`;
  const ownExpenseArm =
    ownExpenses && ownExpenseParty !== null
      ? sql` or (d.kind = 'expense_report' and d.party_id = ${ownExpenseParty})`
      : sql``;
  const fence = sql`and (${kindAllowlist}${ownExpenseArm})${subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope)}`;
  // Index rows carry kind and subsidiary but not the party, so a self-service
  // reader's own expense reports pass this coarser fence and the final read
  // applies the exact one.
  const indexKinds =
    ownExpenses && ownExpenseParty !== null
      ? [...new Set([...visibleKinds, "expense_report"])]
      : visibleKinds;
  const indexFence = (kind: SQL, subsidiary: SQL) =>
    sql`and ${kind} in (${indexKinds.length ? kindList(indexKinds) : sql`null`})${subsidiaryVisibleFilter(subsidiary, scope)}`;

  const candidates = async (query: SQL): Promise<string[]> =>
    (await db.execute<{ id: string }>(query, "objects")).map((row) => row.id);
  const legs: Promise<string[]>[] = [];
  const { words, amount, dates, status } = parsed;

  // Every string-matching leg is driven by one word: a record must contain
  // every word, so the rarest one bounds the candidates best.
  const driver = drivingWord(words);
  if (driver >= 0) {
    const word = words[driver]!;
    const term = [...word.terms].sort((a, b) => b.length - a.length)[0]!;
    const expansion = word.exact
      ? sql`select ${term}::text collate "C" as term`
      : sql`
        with recursive expansions(term) as (
          (select s.term from document_search_terms s
            where s.org_id = ${orgId} and ${termPredicate(sql`s.term`, term, false)}
            order by s.term limit 1)
          union all
          (select (select s.term from document_search_terms s
                    where s.org_id = ${orgId} and s.term > e.term and s.term < ${prefixUpperBound(term)}
                    order by s.term limit 1)
             from expansions e where e.term is not null)
        )
        select term from expansions where term is not null limit ${EXPANSION_CAP}`;
    legs.push(
      candidates(sql`
        select x.document_id as id from (${expansion}) e
        cross join lateral (
          select s.document_id, s.sort_at from document_search_terms s
           where s.org_id = ${orgId} and s.term = e.term ${indexFence(sql`s.kind`, sql`s.subsidiary_id`)}
           order by s.sort_at desc limit ${CANDIDATE_CAP}) x
        group by x.document_id
        order by max(x.sort_at) desc limit ${CANDIDATE_CAP}`),
    );
    const parties = partiesByWord[driver] ?? [];
    if (parties.length > 0) {
      // A counterparty's documents, newest first through its own index.
      legs.push(
        candidates(sql`
          select d.id from unnest(${uuidArray(parties.slice(0, 20))}) p(id)
          cross join lateral (
            select d.id, d.document_date, d.created_at from documents d
             where d.org_id = ${orgId} and d.party_id = p.id ${fence}
             order by d.document_date desc, d.created_at desc limit 25) d
          order by d.document_date desc, d.created_at desc limit ${CANDIDATE_CAP}`),
      );
    }
    if (word.amount) legs.push(amountLeg(word.amount.min, word.amount.max));
  }
  if (amount) legs.push(amountLeg(amount.min, amount.max));

  function amountLeg(min: string, max: string | null): Promise<string[]> {
    // Exact or narrow amounts read in index order; a wide range reads a
    // bounded slice of it so an open-ended bound never sorts the ledger.
    return candidates(sql`
      select x.document_id as id from (
        select a.document_id, a.sort_at from document_search_amounts a
         where a.org_id = ${orgId} and a.cents >= ${min}::bigint
           ${max !== null ? sql`and a.cents <= ${max}::bigint` : sql``} ${indexFence(sql`a.kind`, sql`a.subsidiary_id`)}
         order by a.cents, a.sort_at desc limit ${CANDIDATE_CAP * 10}) x
      group by x.document_id
      order by max(x.sort_at) desc limit ${CANDIDATE_CAP}`);
  }

  // An exact document number or integrator reference resolves directly, so
  // an old exact match is never lost behind a capped leg.
  legs.push(
    candidates(sql`
      select d.id from documents d
       where d.org_id = ${orgId} ${fence}
         and (d.document_number in (${q}, ${q.toUpperCase()}) or d.external_ref = ${q})
       limit 5`),
  );

  // With no word or amount, the query is a window: a status, a date range or
  // a scope ("overdue invoices", "bills last month"). Read each kind's newest
  // documents in that window through its own date index.
  if (driver < 0 && !amount && (dates || status || parsed.scopes.length > 0)) {
    const kinds =
      ownExpenses && ownExpenseParty !== null
        ? [...new Set([...visibleKinds, "expense_report"])]
        : visibleKinds;
    if (kinds.length > 0) {
      legs.push(
        candidates(sql`
          select d.id from unnest(${textArray(kinds)}) k(kind)
          cross join lateral (
            select d.id, d.document_date, d.created_at from documents d
             where d.org_id = ${orgId} and d.kind = k.kind ${fence}
               ${dates?.from ? sql`and d.document_date >= ${dates.from}::date` : sql``}
               ${dates?.to ? sql`and d.document_date <= ${dates.to}::date` : sql``}
               ${status ? sql`and ${statusPredicate(status, input.today)}` : sql``}
             order by d.document_date desc, d.id desc limit ${CANDIDATE_CAP}) d
          order by d.document_date desc, d.created_at desc limit ${CANDIDATE_CAP}`),
      );
    }
  }

  const ids = [...new Set((await Promise.all(legs)).flat())];
  if (ids.length === 0) return { hits: [], more: false };

  // Every constraint of the query, on each candidate.
  const wordCondition = (word: SearchWord, index: number): SQL => {
    const terms = sql.join(
      word.terms.map(
        (term) =>
          sql`exists (select 1 from document_search_terms s
                       where s.org_id = d.org_id and s.document_id = d.id and ${termPredicate(sql`s.term`, term, word.exact)})`,
      ),
      sql` and `,
    );
    const parties = partiesByWord[index] ?? [];
    const party = parties.length ? sql` or d.party_id = any(${uuidArray(parties)})` : sql``;
    const asAmount = word.amount
      ? sql` or exists (select 1 from document_search_amounts a
                         where a.org_id = d.org_id and a.document_id = d.id
                           and a.cents between ${word.amount.min}::bigint and ${word.amount.max ?? word.amount.min}::bigint)`
      : sql``;
    return sql`and ((${terms})${party}${asAmount})`;
  };
  const amountCondition = amount
    ? sql`and exists (select 1 from document_search_amounts a
                       where a.org_id = d.org_id and a.document_id = d.id and a.cents >= ${amount.min}::bigint
                         ${amount.max !== null ? sql`and a.cents <= ${amount.max}::bigint` : sql``})`
    : sql``;
  const dateCondition = sql`${dates?.from ? sql`and d.document_date >= ${dates.from}::date` : sql``} ${dates?.to ? sql`and d.document_date <= ${dates.to}::date` : sql``}`;
  const statusCondition = status ? sql`and ${statusPredicate(status, input.today)}` : sql``;

  // Why a hit matched an amount: the best of its amounts in range, total first.
  const amountRange = amount ?? (driver >= 0 ? words[driver]!.amount : null);
  const amountMatch = amountRange
    ? sql`(select a.source || ':' || a.cents from document_search_amounts a
            where a.org_id = d.org_id and a.document_id = d.id and a.cents >= ${amountRange.min}::bigint
              ${amountRange.max !== null ? sql`and a.cents <= ${amountRange.max}::bigint` : sql``}
            order by case a.source when 'total' then 0 when 'lines' then 1 when 'open' then 2 when 'tax' then 3 else 4 end,
                     a.cents limit 1)`
    : sql`null`;
  const lineWords = words.filter(
    (word) => !word.amount || word.terms.some((term) => /\p{L}/u.test(term)),
  );
  const lineMatch =
    lineWords.length > 0
      ? sql`(select dl.description from document_lines dl
              where dl.org_id = d.org_id and dl.document_id = d.id and dl.description is not null
                and (${sql.join(
                  lineWords.map((word) => sql`dl.description ilike ${likePattern(word.text)}`),
                  sql` or `,
                )})
              order by dl.line_number limit 1)`
      : sql`null`;
  // A number typed without its punctuation ("inv 3668", "INV3668") is still
  // the exact number; digits alone compare as typed, so "1,2" never reads 12.
  const compact = q.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const compactExact = /\p{L}/u.test(compact)
    ? sql` or regexp_replace(lower(d.document_number), '[^[:alnum:]]', '', 'g') = ${compact}`
    : sql``;
  const exactNumber = sql`(lower(d.document_number) = ${q.toLowerCase()} or lower(coalesce(d.external_ref, '')) = ${q.toLowerCase()}${compactExact})`;
  const exactWords =
    words.length > 0
      ? sql`(${sql.join(
          words.map(
            (word) =>
              sql`(case when exists (select 1 from document_search_terms s
                                      where s.org_id = d.org_id and s.document_id = d.id
                                        and s.term = any(${textArray(word.terms)})) then 1 else 0 end)`,
          ),
          sql` + `,
        )})`
      : sql`0`;
  const text = words.map((word) => word.text).join(" ");
  const similarity = text
    ? sql`greatest(similarity(d.document_number, ${text}), similarity(coalesce(d.reference_number, ''), ${text}),
                   similarity(coalesce(d.memo, ''), ${text}), similarity(coalesce(pr.display_name, ''), ${text}))`
    : sql`0`;
  const amtExpr = sql`coalesce((select sum(dl.amount) from document_lines dl where dl.org_id = d.org_id and dl.document_id = d.id and dl.amount > 0), d.total)`;

  const r = await db.execute<DocumentRow>(
    sql`
    select * from (
      select d.id, d.kind, d.document_number, d.reference_number, d.memo, d.status, d.project_id,
             d.document_date::text as document_date,
             pr.display_name as party_name,
             ${amtExpr} as amount,
             ${lineMatch} as line_match,
             ${amountMatch} as amount_source,
             ${exactNumber} as exact_number,
             ${exactWords} as exact_words,
             ${similarity} as sim,
             d.created_at
        from documents d
        left join parties pr on pr.id = d.party_id and pr.org_id = d.org_id
         ${scope === null ? sql`` : sql`and (pr.subsidiary_id is null or pr.subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[]))`}
       where d.org_id = ${orgId} and d.id = any(${uuidArray(ids)}) ${fence}
         ${sql.join(words.map(wordCondition), sql` `)} ${amountCondition} ${dateCondition} ${statusCondition}
    ) m
    order by m.exact_number desc,
             (m.amount_source like 'total:%' or m.amount_source like 'lines:%') desc,
             m.amount_source is not null desc,
             m.exact_words desc, m.sim desc, m.document_date desc nulls last, m.created_at desc, m.id
    limit ${input.limit + 1} offset ${input.offset}`,
    "objects",
  );
  const more = r.length > input.limit;
  return { hits: documentHits(r.slice(0, input.limit)), more };
}

function amountMatchOf(row: DocumentRow): SearchMatch | undefined {
  if (!row.amount_source) return undefined;
  const [source, cents] = row.amount_source.split(":");
  const value = displayMoney(centsToDecimal(cents ?? "0"));
  switch (source) {
    case "total":
    case "lines":
      return { kind: "total", amount: value };
    case "open":
      return { kind: "open", amount: value };
    case "tax":
      return { kind: "tax", amount: value };
    default:
      return { kind: "lineAmount", amount: value };
  }
}

export function documentHits(rows: DocumentRow[]): SearchHit[] {
  // No generic journal fallback: a stored kind without an authorized native
  // module is dropped rather than linked into the wrong module's ledger view.
  return rows.flatMap((row): SearchHit[] => {
    const module = transactionModule(row.kind);
    const href = moduleDrawerHref(row.kind, row.id, { projectId: row.project_id });
    if (!module || !href) return [];
    const match: SearchMatch | undefined = row.line_match
      ? { kind: "line", text: row.line_match }
      : amountMatchOf(row);
    return [
      {
        id: row.id,
        type: "transaction",
        title: `${module.label} ${row.document_number}`,
        subtitle: row.party_name || row.memo || undefined,
        href,
        iconKey: module.iconKey,
        badge:
          row.status && row.status !== "posted" ? { kind: "status", value: row.status } : undefined,
        amount: displayMoney(row.amount),
        date: row.document_date ?? undefined,
        match,
      },
    ];
  });
}

type JournalRow = {
  id: string;
  entry_number: string;
  memo: string | null;
  status: string;
  posting_date: string | null;
  amount: unknown;
  matched_cents: string | null;
};

export interface JournalSearchInput {
  orgId: string;
  q: string;
  parsed: ParsedSearch;
  scope: ReadonlySet<string> | null;
  /** The reader's kind allowlist, gating entries linked to a subledger document. */
  visibleKinds: string[];
  limit: number;
}

/**
 * Journal entries carry their own numbers (JE-…) in journal_entries, and
 * GL-native entries (closing, allocation, …) have no source document at all
 * — the documents legs can never surface them. Matching stays scoped
 * exactly like the journal list (journal/pay_run backed entries plus
 * GL-native origins; entries posted from other subledgers stay discoverable
 * through their document). An exact entry number resolves its entry — a
 * dashboard-visible JE number must never search total zero — but NEVER past
 * the posting module's own gate: a linked entry resolves only when its link
 * scope (journal/pay_run) or the linked document's kind in the caller's
 * allowlist permits it, so a gl.read-only caller cannot pull AP or other
 * subledger memos by number. Unlinked entries resolve under the journal gate
 * alone. The org and subsidiary doorway applies on every arm; an amount
 * matches only lines the reader's subsidiaries can see.
 */
export async function searchJournalEntries(input: JournalSearchInput): Promise<SearchHit[]> {
  const { orgId, q, parsed, scope, visibleKinds } = input;
  const { words, amount, dates, status } = parsed;
  const visibility = journalScopeWhere(orgId, scope);
  const linkedKindGate =
    visibleKinds.length === 0 ? sql`and false` : sql`and d.kind in (${kindList(visibleKinds)})`;
  const linkedDocSubsidiaryFilter = subsidiaryVisibleFilter(sql`d.subsidiary_id`, scope);
  const exactArmLinkRule = sql`(not exists (select 1 from documents d
                            where d.posted_entry_id = e.id and d.org_id = e.org_id)
               or exists (select 1 from documents d
                           where d.posted_entry_id = e.id and d.org_id = e.org_id
                             and d.kind in ('journal', 'pay_run'))
               or exists (select 1 from documents d
                           where d.posted_entry_id = e.id and d.org_id = e.org_id
                             ${linkedDocSubsidiaryFilter} ${linkedKindGate}))`;
  const amountScope =
    scope === null ? sql`` : sql`and a.subsidiary_id = any(${`{${[...scope].join(",")}}`}::uuid[])`;
  const amountRange = amount ?? words.find((word) => word.amount)?.amount ?? null;
  const wordConditions = sql.join(
    words.map((word) => {
      const text = sql`(e.entry_number ilike ${likePattern(word.text)} or e.memo ilike ${likePattern(word.text)})`;
      const asAmount = word.amount
        ? sql` or exists (select 1 from journal_search_amounts a
                           where a.org_id = e.org_id and a.entry_id = e.id ${amountScope}
                             and a.cents between ${word.amount.min}::bigint and ${word.amount.max ?? word.amount.min}::bigint)`
        : sql``;
      return sql`and (${text}${asAmount})`;
    }),
    sql` `,
  );
  const amountCondition = amount
    ? sql`and exists (select 1 from journal_search_amounts a
                       where a.org_id = e.org_id and a.entry_id = e.id ${amountScope} and a.cents >= ${amount.min}::bigint
                         ${amount.max !== null ? sql`and a.cents <= ${amount.max}::bigint` : sql``})`
    : sql``;
  const dateCondition = sql`${dates?.from ? sql`and e.posting_date >= ${dates.from}::date` : sql``} ${dates?.to ? sql`and e.posting_date <= ${dates.to}::date` : sql``}`;
  const statusCondition =
    status === "draft"
      ? sql`and e.status = 'draft'`
      : status === "posted"
        ? sql`and e.status = 'posted'`
        : status === "voided"
          ? sql`and e.status = 'reversed'`
          : status
            ? sql`and false`
            : sql``;
  const constraints = sql`${wordConditions} ${amountCondition} ${dateCondition} ${statusCondition}`;
  if (words.length === 0 && !amount && !dates && !status && !parsed.scopes.includes("journal"))
    return [];

  // Entries found by amount through the index, still inside the fuzzy scope.
  const amountCandidates = amountRange
    ? sql`
      union
      select e.id, e.entry_number, e.memo, e.status, e.posting_date, e.created_at
        from (select a.entry_id from journal_search_amounts a
               where a.org_id = ${orgId} ${amountScope} and a.cents >= ${amountRange.min}::bigint
                 ${amountRange.max !== null ? sql`and a.cents <= ${amountRange.max}::bigint` : sql``}
               order by a.cents, a.sort_at desc limit 2000) x
        join journal_entries e on e.org_id = ${orgId} and e.id = x.entry_id
       where ${visibility}
         and (exists (select 1 from documents d where d.posted_entry_id = e.id and d.org_id = e.org_id and d.kind in ('journal', 'pay_run'))
              or (e.origin in (${sql.join(
                JOURNAL_GL_NATIVE_ORIGINS.map((origin) => sql`${origin}`),
                sql`, `,
              )})
                  and not exists (select 1 from documents d where d.posted_entry_id = e.id and d.org_id = e.org_id)))
         ${constraints}`
    : sql``;
  const matchedCents = amountRange
    ? sql`(select a.cents::text from journal_search_amounts a
            where a.org_id = ${orgId} and a.entry_id = u.id ${amountScope} and a.cents >= ${amountRange.min}::bigint
              ${amountRange.max !== null ? sql`and a.cents <= ${amountRange.max}::bigint` : sql``}
            order by a.cents limit 1)`
    : sql`null`;

  // The fuzzy scope is two small sets, each read from its own index: entries
  // posted by journal and pay-run documents, and GL-native entries with no
  // source document. UNION forbids expression ORDER BY, so the merged legs
  // sit in a subquery and the exact-first ordering applies outside it.
  const r = await db.execute<JournalRow>(
    sql`
    select u.id, u.entry_number, u.memo, u.status, u.posting_date::text as posting_date,
           (select sum(l.amount) from journal_lines l where l.org_id = ${orgId} and l.entry_id = u.id and l.amount > 0) as amount,
           ${matchedCents} as matched_cents
      from (
      select e.id, e.entry_number, e.memo, e.status, e.posting_date, e.created_at
        from documents d
        join journal_entries e on e.org_id = d.org_id and e.id = d.posted_entry_id
       where d.org_id = ${orgId} and d.kind in ('journal', 'pay_run')
         and ${visibility}
         ${constraints}
      union
      select e.id, e.entry_number, e.memo, e.status, e.posting_date, e.created_at
        from journal_entries e
       where ${visibility}
         and e.origin in (${sql.join(
           JOURNAL_GL_NATIVE_ORIGINS.map((origin) => sql`${origin}`),
           sql`, `,
         )})
         and not exists (select 1 from documents d
                          where d.posted_entry_id = e.id and d.org_id = e.org_id)
         ${constraints}
      ${amountCandidates}
      union
      (select e.id, e.entry_number, e.memo, e.status, e.posting_date, e.created_at
         from journal_entries e
        where ${visibility}
          and e.entry_number in (${q}, ${q.toUpperCase()})
          and ${exactArmLinkRule}
        limit 5)
    ) u
     order by (lower(u.entry_number) = ${q.toLowerCase()}) desc, ${matchedCents} is not null desc,
              similarity(u.entry_number, ${q}) desc, u.posting_date desc, u.created_at desc, u.id
     limit ${input.limit}`,
    "objects",
  );
  return journalHits(r);
}

export function journalHits(rows: JournalRow[]): SearchHit[] {
  return rows.map((row): SearchHit => ({
    id: row.id,
    type: "transaction",
    title: `Journal ${row.entry_number}`,
    subtitle: row.memo || undefined,
    href: `/journal?journalEntry=${row.id}`,
    iconKey: "journal",
    badge:
      row.status && row.status !== "posted" ? { kind: "status", value: row.status } : undefined,
    amount: row.amount != null ? displayMoney(row.amount) : undefined,
    date: row.posting_date ?? undefined,
    match: row.matched_cents
      ? { kind: "lineAmount", amount: displayMoney(centsToDecimal(row.matched_cents)) }
      : undefined,
  }));
}
