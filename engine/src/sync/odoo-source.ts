import { OdooClient, m2oId, type OdooCreds } from "../odoo.ts";
import { formatMoney, fromUnits, toUnits } from "../money.ts";
import { buildNativeFromOdoo, type OdooMove, type OdooMoveLine } from "./odoo-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream,
  MigrationSource,
  NativeChanges,
  SourceAccountMonthRow,
  SourceEntity,
  SourceOpenItem,
  SourceTrialBalanceRow,
} from "./source.ts";
import { allModules, fiscalYearsForEndingRule, monthlySourcePeriods, type ImportedModuleStates } from "./periods.ts";

/**
 * Odoo adapter — native `account.move` transactions over JSON-RPC. Moves ARE
 * the native documents (invoices, bills, refunds, payments, journals);
 * `account.partial.reconcile` is the application graph; `amount_residual` is
 * per-document open-item truth; `write_date` is the incremental watermark.
 */

const ODOO_ACCOUNT_TYPE: Record<string, string> = {
  asset_cash: "asset_bank",
  asset_current: "asset_current_other",
  asset_receivable: "asset_receivable",
  asset_fixed: "asset_fixed",
  asset_non_current: "asset_other",
  asset_prepayments: "asset_current_other",
  equity: "equity",
  equity_unaffected: "equity",
  expense: "expense",
  expense_direct_cost: "cogs",
  expense_depreciation: "expense_other",
  income: "income",
  income_other: "income_other",
  liability_current: "liability_current_other",
  liability_payable: "liability_payable",
  liability_non_current: "liability_long_term",
  liability_credit_card: "liability_card",
};

const ODOO_ITEM_KIND: Record<string, string> = {
  consu: "non_inventory",
  service: "service",
  product: "inventory",
};

const MOVE_FIELDS = [
  "id", "name", "move_type", "state", "partner_id", "invoice_date", "invoice_date_due",
  "date", "ref", "payment_id", "statement_line_id", "write_date",
];
const LINE_FIELDS = ["id", "move_id", "account_id", "name", "balance", "display_type", "tax_ids", "tax_line_id", "partner_id"];

/** Odoo datetime "YYYY-MM-DD HH:MM:SS" (UTC) → Date. */
const odooTs = (s: string): Date => new Date(s.replace(" ", "T") + "Z");

export class OdooSource implements MigrationSource {
  readonly name = "odoo";
  readonly refKey = "odooId";
  readonly baseCurrency: string;
  private readonly client: OdooClient;

  constructor(creds: OdooCreds, opts: { baseCurrency?: string } = {}) {
    this.client = new OdooClient(creds);
    this.baseCurrency = opts.baseCurrency ?? "USD";
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    await this.client.authenticate();
    const co = await this.client.searchReadAll<{ name: string }>("res.company", [], ["name"]);
    return { ok: true, detail: co[0]?.name ? `Connected to ${co[0].name}` : "Connected" };
  }

