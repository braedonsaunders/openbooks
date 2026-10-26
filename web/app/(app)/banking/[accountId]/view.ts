import "server-only";

import { getMoneyFormatter } from "@/lib/money-server";
import { notFound } from "next/navigation";
import { getLocale, getTranslations } from "next-intl/server";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/platform/db";
import { businessTimeZone } from "@openbooks/engine/platform/business-date/module";
import {
  badge,
  column,
  field,
  grid,
  heading,
  link,
  money,
  number,
  page,
  pageHeader,
  pagination,
  ref,
  rootRef,
  text,
  widget,
  widgetBlock,
  widgetCell,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { registeredListTable } from "../../../../lib/list/prepared-spec";
import type { ModuleHomeTab } from "../../../../components/module-home/tab-types";
import { requirePermission, can, subsidiaryScopeAllows } from "../../../../lib/authz";
import {
  listAccountStatements,
  reconciliationBookId,
  reconciliationStalenessSummaries,
} from "@openbooks/engine/banking/banking";
import { bankAccount } from "../../../../lib/banking-accounts";
import {
  isUuid,
  mergeHref,
  parsePrefixedListParams,
  pickString,
} from "../../../../lib/list-params";
import type { StatementDrawer as StatementDrawerComponent } from "./StatementDrawer";

/**
 * An active bank/card account, split into a loader and a spec.
 *
 * Two independent prefixed lists — statements (`stmt*`) and reconciliations
 * (`recon*`) — each with its own search, filter, sort and pager, plus a
 * statement-lines drawer (`sl*`, `?statement=<id>`) that stays a widget. The
 * prefixed `sortParamKey`/`dirParamKey`/`pageParamKey` on the table sorting
 * configs exist for exactly this page: without them both tables would bind
 * their headers to `sort`/`dir`/`page` and sorting one would reorder the
 * other.
 *
 * The four header stat tiles are one `account-stats` widget rather than
 * `stat-tile` blocks: the native tiles are plain bordered divs with
 * conditional content (a "never" placeholder, a warning/secondary badge pair),
 * and `stat-tile` renders the cockpit `HomeStatTile` — different markup. The
 * unmatched-count and reconcile-workspace cells are likewise conditional
 * pairs, so they live as small components in ./sections shared with the
 * native render path.
 */

const RECON_VARIANT: Record<string, "success" | "secondary" | "warning"> = {
  signed_off: "success",
  balanced: "warning",
  in_progress: "secondary",
};

// Enum values with translated labels — unknown values render as the raw code
// with underscores spaced out.
const TYPE_KEYS = [
  "asset_bank",
  "liability_card",
  "liability_payable",
  "liability_current_other",
  "liability_long_term",
];
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

// Connector labels resolve from the tenant's own connections table, never
// from a hardcoded vendor map: the display name is tenant data, so product
// copy stays vendor-neutral no matter which systems are supported.

const RECON_SORTS = {
  through: sql`r.through_date`,
  balance: sql`r.statement_balance`,
  status: sql`r.status`,
  created: sql`r.created_at`,
} as const;

interface AccountRow extends Record<string, unknown> {
  id: string;
  number: string | null;
  name: string;
  type: string;
  currency_restriction: string | null;
  balance: string | null;
  reconciled_through: string | null;
  unmatched_lines: string | number;
  open_reconciliation_id: string | null;
}
interface ReconciliationRow extends Record<string, unknown> {
  id: string;
  through_date: string;
  statement_balance: string;
  currency: string;
  status: string;
  signed_off_at: string | null;
  created_at: string;
  evidence_kind: string;
  evidence_connector: string | null;
}
interface CountRow extends Record<string, unknown> {
  n: string | number;
}
interface SourceCountRow extends CountRow {
  source: string;
}
interface StatusCountRow extends CountRow {
  status: string;
}
type DrawerProps = Parameters<typeof StatementDrawerComponent>[0];
type StatementDetailRow = Omit<DrawerProps["statement"], "importedAtLabel"> & {
  imported_at: Date | string;
} & Record<string, unknown>;
type StatementLineRow = DrawerProps["lines"][number] & Record<string, unknown>;

export interface StatementListRow {
  id: string;
  dateHref: string;
  dateLabel: string;
  sourceLabel: string;
  lineCount: string;
  unmatchedCount: string;
  unmatchedIsZero: boolean;
  openingBalance: string;
  closingBalance: string;
  importedAt: string;
  /** Delete affordance: offered only to reconcilers, blocked with its reason
   * when the import already carries match evidence. The engine re-checks. */
  showDelete: boolean;
  deleteBlockedReason: string | null;
  deleteConfirmMessage: string;
  deleteLineCount: number;
  /** Unmatch-all affordance beside a match-blocked delete: releases the
   * import's groups so its delete can proceed. Zero hides the action. */
  unmatchAllMatchedCount: number;
  unmatchAllConfirmMessage: string;
}

export interface ReconciliationListRow {
  id: string;
  throughDate: string;
  statementBalance: string;
  statusLabel: string;
  statusVariant: "success" | "secondary" | "warning";
  /** "Stale since <date>" once late in-period postings or a reversal moved
   *  the ledger under the sign-off; null while the sign-off still stands. */
  staleLabel: string | null;
  evidenceLabel: string;
  evidenceVariant: "secondary" | "outline";
  createdAt: string;
  signedOffAt: string;
  actionHref: string;
  actionLabel: string;
}

export interface BankingAccountData {
  basePath: string;
  currentParams: Record<string, string | string[] | undefined>;
  headerTitle: string;
  headerDescription: string;
  backHref: string;
  backLabel: string;
  canReconcile: boolean;
  canConfigure: boolean;
  configureHref: string;
  configureLabel: string;
  accountId: string;
  activeTab: "statements" | "reconciliations";
  accountCurrency: string | null;
  openReconciliationId: string | null;
  glBalance: string;
  glBalanceDisplay: string;
  glBalanceLabel: string;
  reconciledThroughLabel: string;
  reconciledThrough: string | null;
  unmatchedLinesLabel: string;
  reconciliationLabel: string;
  neverLabel: string;
  unmatchedLinesDisplay: string;
  reconBadgeLabel: string;
  reconBadgeVariant: "warning" | "secondary";
  statementsTitle: string;
  statementsSearchPlaceholder: string;
  sourceLabel: string;
  sourceOptions: { value: string; label: string; count: number }[];
  statementsEmptyTitle: string;
  statementsEmptyDescription: string;
  stmtIsEmpty: boolean;
  stmtShowTable: boolean;
  columnStatementDate: string;
  columnSource: string;
  columnLines: string;
  columnUnmatched: string;
  columnOpening: string;
  columnClosing: string;
  columnImported: string;
  statementRows: StatementListRow[];
  stmtTotal: number;
  stmtPage: number;
  stmtPerPage: number;
  stmtSort: string;
  stmtDir: string;
  reconciliationsTitle: string;
  reconciliationsSearchPlaceholder: string;
  reconStatusLabel: string;
  reconStatusOptions: { value: string; label: string; count: number }[];
  reconIsEmpty: boolean;
  reconShowTable: boolean;
  reconciliationsEmptyTitle: string;
  reconciliationsEmptyDescription: string;
  columnThroughDate: string;
  columnStatementBalance: string;
  columnStatus: string;
  columnStale: string;
  columnEvidence: string;
  columnStarted: string;
  columnSignedOff: string;
  reconRows: ReconciliationListRow[];
  reconTotal: number;
  reconPage: number;
  reconPerPage: number;
  reconSort: string;
  reconDir: string;
  drawerOpen: boolean;
  drawer: {
    basePath: string;
    currentParams: Record<string, string | string[] | undefined>;
    statement: DrawerProps["statement"];
    canEditBalances: DrawerProps["canEditBalances"];
    balancesBlockedReason: DrawerProps["balancesBlockedReason"];
    lines: DrawerProps["lines"];
    lineTotal: number;
    page: number;
    perPage: number;
    sort: string;
    dir: "asc" | "desc";
  } | null;
}

export async function loadBankingAccount(
  accountId: string,
  sp: Record<string, string | string[] | undefined>,
): Promise<BankingAccountData> {
  const authz = await requirePermission("banking.read");
  const t = await getTranslations("banking");
  const tCommon = await getTranslations("common");
  const locale = await getLocale();
  const reconStatusLabel = (status: string) =>
    RECON_STATUS_KEYS.includes(status)
      ? t(`reconStatus.${status}`)
      : String(status).replace(/_/g, " ");
  if (!isUuid(accountId)) notFound();
  const orgId = authz.user.orgId;
  const basePath = `/banking/${accountId}`;
  const activeTab = pickString(sp.tab) === "reconciliations" ? "reconciliations" : "statements";
  const timeZone = await businessTimeZone(orgId);
  const timestampFormatter = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });
  const formatTimestamp = (value: string) => timestampFormatter.format(new Date(value));
  // Statement imports carry their time: same-day imports must stay tellable apart.
  const importTimestampFormatter = new Intl.DateTimeFormat(locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone,
  });
  const formatImportTimestamp = (value: Date | string) =>
    importTimestampFormatter.format(new Date(value));

  // Read every active bank/card account shown by the overview, including
  // accounts awaiting reconciliation setup. Workflow actions remain gated
  // by both the account configuration and the caller's permission.
  // Membership plus ownership: a session, balance, and unmatched queue for
  // another entity's account (or a shared account, for a restricted reader)
  // do not exist as far as this page is concerned.
  const membership = await bankAccount(orgId, accountId);
  if (!membership || !subsidiaryScopeAllows(authz.allowedSubsidiaryIds, membership.subsidiaryId))
    notFound();
  const canReconcile = membership.reconcilable && can(authz, "banking.reconcile");
  const bookId = await reconciliationBookId(db, orgId);
  // Physical account balances use the same book and transaction-currency
  // basis as reconciliation. Unconfigured currency has no priced balance.
  const accountRes = await db.execute<AccountRow>(
    sql`
    select a.id, a.number, a.name, a.type, a.currency_restriction,
           case when a.currency_restriction is null then null else
           coalesce((select sum(jl.txn_amount) from journal_lines jl
                      join journal_entries je on je.id = jl.entry_id and je.org_id = jl.org_id and je.status in ('posted', 'reversed')
                     where jl.account_id = a.id and jl.org_id = a.org_id
                       and je.book_id = ${bookId} and jl.currency = a.currency_restriction), 0)::text end as balance,
           (select max(r.through_date) from reconciliations r
             where r.account_id = a.id and r.org_id = a.org_id and r.status = 'signed_off') as reconciled_through,
           (select count(*) from bank_statement_lines l
             join bank_statements s on s.id = l.statement_id and s.org_id = l.org_id
            where s.account_id = a.id and l.org_id = a.org_id and l.match_status = 'unmatched') as unmatched_lines,
           (select r.id from reconciliations r
             where r.account_id = a.id and r.org_id = a.org_id and r.status <> 'signed_off'
             order by r.created_at desc limit 1) as open_reconciliation_id
      from accounts a
     where a.id = ${accountId} and a.org_id = ${orgId}
  `,
    "objects",
  );
  const account = accountRes[0];
  if (!account) notFound();
  const { money } = await getMoneyFormatter(orgId, account.currency_restriction ?? undefined);

  // -- statements list (prefixed: stmt*) ------------------------------------
  const stmtParams = parsePrefixedListParams(sp, "stmt", {
    sort: "date",
    dir: "desc",
    perPage: 10,
    allowedSorts: ["date", "source", "lines", "imported"] as const,
  });
  const source = pickString(sp.source);
  // -- reconciliations list (prefixed: recon*) -------------------------------
  const reconParams = parsePrefixedListParams(sp, "recon", {
    sort: "created",
    dir: "desc",
    perPage: 10,
    allowedSorts: ["through", "balance", "status", "created"] as const,
  });
  const reconStatus = pickString(sp.reconStatus);
  const reconWhere = sql`r.account_id = ${accountId} and r.org_id = ${orgId}
    ${reconStatus ? sql` and r.status = ${reconStatus}` : sql``}
    ${reconParams.q ? sql` and (r.through_date::text ilike ${"%" + reconParams.q + "%"} or r.statement_balance::text ilike ${"%" + reconParams.q + "%"})` : sql``}`;

  const openStatementId = pickString(sp.statement);

  // One statement per row, keyed by id: same-date imports stay separate rows.
  const statementList = await listAccountStatements(
    accountId,
    {
      q: stmtParams.q,
      source,
      sort: stmtParams.sort,
      dir: stmtParams.dir,
      page: stmtParams.page,
      perPage: stmtParams.perPage,
    },
    { orgId, userId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
  );
  const stmtTotal = statementList.total;

  const [sourceCounts, recons, reconCount, reconStatusCounts] = await Promise.all([
    db.execute<SourceCountRow>(
      sql`select s.source, count(*) as n from bank_statements s where s.account_id = ${accountId} and s.org_id = ${orgId} group by s.source order by s.source`,
      "objects",
    ),
    db.execute<ReconciliationRow>(
      sql`
      select r.id, r.through_date, r.statement_balance, r.currency, r.status, r.signed_off_at, r.created_at,
             r.evidence_kind, r.evidence_connector
        from reconciliations r
       where ${reconWhere}
       order by ${RECON_SORTS[reconParams.sort]} ${reconParams.dir === "asc" ? sql`asc` : sql`desc`} nulls last
       limit ${reconParams.perPage} offset ${(reconParams.page - 1) * reconParams.perPage}
    `,
      "objects",
    ),
    db.execute<CountRow>(
      sql`select count(*) as n from reconciliations r where ${reconWhere}`,
      "objects",
    ),
    db.execute<StatusCountRow>(
      sql`select r.status, count(*) as n from reconciliations r where r.account_id = ${accountId} and r.org_id = ${orgId} group by r.status`,
      "objects",
    ),
  ]);

  // -- statement drawer (?statement=<id>) ------------------------------------
  const statementSourceLabel = (source: string) => {
    const key = STATEMENT_SOURCE_KEYS.find((candidate) => candidate === source) ?? "unknown";
    return t(`statementSources.${key}`);
  };
  let drawer: BankingAccountData["drawer"] = null;
  if (openStatementId && isUuid(openStatementId)) {
    const s = await db.execute<StatementDetailRow>(
      sql`
      select s.id, s.source,
             coalesce((select line.currency from bank_statement_lines line
                        where line.statement_id = s.id and line.org_id = s.org_id
                        order by line.line_number limit 1), a.currency_restriction) as currency,
             s.statement_date, s.opening_balance, s.closing_balance, s.imported_at
        from bank_statements s
        join accounts a on a.id = s.account_id and a.org_id = s.org_id
       where s.id = ${openStatementId} and s.account_id = ${accountId} and s.org_id = ${orgId}
    `,
      "objects",
    );
    if (s[0]) {
      const lineParams = parsePrefixedListParams(sp, "sl", {
        sort: "line",
        dir: "asc",
        perPage: 25,
        allowedSorts: ["line", "date", "amount"] as const,
      });
      const lineSorts = {
        line: sql`l.line_number`,
        date: sql`l.posted_on`,
        amount: sql`l.amount`,
      } as const;
      const lineWhere = sql`l.statement_id = ${openStatementId} and l.org_id = ${orgId}
        ${lineParams.q ? sql` and (l.description ilike ${"%" + lineParams.q + "%"} or l.counterparty_ref ilike ${"%" + lineParams.q + "%"})` : sql``}`;
      const [lines, lineCount] = await Promise.all([
        db.execute<StatementLineRow>(
          sql`
          select l.id, l.line_number, l.posted_on, l.amount, l.description, l.counterparty_ref, l.match_status
            from bank_statement_lines l
           where ${lineWhere}
           order by ${lineSorts[lineParams.sort]} ${lineParams.dir === "asc" ? sql`asc` : sql`desc`}
           limit ${lineParams.perPage} offset ${(lineParams.page - 1) * lineParams.perPage}
        `,
          "objects",
        ),
        db.execute<CountRow>(
          sql`select count(*) as n from bank_statement_lines l where ${lineWhere}`,
          "objects",
        ),
      ]);
      // Balances stay editable until the first match — the engine refuses
      // matched and signed-off-history statements, and the drawer names the
      // reason instead of offering edits that cannot succeed.
      const [matchedLines, coverage] = await Promise.all([
        db.execute<CountRow>(
          sql`
          select count(*) as n
            from reconciliation_matches m
            join bank_statement_lines l on l.id = m.statement_line_id and l.org_id = m.org_id
           where l.statement_id = ${openStatementId} and l.org_id = ${orgId}
        `,
          "objects",
        ),
        db.execute<{ first_posted: string | null; signed_through: string | null }>(
          sql`
          select (select min(l.posted_on)::text from bank_statement_lines l
                   where l.statement_id = ${openStatementId} and l.org_id = ${orgId}) as first_posted,
                 (select max(r.through_date)::text from reconciliations r
                   where r.org_id = ${orgId} and r.account_id = ${accountId} and r.status = 'signed_off') as signed_through
        `,
          "objects",
        ),
      ]);
      const matchedLineCount = Number(matchedLines[0]?.n ?? 0);
      const signedThrough = coverage[0]?.signed_through ?? null;
      const firstPosted = coverage[0]?.first_posted ?? null;
      const canEditBalances =
        matchedLineCount === 0 && !(signedThrough && firstPosted && firstPosted <= signedThrough);
      drawer = {
        basePath,
        currentParams: sp,
        statement: {
          id: s[0].id,
          source: statementSourceLabel(s[0].source),
          currency: s[0].currency,
          statement_date: s[0].statement_date,
          opening_balance: s[0].opening_balance,
          closing_balance: s[0].closing_balance,
          importedAtLabel: formatImportTimestamp(s[0].imported_at),
        },
        canEditBalances,
        balancesBlockedReason:
          matchedLineCount > 0
            ? t("drawer.balancesBlockedMatched", { count: matchedLineCount })
            : signedThrough && firstPosted && firstPosted <= signedThrough
              ? t("drawer.balancesBlockedSignedOff", { date: signedThrough })
              : null,
        lines,
        lineTotal: Number(lineCount[0]?.n ?? 0),
        page: lineParams.page,
        perPage: lineParams.perPage,
        sort: lineParams.sort,
        dir: lineParams.dir,
      };
    }
  }

  // Connector display names resolve from the tenant's own connections table,
  // never from a hardcoded vendor map: the display name is tenant data, so
  // product copy stays vendor-neutral. One query for every distinct
  // connector on the page keeps the row mapping synchronous below.
  const evidenceConnectors = [
    ...new Set(recons.map((r) => r.evidence_connector).filter((c): c is string => c !== null)),
  ];
  const connectorNames = new Map<string, string>();
  if (evidenceConnectors.length > 0) {
    const names = await db.execute<{ source: string; display_name: string }>(
      sql`
      select distinct on (c.source) c.source, c.display_name
        from connections c
       where c.org_id = ${orgId} and c.source in (${sql.join(
         evidenceConnectors.map((c) => sql`${c}`),
         sql`, `,
       )})
       order by c.source, c.mirror_enabled desc, c.created_at
    `,
      "objects",
    );
    for (const n of names) connectorNames.set(n.source, n.display_name);
  }
  const connectorLabel = (connector: string | null) =>
    (connector && connectorNames.get(connector)) || t("sourceSystem.other");
  const evidenceLabel = (kind: string, connector: string | null) =>
    kind === "source"
      ? t("evidenceKind.sourceFrom", { connector: connectorLabel(connector) })
      : t("evidenceKind.statement");

  const sourceOptions = sourceCounts.map((r) => ({
    value: r.source,
    label: statementSourceLabel(r.source),
    count: Number(r.n),
  }));
  const reconStatusOptions = reconStatusCounts.map((r) => ({
    value: r.status,
    label: reconStatusLabel(r.status),
    count: Number(r.n),
  }));

  const typeLabel = TYPE_KEYS.includes(account.type)
    ? t(`types.${account.type}`)
    : String(account.type).replace(/_/g, " ");
  const accountDetails = account.currency_restriction
    ? `${typeLabel} · ${account.currency_restriction}`
    : typeLabel;

  // One read-time staleness pass for the page's sessions: late in-period
  // postings and reversed matches surface beside the frozen sign-off
  // status, reusing the workspace reader so the two can never disagree.
  const staleness = await reconciliationStalenessSummaries(
    accountId,
    recons.map((r) => r.id),
    { orgId, userId: authz.user.id, allowedSubsidiaryIds: authz.allowedSubsidiaryIds },
  );

  // The native page shows the empty state only when the list is truly empty —
  // a filter that matches nothing renders the table with zero body rows.
  const stmtIsEmpty = stmtTotal === 0 && !stmtParams.q && !source;
  const reconTotal = Number(reconCount[0]?.n ?? 0);
  const reconIsEmpty = reconTotal === 0 && !reconParams.q && !reconStatus;

  return {
    basePath,
    currentParams: sp,
    headerTitle: [account.number, account.name].filter(Boolean).join(" · "),
    headerDescription: membership.reconcilable
      ? t("account.description", { details: accountDetails })
      : t("account.setupDescription"),
    backHref: "/banking",
    backLabel: t("home.title"),
    canReconcile,
    canConfigure: !membership.reconcilable && can(authz, "gl.manage"),
    configureHref: `/accounts?account=${accountId}`,
    configureLabel: t("account.configure"),
    accountId: account.id,
    activeTab,
    accountCurrency: account.currency_restriction,
    openReconciliationId: account.open_reconciliation_id,
    glBalance: account.balance ?? "",
    glBalanceDisplay: account.balance === null ? "—" : money(account.balance),
    glBalanceLabel: t("account.stats.glBalance"),
    reconciledThroughLabel: t("account.stats.reconciledThrough"),
    reconciledThrough: account.reconciled_through,
    unmatchedLinesLabel: t("account.stats.unmatchedLines"),
    reconciliationLabel: t("account.stats.reconciliation"),
    neverLabel: t("labels.never"),
    unmatchedLinesDisplay: Number(account.unmatched_lines).toLocaleString(locale),
    reconBadgeLabel: account.open_reconciliation_id
      ? t("account.badges.inProgress")
      : t("account.badges.noneOpen"),
    reconBadgeVariant: account.open_reconciliation_id ? "warning" : "secondary",
    statementsTitle: t("account.statementsTitle"),
    statementsSearchPlaceholder: t("account.searchStatements"),
    sourceLabel: t("labels.source"),
    sourceOptions,
    statementsEmptyTitle: t("account.statementsEmptyTitle"),
    statementsEmptyDescription: t("account.statementsEmptyDescription"),
    stmtIsEmpty,
    stmtShowTable: !stmtIsEmpty,
    columnStatementDate: t("labels.statementDate"),
    columnSource: t("labels.source"),
    columnLines: tCommon("labels.lines"),
    columnUnmatched: t("account.columns.unmatched"),
    columnOpening: t("account.columns.opening"),
    columnClosing: t("account.columns.closing"),
    columnImported: t("account.columns.imported"),
    statementRows: statementList.rows.map((s) => {
      const matched = Number(s.matched_count);
      const excluded = Number(s.excluded_count);
      const lineCount = Number(s.line_count);
      return {
        id: s.id,
        // The opener keeps the lists' search, sort and page exactly like the
        // drawer's closeHref does; rebuilding from the id alone would reset
        // the page underneath to an unfiltered page 1.
        dateHref: mergeHref(basePath, sp, { statement: s.id }),
        dateLabel: s.statement_date,
        sourceLabel: statementSourceLabel(s.source),
        lineCount: lineCount.toLocaleString(locale),
        unmatchedCount: Number(s.unmatched_count).toLocaleString(locale),
        unmatchedIsZero: Number(s.unmatched_count) === 0,
        openingBalance: money(s.opening_balance, { currency: s.currency }),
        closingBalance: money(s.closing_balance, { currency: s.currency }),
        importedAt: formatImportTimestamp(s.imported_at),
        showDelete: canReconcile,
        deleteBlockedReason:
          matched > 0
            ? t("account.deleteBlockedMatched", { count: matched })
            : excluded > 0
              ? t("account.deleteBlockedExcluded", { count: excluded })
              : null,
        deleteConfirmMessage: t("account.deleteImportConfirm", { count: lineCount }),
        deleteLineCount: lineCount,
        unmatchAllMatchedCount: matched,
        unmatchAllConfirmMessage: t("account.unmatchAllConfirm", { count: matched }),
      };
    }),
    stmtTotal,
    stmtPage: stmtParams.page,
    stmtPerPage: stmtParams.perPage,
    stmtSort: stmtParams.sort,
    stmtDir: stmtParams.dir,
    reconciliationsTitle: t("account.reconciliationsTitle"),
    reconciliationsSearchPlaceholder: t("account.searchReconciliations"),
    reconStatusLabel: tCommon("labels.status"),
    reconStatusOptions,
    reconIsEmpty,
    reconShowTable: !reconIsEmpty,
    reconciliationsEmptyTitle: t("account.reconciliationsEmptyTitle"),
    reconciliationsEmptyDescription: t("account.reconciliationsEmptyDescription"),
    columnThroughDate: t("account.columns.throughDate"),
    columnStatementBalance: t("labels.statementBalance"),
    columnStatus: tCommon("labels.status"),
    columnStale: t("stale.column"),
    columnEvidence: t("account.columns.evidence"),
    columnStarted: t("account.columns.started"),
    columnSignedOff: t("account.columns.signedOff"),
    reconRows: recons.map((r) => ({
      id: r.id,
      throughDate: r.through_date,
      statementBalance: money(r.statement_balance, { currency: r.currency }),
      statusLabel: reconStatusLabel(r.status),
      statusVariant: RECON_VARIANT[r.status] ?? "secondary",
      staleLabel:
        staleness[r.id]?.stale && staleness[r.id]?.staleSince
          ? t("stale.badge", { date: staleness[r.id]!.staleSince as string })
          : null,
      evidenceLabel: evidenceLabel(r.evidence_kind, r.evidence_connector),
      evidenceVariant: r.evidence_kind === "source" ? "secondary" : "outline",
      createdAt: formatTimestamp(r.created_at),
      // The native cell renders a bare em-dash, not a styled placeholder.
      signedOffAt: r.signed_off_at ? formatTimestamp(r.signed_off_at) : "—",
      actionHref: `${basePath}/reconcile/${r.id}`,
      actionLabel: r.status === "signed_off" ? tCommon("actions.view") : t("account.openWorkspace"),
    })),
    reconTotal,
    reconPage: reconParams.page,
    reconPerPage: reconParams.perPage,
    reconSort: reconParams.sort,
    reconDir: reconParams.dir,
    drawerOpen: Boolean(drawer),
    drawer,
  };
}

