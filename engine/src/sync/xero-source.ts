import { businessToday, parseIsoDate, utcDateFromParts } from "../platform/business-date.ts";
import { XeroClient, xeroDate } from "../connectors/xero.ts";
import { formatMoney, fromUnits, mulDecimal, toUnits } from "../money/money.ts";
import { buildNativeFromXero, type XeroBuildOpts, type XeroDoc } from "./xero-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream, MigrationSource, NativeChanges, SourceEntity,
  SourceOpenItem, SourceTrialBalanceRow,
} from "./source.ts";
import { allModules, fiscalYearsForEndingRule, monthlySourcePeriods } from "./periods.ts";

/**
 * Xero adapter — native transactions over the accounting API. Invoices (both
 * ACCREC and ACCPAY live in one endpoint), credit notes (whose `Allocations`
 * are credit applications), payments (each is itself an application), manual
 * journals, bank transactions and transfers. The raw `Journals` endpoint is
 * Advanced-tier-gated on new Xero plans, so the trial-balance and month-bucket
 * gates read the TrialBalance REPORT instead (one call per month-end; see
 * bucketsFromReports). `If-Modified-Since` drives incremental pulls; refresh
 * tokens rotate and re-seal via onRefresh.
 *
 * Contacts are ONE party model (IsCustomer/IsSupplier flags) — no prefixing
 * needed, unlike QBO/ERPNext.
 */

/**
 * Reconcilability is a bank-reconciliation input: only bank accounts (Xero
 * carries credit cards as BANK-type accounts) may inherit it, so the import
 * gates the flag by source type instead of defaulting it on or off.
 */
export function xeroReconcilableAccount(type: string): boolean {
  return type === "BANK";
}

const XERO_ACCOUNT_TYPE: Record<string, string> = {
  BANK: "asset_bank",
  CURRENT: "asset_current_other",
  INVENTORY: "asset_current_other",
  PREPAYMENT: "asset_current_other",
  FIXED: "asset_fixed",
  NONCURRENT: "asset_other",
  CURRLIAB: "liability_current_other",
  LIABILITY: "liability_current_other",
  PAYG: "liability_current_other",
  TERMLIAB: "liability_long_term",
  EQUITY: "equity",
  REVENUE: "income",
  SALES: "income",
  OTHERINCOME: "income_other",
  DIRECTCOSTS: "cogs",
  EXPENSE: "expense",
  OVERHEADS: "expense",
  DEPRECIATN: "expense_other",
};

interface XeroAccount {
  AccountID: string; Code?: string; Name: string; Type: string;
  Status?: string; SystemAccount?: string;
}
interface XeroContact { ContactID: string; Name: string; EmailAddress?: string; ContactStatus?: string }
interface XeroItem {
  ItemID: string; Code?: string; Name: string; IsTrackedAsInventory?: boolean;
}
interface XeroTaxRate { Name: string; TaxType: string; EffectiveRate?: number; Status?: string }

/** Xero report JSON (TrialBalance): header row + sections of account rows. */
interface XeroReportCell { Value?: string; Attributes?: { Id?: string; Value?: string }[] }
interface XeroReportRow { RowType?: string; Cells?: XeroReportCell[]; Rows?: XeroReportRow[] }
interface XeroReport { Reports?: { Rows?: XeroReportRow[] }[] }

/**
 * Safety cap on report-based coverage (one TrialBalance call per month).
 * The migration horizon bounds real coverage near ~8 years; anything beyond
 * this refuses loudly instead of paging the API for a decade.
 */
const TB_COVERAGE_MONTH_CAP = 240;

/**
 * Coverage months from `earliestMonth` (YYYY-MM) through the month containing
 * `today`, ascending. Pure for testability; the report loop derives each
 * month-end call from these.
 */
export function xeroCoverageMonths(earliestMonth: string, today: Date): string[] {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(earliestMonth)) {
    throw new Error(`invalid earliest Xero coverage month ${earliestMonth}`);
  }
  const [ey, em] = earliestMonth.split("-").map(Number) as [number, number];
  const months: string[] = [];
  let y = ey, m = em;
  const ty = today.getUTCFullYear();
  const tm = today.getUTCMonth() + 1;
  while (y < ty || (y === ty && m <= tm)) {
    months.push(`${y}-${String(m).padStart(2, "0")}`);
    m++;
    if (m > 12) { m = 1; y++; }
  }
  if (months.length > TB_COVERAGE_MONTH_CAP) {
    throw new Error(
      `Xero report coverage from ${earliestMonth} exceeds ${TB_COVERAGE_MONTH_CAP} months; refusing a decade of TrialBalance calls`,
    );
  }
  return months;
}
interface XeroOrganisation {
  FinancialYearEndDay?: number;
  FinancialYearEndMonth?: number;
  PeriodLockDate?: string;
  EndOfYearLockDate?: string;
}