  // --- master data --------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Daily-mirror efficiency: partners and products honor `since` via
    // write_date; accounts/taxes are small structural streams pulled in full.
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "tax_codes", records: await this.taxCodes() },
      { resource: "parties", records: await this.parties(since) },
      { resource: "items", records: await this.items(since) },
    ];
  }

  /** Odoo domain term for an incremental pull. */
  private sinceDomain(since?: Date | null): unknown[] {
    return since ? [["write_date", ">=", since.toISOString().slice(0, 19).replace("T", " ")]] : [];
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    const [companies, moves] = await Promise.all([
      this.client.searchReadAll<{
        id: number; fiscalyear_last_day: number; fiscalyear_last_month: string;
        fiscalyear_lock_date: string | false; period_lock_date: string | false; tax_lock_date: string | false;
      }>("res.company", [], ["id", "fiscalyear_last_day", "fiscalyear_last_month", "fiscalyear_lock_date", "period_lock_date", "tax_lock_date"]),
      this.client.searchReadAll<{ date: string }>("account.move", [["state", "=", "posted"]], ["date"], "date asc"),
    ]);
    const company = companies[0];
    if (!company) throw new Error("Odoo company fiscal settings are required for period migration");
    const dates = moves.map((move) => move.date).filter(Boolean).sort();
    const now = new Date();
    const start = dates[0] ?? new Date(Date.UTC(now.getUTCFullYear() - 7, 0, 1)).toISOString().slice(0, 10);
    const horizon = new Date(Date.UTC(now.getUTCFullYear() + 1, 11, 31)).toISOString().slice(0, 10);
    const fullLock = company.fiscalyear_lock_date || null;
    const periodLock = company.period_lock_date || null;
    const taxLock = company.tax_lock_date || null;
    const stateFor = (endsOn: string): ImportedModuleStates => {
      if (fullLock && endsOn <= fullLock) return allModules("closed");
      const operational = periodLock && endsOn <= periodLock ? "closed" : "open";
      return {
        ar: operational, ap: operational, banking: operational, assets: operational,
        gl: operational, tax: taxLock && endsOn <= taxLock ? "closed" : operational,
      };
    };
    return monthlySourcePeriods(
      "odoo-period",
      fiscalYearsForEndingRule(start, horizon, Number(company.fiscalyear_last_month), Number(company.fiscalyear_last_day)),
      stateFor,
    );
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.client.searchReadAll<{
      id: number; code: string; name: string; account_type: string; deprecated: boolean;
    }>("account.account", [], ["id", "code", "name", "account_type", "deprecated"]);
    const out: SourceEntity[] = [];
    for (const a of rows) {
      const type = ODOO_ACCOUNT_TYPE[a.account_type];
      if (!type) continue; // off_balance etc.
      out.push({
        sourceRef: String(a.id),
        naturalKey: a.code || null,
        fields: {
          number: a.code || null,
          name: a.name,
          type,
          isActive: !a.deprecated,
          isSummary: false,
        },
      });
    }
    return out;
  }

  private async taxCodes(): Promise<SourceEntity[]> {
    const rows = await this.client.searchReadAll<{
      id: number; name: string; amount: number; type_tax_use: string; active: boolean;
    }>("account.tax", [["active", "in", [true, false]]], ["id", "name", "amount", "type_tax_use", "active"]);
    return rows.map((t) => ({
      sourceRef: String(t.id),
      fields: {
        code: `${t.name} (${t.type_tax_use})`,
        name: t.name,
        ratePercent: String(t.amount),
        appliesTo: t.type_tax_use === "sale" ? "sales" : t.type_tax_use === "purchase" ? "purchases" : "both",
      },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.client.searchReadAll<{
      id: number; name: string; company_type: string; email: string | false;
      phone: string | false; active: boolean;
    }>("res.partner", [["active", "in", [true, false]], ...this.sinceDomain(since)], ["id", "name", "company_type", "email", "phone", "active"]);
    return rows.map((p) => ({
      sourceRef: String(p.id),
      fields: {
        displayName: String(p.name ?? `Partner ${p.id}`).slice(0, 500),
        kind: p.company_type === "person" ? "person" : "company",
        email: p.email || null,
        phone: p.phone || null,
        isActive: p.active,
      },
    }));
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.client.searchReadAll<{
      id: number; default_code: string | false; name: string; detailed_type: string; active: boolean;
    }>("product.product", [["active", "in", [true, false]], ...this.sinceDomain(since)], ["id", "default_code", "name", "detailed_type", "active"]);
    return rows.map((p) => ({
      sourceRef: String(p.id),
      naturalKey: p.default_code || null,
      fields: {
        code: p.default_code || `odoo-${p.id}`,
        name: String(p.name).slice(0, 500),
        kind: ODOO_ITEM_KIND[p.detailed_type] ?? "non_inventory",
        isActive: p.active,
      },
    }));
  }

  // --- control accounts (fresh-org derivation) ------------------------------------

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const accounts = await this.client.searchReadAll<{ id: number; name: string; account_type: string }>(
      "account.account", [], ["id", "name", "account_type"],
    );
    const first = (t: string) => accounts.find((a) => a.account_type === t);
    const bank =
      accounts.find((a) => a.account_type === "asset_cash" && /bank/i.test(a.name)) ?? first("asset_cash");

    // Tax control accounts: the accounts Odoo actually posted tax lines to.
    const taxes = await this.client.searchReadAll<{ id: number; type_tax_use: string }>(
      "account.tax", [], ["id", "type_tax_use"],
    );
    const taxAccountFor = async (use: string): Promise<string | undefined> => {
      const ids = taxes.filter((t) => t.type_tax_use === use).map((t) => t.id);
      if (ids.length === 0) return undefined;
      const line = await this.client.executeKw<{ account_id: unknown }[]>(
        "account.move.line", "search_read",
        [[["display_type", "=", "tax"], ["tax_line_id", "in", ids]]],
        { fields: ["account_id"], limit: 1 },
      );
      return m2oId(line[0]?.account_id) ?? undefined;
    };

    return {
      ar: first("asset_receivable") ? String(first("asset_receivable")!.id) : undefined,
      ap: first("liability_payable") ? String(first("liability_payable")!.id) : undefined,
      bank: bank ? String(bank.id) : undefined,
      taxCollected: await taxAccountFor("sale"),
      taxPaid: await taxAccountFor("purchase"),
    };
  }

  // --- native transactions ----------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    const domain = since
      ? [["write_date", ">=", since.toISOString().slice(0, 19).replace("T", " ")]]
      : [];
    const moves = await this.client.searchReadAll<OdooMove>("account.move", domain, MOVE_FIELDS, "id asc");

    // Lines for those moves (chunked 'in' domains).
    const linesByMove = new Map<string, OdooMoveLine[]>();
    const moveIds = moves.map((m) => m.id);
    for (let i = 0; i < moveIds.length; i += 200) {
      const chunk = moveIds.slice(i, i + 200);
      if (chunk.length === 0) continue;
      const rows = await this.client.searchReadAll<OdooMoveLine>(
        "account.move.line", [["move_id", "in", chunk]], LINE_FIELDS, "id asc",
      );
      for (const l of rows) {
        const key = m2oId(l.move_id)!;
        const arr = linesByMove.get(key);
        if (arr) arr.push(l);
        else linesByMove.set(key, [l]);
      }
    }

    // Payment discrimination + tax rates for the builder.
    const payments = await this.client.searchReadAll<{ id: number; move_id: unknown; partner_type: string }>(
      "account.payment", [], ["id", "move_id", "partner_type"],
    );
    const paymentPartnerType = new Map<string, string>();
    for (const p of payments) {
      const mid = m2oId(p.move_id);
      if (mid) paymentPartnerType.set(mid, p.partner_type);
    }
    const taxes = await this.client.searchReadAll<{ id: number; amount: number }>(
      "account.tax", [["active", "in", [true, false]]], ["id", "amount"],
    );
    const taxRateById = new Map(taxes.map((t) => [t.id, t.amount]));

    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    let maxWrite: Date | null = null;
    for (const m of moves) {
      const w = odooTs(m.write_date);
      if (!maxWrite || w > maxWrite) maxWrite = w;
      const built = buildNativeFromOdoo(ctx, m, linesByMove.get(String(m.id)) ?? [], {
        paymentPartnerType,
        taxRateById,
      });
      if ("skip" in built) {
        unbuildable.push({ ref: String(m.id), reason: built.skip });
        continue;
      }
      documents.push(built);
    }

    // Applications: the FULL partial-reconcile graph (delta-safe reconciler).
    const partials = await this.client.searchReadAll<{
      id: number; debit_move_id: unknown; credit_move_id: unknown; amount: number;
    }>("account.partial.reconcile", [], ["id", "debit_move_id", "credit_move_id", "amount"]);
    const lineIds = new Set<number>();
    for (const p of partials) {
      const d = m2oId(p.debit_move_id), c = m2oId(p.credit_move_id);
      if (d) lineIds.add(Number(d));
      if (c) lineIds.add(Number(c));
    }
    const lineInfo = new Map<string, { moveId: string; accountRef: string }>();
    const idList = [...lineIds];
    for (let i = 0; i < idList.length; i += 500) {
      const rows = await this.client.executeKw<{ id: number; move_id: unknown; account_id: unknown }[]>(
        "account.move.line", "read", [idList.slice(i, i + 500)], { fields: ["move_id", "account_id"] },
      );
      for (const r of rows) {
        lineInfo.set(String(r.id), { moveId: m2oId(r.move_id)!, accountRef: m2oId(r.account_id)! });
      }
    }
    const applications: NativeChanges["applications"] = [];
    for (const p of partials) {
      const debit = lineInfo.get(m2oId(p.debit_move_id) ?? "");
      const credit = lineInfo.get(m2oId(p.credit_move_id) ?? "");
      if (!debit || !credit || !(p.amount > 0)) continue;
      const type = ctx.accountByRef.get(debit.accountRef)?.type;
      // Receivable: debit side = the invoice (open item), credit side settles it.
      // Payable: credit side = the bill (open item), debit side settles it.
      const [paymentRef, appliedRef] =
        type === "liability_payable" ? [debit.moveId, credit.moveId] : [credit.moveId, debit.moveId];
      applications.push({ paymentRef, appliedRef, amount: formatMoney(String(p.amount), 2) });
    }

    return {
      documents,
      applications,
      deletedRefs: [],
      syncedThrough: maxWrite ?? since ?? new Date(0),
      unbuildable,
    };
  }

  // --- verification -------------------------------------------------------------------

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const groups = await this.client.executeKw<{ account_id: unknown; balance: number }[]>(
      "account.move.line", "read_group",
      [[["parent_state", "=", "posted"]], ["balance:sum"], ["account_id"]],
      {},
    );
    return groups
      .filter((g) => m2oId(g.account_id))
      .map((g) => ({
        accountRef: m2oId(g.account_id)!,
        balance: fromUnits(toUnits(String(g.balance ?? 0))),
      }));
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    const rows = await this.client.searchReadAll<{ account_id: unknown; date: string; balance: number }>(
      "account.move.line", [["parent_state", "=", "posted"]], ["account_id", "date", "balance"],
    );
    const byBucket = new Map<string, bigint>();
    for (const r of rows) {
      const ref = m2oId(r.account_id);
      if (!ref) continue;
      const key = `${ref}|${String(r.date).slice(0, 7)}`;
      byBucket.set(key, (byBucket.get(key) ?? 0n) + toUnits(String(r.balance ?? 0)));
    }
    return [...byBucket.entries()].map(([key, amt]) => {
      const [accountRef, month] = key.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amt) };
    });
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const rows = await this.client.searchReadAll<{ id: number; amount_residual: number }>(
      "account.move",
      [["state", "=", "posted"], ["move_type", "in", ["out_invoice", "in_invoice", "out_refund", "in_refund"]]],
      ["id", "amount_residual"],
    );
    return rows.map((r) => ({ ref: String(r.id), unpaid: formatMoney(String(r.amount_residual ?? 0), 2) }));
  }
}
