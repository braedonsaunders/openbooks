import { ErpNextClient, type ErpNextCreds } from "../connectors/erpnext.ts";
import { formatMoney, fromUnits, toUnits } from "../money/money.ts";
import {
  buildErpInvoice, buildErpJournal, buildErpPayment,
  type ErpInvoice, type ErpJournal, type ErpPayment,
} from "./erpnext-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream, MigrationSource, NativeChanges, SourceEntity,
  SourceAccountMonthRow, SourceOpenItem, SourceTrialBalanceRow,
} from "./source.ts";
import { allModules, monthlySourcePeriods, type SourceFiscalYear } from "./periods.ts";

/**
 * ERPNext adapter — native vouchers over the Frappe REST API. Sales/Purchase
 * Invoices, Payment Entries (whose `references[]` ARE the application graph)
 * and Journal Entries become insert-ready documents; `GL Entry` is the ledger
 * truth for TB verification; `outstanding_amount` is per-invoice open-item
 * truth; `modified` is the incremental watermark.
 *
 * Party refs are prefixed (`C:`/`S:`) because Customer and Supplier are
 * separate doctypes whose names can collide.
 */

/**
 * Reconcilability is a bank-reconciliation input: only bank and cash
 * accounts may inherit it, so the import gates the flag by source account
 * type instead of defaulting it on or off.
 */
export function erpNextReconcilableAccountType(accountType: string | null): boolean {
  return accountType === "Bank" || accountType === "Cash";
}

const ERP_TYPE_BY_ACCOUNT_TYPE: Record<string, string> = {
  Bank: "asset_bank",
  Cash: "asset_bank",
  Receivable: "asset_receivable",
  Payable: "liability_payable",
  "Fixed Asset": "asset_fixed",
  "Accumulated Depreciation": "asset_fixed",
  "Cost of Goods Sold": "cogs",
  Tax: "liability_current_other",
  Stock: "asset_current_other",
  "Stock Received But Not Billed": "liability_current_other",
  Depreciation: "expense_other",
  "Capital Work in Progress": "asset_fixed",
  "Round Off": "expense_other",
};
const ERP_TYPE_BY_ROOT: Record<string, string> = {
  Asset: "asset_current_other",
  Liability: "liability_current_other",
  Equity: "equity",
  Income: "income",
  Expense: "expense",
};

const INVOICE_FIELDS = ["name", "modified", "docstatus"];

export class ErpNextSource implements MigrationSource {
  readonly name = "erpnext";
  readonly refKey = "erpId";
  readonly baseCurrency: string;
  private readonly client: ErpNextClient;

  constructor(creds: ErpNextCreds, opts: { baseCurrency?: string } = {}) {
    this.client = new ErpNextClient(creds);
    this.baseCurrency = opts.baseCurrency ?? "USD";
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const user = await this.client.ping();
    return { ok: true, detail: `Connected as ${user}` };
  }