const f = ref<BankingAccountData>();
const item = field;
const rootF = rootRef<BankingAccountData>();

const MUTED = "text-slate-500 dark:text-slate-400";

export function bankingAccountSpec(data: BankingAccountData): PageSpec {
  return page({
    route: "/banking/[accountId]",
    layout: "list",
    header: [
      pageHeader({
        back: { href: f("backHref"), label: f("backLabel") },
        title: f("headerTitle"),
        description: f("headerDescription"),
        actionsClassName: "flex items-center gap-2",
        actions: [
          widget(
            "link-button",
            {
              href: f("configureHref"),
              label: f("configureLabel"),
              iconKey: "settings",
              variant: "outline",
            },
            f("canConfigure"),
          ),
          widget("import-statement", { accountId: data.accountId }, f("canReconcile")),
          widget(
            "start-reconciliation",
            {
              accountId: data.accountId,
              openReconciliationId: data.openReconciliationId,
              glBalance: data.glBalance,
              currency: data.accountCurrency,
            },
            f("canReconcile"),
          ),
        ],
      }),
      widgetBlock("account-stats", {
        glBalanceLabel: data.glBalanceLabel,
        glBalanceValue: data.glBalanceDisplay,
        reconciledThroughLabel: data.reconciledThroughLabel,
        reconciledThrough: data.reconciledThrough,
        neverLabel: data.neverLabel,
        unmatchedLinesLabel: data.unmatchedLinesLabel,
        unmatchedLinesValue: data.unmatchedLinesDisplay,
        reconciliationLabel: data.reconciliationLabel,
        reconBadgeLabel: data.reconBadgeLabel,
        reconBadgeVariant: data.reconBadgeVariant,
      }),
    ],
    body: [
      widgetBlock("module-home-tabs", {
        tabs: [
          {
            href: mergeHref(data.basePath, data.currentParams, { tab: "statements" }),
            label: data.statementsTitle,
            active: data.activeTab === "statements",
          },
          {
            href: mergeHref(data.basePath, data.currentParams, { tab: "reconciliations" }),
            label: data.reconciliationsTitle,
            active: data.activeTab === "reconciliations",
          },
        ] satisfies ModuleHomeTab[],
        placement: "local",
      }),
      ...(data.activeTab === "statements"
        ? data.stmtIsEmpty
          ? [
              widgetBlock("empty-state", {
                title: data.statementsEmptyTitle,
                description: data.statementsEmptyDescription,
                action: data.canReconcile ? "import-statement" : null,
                actionProps: data.canReconcile ? { accountId: data.accountId } : null,
              }),
            ]
          : [
              grid(
                "space-y-2",
                [
                  heading(
                    2,
                    f("statementsTitle"),
                    "text-sm font-semibold text-slate-900 dark:text-slate-100",
                  ),
                  registeredListTable(
                    "bank_account_statements",
                    {
                      variant: "app",
                      rows: f("statementRows"),
                      rowKey: item("id"),
                      sorting: {
                        basePath: data.basePath,
                        sort: f("stmtSort"),
                        dir: f("stmtDir"),
                        sortParamKey: "stmtSort",
                        dirParamKey: "stmtDir",
                        pageParamKey: "stmtPage",
                      },
                      columns: [
                        column(
                          rootF("columnStatementDate"),
                          link(
                            item("dateLabel"),
                            item("dateHref"),
                            "text-teal-700 hover:underline dark:text-teal-300",
                          ),
                          { sort: "date", className: "font-medium" },
                        ),
                        column(
                          rootF("columnSource"),
                          badge(item("sourceLabel"), { variant: "outline" }),
                          { sort: "source" },
                        ),
                        column(rootF("columnLines"), number(item("lineCount")), {
                          sort: "lines",
                          align: "right",
                        }),
                        column(
                          rootF("columnUnmatched"),
                          widgetCell("unmatched-count-cell", {
                            display: item("unmatchedCount"),
                            isZero: item("unmatchedIsZero"),
                          }),
                          { align: "right", className: "tabular-nums" },
                        ),
                        column(rootF("columnOpening"), money(item("openingBalance")), {
                          align: "right",
                        }),
                        column(rootF("columnClosing"), money(item("closingBalance")), {
                          align: "right",
                        }),
                        column(rootF("columnImported"), text(item("importedAt")), {
                          sort: "imported",
                          className: MUTED,
                        }),
                        column(
                          "",
                          widgetCell("statement-delete-cell", {
                            statementId: item("id"),
                            lineCount: item("deleteLineCount"),
                            blockedReason: item("deleteBlockedReason"),
                            confirmMessage: item("deleteConfirmMessage"),
                            showDelete: item("showDelete"),
                            matchedCount: item("unmatchAllMatchedCount"),
                            unmatchAllConfirmMessage: item("unmatchAllConfirmMessage"),
                          }),
                        ),
                      ],
                    },
                    [
                      widgetBlock("search-input", {
                        placeholder: data.statementsSearchPlaceholder,
                        paramKey: "stmtQ",
                        pageParamKey: "stmtPage",
                      }),
                      widgetBlock("filter-chips", {
                        basePath: data.basePath,
                        currentParams: data.currentParams,
                        paramKey: "source",
                        label: data.sourceLabel,
                        options: data.sourceOptions,
                        pageParamKey: "stmtPage",
                      }),
                    ],
                  ),
                  pagination({
                    basePath: data.basePath,
                    total: f("stmtTotal"),
                    page: f("stmtPage"),
                    perPage: f("stmtPerPage"),
                    pageParamKey: "stmtPage",
                    bare: true,
                  }),
                ],
                { as: "section" },
              ),
            ]
        : data.reconIsEmpty
          ? [
              widgetBlock("empty-state", {
                title: data.reconciliationsEmptyTitle,
                description: data.reconciliationsEmptyDescription,
                action: data.canReconcile ? "start-reconciliation" : null,
                actionProps: data.canReconcile
                  ? {
                      accountId: data.accountId,
                      openReconciliationId: data.openReconciliationId,
                      glBalance: data.glBalance,
                    }
                  : null,
              }),
            ]
          : [
              grid(
                "space-y-2",
                [
                  heading(
                    2,
                    f("reconciliationsTitle"),
                    "text-sm font-semibold text-slate-900 dark:text-slate-100",
                  ),
                  registeredListTable(
                    "bank_account_reconciliations",
                    {
                      variant: "app",
                      rows: f("reconRows"),
                      rowKey: item("id"),
                      sorting: {
                        basePath: data.basePath,
                        sort: f("reconSort"),
                        dir: f("reconDir"),
                        sortParamKey: "reconSort",
                        dirParamKey: "reconDir",
                        pageParamKey: "reconPage",
                      },
                      columns: [
                        column(rootF("columnThroughDate"), text(item("throughDate")), {
                          sort: "through",
                          className: "font-medium",
                        }),
                        column(rootF("columnStatementBalance"), money(item("statementBalance")), {
                          sort: "balance",
                          align: "right",
                        }),
                        column(
                          rootF("columnStatus"),
                          badge(item("statusLabel"), { variant: item("statusVariant") }),
                          {
                            sort: "status",
                          },
                        ),
                        column(
                          rootF("columnStale"),
                          widgetCell("stale-badge-cell", { label: item("staleLabel") }),
                        ),
                        column(
                          rootF("columnEvidence"),
                          badge(item("evidenceLabel"), { variant: item("evidenceVariant") }),
                        ),
                        column(rootF("columnStarted"), text(item("createdAt")), {
                          sort: "created",
                          className: MUTED,
                        }),
                        column(rootF("columnSignedOff"), text(item("signedOffAt")), {
                          className: MUTED,
                        }),
                        column(
                          "",
                          widgetCell("recon-action-cell", {
                            href: item("actionHref"),
                            label: item("actionLabel"),
                          }),
                        ),
                      ],
                    },
                    [
                      widgetBlock("search-input", {
                        placeholder: data.reconciliationsSearchPlaceholder,
                        paramKey: "reconQ",
                        pageParamKey: "reconPage",
                      }),
                      widgetBlock("filter-chips", {
                        basePath: data.basePath,
                        currentParams: data.currentParams,
                        paramKey: "reconStatus",
                        label: data.reconStatusLabel,
                        options: data.reconStatusOptions,
                        pageParamKey: "reconPage",
                      }),
                    ],
                  ),
                  pagination({
                    basePath: data.basePath,
                    total: f("reconTotal"),
                    page: f("reconPage"),
                    perPage: f("reconPerPage"),
                    pageParamKey: "reconPage",
                    bare: true,
                  }),
                ],
                { as: "section" },
              ),
            ]),
      widgetBlock("statement-drawer", { drawer: data.drawer }, f("drawerOpen")),
    ],
  });
}
