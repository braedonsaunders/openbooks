import { businessToday, parseIsoDate } from "../business-date.ts";
import { QboClient } from "../qbo.ts";
import { formatMoney, fromUnits, mulDecimal, toUnits } from "../money.ts";
import { buildNativeFromQbo, type QboBuildOpts, type QboTxn } from "./qbo-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream, MigrationSource, NativeChanges, SourceEntity,
  SourceAccountMonthRow, SourceOpenItem, SourceTrialBalanceRow,
} from "./source.ts";
import { allModules, fiscalYearsForRange, monthlySourcePeriods } from "./periods.ts";

/**
 * QuickBooks Online adapter — NATIVE transactions over the accounting API.
 * Invoices, bills, payments, credits, journals, deposits, purchases and
 * transfers import as real documents; `Payment`/`BillPayment` LinkedTxns ARE
 * the application graph; Invoice/Bill `Balance` is per-document open-item
 * truth; `Metadata.LastUpdatedTime` is the incremental watermark; the
 * TrialBalance report (all-dates, accrual) verifies the ledger.
 *
 * Party refs are prefixed (`C:`/`V:`/`E:`) — Customer, Vendor and Employee ids
 * are separate QBO sequences. Transaction refs are `<Entity>:<Id>` — QBO ids
 * are per-entity sequences too.
 */

const QBO_ACCOUNT_TYPE: Record<string, string> = {
  "Bank": "asset_bank",
  "Accounts Receivable": "asset_receivable",
  "Other Current Asset": "asset_current_other",
  "Fixed Asset": "asset_fixed",
  "Other Asset": "asset_other",
  "Accounts Payable": "liability_payable",
  "Credit Card": "liability_card",
  "Other Current Liability": "liability_current_other",
  "Long Term Liability": "liability_long_term",
  "Equity": "equity",
  "Income": "income",
  "Other Income": "income_other",
  "Cost of Goods Sold": "cogs",
  "Expense": "expense",
  "Other Expense": "expense_other",
};

const TXN_ENTITIES = [
  "Invoice", "CreditMemo", "Bill", "VendorCredit", "Payment", "BillPayment",
  "JournalEntry", "Deposit", "Purchase", "Transfer", "SalesReceipt", "RefundReceipt",
  "TaxPayment",
];

interface QboAccount {
  Id: string; Name: string; AcctNum?: string; AccountType: string; AccountSubType?: string;
  Active?: boolean; SubAccount?: boolean; ParentRef?: { value: string };
}
interface QboParty { Id: string; DisplayName?: string; Active?: boolean }
interface QboItem {
  Id: string; Name: string; Sku?: string; Type: string; Active?: boolean;
  IncomeAccountRef?: { value: string }; ExpenseAccountRef?: { value: string };
}
interface QboTaxRate { Id: string; Name: string; RateValue?: number; Active?: boolean }
interface QboCompanyInfo { CompanyStartDate?: string; FiscalYearStartMonth?: string }
interface QboPreferences { AccountingInfoPrefs?: { FirstMonthOfFiscalYear?: string; BookCloseDate?: string } }

const MONTH_NUMBER: Record<string, number> = {
  January: 1, February: 2, March: 3, April: 4, May: 5, June: 6,
  July: 7, August: 8, September: 9, October: 10, November: 11, December: 12,
};

export class QboSource implements MigrationSource {
  readonly name = "qbo";
  readonly refKey = "qboId";
  readonly baseCurrency: string;
  private readonly orgId: string;

  constructor(private client: QboClient, opts: { orgId: string; baseCurrency?: string }) {
    this.orgId = opts.orgId;
    this.baseCurrency = opts.baseCurrency ?? "USD";
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const info = await this.client.queryAll<{ CompanyName?: string }>("CompanyInfo");
    return { ok: true, detail: info[0]?.CompanyName ? `Connected to ${info[0].CompanyName}` : "Connected" };
  }

