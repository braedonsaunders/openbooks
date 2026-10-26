import "server-only";
import { sql } from "drizzle-orm";
import { getTranslations } from "next-intl/server";
import { redirect } from "next/navigation";
import { db } from "@openbooks/engine/platform/db";
import { businessToday } from "@openbooks/engine/platform/business-date/module";
import {
  buildNecPreparationRows,
  computeFiling,
  formDefinitionForYear,
  InformationReturnError,
  resolveInformationReturnCurrency,
  type FilingComputation,
  type NecPreparationVendor,
} from "@openbooks/engine/compliance/information-returns";
import {
  field,
  money,
  ref,
  summaryLine,
  table,
  textBlock,
  toggleLinks,
  widget,
  widgetBlock,
  type PageSpec,
} from "@braedonsaunders/appkit-viewspec";
import { requirePermission } from "../../../../lib/authz";
import { accessDeniedHref } from "../../../../lib/gate-targets";
import { getMoneyFormatter } from "@/lib/money-server";
import { buildHref, isUuid, pickString } from "../../../../lib/list-params";
import { statementReportSpec } from "@/lib/reports/statement-report-spec";
import { decimalSum } from "../../../../lib/statement-format";
import { orgInfo } from "../../../../lib/data";
import { necEmptyCause } from "./empty-cause";
import {
  mapNecVendorRow,
  necPaymentColumns,
  necVendorColumns,
  type NecPaymentRow,
  type NecVendorRow,
} from "./vendor-table";

/**
 * 1099-NEC preparation: per-vendor reportable amounts by box for a calendar
 * year on the CASH basis (payments actually made, not billed), with the
 * threshold flag, masked TIN status and the exclusions an accountant chases
 * before filing. Reachable on reports.read + ap.read with no feature switch:
 * the compliance workspace owns filing, this report owns preparation.
 *
 * Every figure reuses the filing computation itself (computeFiling): the same
 * posted-payment cash traces, box rules, statutory thresholds and exception
 * vocabulary the filing flow files. Nothing here is a parallel system — a
 * preview the workspace would agree with peso for peso. No filing row is
 * created, and no TIN is ever decrypted: the report shows only the last four.
 */

const ROUTE = "/reports/1099-preparation";

export type { NecPaymentRow, NecVendorRow } from "./vendor-table";

export interface NecPreparationData {
  title: string;
  backHref: string;
  backLabel: string;
  searchPlaceholder: string;
  company: string;
  periodPhrase: string;
  cashBasisNotice: string;
  yearA: { href: string; label: string; active: boolean };
  yearB: { href: string; label: string; active: boolean };
  yearC: { href: string; label: string; active: boolean };
  columnVendor: string;
  columnTin: string;
  columnBox1: string;
  columnWithheld: string;
  columnTotal: string;
  columnThreshold: string;
  columnPayments: string;
  columnNotes: string;
  columnCardPaid: string;
  hasCardPaid: boolean;
  columnDate: string;
  columnNumber: string;
  columnCash: string;
  totalLabel: string;
  total: string;
  cardTotalLabel: string | null;
  cardTotal: string | null;
  rows: NecVendorRow[];
  showEmpty: boolean;
  emptyTitle: string;
  emptyDescription: string;
  emptyAction: { href: string; label: string } | null;
  paymentsTitle: string | null;
  allVendorsLabel: string;
  allVendorsHref: string;
  paymentRows: NecPaymentRow[];
  refusal: { title: string; description: string } | null;
  reportReady: boolean;
}

type CardPaymentRow = {
  paymentId: string;
  documentNumber: string;
  paymentDate: string;
  partyId: string;
  vendorName: string;
  cardPaid: string;
};

/**
 * Posted vendor payments settled through a corporate card in the calendar
 * year. Card-funded payments are reported on Form 1099-K, never the payer's
 * 1099-NEC — the cash trace draws the same boundary by counting bank legs
 * only, so this query names what the filing leaves out.
 */