  // --- master data ---------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Daily-mirror efficiency: parties and items honor `since` via `modified`;
    // accounts/taxes are small structural streams pulled in full.
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "tax_codes", records: await this.taxCodes() },
      { resource: "parties", records: await this.parties(since) },
      { resource: "items", records: await this.items(since) },
    ];
  }

  /** ERPNext list filter for an incremental pull. */
  private sinceFilter(since?: Date | null): (string | number)[][] {
    return since ? [["modified", ">", since.toISOString().slice(0, 19).replace("T", " ")]] : [];
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    const [years, settings] = await Promise.all([
      this.client.listAll<{ name: string; year_start_date: string; year_end_date: string; disabled: 0 | 1 }>(
        "Fiscal Year", ["name", "year_start_date", "year_end_date", "disabled"], [["disabled", "=", 0]], "year_start_date asc",
      ),
      this.client.getDoc<{ acc_frozen_upto?: string | null }>("Accounts Settings", "Accounts Settings"),
    ]);
    if (years.length === 0) throw new Error("ERPNext fiscal years are required for period migration");
    const normalized: SourceFiscalYear[] = years.map((year) => ({
      key: year.name,
      fiscalYear: Number(year.name.match(/\d{4}/)?.[0] ?? year.year_end_date.slice(0, 4)),
      startsOn: year.year_start_date,
      endsOn: year.year_end_date,
    }));
    const frozen = settings.acc_frozen_upto ?? null;
    return monthlySourcePeriods(
      "erpnext-period",
      normalized,
      (endsOn) => allModules(frozen && endsOn <= frozen ? "closed" : "open"),
    );
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.client.listAll<{
      name: string; account_name: string; account_number: string | null;
      parent_account: string | null; is_group: 0 | 1; root_type: string;
      account_type: string | null; disabled: 0 | 1;
    }>("Account", ["name", "account_name", "account_number", "parent_account", "is_group", "root_type", "account_type", "disabled"]);
    return rows.map((a) => ({
      sourceRef: a.name,
      naturalKey: a.account_number || null,
      parentRef: a.parent_account || null,
      fields: {
        number: a.account_number || null,
        name: a.account_name,
        type:
          (a.account_type ? ERP_TYPE_BY_ACCOUNT_TYPE[a.account_type] : undefined) ??
          ERP_TYPE_BY_ROOT[a.root_type] ?? "asset_current_other",
        isSummary: a.is_group === 1,
        isActive: a.disabled !== 1,
        reconcilable: erpNextReconcilableAccountType(a.account_type),
      },
    }));
  }

  private async taxCodes(): Promise<SourceEntity[]> {
    // Each Tax-typed account is its own code: ERPNext posts every rate to its
    // own ledger account, and the per-code control routing reproduces that.
    const rows = await this.client.listAll<{ name: string; account_name: string; is_group: 0 | 1 }>(
      "Account", ["name", "account_name", "is_group"], [["account_type", "=", "Tax"]],
    );
    return rows
      .filter((a) => a.is_group === 0)
      .map((a) => {
        const rateM = a.account_name.match(/([\d.]+)\s*%/);
        return {
          sourceRef: a.name,
          fields: {
            code: a.name,
            name: a.account_name,
            ratePercent: rateM ? rateM[1] : "0",
            appliesTo: "both",
            collectedAccountRef: a.name,
            paidAccountRef: a.name,
          },
        };
      });
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    // Merge signals: Customer/Supplier list rows expose `disabled` only — no
    // successor pointer. No mergedIntoRef is emitted; disappearances take the
    // held path.
    const customers = await this.client.listAll<{ name: string; customer_name: string; customer_type: string; disabled: 0 | 1 }>(
      "Customer", ["name", "customer_name", "customer_type", "disabled"], this.sinceFilter(since),
    );
    const suppliers = await this.client.listAll<{ name: string; supplier_name: string; supplier_type: string; disabled: 0 | 1 }>(
      "Supplier", ["name", "supplier_name", "supplier_type", "disabled"], this.sinceFilter(since),
    );
    return [
      ...customers.map((c) => ({
        sourceRef: `C:${c.name}`,
        fields: {
          displayName: String(c.customer_name ?? c.name).slice(0, 500),
          kind: c.customer_type === "Individual" ? "person" : "company",
          isActive: c.disabled !== 1,
        },
      })),
      ...suppliers.map((s) => ({
        sourceRef: `S:${s.name}`,
        fields: {
          displayName: String(s.supplier_name ?? s.name).slice(0, 500),
          kind: s.supplier_type === "Individual" ? "person" : "company",
          isActive: s.disabled !== 1,
        },
      })),
    ];
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.client.listAll<{ name: string; item_code: string; item_name: string; is_stock_item: 0 | 1; disabled: 0 | 1 }>(
      "Item", ["name", "item_code", "item_name", "is_stock_item", "disabled"], this.sinceFilter(since),
    );
    return rows.map((i) => ({
      sourceRef: i.name,
      naturalKey: i.item_code || null,
      fields: {
        code: i.item_code || i.name,
        name: String(i.item_name ?? i.name).slice(0, 500),
        kind: i.is_stock_item === 1 ? "inventory" : "service",
        isActive: i.disabled !== 1,
      },
    }));
  }

  // --- control accounts ------------------------------------------------------------

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const rows = await this.client.listAll<{ name: string; account_type: string | null; is_group: 0 | 1 }>(
      "Account", ["name", "account_type", "is_group"],
      [["account_type", "in", ["Receivable", "Payable", "Bank", "Cash", "Tax"]], ["is_group", "=", 0]],
    );
    const first = (t: string) => rows.find((a) => a.account_type === t)?.name;
    const bank = first("Bank") ?? first("Cash");
    const tax = first("Tax");
    return { ar: first("Receivable"), ap: first("Payable"), bank, taxCollected: tax, taxPaid: tax };
  }

  // --- native transactions -----------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    const sinceStr = since ? since.toISOString().slice(0, 19).replace("T", " ") : null;
    const filt = sinceStr ? [["modified", ">", sinceStr]] : [];

    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    let maxWrite: Date | null = null;
    const track = (modified: string) => {
      const d = new Date(modified.replace(" ", "T") + "Z");
      if (!maxWrite || d > maxWrite) maxWrite = d;
    };
    const add = (built: NativeDocument | { skip: string }, ref: string) => {
      if ("skip" in built) unbuildable.push({ ref, reason: built.skip });
      else documents.push(built);
    };

    for (const doctype of ["Sales Invoice", "Purchase Invoice"]) {
      const heads = await this.client.listAll<{ name: string; modified: string }>(doctype, INVOICE_FIELDS, filt);
      for (const h of heads) {
        track(h.modified);
        const doc = await this.client.getDoc<ErpInvoice>(doctype, h.name);
        add(buildErpInvoice(ctx, doc), h.name);
      }
    }
    const payHeads = await this.client.listAll<{ name: string; modified: string }>("Payment Entry", INVOICE_FIELDS, filt);
    for (const h of payHeads) {
      track(h.modified);
      add(buildErpPayment(ctx, await this.client.getDoc<ErpPayment>("Payment Entry", h.name)), h.name);
    }
    const jeHeads = await this.client.listAll<{ name: string; modified: string }>("Journal Entry", INVOICE_FIELDS, filt);
    for (const h of jeHeads) {
      track(h.modified);
      add(buildErpJournal(ctx, await this.client.getDoc<ErpJournal>("Journal Entry", h.name)), h.name);
    }

    // Applications: every submitted Payment Entry's references (full graph —
    // the reconciler is delta-safe), plus journal-row allocations.
    // `allocated_amount` is denominated in the reference's account currency
    // (ERPNext docs: "Allocate the invoice in its account currency"), so map
    // every invoice/order to that currency with un-windowed pulls — payment
    // references reach back past the document window. The per-reference
    // `exchange_rate` converts the ALLOCATION's currency to company currency
    // (frappe/erpnext `payment_entry.py` `get_reference_details()`: an invoice
    // reference's rate is the invoice's own `conversion_rate`, fallback
    // `get_exchange_rate(party_account_currency, company_currency, ...)`; and
    // `calculate_base_allocated_amount_for_reference()` books
    // `exchange_gain_loss = allocated × header_rate − allocated ×
    // d.exchange_rate`, which only balances when the reference rate converts
    // the allocation's currency). The rate is stated only when the invoice's
    // transaction and party-account currencies are both known and EQUAL — the
    // documented normal case ("If the selected account is in a foreign
    // currency, the invoice currency must normally match it", docs.frappe.io
    // "Managing Transactions in Multiple Currencies") — so the rate's FROM
    // matches the allocation's currency; anything else stays unstated and
    // foreign links resolve through the books' own line rates or refuse
    // loudly. References the map cannot price (Journal Entry advances and the
    // like — no single currency) stay unstated for the same reason.
    const refCurrency = new Map<string, { account: string | null; txn: string | null }>();
    for (const doctype of ["Sales Invoice", "Purchase Invoice", "Sales Order", "Purchase Order"]) {
      const rows = await this.client.listAll<{
        name: string; currency?: string | null; party_account_currency?: string | null;
      }>(doctype, ["name", "currency", "party_account_currency"], []);
      for (const row of rows) {
        if (!row.name) continue;
        refCurrency.set(`${doctype}:${row.name}`, {
          account: row.party_account_currency ?? null,
          txn: row.currency ?? null,
        });
      }
    }
    const applications: NativeChanges["applications"] = [];
    const allPays = await this.client.listAll<{ name: string }>("Payment Entry", ["name"], [["docstatus", "=", 1]]);
    for (const p of allPays) {
      const doc = await this.client.getDoc<ErpPayment & { references?: { reference_doctype?: string | null; reference_name: string; allocated_amount: number; exchange_rate?: number | null }[] }>(
        "Payment Entry", p.name,
      );
      for (const r of doc.references ?? []) {
        if (!(r.allocated_amount > 0)) continue;
        const pair = r.reference_doctype ? refCurrency.get(`${r.reference_doctype}:${r.reference_name}`) : undefined;
        const currency = pair?.account ?? pair?.txn ?? "";
        // State the producer rate only when its FROM (the invoice's
        // transaction currency) provably equals the allocation's currency
        // (the party-account currency): a positive finite number on an
        // aligned pair. The reconciler still prefers the books' booked rate
        // for same-currency links, so this only prices cross-currency links
        // the books cannot price themselves.
        const fx = r.exchange_rate;
        const aligned = !!pair?.account && !!pair?.txn && pair.account === pair.txn;
        const rate = currency && aligned && typeof fx === "number" && Number.isFinite(fx) && fx > 0
          ? String(fx)
          : null;
        applications.push({
          paymentRef: p.name,
          appliedRef: r.reference_name,
          amount: formatMoney(String(r.allocated_amount), 2),
          currency,
          rate,
        });
      }
    }

    return { documents, applications, deletedRefs: [], syncedThrough: maxWrite ?? since ?? new Date(0), unbuildable };
  }

  // --- verification ---------------------------------------------------------------------

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const rows = await this.client.listAll<{ account: string; debit: number; credit: number }>(
      "GL Entry", ["account", "debit", "credit"], [["is_cancelled", "=", 0]],
    );
    const byAccount = new Map<string, bigint>();
    for (const g of rows) {
      const u = toUnits(String(g.debit ?? 0)) - toUnits(String(g.credit ?? 0));
      byAccount.set(g.account, (byAccount.get(g.account) ?? 0n) + u);
    }
    return [...byAccount.entries()].map(([accountRef, bal]) => ({ accountRef, balance: fromUnits(bal) }));
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    const rows = await this.client.listAll<{ account: string; posting_date: string; debit: number; credit: number }>(
      "GL Entry", ["account", "posting_date", "debit", "credit"], [["is_cancelled", "=", 0]],
    );
    const byBucket = new Map<string, bigint>();
    for (const g of rows) {
      const key = `${g.account}|${String(g.posting_date).slice(0, 7)}`;
      const u = toUnits(String(g.debit ?? 0)) - toUnits(String(g.credit ?? 0));
      byBucket.set(key, (byBucket.get(key) ?? 0n) + u);
    }
    return [...byBucket.entries()].map(([key, amt]) => {
      const [accountRef, month] = key.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amt) };
    });
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const out: SourceOpenItem[] = [];
    for (const doctype of ["Sales Invoice", "Purchase Invoice"]) {
      const rows = await this.client.listAll<{ name: string; outstanding_amount: number }>(
        doctype, ["name", "outstanding_amount"], [["docstatus", "=", 1]],
      );
      for (const r of rows) out.push({ ref: r.name, unpaid: formatMoney(String(r.outstanding_amount ?? 0), 2) });
    }
    return out;
  }
}
