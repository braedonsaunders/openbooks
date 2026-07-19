import { DynamicsClient } from "../dynamics.ts";
import { fromUnits, toUnits } from "../money.ts";
import { buildNativeFromBC, type BCBuildOpts, type BCDoc } from "./dynamics-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream, MigrationSource, NativeChanges, SourceAccountMonthRow,
  SourceEntity, SourceOpenItem, SourceTrialBalanceRow,
} from "./source.ts";
import { allModules, fiscalYearsForEndingRule, monthlySourcePeriods } from "./periods.ts";

/**
 * Microsoft Dynamics 365 Business Central adapter — native transactions over
 * the v2.0 REST API. Sales/purchase invoices + credit memos (with their line
 * entities), general-journal batches, and customer/vendor payments become
 * openbooks documents; payments' `appliesToInvoiceId` are the applications.
 *
 * The trial-balance and monthly-period gates read `generalLedgerEntries` (the
 * posted GL, debit/credit per account) — guaranteed to reconcile with our
 * postings. Open items come from invoice `remainingAmount`.
 *
 * VALIDATION RISK (pending the CRONUS sandbox): the v2.0 line entities expose
 * a GL `accountId` only for Account-type lines. Item/Resource lines resolve
 * through the item→posting-account map built in `entities()`; where posting
 * setup isn't reachable via the standard API those lines surface as
 * `unbuildable` rather than being silently dropped.
 */

/** BC OData escapes special chars in enum values: `_x0020_`=space, `_x002D_`=-. */
const odataDecode = (s?: string): string =>
  (s ?? "").replace(/_x([0-9A-Fa-f]{4})_/g, (_m, h) => String.fromCharCode(parseInt(h, 16)));

const BC_CATEGORY_TYPE: Record<string, string> = {
  Assets: "asset_current_other",
  Liabilities: "liability_current_other",
  Equity: "equity",
  Income: "income",
  "Cost of Goods Sold": "cogs",
  Expense: "expense",
};

interface BCAccount { id: string; number?: string; displayName?: string; category?: string; subCategory?: string; accountType?: string; blocked?: boolean }
interface BCParty { id: string; number?: string; displayName?: string; blocked?: boolean }
interface BCItem { id: string; number?: string; displayName?: string; type?: string; blocked?: boolean }
interface BCGLEntry { id: string; postingDate?: string; accountId?: string; debitAmount?: number; creditAmount?: number }

const TXN_ENTITIES: { path: string; entity: string; expand: string }[] = [
  { path: "salesInvoices", entity: "salesInvoice", expand: "salesInvoiceLines" },
  { path: "purchaseInvoices", entity: "purchaseInvoice", expand: "purchaseInvoiceLines" },
  { path: "salesCreditMemos", entity: "salesCreditMemo", expand: "salesCreditMemoLines" },
  { path: "purchaseCreditMemos", entity: "purchaseCreditMemo", expand: "purchaseCreditMemoLines" },
];

export class DynamicsSource implements MigrationSource {
  readonly name = "dynamics";
  readonly refKey = "bcId";
  readonly baseCurrency: string;

  constructor(private client: DynamicsClient, opts: { baseCurrency?: string } = {}) {
    this.baseCurrency = opts.baseCurrency ?? "USD";
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const info = await this.client.list<{ displayName?: string }>("companyInformation");
    return { ok: true, detail: info[0]?.displayName ? `Connected to ${info[0].displayName}` : "Connected" };
  }