async function loadCardPaidPayments(orgId: string, taxYear: number): Promise<CardPaymentRow[]> {
  const from = `${taxYear}-01-01`;
  const to = `${taxYear}-12-31`;
  const rows = await db.execute<CardPaymentRow>(
    sql`
    select d.id as "paymentId", d.document_number as "documentNumber",
           d.document_date as "paymentDate", d.party_id as "partyId",
           p.display_name as "vendorName",
           coalesce(-sum(jl.amount) filter (
             where jl.amount < 0 and not jl.is_open_item and funding.type = 'liability_card'
           ), 0) as "cardPaid"
      from documents d
      -- Live entries only: a voided payment was not paid and is not reportable
      join journal_entries je on je.id = d.posted_entry_id and je.org_id = d.org_id and je.status = 'posted'
      join journal_lines jl on jl.entry_id = je.id and jl.org_id = je.org_id
      join accounts funding on funding.id = jl.account_id and funding.org_id = jl.org_id
      join parties p on p.id = d.party_id and p.org_id = d.org_id
     -- Live entries only: a voided payment was not paid and is not reportable
     where d.org_id = ${orgId} and d.kind = 'vendor_payment' and d.status = 'posted'
       and d.document_date between ${from} and ${to}
       and d.party_id is not null
     group by d.id, d.document_number, d.document_date, d.party_id, p.display_name
    having coalesce(-sum(jl.amount) filter (
       where jl.amount < 0 and not jl.is_open_item and funding.type = 'liability_card'
     ), 0) > 0
     order by d.document_date, d.document_number
  `,
    "objects",
  );
  return rows;
}

/**
 * Vendor payments in the calendar year that never posted. Drafts and
 * approvals hold cash the cash-basis trace cannot see, so an empty
 * worksheet names them instead of restating that nothing traced.
 */
async function loadUnpostedPaymentTotal(
  orgId: string,
  taxYear: number,
): Promise<{ count: number; total: string } | null> {
  const rows = await db.execute<{ count: number; total: string }>(
    sql`
    select count(*)::int as count, coalesce(sum(total), 0)::text as total
      from documents
     where org_id = ${orgId} and kind = 'vendor_payment'
       and status in ('draft', 'approved')
       and document_date between ${`${taxYear}-01-01`} and ${`${taxYear}-12-31`}
  `,
    "objects",
  );
  const [row] = rows;
  if (!row || row.count === 0) return null;
  return { count: row.count, total: row.total };
}

