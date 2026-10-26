import "server-only";
import { reportBookSelection } from "../../../../lib/report-books";

import { getLocale, getTranslations } from "next-intl/server";
import { civilDateParams } from "../../../../lib/format";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  column,
  field,
  link,
  money,
  pagination,
  ref,
  table,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { assertCan, can, requirePermission } from "../../../../lib/authz";
import { getMoneyFormatter } from "@/lib/money-server";
import { parseListParams } from "../../../../lib/list-params";
import { partnerBalances } from "../../../../lib/reports";
import { reportSubsidiaryView, type CurrencyBasisNotice } from "../../../../lib/consolidation";
import { statementReportSpec } from "@/lib/reports/statement-report-spec";
import { ReportCurrencyBasisError } from "../../../../lib/reports/currency-basis";
import { orgInfo } from "../../../../lib/data";
import { resolveOrgId } from "../../../../lib/org-scope";
import { decimalCmp } from "../../../../lib/statement-format";

/**
 * The customer-statement picker: every customer with an open-item balance,
 * each row linking to that customer's statement for the chosen period. The
 * statement detail page carries its own period presets; the From/To controls
 * here pre-set the range the row links open with, so a hub visitor picks a
 * customer and a period before ever reaching a party page.
 */

const PER_PAGE = 50;

export interface StatementPickerRow {
  rowKey: string;
  displayName: string;
  balance: string;
  /** Named presentation state, decided here — the spec never compares numbers. */
  balanceTone: "default" | "negative";
  /** The statement URL for this customer, carrying the picker's period. */
  href: string;
}

export interface StatementPickerData {
  title: string;
  backHref: string;
  backLabel: string;
  searchPlaceholder: string;
  columnCustomer: string;
  columnBalance: string;
  company: string;
  periodPhrase: string;
  /** Only offered when the org holds more than one accounting book. */
  primaryFilter: {
    paramKey: string;
    label: string;
    value: string;
    options: { value: string; label: string }[];
  } | null;
  dateRange: { from: string; to: string };
  rows: StatementPickerRow[];
  totalRows: number;
  currentPage: number;
  perPage: number;
  emptyTitle: string;
  emptyHint: string;
  /** Composer href carrying the picker's period, and its label. */
  sendHref: string;
  sendLabel: string;
  /** True for senders (ar.create); the entry hides otherwise. */
  canSend: boolean;
  /** True exactly when at least one customer row matched. */
  hasRows: boolean;
  subsidiaries: SubsidiaryPicker;
  /** Set when the viewed set spans more than one functional currency: the
   * page renders the named refusal (whose remedy is the subsidiary picker
   * beside it) instead of numbers or a generic error page. */
  currencyBasisBlocked: CurrencyBasisNotice | null;
  /** False exactly when the multi-currency refusal is set. */
  currencyBasisReady: boolean;
}

type SubsidiaryPicker = Awaited<ReturnType<typeof reportSubsidiaryView>>["picker"];