const TXN_ENTITIES: [path: string, key: string][] = [
  ["Invoices", "Invoices"],
  ["CreditNotes", "CreditNotes"],
  ["Payments", "Payments"],
  ["ManualJournals", "ManualJournals"],
  ["BankTransactions", "BankTransactions"],
  ["BankTransfers", "BankTransfers"],
];
const ENTITY_NAME: Record<string, string> = {
  Invoices: "Invoice", CreditNotes: "CreditNote", Payments: "Payment",
  ManualJournals: "ManualJournal", BankTransactions: "BankTransaction", BankTransfers: "BankTransfer",
};

export class XeroSource implements MigrationSource {
  readonly name = "xero";
  readonly refKey = "xeroId";
  readonly baseCurrency: string;
  private readonly orgId: string;

  constructor(private client: XeroClient, opts: { orgId: string; baseCurrency?: string }) {
    this.orgId = opts.orgId;
    this.baseCurrency = opts.baseCurrency ?? "USD";
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const org = await this.client.get<{ Organisations?: { Name?: string }[] }>("Organisation");
    const name = org.Organisations?.[0]?.Name;
    return { ok: true, detail: name ? `Connected to ${name}` : "Connected" };
  }

  // --- master data ----------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Daily-mirror efficiency: contacts and items honor `since` via Xero's
    // If-Modified-Since header; accounts/taxes are small structural streams
    // pulled in full.
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "tax_codes", records: await this.taxCodes() },
      { resource: "parties", records: await this.parties(since) },
      { resource: "items", records: await this.items(since) },
    ];
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    const organisation = await this.client.get<{ Organisations?: XeroOrganisation[] }>("Organisation");
    const org = organisation.Organisations?.[0];
    if (!org?.FinancialYearEndMonth || !org.FinancialYearEndDay) {
      throw new Error("Xero organisation fiscal year end is required for period migration");
    }
    const year = Number((await businessToday(this.orgId)).slice(0, 4));
    const fallbackStart = `${year - 7}-01-01`;
    const horizon = `${year + 1}-12-31`;
    const periodLock = xeroDate(org.PeriodLockDate)?.slice(0, 10) ?? null;
    const yearLock = xeroDate(org.EndOfYearLockDate)?.slice(0, 10) ?? null;
    return monthlySourcePeriods(
      "xero-period",
      fiscalYearsForEndingRule(fallbackStart, horizon, org.FinancialYearEndMonth, org.FinancialYearEndDay),
      (endsOn) => allModules(yearLock && endsOn <= yearLock ? "closed" : periodLock && endsOn <= periodLock ? "soft_closed" : "open"),
    );
  }

  private async xeroAccounts(): Promise<XeroAccount[]> {
    const data = await this.client.get<{ Accounts: XeroAccount[] }>("Accounts");
    return data.Accounts ?? [];
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.xeroAccounts();
    const out: SourceEntity[] = [];
    for (const a of rows) {
      // System Debtors/Creditors carry generic types — override to AR/AP.
      const type =
        a.SystemAccount === "DEBTORS" ? "asset_receivable" :
        a.SystemAccount === "CREDITORS" ? "liability_payable" :
        XERO_ACCOUNT_TYPE[a.Type];
      if (!type) continue;
      out.push({
        sourceRef: a.AccountID,
        naturalKey: a.Code || null,
        fields: {
          number: a.Code || null,
          name: a.Name,
          type,
          isActive: a.Status !== "ARCHIVED",
          isSummary: false,
          reconcilable: xeroReconcilableAccount(a.Type),
        },
      });
    }
    return out;
  }

  private async taxCodes(): Promise<SourceEntity[]> {
    const data = await this.client.get<{ TaxRates: XeroTaxRate[] }>("TaxRates");
    return (data.TaxRates ?? []).map((t) => ({
      sourceRef: t.TaxType, // TaxType is the stable key line items reference
      fields: {
        code: t.TaxType,
        name: t.Name,
        ratePercent: String(t.EffectiveRate ?? 0),
        appliesTo: "both",
      },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    // Merge signals: the Contacts API exposes ContactStatus only (ARCHIVED
    // arrives as isActive false above) — there is no survivor pointer on the
    // wire. No mergedIntoRef is emitted; a merged-away contact takes the
    // mirror's held path.
    const rows = await this.client.listAll<XeroContact>("Contacts", "Contacts", { includeArchived: "true" }, since);
    return rows.map((c) => ({
      sourceRef: c.ContactID,
      fields: {
        displayName: String(c.Name).slice(0, 500),
        kind: "company",
        email: c.EmailAddress || null,
        isActive: c.ContactStatus !== "ARCHIVED",
      },
    }));
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const data = await this.client.get<{ Items: XeroItem[] }>("Items", {}, since);
    return (data.Items ?? []).map((i) => ({
      sourceRef: i.ItemID,
      naturalKey: i.Code || null,
      fields: {
        code: i.Code || `xero-${i.ItemID.slice(0, 8)}`,
        name: String(i.Name).slice(0, 500),
        kind: i.IsTrackedAsInventory ? "inventory" : "service",
        isActive: true,
      },
    }));
  }

  // --- control accounts --------------------------------------------------------------

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const rows = await this.xeroAccounts();
    const sys = (s: string) => rows.find((a) => a.SystemAccount === s)?.AccountID;
    const gst = sys("GST");
    return {
      ar: sys("DEBTORS"),
      ap: sys("CREDITORS"),
      bank: rows.find((a) => a.Type === "BANK")?.AccountID,
      taxCollected: gst,
      taxPaid: gst, // Xero books both sides to the single GST account
    };
  }

  // --- native transactions --------------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    const accounts = await this.xeroAccounts();
    const opts: XeroBuildOpts = {
      accountIdByCode: new Map(accounts.filter((a) => a.Code).map((a) => [a.Code!, a.AccountID])),
      gstAccountRef: accounts.find((a) => a.SystemAccount === "GST")?.AccountID,
    };

    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    const applications: NativeChanges["applications"] = [];
    let maxWrite: Date | null = null;
    const track = (updated?: string) => {
      const iso = xeroDate(updated);
      if (!iso) return;
      const d = new Date(iso);
      if (!maxWrite || d > maxWrite) maxWrite = d;
    };

    for (const [path, key] of TXN_ENTITIES) {
      const entity = ENTITY_NAME[key]!;
      const rows = await this.client.listAll<XeroDoc>(path, key, {}, since);
      for (const t of rows) {
        track(t.UpdatedDateUTC);
        const built = buildNativeFromXero(ctx, entity, t, opts);
        const id =
          t.InvoiceID ?? t.CreditNoteID ?? t.PaymentID ?? t.ManualJournalID ?? t.BankTransactionID ?? t.BankTransferID;
        if ("skip" in built) unbuildable.push({ ref: `${entity}:${id}`, reason: built.skip });
        else documents.push(built);
      }
    }

    // Applications: every Payment settles its invoice or credit note;
    // credit-note Allocations settle theirs. Pull FULL graphs (the reconciler
    // is delta-safe). Every link amount is denominated in the SETTLED
    // document's currency (per Xero's single-currency documents:
    // Payment.Amount and Allocation.Amount are capped by the target
    // outstanding, so they price in the target's currency). Build target →
    // { currency, rate } maps with one un-windowed pull each so links against
    // out-of-window documents stay stated.
    const invMeta = await this.client.listAll<XeroDoc>("Invoices", "Invoices");
    const invFx = new Map<string, { currency: string; rate: string | null }>();
    for (const v of invMeta) {
      if (v.InvoiceID && v.CurrencyCode) {
        invFx.set(v.InvoiceID, {
          currency: v.CurrencyCode,
          rate: typeof v.CurrencyRate === "number" && v.CurrencyRate > 0 ? String(v.CurrencyRate) : null,
        });
      }
    }
    const credits = await this.client.listAll<
      XeroDoc & { Allocations?: { Amount?: number; Invoice?: { InvoiceID?: string } }[] }
    >("CreditNotes", "CreditNotes");
    // A refund settles its credit note the same way a receipt settles its
    // invoice — without this link the credit stays open in the subledger.
    const cnFx = new Map<string, { currency: string; rate: string | null }>();
    for (const c of credits) {
      if (c.CreditNoteID && c.CurrencyCode) {
        cnFx.set(c.CreditNoteID, {
          currency: c.CurrencyCode,
          rate: typeof c.CurrencyRate === "number" && c.CurrencyRate > 0 ? String(c.CurrencyRate) : null,
        });
      }
    }
    const pays = await this.client.listAll<XeroDoc & { Amount?: number; CurrencyRate?: number }>("Payments", "Payments");
    for (const p of pays) {
      // Xero payment legs are unsigned magnitudes on both sides of the books:
      // the published Accounting API contract (XeroAPI/xero-openapi
      // `xero_accounting.yaml`, components/schemas/Payment) defines `Amount`
      // as "The amount of the payment. Must be less than or equal to the
      // outstanding amount owing on the invoice", with a PaymentType enum
      // covering ACCRECPAYMENT (sales invoices) and ACCPAYPAYMENT (bills) —
      // and the ARCREDITPAYMENT/APCREDITPAYMENT families for refunds, whose
      // Amount is likewise capped by the credit outstanding.
      // Normalize defensively with abs(); only zero/missing legs are skipped.
      const magnitude = Math.abs(p.Amount ?? 0);
      if ((p.Status ?? "") === "DELETED" || !(magnitude > 0)) continue;
      // One payment settles exactly one target — the same single-target rule
      // the document builder enforces (a multi-target payment is skipped as a
      // document, so linking either pointer would dangle or double-settle).
      const targets = [
        p.Invoice?.InvoiceID
          ? { ref: `Invoice:${p.Invoice.InvoiceID}`, fx: invFx.get(p.Invoice.InvoiceID) }
          : null,
        p.CreditNote?.CreditNoteID
          ? { ref: `CreditNote:${p.CreditNote.CreditNoteID}`, fx: cnFx.get(p.CreditNote.CreditNoteID) }
          : null,
      ].filter((t): t is { ref: string; fx: { currency: string; rate: string | null } | undefined } => t !== null);
      // Prepayment/Overpayment pointers resolve to no imported document (those
      // endpoints are not pulled), so a payment against one has no open item
      // to link: it posts standalone and is skipped here rather than linked
      // to a ref that can never resolve. Importing those endpoints (with
      // their allocations) is the follow-up that closes those credits.
      if (targets.length !== 1) continue;
      const target = targets[0]!;
      const producerRate =
        typeof p.CurrencyRate === "number" && p.CurrencyRate > 0 ? String(p.CurrencyRate) : null;
      applications.push({
        paymentRef: `Payment:${p.PaymentID}`,
        appliedRef: target.ref,
        amount: String(magnitude),
        // Xero payments price in the settled document's currency (Amount is
        // capped by its outstanding). The producer rate is the payment's own
        // Xero rate (home-per-target-ccy). A missing target code means a
        // deleted target; the reconciler refuses the link honestly.
        currency: target.fx?.currency ?? "",
        rate: target.fx && producerRate ? producerRate : target.fx?.rate ?? null,
      });
    }
    for (const c of credits) {
      if (!["AUTHORISED", "PAID"].includes(c.Status ?? "")) continue;
      for (const a of c.Allocations ?? []) {
        // Credit-note allocation legs are unsigned magnitudes, exactly like
        // payments: the published Accounting API contract (XeroAPI/xero-openapi
        // `xero_accounting.yaml`, components/schemas/Allocation) defines the
        // ONE shared allocation schema — serving CreditNote, Prepayment AND
        // Overpayment allocations — with `Amount` as "the amount being applied
        // to the invoice". Normalize defensively with abs(); only zero/missing
        // legs are skipped, so a signed leg settles instead of being dropped.
        const magnitude = Math.abs(a.Amount ?? 0);
        if (!a.Invoice?.InvoiceID || !(magnitude > 0)) continue;
        const inv = invFx.get(a.Invoice.InvoiceID);
        applications.push({
          paymentRef: `CreditNote:${c.CreditNoteID}`,
          appliedRef: `Invoice:${a.Invoice.InvoiceID}`,
          amount: String(magnitude),
          // Allocation.Amount prices in the invoice's currency, so the
          // producer rate is the INVOICE's own Xero rate (same-currency
          // allocations — the Xero norm — make this identical to the
          // credit-note rate the old code used).
          currency: inv?.currency ?? "",
          rate: inv?.rate ?? null,
        });
      }
    }

    return { documents, applications, deletedRefs: [], syncedThrough: maxWrite ?? since ?? new Date(0), unbuildable };
  }

  // --- verification ---------------------------------------------------------------------
  //
  // The Journals endpoint (the raw GL) is Advanced-tier-gated on new Xero
  // plans, so both gates read the TrialBalance REPORT instead: one call per
  // month-end, taking the month-movement Debit/Credit columns per account.
  // Cumulative TB = Σ monthly movements — identical semantics to our raw
  // journal-line sums, and immune to Xero's retained-earnings year-close.

  private monthlyBuckets: Promise<Map<string, bigint>> | null = null;

  private bucketsFromReports(): Promise<Map<string, bigint>> {
    this.monthlyBuckets ??= (async () => {
      const buckets = new Map<string, bigint>(); // `${accountRef}|${YYYY-MM}` → units
      const today = parseIsoDate(await businessToday(this.orgId));
      // Full migration history, not a fixed window. The earliest sourced
      // accounting period bounds the migration, and every month from there
      // through today is reported — a month outside this coverage is UNKNOWN
      // to the source (the true-up skips it), never zero. A fixed lookback
      // (previously 24 months) read every older mirrored month as zero and
      // reversed real history when glTrueup was on.
      const periods = await this.accountingPeriods();
      const startsOn = periods
        .map((p) => String((p.fields as { startsOn?: unknown })?.startsOn ?? ""))
        .filter((s) => /^\d{4}-\d{2}-\d{2}$/.test(s))
        .sort();
      if (startsOn.length === 0) {
        throw new Error("Xero organisation exposes no accounting periods; refusing a windowed trial balance");
      }
      const months = xeroCoverageMonths(startsOn[0]!.slice(0, 7), today);
      for (const month of months) {
        const [y, mo] = month.split("-").map(Number) as [number, number];
        // utcDateFromParts keeps literal years 0001-0099 that Date.UTC
        // would remap onto 1900-1999.
        const monthEnd = utcDateFromParts(y, mo, 0);
        const report = await this.client.get<XeroReport>("Reports/TrialBalance", {
          date: monthEnd.toISOString().slice(0, 10),
        });
        const rows = report.Reports?.[0]?.Rows ?? [];
        // Header row → column indices ("Debit"/"Credit" first pair = the month).
        const header = rows.find((r) => r.RowType === "Header")?.Cells ?? [];
        const debitCol = header.findIndex((c) => c.Value === "Debit");
        const creditCol = header.findIndex((c) => c.Value === "Credit");
        if (debitCol < 0 || creditCol < 0) continue;
        const walk = (rr: XeroReportRow[]) => {
          for (const row of rr) {
            if (row.Rows) walk(row.Rows);
            if (row.RowType !== "Row" || !row.Cells) continue;
            const accountRef = row.Cells[0]?.Attributes?.find((a) => a.Id === "account")?.Value;
            if (!accountRef) continue;
            const num = (i: number) => {
              const v = String(row.Cells?.[i]?.Value ?? "").replace(/,/g, "").trim();
              return v === "" ? 0n : toUnits(String(v));
            };
            const movement = num(debitCol) - num(creditCol);
            if (movement === 0n) continue;
            const key = `${accountRef}|${month}`;
            buckets.set(key, (buckets.get(key) ?? 0n) + movement);
          }
        };
        walk(rows);
      }
      return buckets;
    })();
    return this.monthlyBuckets;
  }

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const buckets = await this.bucketsFromReports();
    const byAccount = new Map<string, bigint>();
    for (const [key, amt] of buckets) {
      const accountRef = key.split("|")[0]!;
      byAccount.set(accountRef, (byAccount.get(accountRef) ?? 0n) + amt);
    }
    return [...byAccount.entries()].map(([accountRef, bal]) => ({ accountRef, balance: fromUnits(bal) }));
  }

  async monthlyActivity(): Promise<{ accountRef: string; month: string; amount: string }[]> {
    const buckets = await this.bucketsFromReports();
    return [...buckets.entries()].map(([key, amt]) => {
      const [accountRef, month] = key.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amt) };
    });
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const out: SourceOpenItem[] = [];
    const invoices = await this.client.listAll<{
      InvoiceID: string; AmountDue?: number; CurrencyRate?: number; Status?: string;
    }>("Invoices", "Invoices");
    for (const i of invoices) {
      if (!["AUTHORISED", "PAID"].includes(i.Status ?? "")) continue;
      const rate = i.CurrencyRate && i.CurrencyRate > 0 ? i.CurrencyRate : 1;
      out.push({ ref: `Invoice:${i.InvoiceID}`, unpaid: formatMoney(mulDecimal(String(i.AmountDue ?? 0), String(rate)), 2) });
    }
    const credits = await this.client.listAll<{
      CreditNoteID: string; RemainingCredit?: number; CurrencyRate?: number; Status?: string;
    }>("CreditNotes", "CreditNotes");
    for (const c of credits) {
      if (!["AUTHORISED", "PAID"].includes(c.Status ?? "")) continue;
      const rate = c.CurrencyRate && c.CurrencyRate > 0 ? c.CurrencyRate : 1;
      out.push({ ref: `CreditNote:${c.CreditNoteID}`, unpaid: formatMoney(mulDecimal(String(c.RemainingCredit ?? 0), String(rate)), 2) });
    }
    return out;
  }
}
