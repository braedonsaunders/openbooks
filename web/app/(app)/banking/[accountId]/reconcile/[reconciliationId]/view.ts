import "server-only";

import { getMoneyFormatter } from "@/lib/money-server";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { formatCivilDate } from "@/lib/format";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import {
  reconciliationBookId,
  reconciliationTotals,
  reconciliationStaleness,
  priorPeriodLateEffect,
  openingPosition,
  reconciliationEvidence,
  type OpeningPosition,
} from "@openbooks/engine/banking/banking";
import { businessTimeZone } from "@openbooks/engine/platform/business-date/module";
import { excludePeriodEndJournals } from "@openbooks/engine/records/period-end-origins";
import {
  page,
  pageHeader,
  ref,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { can, requirePermission, subsidiaryScopeAllows } from "../../../../../../lib/authz";
import { openingCarryStartDate } from "../../../../../../lib/banking-accounts";
import { isUuid, parsePrefixedListParams, pickString } from "../../../../../../lib/list-params";
import type { ModuleHomeTab } from "../../../../../../components/module-home/tab-types";
import {
  formatHistory,
  formatStatementEvidence,
  type EvidenceFormatters,
  type HistoryRow,
  type StatementEvidenceRow,
} from "./evidence-format";

/**
 * A single reconciliation session, split into a loader and a spec.
 *
 * The page is a header plus one stateful workspace — the same archetype as
 * `/banking/match` (see `../../match/view.ts` for the division and its
 * rationale): the spec composes the header and the stat tiles, and the
 * `ReconcileWorkspace` stays whole. It owns selection state across three
 * paginated panes, the match/unmatch/sign-off calls, and an adjust drawer.
 * Decomposing it would strand the selection from the actions it drives, and
 * its tables carry per-row client state (radio/checkbox selection) no `table`
 * block can express.
 *
 * The loader below copies `page.tsx`'s query, permission and formatting logic
 * verbatim: the `banking.read` gate (which also decides the row counts), the
 * `banking.reconcile` boolean (data, not a capability — the workspace's
 * mutations ride the session cookie inside the shared component), the
 * `signed_off` short-circuits that zero the two open panes, and the unknown-
 * status fallback that renders the raw code with underscores spaced out.
 *
 * `canReconcile` travels as a plain boolean for the same reason
 * `canManageAccounts` does on the accounts page: a spec that could name an
 * Authz, an org id or a user id is a cross-tenant read.
 */

const STMT_SORTS = {
  date: sql`l.posted_on`,
  amount: sql`l.amount`,
  description: sql`l.description`,
} as const;

const GL_SORTS = {
  date: sql`je.posting_date`,
  amount: sql`jl.txn_amount`,
  entry: sql`je.entry_number`,
} as const;

const M_SORTS = {
  date: sql`sl.posted_on`,
  amount: sql`sl.amount`,
  by: sql`m.matched_by`,
} as const;

// Known reconciliation statuses — unknown values render as the raw code with
// underscores spaced out.
const RECON_STATUS_KEYS = ["signed_off", "balanced", "in_progress"];
const STATEMENT_SOURCE_KEYS = [
  "ofx",
  "csv",
  "camt053",
  "bai2",
  "mt940",
  "feed_api",
  "manual",
] as const;

/** The body the page shows: the matching workspace, or one evidence tab. */
export type ReconcileView = "working" | "statements" | "history";

/** Read-only evidence for the statements and history tabs, formatted by the loader. */
export interface ReconcileEvidenceView {
  sourceEvidence: boolean;
  windowStart: string | null;
  throughDate: string;
  statements: StatementEvidenceRow[];
  history: HistoryRow[];
}

// Connector labels resolve from the tenant's own connections table, never
// from a hardcoded vendor map (shared with the account page).

interface ReconciliationRow extends Record<string, unknown> {
  id: string;
  account_id: string;
  through_date: string;
  statement_balance: string;
  currency: string;
  status: string;
  signed_off_at: string | null;
  signed_off_by_name: string | null;
  account_number: string | null;
  account_name: string;
  evidence_kind: string;
  evidence_connector: string | null;
  account_subsidiary_id: string | null;
}

export interface ReconcileStmtRow extends Record<string, unknown> {
  id: string;
  posted_on: string;
  amount: string;
  description: string | null;
  counterparty_ref: string | null;
  /** The earlier line this one may duplicate (flagged), or null. */
  possible_duplicate_of: string | null;
  dup_posted_on: string | null;
  dup_amount: string | null;
}

export interface ReconcileGlRow extends Record<string, unknown> {
  id: string;
  posting_date: string;
  entry_number: string;
  amount: string;
  memo: string | null;
  party: string | null;
}

export interface ReconcileMatchedRow extends Record<string, unknown> {
  id: string;
  statement_line_id: string;
  matched_by: string;
  confidence: string | null;
  stmt_date: string;
  stmt_amount: string;
  stmt_description: string | null;
  entry_number: string;
  gl_date: string;
  gl_amount: string;
  gl_memo: string | null;
}

interface CountRow extends Record<string, unknown> {
  n: string | number;
}

export interface ReconcilePaneParams {
  q: string | undefined;
  sort: string;
  dir: "asc" | "desc";
  page: number;
  perPage: number;
}

export interface ReconcileGlClearing extends Record<string, unknown> {
  group_id: string;
  lines: number;
  entries: string | null;
  total: string;
}

export interface ReconcileStaleLateEntry extends Record<string, unknown> {
  entryNumber: string;
  postingDate: string;
  amount: string;
  postedBy: string | null;
  postedAt: string | null;
}

export interface ReconcileStaleReversedEntry extends Record<string, unknown> {
  entryNumber: string;
  postingDate: string;
  amount: string;
  reversal: string | null;
}

export interface ReconcileStaleness extends Record<string, unknown> {
  reviewed: boolean;
  reviewedHref: string | null;
  reviewedText: string | null;
  badge: string;
  effect: string;
  late: ReconcileStaleLateEntry[];
  reversed: ReconcileStaleReversedEntry[];
}

export interface ReconciliationData {
  backHref: string;
  backLabel: string;
  headerTitle: string;
  headerDescription: string;
  badgeLabel: string;
  badgeVariant: "success" | "warning" | "secondary";
  statementBalanceLabel: string;
  statementBalanceValue: string;
  clearedBalanceLabel: string;
  clearedBalanceValue: string;
  differenceLabel: string;
  difference: string;
  differenceCurrency: string;
  matchedLabel: string;
  matchedValue: string;
  basePath: string;
  accountPath: string;
  currentParams: Record<string, string | string[] | undefined>;
  canReconcile: boolean;
  canReviewSignOff: boolean;
  reconciliation: {
    id: string;
    status: string;
    throughDate: string;
    statementBalance: string;
    currency: string;
  };
  stmtRows: ReconcileStmtRow[];
  stmtTotal: number;
  stmtOutstandingTotal: string;
  stmtParams: ReconcilePaneParams;
  glRows: ReconcileGlRow[];
  glTotal: number;
  glOutstandingTotal: string;
  glParams: ReconcilePaneParams;
  matchedRows: ReconcileMatchedRow[];
  matchedTotal: number;
  mParams: ReconcilePaneParams;
  glClearings: ReconcileGlClearing[];
  /** Read-time staleness once signed off; null while the sign-off stands. */
  stale: ReconcileStaleness | null;
  /** Late effects from earlier signed-off periods, for unsigned sessions. */
  priorEffects: string[];
  /**
   * Opening position for a first reconciliation from a balance-less
   * statement: whether the operator must confirm the book balance carried
   * in, and the confirmation standing behind the cleared balance.
   */
  opening: OpeningPosition | null;
  /** The body the page shows; the workspace is the default. */
  view: ReconcileView;
  /** Peer concepts of the session, switched in the page header. */
  tabs: ModuleHomeTab[];
  /** Supporting statements and history; null while the workspace is shown. */
  evidence: ReconcileEvidenceView | null;
}

export async function loadReconciliation(
  accountId: string,
  reconciliationId: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<ReconciliationData> {
  const authz = await requirePermission("banking.read");
  const canReconcile = can(authz, "banking.reconcile");
  const canReviewSignOff = canReconcile || can(authz, "banking.review_sign_off");
  const t = await getTranslations("banking");
  const locale = await getLocale();
  if (!isUuid(accountId) || !isUuid(reconciliationId)) notFound();
  const basePath = `/banking/${accountId}/reconcile/${reconciliationId}`;

  const reconRes = await db.execute<ReconciliationRow>(
    sql`
    select r.id, r.account_id, r.through_date, r.statement_balance, r.currency, r.status,
           r.signed_off_at, u.name as signed_off_by_name,
           a.number as account_number, a.name as account_name,
           r.evidence_kind, r.evidence_connector,
           a.subsidiary_id as account_subsidiary_id
      from reconciliations r
      join accounts a on a.id = r.account_id and a.org_id = r.org_id
      left join users u on u.id = r.signed_off_by
     where r.id = ${reconciliationId} and r.account_id = ${accountId}
       and r.org_id = ${authz.user.orgId}
  `,
    "objects",
  );
  const recon = reconRes[0];
  // Sessions on another entity's account (or a shared account, for a
  // restricted reader) do not exist as far as this page is concerned.
  if (!recon || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, recon.account_subsidiary_id))
    notFound();
  const { money } = await getMoneyFormatter(authz.user.orgId, recon.currency);

  const ctx = {
    orgId: authz.user.orgId,
    userId: authz.user.id,
    allowedSubsidiaryIds: authz.allowedSubsidiaryIds,
  };
  const totals = await reconciliationTotals(reconciliationId, ctx);
  const bookId = await reconciliationBookId(db, ctx.orgId);
  const signedOff = recon.status === "signed_off";
  const sourceEvidence = recon.evidence_kind === "source";
  // The connection's own display name is tenant data, so naming the source
  // system stays vendor-neutral; without a matching connection the generic
  // fallback names it.
  const connectorName = recon.evidence_connector
    ? ((
        await db.execute<{ display_name: string }>(
          sql`
        select c.display_name from connections c
         where c.org_id = ${ctx.orgId} and c.source = ${recon.evidence_connector}
         order by c.mirror_enabled desc, c.created_at limit 1
      `,
          "objects",
        )
      )[0]?.display_name ?? t("sourceSystem.other"))
    : t("sourceSystem.other");

  // Source-evidenced sign-offs stand on mirrored cleared stamps, not on
  // imported statement lines: count the covered lines the same way close
  // readiness does (cleared stamp or reconciled vs neither, cutoff-bound).
  let clearedLines = 0;
  let unclearedLines = 0;
  if (sourceEvidence) {
    const evidenceCounts = await db.execute<Record<string, unknown>>(
      sql`
      select count(*) filter (
               where (jl.source_cleared_date is not null and jl.source_cleared_date <= ${recon.through_date})
                  or jl.reconciled_at is not null
             ) as cleared,
             count(*) filter (
               where (jl.source_cleared_date is null or jl.source_cleared_date > ${recon.through_date})
                 and jl.reconciled_at is null
             ) as uncleared
        from journal_lines jl
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where jl.org_id = ${ctx.orgId} and jl.account_id = ${accountId}
         and je.book_id = ${bookId} and je.status in ('posted', 'reversed')
         and jl.currency = ${recon.currency} and jl.posting_date <= ${recon.through_date}
         and ${excludePeriodEndJournals(sql`je.origin`)}
    `,
      "objects",
    );
    clearedLines = Number(evidenceCounts[0]?.cleared ?? 0);
    unclearedLines = Number(evidenceCounts[0]?.uncleared ?? 0);
  }
  // Resolved eagerly: the description below needs a connector label exactly
  // when this reconciliation stands on source evidence.
  const sourceConnector = sourceEvidence ? connectorName : "";

  // -- left pane: unmatched statement lines (prefix stmt*) -------------------
  const stmtParams = parsePrefixedListParams(sp, "stmt", {
    sort: "date",
    dir: "asc",
    perPage: 15,
    allowedSorts: ["date", "amount", "description"] as const,
  });
  const stmtWhere = sql`s.account_id = ${accountId} and s.org_id = ${ctx.orgId}
    and l.currency = ${recon.currency} and l.match_status = 'unmatched' and l.posted_on <= ${recon.through_date}
    ${stmtParams.q ? sql` and (l.description ilike ${"%" + stmtParams.q + "%"} or l.counterparty_ref ilike ${"%" + stmtParams.q + "%"} or l.amount::text ilike ${"%" + stmtParams.q + "%"})` : sql``}`;

  // -- right pane: unreconciled, unclaimed GL lines (prefix gl*) --------------
  const glParams = parsePrefixedListParams(sp, "gl", {
    sort: "date",
    dir: "asc",
    perPage: 15,
    allowedSorts: ["date", "amount", "entry"] as const,
  });
  // Lines covered by an opening carry are cleared by that carry, not by
  // matching — hide them here exactly as the engine excludes them. A first
  // session's own confirmed opening applies before anything is signed off,
  // so its pre-carry book lines stop reading as outstanding items.
  const opening = await openingPosition(reconciliationId, ctx);
  const signedCarryStart = await openingCarryStartDate(ctx.orgId, accountId);
  const carryStart = signedCarryStart ?? (opening?.carryApplies ? opening.carryStart : null);
  const glWhere = sql`jl.account_id = ${accountId} and jl.org_id = ${ctx.orgId}
    and je.book_id = ${bookId} and jl.currency = ${recon.currency}
    and je.status in ('posted', 'reversed') and je.posting_date <= ${recon.through_date}
    and ${excludePeriodEndJournals(sql`je.origin`)}
    ${carryStart ? sql`and je.posting_date >= ${carryStart}` : sql``}
    and jl.reconciled_at is null
    and not exists (select 1 from reconciliation_matches m where m.journal_line_id = jl.id and m.org_id = jl.org_id)
    ${glParams.q ? sql` and (je.entry_number ilike ${"%" + glParams.q + "%"} or je.memo ilike ${"%" + glParams.q + "%"} or jl.memo ilike ${"%" + glParams.q + "%"} or jl.txn_amount::text ilike ${"%" + glParams.q + "%"})` : sql``}`;

  // -- matched this session (prefix m*) ---------------------------------------
  const mParams = parsePrefixedListParams(sp, "m", {
    sort: "date",
    dir: "asc",
    perPage: 15,
    allowedSorts: ["date", "amount", "by"] as const,
  });
  const mWhere = sql`m.reconciliation_id = ${reconciliationId} and m.org_id = ${ctx.orgId}
    ${mParams.q ? sql` and (sl.description ilike ${"%" + mParams.q + "%"} or je.entry_number ilike ${"%" + mParams.q + "%"} or jl.memo ilike ${"%" + mParams.q + "%"})` : sql``}`;

  // Outstanding evidence loads for every status including signed_off: a
  // signed-off session with a posted in-period book entry and no bank line
  // must show it, not report difference zero over an empty pane. The panes
  // stay read-only once signed; only their data flows again.
  // -- GL-only clearing groups this session (no statement side) --------------
  const glClearings = await db.execute<ReconcileGlClearing>(
    sql`
    select m.group_id, count(*)::int as lines,
           string_agg(distinct je.entry_number, ', ') as entries,
           coalesce(sum(jl.txn_amount), 0)::text as total
      from reconciliation_matches m
      join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
     where m.reconciliation_id = ${reconciliationId} and m.org_id = ${ctx.orgId}
       and m.statement_line_id is null
     group by m.group_id
     order by min(m.created_at)
  `,
    "objects",
  );

  const [stmtRows, stmtCount, glRows, glCount, mRows, mCount] = await Promise.all([
    db.execute<ReconcileStmtRow>(
      sql`
          select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref,
                 l.possible_duplicate_of, dup.posted_on::text as dup_posted_on, dup.amount::text as dup_amount
            from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
            left join bank_statement_lines dup on dup.id = l.possible_duplicate_of and dup.org_id = l.org_id
           where ${stmtWhere}
           order by ${STMT_SORTS[stmtParams.sort]} ${stmtParams.dir === "asc" ? sql`asc` : sql`desc`} nulls last, l.line_number
           limit ${stmtParams.perPage} offset ${(stmtParams.page - 1) * stmtParams.perPage}
        `,
      "objects",
    ),
    db.execute<CountRow & { total: string }>(
      sql`
          select count(*) as n, coalesce(sum(l.amount), 0) as total from bank_statement_lines l
            join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
           where ${stmtWhere}`,
      "objects",
    ),
    db.execute<ReconcileGlRow>(
      sql`
          select jl.id, je.posting_date, je.entry_number, jl.txn_amount as amount,
                 coalesce(jl.memo, je.memo) as memo, p.display_name as party
            from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
            left join parties p on p.id = jl.party_id and p.org_id = jl.org_id
           where ${glWhere}
           order by ${GL_SORTS[glParams.sort]} ${glParams.dir === "asc" ? sql`asc` : sql`desc`} nulls last, jl.line_number
           limit ${glParams.perPage} offset ${(glParams.page - 1) * glParams.perPage}
        `,
      "objects",
    ),
    db.execute<CountRow & { total: string }>(
      sql`
          select count(*) as n, coalesce(sum(jl.txn_amount), 0) as total from journal_lines jl
            join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
           where ${glWhere}`,
      "objects",
    ),
    db.execute<ReconcileMatchedRow>(
      sql`
      select m.id, m.statement_line_id, m.matched_by, m.confidence,
             sl.posted_on as stmt_date, sl.amount as stmt_amount, sl.description as stmt_description,
             je.entry_number, je.posting_date as gl_date, jl.txn_amount as gl_amount,
             coalesce(jl.memo, je.memo) as gl_memo
        from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
        join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}
       order by ${M_SORTS[mParams.sort]} ${mParams.dir === "asc" ? sql`asc` : sql`desc`} nulls last, m.created_at
       limit ${mParams.perPage} offset ${(mParams.page - 1) * mParams.perPage}
    `,
      "objects",
    ),
    db.execute<CountRow>(
      sql`
      select count(*) as n from reconciliation_matches m
        join bank_statement_lines sl on sl.id = m.statement_line_id and sl.org_id = m.org_id
        join journal_lines jl on jl.id = m.journal_line_id and jl.org_id = m.org_id
        join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id
       where ${mWhere}`,
      "objects",
    ),
  ]);

  // Read-time staleness: late in-period postings and reversed matches move
  // the ledger under a frozen sign-off. Unsigned sessions instead explain
  // their opening difference from earlier signed-off periods' late effects.
  const detail = await reconciliationStaleness(reconciliationId, ctx);
  const stale: ReconcileStaleness | null =
    detail.stale || detail.revalidation
      ? {
          reviewed: !!detail.revalidation,
          reviewedHref: detail.revalidation
            ? `/banking/${accountId}/reconcile/${detail.revalidation.reviewedReconciliationId}`
            : null,
          reviewedText: detail.revalidation
            ? t("revalidation.reviewedBasis", { date: detail.revalidation.appliesFromThroughDate })
            : null,
          badge: detail.revalidation
            ? t("revalidation.reviewedBadge")
            : t("stale.badge", { date: detail.staleSince ?? recon.through_date }),
          effect:
            detail.revalidation?.proof.neutralBasis === "outstanding_movements"
              ? t("revalidation.reviewedOutstandingEffect", {
                  lateAmount: money(detail.clearedEffect, { maximumFractionDigits: 4 }),
                  amount: money(detail.revalidation.proof.outstandingEffect, {
                    maximumFractionDigits: 4,
                  }),
                })
              : t("stale.effect", {
                  amount: money(detail.clearedEffect, { maximumFractionDigits: 4 }),
                }),
          late: detail.lateEntries.map((entry) => ({
            entryNumber: entry.entryNumber,
            postingDate: entry.postingDate,
            amount: entry.amount,
            postedBy: entry.postedBy,
            postedAt: entry.postedAt?.slice(0, 10) ?? null,
          })),
          reversed: detail.reversedMatches.map((entry) => ({
            entryNumber: entry.entryNumber,
            postingDate: entry.postingDate,
            amount: entry.amount,
            reversal: entry.reversalNumber
              ? t("stale.reversal", {
                  number: entry.reversalNumber,
                  date: entry.reversedAt?.slice(0, 10) ?? recon.through_date,
                })
              : null,
          })),
        }
      : null;
  const priorEffects = signedOff
    ? []
    : (await priorPeriodLateEffect(accountId, recon.through_date, ctx)).map((effect) =>
        t("stale.openingEffect", {
          amount: money(effect.amount, { maximumFractionDigits: 4 }),
          period: effect.throughDate,
        }),
      );

  // -- evidence tabs (?view=statements|history) ------------------------------
  // The matching workspace stays the default body. The evidence tabs replace
  // it: each reads the session's supporting statements or governed history,
  // formatted here so the components receive display values only.
  const requestedView = pickString(sp.view);
  const view: ReconcileView =
    requestedView === "statements" || requestedView === "history" ? requestedView : "working";
  const tabs: ModuleHomeTab[] = [
    { href: basePath, label: t("reconcileEvidence.tabs.workspace"), active: view === "working" },
    {
      href: `${basePath}?view=statements`,
      label: t("reconcileEvidence.tabs.statements"),
      active: view === "statements",
    },
    {
      href: `${basePath}?view=history`,
      label: t("reconcileEvidence.tabs.history"),
      active: view === "history",
    },
  ];
  let evidence: ReconcileEvidenceView | null = null;
  if (view !== "working") {
    const timeZone = await businessTimeZone(ctx.orgId);
    const timestampFormatter = new Intl.DateTimeFormat(locale, {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone,
    });
    const countFormatter = new Intl.NumberFormat(locale);
    const formatters: EvidenceFormatters = {
      money: (value) => money(value, { maximumFractionDigits: 4 }),
      count: (value) => countFormatter.format(value),
      civilDate: (value) => formatCivilDate(value, locale),
      timestamp: (value) => {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : timestampFormatter.format(date);
      },
      source: (value) => {
        const key = STATEMENT_SOURCE_KEYS.find((candidate) => candidate === value) ?? "unknown";
        return t(`statementSources.${key}`);
      },
      status: (value) =>
        RECON_STATUS_KEYS.includes(value) ? t(`reconStatus.${value}`) : value.replace(/_/g, " "),
    };
    const read = await reconciliationEvidence(reconciliationId, ctx);
    evidence = {
      sourceEvidence,
      windowStart: read.reconciliation.windowStart
        ? formatCivilDate(read.reconciliation.windowStart, locale)
        : null,
      throughDate: formatCivilDate(read.reconciliation.throughDate, locale),
      statements: formatStatementEvidence(read, formatters),
      history: formatHistory(read.history, formatters),
    };
  }

  return {
    backHref: `/banking/${accountId}`,
    backLabel: [recon.account_number, recon.account_name].filter(Boolean).join(" · "),
    headerTitle: t("reconcile.title", { date: recon.through_date }),
    headerDescription: sourceEvidence
      ? recon.signed_off_by_name
        ? t("reconcile.sourceSignedOffByDescription", {
            connector: sourceConnector,
            date: recon.through_date,
            name: recon.signed_off_by_name,
            cleared: clearedLines,
            uncleared: unclearedLines,
          })
        : t("reconcile.sourceSignedOffDescription", {
            connector: sourceConnector,
            date: recon.through_date,
            cleared: clearedLines,
            uncleared: unclearedLines,
          })
      : signedOff
        ? recon.signed_off_by_name
          ? t("reconcile.signedOffByDescription", {
              date: formatCivilDate(
                String(recon.signed_off_at ?? recon.through_date).slice(0, 10),
                locale,
              ),
              name: recon.signed_off_by_name,
            })
          : t("reconcile.signedOffDescription", {
              date: formatCivilDate(
                String(recon.signed_off_at ?? recon.through_date).slice(0, 10),
                locale,
              ),
            })
        : t("reconcile.description"),
    badgeLabel: RECON_STATUS_KEYS.includes(recon.status)
      ? t(`reconStatus.${recon.status}`)
      : String(recon.status).replace(/_/g, " "),
    badgeVariant: signedOff ? "success" : recon.status === "balanced" ? "warning" : "secondary",
    statementBalanceLabel: t("labels.statementBalance"),
    statementBalanceValue: money(totals.statementBalance, { maximumFractionDigits: 4 }),
    clearedBalanceLabel: t("reconcile.stats.clearedGlBalance"),
    clearedBalanceValue: money(totals.clearedBalance, { maximumFractionDigits: 4 }),
    differenceLabel: t("reconcile.stats.difference"),
    difference: totals.difference,
    differenceCurrency: recon.currency,
    matchedLabel: t("reconcile.stats.matched"),
    matchedValue: t("reconcile.matchedCounts", {
      bank: totals.matchedStatementLines,
      gl: totals.matchedJournalLines,
    }),
    basePath,
    accountPath: `/banking/${accountId}`,
    currentParams: sp,
    canReconcile,
    canReviewSignOff,
    reconciliation: {
      id: recon.id,
      status: recon.status,
      throughDate: recon.through_date,
      statementBalance: String(recon.statement_balance),
      currency: recon.currency,
    },
    stmtRows,
    stmtTotal: Number(stmtCount[0]?.n ?? 0),
    stmtOutstandingTotal: String(stmtCount[0]?.total ?? "0"),
    stmtParams,
    glRows,
    glTotal: Number(glCount[0]?.n ?? 0),
    glOutstandingTotal: String(glCount[0]?.total ?? "0"),
    glParams,
    matchedRows: mRows,
    matchedTotal: Number(mCount[0]?.n ?? 0),
    mParams,
    glClearings,
    stale,
    priorEffects,
    opening,
    view,
    tabs,
    evidence,
  };
}

const f = ref<ReconciliationData>();

export function reconcileSpec(data: ReconciliationData): PageSpec {
  return page({
    route: "/banking/[accountId]/reconcile/[reconciliationId]",
    layout: "list",
    header: [
      pageHeader({
        back: { href: f("backHref"), label: f("backLabel") },
        title: f("headerTitle"),
        description: f("headerDescription"),
        actionsClassName: "flex flex-wrap items-center gap-3",
        actions: [
          widget("reconcile-status-badge", { label: data.badgeLabel, variant: data.badgeVariant }),
          widget("module-home-tabs", { tabs: data.tabs }),
        ],
      }),
      widgetBlock("reconcile-stats", {
        statementBalanceLabel: data.statementBalanceLabel,
        statementBalanceValue: data.statementBalanceValue,
        clearedBalanceLabel: data.clearedBalanceLabel,
        clearedBalanceValue: data.clearedBalanceValue,
        differenceLabel: data.differenceLabel,
        difference: data.difference,
        differenceCurrency: data.differenceCurrency,
        matchedLabel: data.matchedLabel,
        matchedValue: data.matchedValue,
      }),
    ],
    body: reconcileBody(data),
  });
}

/**
 * One concept per body: the matching workspace, or one evidence tab. The
 * workspace is placed through one widget because it owns selection state
 * across three paginated panes plus every mutation. The spec supplies only
 * loader-resolved data; `canReconcile` is a boolean, never an Authz.
 */
function reconcileBody(data: ReconciliationData): PageSpec["body"] {
  if (data.view === "statements" && data.evidence) {
    return [
      widgetBlock("reconcile-supporting-statements", {
        accountPath: data.accountPath,
        sourceEvidence: data.evidence.sourceEvidence,
        windowStart: data.evidence.windowStart,
        throughDate: data.evidence.throughDate,
        statements: data.evidence.statements,
      }),
    ];
  }
  if (data.view === "history" && data.evidence) {
    return [widgetBlock("reconcile-history", { rows: data.evidence.history })];
  }
  return [
    widgetBlock("reconcile-workspace", {
      basePath: data.basePath,
      accountPath: data.accountPath,
      currentParams: data.currentParams,
      reconciliation: data.reconciliation,
      difference: data.difference,
      canReconcile: data.canReconcile,
      canReviewSignOff: data.canReviewSignOff,
      stmtRows: data.stmtRows,
      stmtTotal: data.stmtTotal,
      stmtOutstandingTotal: data.stmtOutstandingTotal,
      stmtParams: data.stmtParams,
      glRows: data.glRows,
      glTotal: data.glTotal,
      glOutstandingTotal: data.glOutstandingTotal,
      glParams: data.glParams,
      matchedRows: data.matchedRows,
      matchedTotal: data.matchedTotal,
      mParams: data.mParams,
      glClearings: data.glClearings,
      stale: data.stale,
      priorEffects: data.priorEffects,
      opening: data.opening,
    }),
  ];
}