  // --- master data ---------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Daily-mirror efficiency: the high-volume streams (parties, items) honor
    // `since` via Metadata.LastUpdatedTime; the small structural streams
    // (accounts, tax rates) always pull in full. Full migration = everything.
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "tax_codes", records: await this.taxCodes() },
      { resource: "parties", records: await this.parties(since) },
      { resource: "items", records: await this.items(since) },
    ];
  }

  /** QBO query WHERE clause for an incremental pull ("" = full). */
  private sinceWhere(since?: Date | null): string {
    return since ? `Metadata.LastUpdatedTime >= '${since.toISOString()}'` : "";
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    const [company] = await this.client.queryAll<QboCompanyInfo>("CompanyInfo");
    const preferenceResponse = await this.client.preferences<{ Preferences?: QboPreferences }>();
    const preferences = preferenceResponse.Preferences;
    const start = company?.CompanyStartDate;
    if (!start) throw new Error("QBO CompanyInfo.CompanyStartDate is required for period migration");
    const firstMonth = preferences?.AccountingInfoPrefs?.FirstMonthOfFiscalYear
      ?? company.FiscalYearStartMonth
      ?? "January";
    const startMonth = MONTH_NUMBER[firstMonth] ?? Number(firstMonth);
    if (!Number.isInteger(startMonth) || startMonth < 1 || startMonth > 12) {
      throw new Error(`QBO fiscal year start month is invalid: ${firstMonth}`);
    }
    const closeDate = preferences?.AccountingInfoPrefs?.BookCloseDate ?? null;
    const horizon = parseIsoDate(await businessToday(this.orgId));
    horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
    const end = horizon.toISOString().slice(0, 10);
    return monthlySourcePeriods(
      "qbo-period",
      fiscalYearsForRange(start, end, startMonth),
      (endsOn) => allModules(closeDate && endsOn <= closeDate ? "closed" : "open"),
    );
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.client.queryAll<QboAccount>("Account");
    const out: SourceEntity[] = [];
    for (const a of rows) {
      const type = QBO_ACCOUNT_TYPE[a.AccountType];
      if (!type) continue;
      out.push({
        sourceRef: String(a.Id),
        naturalKey: a.AcctNum || null,
        parentRef: a.SubAccount && a.ParentRef ? String(a.ParentRef.value) : null,
        fields: {
          number: a.AcctNum || null,
          name: a.Name,
          type,
          isActive: a.Active !== false,
          isSummary: false,
        },
      });
    }
    return out;
  }

  private async taxCodes(): Promise<SourceEntity[]> {
    const rows = await this.client.queryAll<QboTaxRate>("TaxRate");
    return rows.map((t) => ({
      sourceRef: String(t.Id),
      fields: {
        code: `${t.Name} (${t.Id})`,
        name: t.Name,
        ratePercent: String(t.RateValue ?? 0),
        appliesTo: "both",
      },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    const where = this.sinceWhere(since);
    const [customers, vendors, employees] = [
      await this.client.queryAll<QboParty>("Customer", where),
      await this.client.queryAll<QboParty>("Vendor", where),
      await this.client.queryAll<QboParty>("Employee", where),
    ];
    const mk = (prefix: string, kind: string) => (p: QboParty): SourceEntity => ({
      sourceRef: `${prefix}:${p.Id}`,
      fields: {
        displayName: String(p.DisplayName ?? `${prefix} ${p.Id}`).slice(0, 500),
        kind,
        isActive: p.Active !== false,
      },
    });
    return [
      ...customers.map(mk("C", "company")),
      ...vendors.map(mk("V", "company")),
      ...employees.map(mk("E", "person")),
    ];
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.client.queryAll<QboItem>("Item", this.sinceWhere(since));
    return rows
      .filter((i) => i.Type !== "Category")
      .map((i) => ({
        sourceRef: String(i.Id),
        naturalKey: i.Sku || null,
        fields: {
          code: i.Sku || `qbo-${i.Id}`,
          name: String(i.Name).slice(0, 500),
          kind: i.Type === "Service" ? "service" : i.Type === "Inventory" ? "inventory" : "non_inventory",
          isActive: i.Active !== false,
        },
      }));
  }

  // --- control accounts -------------------------------------------------------------

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const rows = await this.client.queryAll<QboAccount>("Account");
    const firstType = (t: string) => rows.find((a) => a.AccountType === t && a.Active !== false);
    const bySub = (s: string) => rows.find((a) => a.AccountSubType === s);
    const tax = bySub("GlobalTaxPayable") ?? bySub("SalesTaxPayable") ?? rows.find((a) => /tax.*payable/i.test(a.Name));
    return {
      ar: firstType("Accounts Receivable")?.Id,
      ap: firstType("Accounts Payable")?.Id,
      bank: firstType("Bank")?.Id,
      // Both sales tax collected AND purchase input-tax credits net in the same
      // liability (GST/HST Payable); Suspense is only for filed/remitted tax.
      taxCollected: tax?.Id,
      taxPaid: tax?.Id,
    };
  }

  // --- native transactions ------------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    // Item → income/expense account maps for line resolution.
    const items = await this.client.queryAll<QboItem>("Item");
    const accounts = await this.client.queryAll<QboAccount>("Account");
    const opts: QboBuildOpts = {
      itemIncomeAccount: new Map(items.filter((i) => i.IncomeAccountRef).map((i) => [String(i.Id), String(i.IncomeAccountRef!.value)])),
      itemExpenseAccount: new Map(items.filter((i) => i.ExpenseAccountRef).map((i) => [String(i.Id), String(i.ExpenseAccountRef!.value)])),
      undepositedFundsRef: accounts.find((a) => a.AccountSubType === "UndepositedFunds")?.Id,
      taxSuspenseRef: accounts.find((a) => a.AccountSubType === "GlobalTaxSuspense")?.Id,
    };

    const where = since ? `Metadata.LastUpdatedTime >= '${since.toISOString()}'` : "";
    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    const applications: NativeChanges["applications"] = [];
    let maxWrite: Date | null = null;

    for (const entity of TXN_ENTITIES) {
      const rows = await this.client.queryAll<QboTxn>(entity, where);
      for (const t of rows) {
        const w = t.MetaData?.LastUpdatedTime ? new Date(t.MetaData.LastUpdatedTime) : null;
        if (w && (!maxWrite || w > maxWrite)) maxWrite = w;
        const built = buildNativeFromQbo(ctx, entity, t, opts);
        if ("skip" in built) unbuildable.push({ ref: `${entity}:${t.Id}`, reason: built.skip });
        else documents.push(built);
      }
    }

    // Applications: the FULL LinkedTxn graph from payments (delta-safe applier).
    for (const entity of ["Payment", "BillPayment"] as const) {
      const pays = await this.client.queryAll<QboTxn>(entity);
      for (const p of pays) {
        if (/voided/i.test(p.PrivateNote ?? "")) continue;
        const rate = p.ExchangeRate && p.ExchangeRate > 0 ? p.ExchangeRate : 1;
        for (const l of p.Line ?? []) {
          const amt = mulDecimal(String(l.Amount ?? 0), String(rate));
          if (toUnits(amt) <= 0n) continue;
          for (const lt of l.LinkedTxn ?? []) {
            if (lt.TxnType === "Invoice" || lt.TxnType === "Bill") {
              applications.push({
                paymentRef: `${entity}:${p.Id}`,
                appliedRef: `${lt.TxnType}:${lt.TxnId}`,
                amount: formatMoney(amt, 2),
              });
            } else if (lt.TxnType === "CreditMemo" || lt.TxnType === "VendorCredit") {
              // A zero-amount payment can consume a credit against the other
              // linked open item — the credit becomes the settling side.
              const target = (l.LinkedTxn ?? []).find((x) => x.TxnType === "Invoice" || x.TxnType === "Bill");
              if (target) {
                applications.push({
                  paymentRef: `${lt.TxnType}:${lt.TxnId}`,
                  appliedRef: `${target.TxnType}:${target.TxnId}`,
                  amount: formatMoney(amt, 2),
                });
              }
            }
          }
        }
      }
    }

    return { documents, applications, deletedRefs: [], syncedThrough: maxWrite ?? since ?? new Date(0), unbuildable };
  }

  // --- verification ----------------------------------------------------------------------

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    // All-time home-currency TB; account id rides ColData[0].id (validated live).
    const report = await this.client.report<QboReport>("TrialBalance", {
      accounting_method: "Accrual",
      date_macro: "All",
    });
    const rows: SourceTrialBalanceRow[] = [];
    walk(report.Rows, (cd) => {
      const accountRef = cd[0]?.id;
      if (!accountRef) return;
      const debit = toUnits(numeric(cd[1]?.value));
      const credit = toUnits(numeric(cd[2]?.value));
      rows.push({ accountRef: String(accountRef), balance: fromUnits(debit - credit) });
    });
    return rows;
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    // GeneralLedger report with HOME-currency debit/credit columns (validated
    // pattern: account id on col 4, debit/credit on cols 5/6, date on col 0).
    const report = await this.client.report<QboReport>("GeneralLedger", {
      accounting_method: "Accrual",
      start_date: "1970-01-01",
      end_date: new Date(Date.now() + 400 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      columns: "tx_date,txn_type,doc_num,name,account_name,debt_home_amt,credit_home_amt",
    });
    const byBucket = new Map<string, bigint>();
    walk(report.Rows, (cd) => {
      const accountRef = cd[4]?.id;
      const date = cd[0]?.value;
      if (!accountRef || !date || (cd.length > 0 && !cd[1]?.id)) return; // data rows carry a txn id
      const u = toUnits(numeric(cd[5]?.value)) - toUnits(numeric(cd[6]?.value));
      if (u === 0n) return;
      const key = `${accountRef}|${String(date).slice(0, 7)}`;
      byBucket.set(key, (byBucket.get(key) ?? 0n) + u);
    });
    return [...byBucket.entries()].map(([key, amt]) => {
      const [accountRef, month] = key.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amt) };
    });
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const out: SourceOpenItem[] = [];
    for (const entity of ["Invoice", "Bill", "CreditMemo", "VendorCredit"]) {
      const rows = await this.client.queryAll<{ Id: string; Balance?: number; ExchangeRate?: number; PrivateNote?: string }>(entity);
      for (const r of rows) {
        if (/voided/i.test(r.PrivateNote ?? "")) continue;
        const rate = r.ExchangeRate && r.ExchangeRate > 0 ? r.ExchangeRate : 1;
        out.push({ ref: `${entity}:${r.Id}`, unpaid: formatMoney(mulDecimal(String(r.Balance ?? 0), String(rate)), 2) });
      }
    }
    return out;
  }
}

// --- QBO report helpers ------------------------------------------------------------

interface QboColData { value?: string; id?: string }
interface QboReportRow { ColData?: QboColData[]; Rows?: QboReport["Rows"]; type?: string }
interface QboReport { Rows?: { Row?: QboReportRow[] } }

function walk(rows: QboReport["Rows"], fn: (cd: QboColData[]) => void): void {
  for (const row of rows?.Row ?? []) {
    if (row.ColData) fn(row.ColData);
    if (row.Rows) walk(row.Rows, fn);
  }
}

function numeric(v: string | undefined): string {
  const s = String(v ?? "").replace(/,/g, "").trim();
  return s === "" ? "0" : s;
}