export async function loadNecPreparation(
  sp: Record<string, string | string[] | undefined>,
): Promise<NecPreparationData> {
  const authz = await requirePermission("reports.read");
  await requirePermission("ap.read");
  // Preparation has no subsidiary dimension: like Tax Filings, it refuses an
  // entity-restricted caller by name instead of mixing payer entities.
  if (authz.allowedSubsidiaryIds !== null) {
    redirect(accessDeniedHref({ permission: "unrestricted subsidiary access" }));
  }
  const { orgId } = authz.user;
  const { money: formatMoney } = await getMoneyFormatter();
  const t = await getTranslations("reports.necPreparation");
  const tr = await getTranslations("reports");
  const tc = await getTranslations("compliance");
  const today = await businessToday(orgId);
  const currentYear = Number(today.slice(0, 4));
  const lastYear = currentYear - 1;
  const yearParam = pickString(sp.year);
  const year = yearParam && /^\d{4}$/.test(yearParam) ? Number(yearParam) : lastYear;
  const vendorParam = pickString(sp.vendor);
  const selectedVendor = vendorParam && isUuid(vendorParam) ? vendorParam : null;

  let computation: FilingComputation | null = null;
  let refusal: NecPreparationData["refusal"] = null;
  try {
    const currency = await resolveInformationReturnCurrency({ orgId });
    computation = await computeFiling({ orgId, taxYear: year, formType: "1099-NEC", currency });
  } catch (error) {
    // A mixed-currency org cannot sum one filing: name the refusal with its
    // remedy (one preparation per subsidiary) instead of a generic error.
    if (!(error instanceof InformationReturnError)) throw error;
    refusal = { title: t("refusalTitle"), description: error.message };
  }

  const cardPayments = refusal ? [] : await loadCardPaidPayments(orgId, year);
  const cardPaidByParty = new Map<string, string>();
  for (const payment of cardPayments) {
    cardPaidByParty.set(
      payment.partyId,
      decimalSum([cardPaidByParty.get(payment.partyId) ?? "0", payment.cardPaid]),
    );
  }
  const rawRows: NecPreparationVendor[] = computation
    ? buildNecPreparationRows(computation, cardPaidByParty)
    : [];
  const form = formDefinitionForYear("1099-NEC", year);
  const box1 = form.boxes.find((box) => box.key === "nec1");
  const box4 = form.boxes.find((box) => box.key === "nec4");
  const m = (value: string) => formatMoney(value, { currency: computation?.currency ?? "USD" });

  const query = pickString(sp.q)?.toLowerCase();
  const visibleRows = query
    ? rawRows.filter((row) => row.vendorName.toLowerCase().includes(query))
    : rawRows;
  const rows: NecVendorRow[] = visibleRows.map((row) =>
    mapNecVendorRow(row, {
      formatMoney: m,
      missingTinText: tc("readiness.missingTin"),
      thresholdBelow: t("thresholdBelow"),
      thresholdReportable: t("thresholdReportable"),
      cardExcludedText: (amount) => t("cardExcluded", { amount }),
      vendorHref: buildHref(ROUTE, {
        year: String(year),
        vendor: row.partyId,
        q: pickString(sp.q),
      }),
      // The vendor (payee) record carries TIN capture behind the
      // informationReturns switch itself — never the compliance-gated
      // drawer, which an information-returns-only org cannot open.
      vendorDrawerHref: `/parties?party=${row.partyId}&partyTab=compliance`,
      boxRulesHref: "/admin/setup/information-return-box-rules",
    }),
  );

  const selected = selectedVendor
    ? rawRows.find((row) => row.partyId === selectedVendor)
    : undefined;
  const traces =
    selected && computation
      ? (computation.recipients.find((recipient) => recipient.profile.partyId === selected.partyId)
          ?.paymentTraces ?? [])
      : [];
  const paymentRows: NecPaymentRow[] = traces.map((trace) => ({
    rowKey: trace.paymentId,
    paymentId: trace.paymentId,
    paymentDate: trace.paymentDate,
    documentNumber: trace.documentNumber,
    cash: m(trace.cash),
    paymentHref: `/payments?payment=${trace.paymentId}`,
  }));

  const cardTotal = decimalSum([...cardPaidByParty.values(), "0"]);
  const hasCardPaid = Number(cardTotal) > 0;
  // An empty worksheet names what blocks tracing instead of restating that
  // nothing traced: paid vendors missing reportability details link to the
  // vendor record, and unposted payments link to the payments list.
  let emptyCause: { description: string; action: { href: string; label: string } } | null = null;
  if (!refusal && rows.length === 0) {
    const cause = necEmptyCause({
      exceptions: computation?.exceptions ?? [],
      unposted: await loadUnpostedPaymentTotal(orgId, year),
    });
    if (cause?.kind === "vendors") {
      const [first] = cause.vendors;
      emptyCause = {
        description: t("emptyVendorsDescription", {
          vendors: cause.vendors.map((vendor) => `${vendor.name} (${m(vendor.total)})`).join("; "),
          year: String(year),
        }),
        action: {
          href: `/parties?party=${first!.partyId}&partyTab=compliance`,
          label: t("emptyVendorAction"),
        },
      };
    } else if (cause?.kind === "unposted") {
      emptyCause = {
        description: t("emptyUnpostedDescription", {
          count: cause.count,
          total: m(cause.total),
          year: String(year),
        }),
        action: { href: "/payments", label: t("emptyPaymentsAction") },
      };
    }
  }
  const org = await orgInfo();
  const yearToggle = (option: number) => ({
    href: buildHref(ROUTE, { year: String(option) }),
    label: String(option),
    active: option === year,
  });

  return {
    title: tr("hub.cards.necPreparationTitle"),
    backHref: "/reports",
    backLabel: tr("hub.title"),
    searchPlaceholder: t("searchPlaceholder"),
    company: org?.name ?? "",
    periodPhrase: String(year),
    cashBasisNotice: t("cashBasisNotice", { year: String(year) }),
    yearA: yearToggle(lastYear - 1),
    yearB: yearToggle(lastYear),
    yearC: yearToggle(currentYear),
    columnVendor: tc("informationReturns.columns.vendor"),
    columnTin: tc("informationReturns.columns.tin"),
    columnBox1: box1 ? `Box ${box1.number} · ${box1.name}` : "Box 1",
    columnWithheld: box4 ? `Box ${box4.number} · ${box4.name}` : "Box 4",
    columnTotal: tc("informationReturns.columns.total"),
    columnThreshold: t("columnThreshold"),
    columnPayments: t("columnPayments"),
    columnNotes: t("columnNotes"),
    columnCardPaid: t("columnCardPaid"),
    hasCardPaid,
    columnDate: t("columnDate"),
    columnNumber: t("columnNumber"),
    columnCash: t("columnCash"),
    totalLabel: t("totalLabel"),
    total: m(decimalSum([...visibleRows.map((row) => row.reportableTotal), "0"])),
    cardTotalLabel: hasCardPaid ? t("cardTotalLabel") : null,
    cardTotal: hasCardPaid ? m(cardTotal) : null,
    rows,
    showEmpty: !refusal && rows.length === 0,
    emptyTitle: t("emptyTitle"),
    emptyDescription: emptyCause?.description ?? t("emptyDescription", { year: String(year) }),
    emptyAction: emptyCause?.action ?? null,
    paymentsTitle: selected ? t("paymentsTitle", { vendor: selected.vendorName }) : null,
    allVendorsLabel: t("allVendors"),
    allVendorsHref: buildHref(ROUTE, { year: String(year) }),
    paymentRows,
    refusal,
    reportReady: !refusal,
  };
}