  // --- master data ----------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Daily-mirror efficiency: customers/vendors/items honor `since` via the
    // OData lastModifiedDateTime filter; accounts/taxes pull in full (small).
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "tax_codes", records: await this.taxCodes() },
      { resource: "parties", records: await this.parties(since) },
      { resource: "items", records: await this.items(since) },
    ];
  }

  /** OData params for an incremental pull ({} = full). */
  private sinceParams(since?: Date | null): Record<string, string> {
    return since ? { $filter: `lastModifiedDateTime ge ${since.toISOString()}` } : {};
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.client.list<BCAccount>("accounts");
    const out: SourceEntity[] = [];
    for (const a of rows) {
      if (a.accountType && odataDecode(a.accountType) !== "Posting") continue; // headings/totals aren't postable
      // subCategory pins the AR/AP control accounts to the open-item types the
      // reconciler keys on; everything else maps by category.
      const sub = odataDecode(a.subCategory);
      const type =
        sub === "Accounts Receivable" ? "asset_receivable" :
        sub === "Accounts Payable" ? "liability_payable" :
        BC_CATEGORY_TYPE[odataDecode(a.category)] ?? null;
      if (!type) continue;
      out.push({
        sourceRef: a.id,
        naturalKey: a.number ?? null,
        fields: { number: a.number ?? null, name: a.displayName ?? a.number ?? a.id, type, isActive: !a.blocked, isSummary: false },
      });
    }
    return out;
  }

  private async taxCodes(): Promise<SourceEntity[]> {
    // BC tax is jurisdiction-specific (VAT posting setup / tax areas). The line
    // `taxCode` string is the stable per-line key; expose the distinct set.
    const groups = await this.client.list<{ id: string; code?: string; displayName?: string }>("taxGroups");
    return groups.map((g) => ({
      sourceRef: g.code ?? g.id,
      fields: { code: g.code ?? g.id, name: g.displayName ?? g.code ?? g.id, ratePercent: "0", appliesTo: "both" },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    const [customers, vendors] = await Promise.all([
      this.client.list<BCParty>("customers", this.sinceParams(since)),
      this.client.list<BCParty>("vendors", this.sinceParams(since)),
    ]);
    const mk = (p: BCParty): SourceEntity => ({
      sourceRef: p.id,
      fields: { displayName: String(p.displayName ?? p.number ?? p.id).slice(0, 500), kind: "company", isActive: !p.blocked },
    });
    return [...customers.map(mk), ...vendors.map(mk)];
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.client.list<BCItem>("items", this.sinceParams(since));
    return rows.map((i) => ({
      sourceRef: i.id,
      naturalKey: i.number ?? null,
      fields: {
        code: i.number ?? `bc-${i.id.slice(0, 8)}`,
        name: String(i.displayName ?? i.number ?? i.id).slice(0, 500),
        kind: i.type === "Inventory" ? "inventory" : "service",
        isActive: !i.blocked,
      },
    }));
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    // BC exposes fiscal periods via `accountingPeriods`; fall back to a
    // calendar-year rule (Jan–Dec) when the list is empty.
    const now = new Date();
    const fallbackStart = new Date(Date.UTC(now.getUTCFullYear() - 7, 0, 1)).toISOString().slice(0, 10);
    const horizon = new Date(Date.UTC(now.getUTCFullYear() + 1, 11, 31)).toISOString().slice(0, 10);
    return monthlySourcePeriods(
      "bc-period",
      fiscalYearsForEndingRule(fallbackStart, horizon, 12, 31),
      () => allModules("open"),
    );
  }

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const rows = await this.client.list<BCAccount>("accounts");
    const sub = (a: BCAccount) => odataDecode(a.subCategory);
    const name = (a: BCAccount) => (a.displayName ?? "").toLowerCase();
    const bySub = (s: string) => rows.find((a) => sub(a) === s)?.id;
    return {
      ar: bySub("Accounts Receivable") ?? rows.find((a) => /receivable/i.test(name(a)))?.id,
      ap: bySub("Accounts Payable") ?? rows.find((a) => /payable|vendors?,/i.test(name(a)))?.id,
      bank: bySub("Cash") ?? rows.find((a) => /\b(bank|cash|chequ|checking)\b/i.test(name(a)))?.id,
    };
  }

  // --- native transactions --------------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    // Item lines don't carry their GL account and BC omits the posting setup, so
    // resolve each document's income/expense account from the posted GL
    // (generalLedgerEntries carry documentNumber + accountId). Per document, take
    // the largest income / expense (incl. COGS) movement as that doc's line
    // account; the GL trueup closes any account-distribution residual.
    const bcAccounts = await this.client.list<BCAccount>("accounts");
    const catByBcId = new Map(bcAccounts.map((a) => [a.id, BC_CATEGORY_TYPE[odataDecode(a.category)] ?? ""]));
    const glAll = await this.client.list<BCGLEntry & { documentNumber?: string }>("generalLedgerEntries");
    const docIncomeAccount = new Map<string, string>();
    const docExpenseAccount = new Map<string, string>();
    const incMag = new Map<string, number>();
    const expMag = new Map<string, number>();
    for (const e of glAll) {
      if (!e.documentNumber || !e.accountId) continue;
      const obId = ctx.accountByRef.get(e.accountId)?.id;
      if (!obId) continue;
      const cat = catByBcId.get(e.accountId) ?? ""; // already decoded in catByBcId
      const mag = Math.abs((e.creditAmount ?? 0) - (e.debitAmount ?? 0));
      if (cat === "income" || cat === "income_other") {
        if (mag > (incMag.get(e.documentNumber) ?? 0)) { incMag.set(e.documentNumber, mag); docIncomeAccount.set(e.documentNumber, obId); }
      } else if (cat === "expense" || cat === "cogs" || cat === "expense_other") {
        if (mag > (expMag.get(e.documentNumber) ?? 0)) { expMag.set(e.documentNumber, mag); docExpenseAccount.set(e.documentNumber, obId); }
      }
    }
    const opts: BCBuildOpts = { itemSalesAccount: new Map(), itemPurchaseAccount: new Map(), docIncomeAccount, docExpenseAccount };
    const filter = DynamicsClient.modifiedSince(since);

    // Bank accounts + per-document bank movement — BC's standard API exposes no
    // payment records; settlements are embedded in the invoice GL. Reconstruct a
    // payment from the bank leg BC posted under the invoice's documentNumber.
    const bankObIds = new Set<string>();
    for (const a of bcAccounts) {
      const obId = ctx.accountByRef.get(a.id)?.id;
      if (obId && /\b(cash|bank|chequ|checking)\b/i.test(`${odataDecode(a.subCategory)} ${a.displayName ?? ""}`)) bankObIds.add(obId);
    }
    const docBank = new Map<string, string>();
    const bankMag = new Map<string, number>();
    for (const e of glAll) {
      if (!e.documentNumber || !e.accountId) continue;
      const obId = ctx.accountByRef.get(e.accountId)?.id;
      if (!obId || !bankObIds.has(obId)) continue;
      const mag = Math.abs((e.debitAmount ?? 0) - (e.creditAmount ?? 0));
      if (mag > (bankMag.get(e.documentNumber) ?? 0)) { bankMag.set(e.documentNumber, mag); docBank.set(e.documentNumber, obId); }
    }

    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    const applications: NativeChanges["applications"] = [];
    let maxWrite: Date | null = null;
    const track = (v?: string) => { if (v) { const d = new Date(v); if (!maxWrite || d > maxWrite) maxWrite = d; } };

    for (const { path, entity, expand } of TXN_ENTITIES) {
      const rows = await this.client.list<BCDoc & { salesInvoiceLines?: unknown[]; [k: string]: unknown }>(path, {
        ...filter, $expand: expand,
      });
      for (const t of rows) {
        track(t.lastModifiedDateTime);
        const lines = (t[expand] as BCDoc["lines"]) ?? t.lines ?? [];
        const built = buildNativeFromBC(ctx, entity, { ...t, lines }, opts);
        if ("skip" in built) { unbuildable.push({ ref: `${entity}:${t.id}`, reason: built.skip }); continue; }
        documents.push(built);

        // Reconstruct the settlement BC baked into the invoice GL: a payment for
        // (total − remaining), applied to the invoice, so AR aging matches.
        const isSales = entity === "salesInvoice", isPurch = entity === "purchaseInvoice";
        if ((isSales || isPurch) && t.number) {
          // Settle against OUR posted AR (per-line ex-tax + tax) rather than BC's
          // rounded document total, so the invoice closes to the exact penny.
          const arTotal = (lines ?? []).reduce((s, l) => s + (l.amountExcludingTax ?? 0) + (l.totalTaxAmount ?? 0), 0);
          const settled = arTotal - (t.remainingAmount ?? 0);
          const bank = docBank.get(t.number) ?? ctx.control.bank ?? null;
          if (settled > 0.005 && bank) {
            documents.push({
              sourceRef: `${entity}Payment:${t.id}`, kind: isSales ? "customer_payment" : "vendor_payment",
              posting: true, partyId: built.partyId, controlAccountId: null,
              documentDate: built.documentDate, dueDate: null,
              memo: `Settlement of ${t.number}`, referenceNumber: `PAY-${t.number}`,
              lines: [{ accountId: bank, itemId: null, amount: settled.toFixed(2), taxAmount: "0", taxOverridden: false, taxCodeId: null, departmentId: null, projectId: null, description: "Payment", lineNumber: 1 }],
            });
            applications.push({ paymentRef: `${entity}Payment:${t.id}`, appliedRef: `${entity}:${t.id}`, amount: settled.toFixed(2) });
          }
        }
      }
    }

    // Payments (customer + vendor) — one journal-line entity each; the bank
    // account is the payment journal's balancing account.
    for (const [path, entity] of [["customerPayments", "customerPayment"], ["vendorPayments", "vendorPayment"]] as const) {
      let rows: BCDoc[] = [];
      try { rows = await this.client.list<BCDoc>(path, filter); } catch { rows = []; }
      for (const p of rows) {
        track(p.lastModifiedDateTime);
        const built = buildNativeFromBC(ctx, entity, p, opts);
        if ("skip" in built) unbuildable.push({ ref: `${entity}:${p.id}`, reason: built.skip });
        else documents.push(built);
        if (p.appliesToInvoiceId && p.amount) {
          const invEntity = entity === "customerPayment" ? "salesInvoice" : "purchaseInvoice";
          applications.push({
            paymentRef: `${entity}:${p.id}`,
            appliedRef: `${invEntity}:${p.appliesToInvoiceId}`,
            amount: Math.abs(p.amount).toFixed(2),
          });
        }
      }
    }

    return { documents, applications, deletedRefs: [], syncedThrough: maxWrite ?? since ?? new Date(0), unbuildable };
  }

  // --- verification (generalLedgerEntries = posted GL) ----------------------------------

  private glCache: Promise<BCGLEntry[]> | null = null;
  private glEntries(): Promise<BCGLEntry[]> {
    this.glCache ??= this.client.list<BCGLEntry>("generalLedgerEntries");
    return this.glCache;
  }

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const byAccount = new Map<string, bigint>();
    for (const e of await this.glEntries()) {
      if (!e.accountId) continue;
      const mv = toUnits((e.debitAmount ?? 0).toFixed(2)) - toUnits((e.creditAmount ?? 0).toFixed(2));
      byAccount.set(e.accountId, (byAccount.get(e.accountId) ?? 0n) + mv);
    }
    return [...byAccount.entries()].map(([accountRef, bal]) => ({ accountRef, balance: fromUnits(bal) }));
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    const buckets = new Map<string, bigint>();
    for (const e of await this.glEntries()) {
      if (!e.accountId || !e.postingDate) continue;
      const key = `${e.accountId}|${e.postingDate.slice(0, 7)}`;
      const mv = toUnits((e.debitAmount ?? 0).toFixed(2)) - toUnits((e.creditAmount ?? 0).toFixed(2));
      buckets.set(key, (buckets.get(key) ?? 0n) + mv);
    }
    return [...buckets.entries()].map(([k, amt]) => {
      const [accountRef, month] = k.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amt) };
    });
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const out: SourceOpenItem[] = [];
    for (const [path, entity] of [["salesInvoices", "salesInvoice"], ["purchaseInvoices", "purchaseInvoice"]] as const) {
      const rows = await this.client.list<{ id: string; remainingAmount?: number; status?: string }>(path);
      for (const r of rows) {
        if (r.status === "Draft" || r.status === "Canceled") continue;
        out.push({ ref: `${entity}:${r.id}`, unpaid: (r.remainingAmount ?? 0).toFixed(2) });
      }
    }
    return out;
  }
}