export async function loadStatementPicker(
  sp: Record<string, string | string[] | undefined>,
): Promise<StatementPickerData> {
  const authz = await requirePermission("reports.read");
  // The picker lists the same customer balances as the receivables report,
  // so it owes the same AR grant — a role without it gets a named refusal,
  // not a customer list.
  assertCan(authz, "ar.read");
  const { money: formatMoney } = await getMoneyFormatter();
  const tp = await getTranslations("reports.statementsPicker");
  const locale = await getLocale();
  const tr = await getTranslations("reports");

  const tb = await getTranslations("budgets");
  const { books, selectedBook } = await reportBookSelection(
    authz.user.orgId,
    Array.isArray(sp.book) ? sp.book[0] : sp.book,
  );
  const params = parseListParams(sp, {
    sort: "balance",
    allowedSorts: ["balance"] as const,
    perPage: PER_PAGE,
  });
  const asOf = await businessToday(await resolveOrgId());
  // Legal-entity scope resolves through the subsidiary view — the same
  // contract as the partners report: a restricted reader's view resolves to
  // the subsidiaries they may see.
  const subRaw = sp.sub;
  const subsidiaryParam = Array.isArray(subRaw) ? subRaw[0] : subRaw;
  const orgPromise = orgInfo();
  let subView: Awaited<ReturnType<typeof reportSubsidiaryView>> | undefined;
  let all: Awaited<ReturnType<typeof partnerBalances>> = [];
  let currencyBasisBlocked: CurrencyBasisNotice | null = null;
  try {
    subView = await reportSubsidiaryView(subsidiaryParam, asOf, selectedBook.id);
    all = await partnerBalances(
      "receivable",
      authz.user.orgId,
      asOf,
      selectedBook.id,
      {
        subsidiaryIds: subView.subsidiary?.ids,
      },
      can(authz, "payroll.read"),
    );
  } catch (e) {
    // A multi-currency viewed set is a NAMED refusal, not a defect: the
    // banner carries the remedy (choose a single-currency subsidiary view)
    // and the filter-bar picker beside it offers that choice.
    if (!(e instanceof ReportCurrencyBasisError)) throw e;
    currencyBasisBlocked = {
      code: "multi-currency-basis",
      title: tr("statement.currencyBasisBlockedTitle"),
      description: e.message,
    };
  }
  const org = await orgPromise;

  // Figures present in the VIEW's currency (the context node's functional
  // currency), not the org base — a foreign-functional subsidiary view
  // states its own money. Mirrors the partners report.
  const m = (value: string) =>
    formatMoney(value, { currency: subView?.currency ?? org?.base_currency });
  const q = params.q?.toLowerCase();
  const fromRaw = sp.from;
  const toRaw = sp.to;
  const from = Array.isArray(fromRaw) ? fromRaw[0] : fromRaw;
  const to = Array.isArray(toRaw) ? toRaw[0] : toRaw;
  const statementParams = new URLSearchParams();
  if (from && to) {
    statementParams.set("period", "custom");
    statementParams.set("from", from);
    statementParams.set("to", to);
  }
  const statementQuery = statementParams.toString();
  const customers = all.filter((row) => row.id !== null);
  const filtered = q
    ? customers.filter((r) => (r.display_name ?? "").toLowerCase().includes(q))
    : customers;
  const pageRows = filtered.slice((params.page - 1) * PER_PAGE, params.page * PER_PAGE);

  return {
    title: tp("title"),
    backHref: "/reports",
    backLabel: tr("hub.title"),
    searchPlaceholder: tp("searchPlaceholder"),
    columnCustomer: tp("columnCustomer"),
    columnBalance: tp("columnBalance"),
    company: org?.name ?? "",
    periodPhrase:
      books.length > 1
        ? `${selectedBook.name} · ${from && to ? tp("periodRange", civilDateParams({ from, to }, locale)) : tp("periodDefault")}`
        : from && to
          ? tp("periodRange", civilDateParams({ from, to }, locale))
          : tp("periodDefault"),
    primaryFilter:
      books.length > 1
        ? {
            paramKey: "book",
            label: tb("list.bookFilter"),
            value: selectedBook.id,
            options: books.map((book) => ({ value: book.id, label: book.name })),
          }
        : null,
    dateRange: { from: from ?? "", to: to ?? "" },
    rows: pageRows.map((row) => ({
      rowKey: row.id as string,
      displayName: row.display_name ?? "",
      balance: m(row.balance),
      balanceTone: decimalCmp(row.balance, "0") < 0 ? "negative" : "default",
      href: statementQuery
        ? `/reports/statements/${row.id}?${statementQuery}`
        : `/reports/statements/${row.id}`,
    })),
    totalRows: filtered.length,
    currentPage: params.page,
    perPage: PER_PAGE,
    emptyTitle: tp("emptyTitle"),
    emptyHint: tp("emptyHint"),
    sendHref: statementQuery
      ? `/reports/statements/send?${statementQuery}`
      : "/reports/statements/send",
    sendLabel: tp("sendAction"),
    canSend: can(authz, "ar.create"),
    hasRows: filtered.length > 0,
    subsidiaries: subView?.picker ?? [],
    currencyBasisBlocked,
    currencyBasisReady: currencyBasisBlocked === null,
  };
}

const f = ref<StatementPickerData>();
const row = field;

export function statementPickerSpec(data: StatementPickerData): PageSpec {
  return statementReportSpec({
    route: "/reports/statements",
    header: { title: f("title"), back: { href: f("backHref"), label: f("backLabel") } },
    filters: [
      {
        controls: { search: true, dateRange: true, subsidiary: true },
        options: {
          searchPlaceholder: f("searchPlaceholder"),
          dateRange: f("dateRange"),
          subsidiaries: f("subsidiaries"),
          primaryFilter: f("primaryFilter"),
        },
      },
    ],
    // A picker opens statements; it is not itself a schedulable statement.
    saveView: false,
    actionsBefore: [
      widget("link-button", { href: f("sendHref"), label: f("sendLabel") }, f("canSend")),
    ],
    paper: {
      company: f("company"),
      title: f("title"),
      periodPhrase: f("periodPhrase"),
      when: f("currencyBasisReady"),
    },
    bodyBeforePaper: [
      // The multi-currency refusal renders without an action: the remedy is
      // the subsidiary picker in the filter bar above, not a link.
      ...(data.currencyBasisBlocked
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.currencyBasisBlocked?.title ?? "",
                description: data.currencyBasisBlocked?.description,
              }),
              when: f("currencyBasisBlocked"),
            },
          ]
        : []),
      ...(!data.hasRows && !data.currencyBasisBlocked
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.emptyTitle ?? "",
                description: data.emptyHint,
              }),
              when: f("currencyBasisReady"),
            },
          ]
        : []),
    ],
    blocks: [
      table({
        variant: "report",
        rows: f("rows"),
        rowKey: row("rowKey"),
        columns: [
          column(f("columnCustomer"), link(row("displayName"), row("href"))),
          column(f("columnBalance"), money(row("balance"), { tone: row("balanceTone") }), {
            align: "right",
          }),
        ],
      }),
      pagination({
        basePath: "/reports/statements",
        total: f("totalRows"),
        page: f("currentPage"),
        perPage: f("perPage"),
      }),
    ],
  });
}