const f = ref<NecPreparationData>();

export function necPreparationSpec(data: NecPreparationData): PageSpec {
  return statementReportSpec({
    route: "/reports/1099-preparation",
    header: { title: f("title"), back: { href: f("backHref"), label: f("backLabel") } },
    filters: [
      {
        controls: { search: true, period: false, subsidiary: false },
        options: {
          searchPlaceholder: f("searchPlaceholder"),
          leading: toggleLinks([
            { href: f("yearA.href"), label: f("yearA.label"), activeWhen: f("yearA.active") },
            { href: f("yearB.href"), label: f("yearB.label"), activeWhen: f("yearB.active") },
            { href: f("yearC.href"), label: f("yearC.label"), activeWhen: f("yearC.active") },
          ]),
        },
      },
    ],
    headerAfterFilters: [
      summaryLine(f("totalLabel"), money(f("total"))),
      ...(data.cardTotalLabel ? [summaryLine(f("cardTotalLabel"), money(f("cardTotal")))] : []),
    ],
    actionsBefore: data.paymentsTitle
      ? [widget("plain-link-button", { href: data.allVendorsHref, label: data.allVendorsLabel })]
      : [],
    bodyBeforePaper: [
      textBlock(f("cashBasisNotice"), { tone: "muted" }),
      ...(data.refusal
        ? [
            {
              ...widgetBlock("empty-state", {
                title: data.refusal?.title ?? "",
                description: data.refusal?.description,
              }),
              when: f("refusal"),
            },
          ]
        : []),
    ],
    paper: {
      company: f("company"),
      title: f("title"),
      periodPhrase: f("periodPhrase"),
      when: f("reportReady"),
    },
    blocks: [
      ...(data.refusal
        ? []
        : [
            ...(data.showEmpty
              ? [
                  widgetBlock("empty-state", {
                    title: f("emptyTitle"),
                    description: f("emptyDescription"),
                    action: data.emptyAction ? "link-button" : null,
                    actionProps: data.emptyAction ?? undefined,
                  }),
                ]
              : [
                  table({
                    variant: "report",
                    rows: f("rows"),
                    rowKey: field("rowKey"),
                    columns: necVendorColumns(
                      {
                        vendor: f("columnVendor"),
                        tin: f("columnTin"),
                        box1: f("columnBox1"),
                        withheld: f("columnWithheld"),
                        total: f("columnTotal"),
                        threshold: f("columnThreshold"),
                        payments: f("columnPayments"),
                        cardPaid: f("columnCardPaid"),
                        notes: f("columnNotes"),
                      },
                      { hasCardPaid: data.hasCardPaid },
                    ),
                  }),
                ]),
            ...(data.paymentsTitle
              ? [
                  table({
                    variant: "report",
                    rows: f("paymentRows"),
                    rowKey: field("rowKey"),
                    columns: necPaymentColumns({
                      date: f("columnDate"),
                      number: f("columnNumber"),
                      cash: f("columnCash"),
                    }),
                  }),
                ]
              : []),
          ]),
    ],
  });
}
