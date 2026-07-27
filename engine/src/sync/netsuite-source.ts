import { NetSuiteBridgeClient, type NetSuiteBridgeConfig } from "../netsuite-bridge.ts";
import type { NetSuiteCreds } from "../netsuite.ts";
import { fromUnits, toUnits } from "../money.ts";
import { buildNativeFromNetSuite, type NsHeader, type NsLine } from "./netsuite-native.ts";
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

/**
 * NetSuite adapter — NATIVE transactions from live SuiteQL. Headers + business
 * lines (`transaction` / `transactionline`) become insert-ready openbooks
 * documents via the proven builder; the application graph comes from
 * `nexttransactionlinelink` (linktype 'Payment'); verification reads the
 * posted GL (`transactionaccountingline`) and per-transaction unpaid balances.
 *
 * AR/DELETION VISIBILITY: the integration role now has the permissions for
 * CustPymt, Deposit and deletedrecord — all three are visible to SuiteQL, so
 * customer payments and deposits import natively (TTYPE_KIND classifies them)
 * and the deleted-record feed is available. Deletions remain report-only:
 * voiding an already-posted document is a deliberate act, never automatic.
 */

const NS_ACCOUNT_TYPE: Record<string, string> = {
  Bank: "asset_bank",
  AcctRec: "asset_receivable",
  OthCurrAsset: "asset_current_other",
  FixedAsset: "asset_fixed",
  OthAsset: "asset_other",
  AcctPay: "liability_payable",
  CredCard: "liability_card",
  OthCurrLiab: "liability_current_other",
  LongTermLiab: "liability_long_term",
  Equity: "equity",
  Income: "income",
  OthIncome: "income_other",
  COGS: "cogs",
  Expense: "expense",
  OthExpense: "expense_other",
  DeferExpense: "expense_deferred",
};

const NS_ITEM_KIND: Record<string, string> = {
  NonInvtPart: "non_inventory",
  Service: "service",
  OthCharge: "other_charge",
  Markup: "other_charge",
  Discount: "discount",
  InvtPart: "inventory",
  Assembly: "assembly",
  Kit: "kit",
};

// NetSuite jobbillingtype → openbooks projects.billing_method enum.
const NS_BILLING: Record<string, string> = {
  TM: "time_and_materials", FBI: "fixed_price", FBM: "fixed_price",
};
const NETSUITE_ID_WINDOW = 5_000;

/**
 * Use the clock of the column being bounded. Some accounts render SYSDATE in
 * the data-center timezone while transaction.lastmodifieddate is rendered in
 * the account timezone; mixing them can make fresh changes appear to be in the
 * future and silently exclude them from an incremental pull.
 */
export const NETSUITE_TRANSACTION_WATERMARK_QUERY =
  "SELECT TO_CHAR(MAX(lastmodifieddate), 'YYYY-MM-DD HH24:MI:SS') AS now FROM transaction";

export interface NetSuiteAccountMappings {
  projectForemanField?: string;
  /** Line field holding the rebill markup, if this account records one. */
  lineMarkupField?: string;
  projectPurchaseOrderField?: string;
  itemCategoryField?: string;
  customerShortCodeField?: string;
  employeeBenefitsField?: string;
  timeTypeRecord?: string;
  timeTypeMultiplierField?: string;
  timeEntryTypeField?: string;
  projectStatuses?: Record<string, "active" | "awarded" | "substantially_complete" | "closed" | "cancelled">;
}

/**
 * Complete NetSuite Fixed Assets Management snapshot.  Rows intentionally stay
 * lossless here: FAM is a locked SuiteApp with account-specific custom fields,
 * so the loader persists every source column in `fixed_assets.custom` while it
 * maps the stable accounting fields into the OpenBooks register.
 */
export interface NetSuiteFixedAssetSnapshot {
  extractedAt: string;
  sourceAccount: string;
  bridgeVersion: string;
  assets: Record<string, unknown>[];
  assetTypes: Record<string, unknown>[];
  depreciationHistory: Record<string, unknown>[];
  assetValues: Record<string, unknown>[];
  depreciationMethods: Record<string, unknown>[];
  alternateMethods: Record<string, unknown>[];
  alternateDepreciation: Record<string, unknown>[];
  alternateDefinitions: Record<string, unknown>[];
  assetLifetimes: Record<string, unknown>[];
}

const safeSuiteScriptId = (value: unknown, label: string): string | null => {
  const field = s(value);
  if (!field) return null;
  if (!/^[a-z][a-z0-9_]{0,119}$/i.test(field)) throw new Error(`${label} has an invalid script ID`);
  return field;
};

export function numericIdWindows(maxId: number, width = NETSUITE_ID_WINDOW): Array<[number, number]> {
  if (!Number.isSafeInteger(maxId) || maxId < 0) throw new Error("maxId must be a non-negative safe integer");
  if (!Number.isSafeInteger(width) || width < 1) throw new Error("window width must be a positive safe integer");
  const windows: Array<[number, number]> = [];
  for (let lo = 0; lo < maxId; lo += width) windows.push([lo, Math.min(lo + width, maxId)]);
  return windows;
}

/** NetSuite exposes foreignamountunpaid for invoices/bills but returns NULL for
 * credit memos. Credits are therefore proven from their mainline amount less
 * exact Payment links, in the same 4-decimal integer arithmetic as the ledger. */
export function netSuiteCreditOpenBalance(total: string, applied: string): string {
  const totalUnits = toUnits(total);
  const appliedUnits = toUnits(applied);
  const remaining = (totalUnits < 0n ? -totalUnits : totalUnits)
    - (appliedUnits < 0n ? -appliedUnits : appliedUnits);
  return fromUnits(remaining > 0n ? remaining : 0n);
}

/** Enforce NetSuite's transaction-line identity across governed export retries. */
export function uniqueNetSuiteTransactionLines(rows: NsLine[]): NsLine[] {
  const unique = new Map<string, { payload: string; row: NsLine }>();
  for (const row of rows) {
    const key = `${String(row.transaction)}:${String(row.id)}`;
    const payload = JSON.stringify([
      row.transaction, row.id, row.mainline, row.taxline, row.item ?? null,
      row.account ?? null, row.expenseaccount ?? null, row.netamount ?? null,
      row.foreignamount ?? null, row.department ?? null, row.entity ?? null,
      row.subsidiary ?? null, row.memo ?? null, row.taxrate1 ?? null,
      row.taxcode ?? null,
    ]);
    const prior = unique.get(key);
    if (prior) {
      if (prior.payload !== payload) {
        throw new Error(`NetSuite returned conflicting transaction line ${key}`);
      }
      continue;
    }
    unique.set(key, { payload, row });
  }
  return [...unique.values()].map(({ row }) => row);
}

export interface NsApplicationLink {
  previousdoc: string;
  previousline: string;
  nextdoc: string;
  nextline: string;
  foreignamount: string;
}

/** Enforce a stable application-link identity across governed export retries. */
export function uniqueNetSuiteApplicationLinks(rows: NsApplicationLink[]): NsApplicationLink[] {
  const unique = new Map<string, { amount: string; row: NsApplicationLink }>();
  for (const row of rows) {
    const key = `${row.previousdoc}:${row.previousline}:${row.nextdoc}:${row.nextline}`;
    const prior = unique.get(key);
    if (prior) {
      if (prior.amount !== String(row.foreignamount)) {
        throw new Error(`NetSuite returned conflicting application link ${key}`);
      }
      continue;
    }
    unique.set(key, { amount: String(row.foreignamount), row });
  }
  return [...unique.values()].map(({ row }) => row);
}

export function parseNetSuiteMappings(value: unknown): NetSuiteAccountMappings {
  if (value == null || value === "") return {};
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("NetSuite field mappings must be a JSON object");
  }
  const raw = parsed as Record<string, unknown>;
  const projectStatuses = raw.projectStatuses == null
    ? undefined
    : Object.fromEntries(Object.entries(raw.projectStatuses as Record<string, unknown>).map(([key, status]) => {
        const normalized = String(status);
        if (!["active", "awarded", "substantially_complete", "closed", "cancelled"].includes(normalized)) {
          throw new Error(`NetSuite project status mapping ${key} has invalid target ${normalized}`);
        }
        return [key.toLowerCase(), normalized];
      })) as NetSuiteAccountMappings["projectStatuses"];
  return {
    projectForemanField: safeSuiteScriptId(raw.projectForemanField, "projectForemanField") ?? undefined,
    lineMarkupField: safeSuiteScriptId(raw.lineMarkupField, "lineMarkupField") ?? undefined,
    projectPurchaseOrderField: safeSuiteScriptId(raw.projectPurchaseOrderField, "projectPurchaseOrderField") ?? undefined,
    itemCategoryField: safeSuiteScriptId(raw.itemCategoryField, "itemCategoryField") ?? undefined,
    customerShortCodeField: safeSuiteScriptId(raw.customerShortCodeField, "customerShortCodeField") ?? undefined,
    employeeBenefitsField: safeSuiteScriptId(raw.employeeBenefitsField, "employeeBenefitsField") ?? undefined,
    timeTypeRecord: safeSuiteScriptId(raw.timeTypeRecord, "timeTypeRecord") ?? undefined,
    timeTypeMultiplierField: safeSuiteScriptId(raw.timeTypeMultiplierField, "timeTypeMultiplierField") ?? undefined,
    timeEntryTypeField: safeSuiteScriptId(raw.timeEntryTypeField, "timeEntryTypeField") ?? undefined,
    projectStatuses,
  };
}

const isT = (v: unknown) => v === "T" || v === true;
const s = (v: unknown): string | null => {
  const t = (v == null ? "" : String(v)).trim();
  return t === "" ? null : t;
};
/** Parse a NetSuite money field without crossing the IEEE-754 boundary. */
const moneyValue = (v: unknown): string | null => {
  const t = s(v);
  if (!t) return null;
  const normalized = fromUnits(toUnits(t.replace(/[$,]/g, "")));
  return toUnits(normalized) === 0n ? null : normalized;
};
/** MM/DD/YYYY → ISO YYYY-MM-DD (NetSuite date columns come back US-formatted). */
const isoDate = (v: unknown): string | null => {
  const t = s(v);
  if (!t) return null;
  const [m, d, y] = t.split("/");
  return m && d && y ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : t;
};
const HEADER_COLS = `t.id, t.type AS ttype, t.tranid, TO_CHAR(t.trandate, 'MM/DD/YYYY') AS trandate,
  TO_CHAR(t.duedate, 'MM/DD/YYYY') AS duedate, t.entity, t.currency, t.memo, t.status,
  t.otherrefnum, t.posting`;
const LINE_COLS = `tl.transaction, tl.id, tl.mainline, tl.taxline, tl.item, tl.account,
  tl.expenseaccount, tl.netamount, tl.foreignamount, tl.department, tl.entity, tl.subsidiary,
  tl.memo, tl.taxrate1, tl.taxcode, tl.isbillable`;

/** Line columns plus whatever optional fields this account has mapped. */
function lineCols(mappings: NetSuiteAccountMappings): string {
  return mappings.lineMarkupField
    ? `${LINE_COLS}, ${mappings.lineMarkupField} AS markup`
    : LINE_COLS;
}

export function normalizeNetSuiteAccountingPeriods(
  rows: Record<string, string>[],
): SourceEntity[] {
  const years = rows
    .filter((row) => isT(row.isyear))
    .map((row) => ({
      start: isoDate(row.startdate)!,
      end: isoDate(row.enddate)!,
      year: Number(s(row.periodname)?.match(/\d{4}/)?.[0] ?? 0),
    }))
    .filter((row) => row.start && row.end && row.year > 0);
  const posting = rows
    .filter((row) => isT(row.isposting))
    .map((row) => ({ row, start: isoDate(row.startdate), end: isoDate(row.enddate) }))
    .filter((item): item is { row: Record<string, string>; start: string; end: string } =>
      Boolean(item.start && item.end),
    );
  const counters = new Map<number, number>();
  return posting.map(({ row, start, end }) => {
    const fiscalYear = years.find((year) => year.start <= start && year.end >= end)?.year
      ?? Number(end.slice(0, 4));
    const periodNumber = (counters.get(fiscalYear) ?? 0) + 1;
    counters.set(fiscalYear, periodNumber);
    return {
      sourceRef: String(row.id),
      fields: {
        name: s(row.periodname) ?? `${fiscalYear}-${periodNumber}`,
        fiscalYear,
        periodNumber,
        startsOn: start,
        endsOn: end,
        isAdjustment: isT(row.isadjust),
        closed: isT(row.closed),
        allLocked: isT(row.alllocked),
        apLocked: isT(row.aplocked),
        arLocked: isT(row.arlocked),
        closedAt: isoDate(row.closedondate),
      },
    };
  });
}

export class NetSuiteSource implements MigrationSource {
  readonly name = "netsuite";
  readonly refKey = "nsId";
  readonly baseCurrency: string;
  private readonly bridge: NetSuiteBridgeClient;
  private readonly expectedAccount: string;
  private readonly mappings: NetSuiteAccountMappings;

  constructor(
    creds: NetSuiteCreds,
    opts: { baseCurrency?: string; bridge?: NetSuiteBridgeConfig; mappings?: unknown } = {},
  ) {
    this.bridge = new NetSuiteBridgeClient(creds, opts.bridge);
    this.expectedAccount = creds.account;
    this.mappings = parseNetSuiteMappings(opts.mappings);
    this.baseCurrency = opts.baseCurrency ?? "CAD";
  }

  private q<T = Record<string, unknown>>(query: string): Promise<T[]> {
    return this.bridge.query<T>(query);
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const health = await this.bridge.health();
    if (String(health.accountId).replaceAll("_", "-").toLowerCase()
      !== this.expectedAccount.replaceAll("_", "-").toLowerCase()) {
      throw new Error(
        `NetSuite bridge account ${health.accountId} does not match configured account ${this.expectedAccount}`,
      );
    }
    const rows = await this.q<{ n: string }>("SELECT COUNT(*) AS n FROM account");
    return {
      ok: true,
      detail: `bridge ${health.bridgeVersion} · account ${health.accountId} · ${rows[0]?.n ?? 0} accounts visible`,
    };
  }

  /**
   * Pull only the FAM register through the already-deployed OpenBooks RESTlet.
   * This is deliberately separate from `entities()` so a fixed-assets refresh
   * never starts the high-volume transaction connector.
   */
  async fixedAssets(): Promise<NetSuiteFixedAssetSnapshot> {
    const [
      health,
      assets,
      assetTypes,
      depreciationHistory,
      assetValues,
      depreciationMethods,
      alternateMethods,
      alternateDepreciation,
      alternateDefinitions,
      assetLifetimes,
    ] = await Promise.all([
      this.bridge.health(),
      this.q(`SELECT a.*,
                     BUILTIN.DF(a.custrecord_assetstatus) AS fam_status_label,
                     BUILTIN.DF(a.custrecord_assetaccmethod) AS fam_method_label,
                     BUILTIN.DF(a.custrecord_assetconvention) AS fam_convention_label,
                     BUILTIN.DF(a.custrecord_assetdeprperiod) AS fam_period_label
                FROM customrecord_ncfar_asset a ORDER BY a.id`),
      this.q(`SELECT t.*,
                     BUILTIN.DF(t.custrecord_assettypeaccmethod) AS fam_method_label,
                     BUILTIN.DF(t.custrecord_assettypeconvention) AS fam_convention_label
                FROM customrecord_ncfar_assettype t ORDER BY t.id`),
      this.q(`SELECT h.*,
                     BUILTIN.DF(h.custrecord_deprhisttype) AS fam_history_type_label
                FROM customrecord_ncfar_deprhistory h ORDER BY h.id`),
      this.q("SELECT * FROM customrecord_fam_assetvalues ORDER BY id"),
      this.q("SELECT * FROM customrecord_ncfar_deprmethod ORDER BY id"),
      this.q("SELECT * FROM customrecord_ncfar_altmethods ORDER BY id"),
      this.q("SELECT * FROM customrecord_ncfar_altdepreciation ORDER BY id"),
      this.q("SELECT * FROM customrecord_ncfar_altdeprdef ORDER BY id"),
      this.q("SELECT * FROM customrecord_assetlifetimes ORDER BY id"),
    ]);
    return {
      extractedAt: health.serverTime,
      sourceAccount: health.accountId,
      bridgeVersion: health.bridgeVersion,
      assets,
      assetTypes,
      depreciationHistory,
      assetValues,
      depreciationMethods,
      alternateMethods,
      alternateDepreciation,
      alternateDefinitions,
      assetLifetimes,
    };
  }

  /** SuiteQL timestamp literal for a watermark. */
  private ts(since: Date): string {
    return `TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`;
  }

  /**
   * Incremental pull: run the query with a `lastmodifieddate >= since` filter
   * appended; if the account's SuiteQL rejects the filter (feature-gated
   * column), fall back to the unfiltered pull — a daily mirror must never
   * silently miss records, so the fallback is always the FULL stream.
   */
  private async qSince<T = Record<string, unknown>>(
    fullSql: string,
    since: Date | null | undefined,
    filteredSql?: string,
  ): Promise<T[]> {
    if (!since) return this.q<T>(fullSql);
    try {
      return await this.q<T>(filteredSql ?? `${fullSql} WHERE lastmodifieddate >= ${this.ts(since)}`);
    } catch {
      return this.q<T>(fullSql);
    }
  }

  // --- master data ------------------------------------------------------------

  async entities(since?: Date | null): Promise<EntityStream[]> {
    // Dependency order: a stream's foreign refs must be landable from earlier
    // streams (parties before projects/addresses/contacts; accounts/terms/depts
    // before party roles; timeTypes before time entries).
    //
    // The high-volume streams (items, parties, projects, addresses, contacts,
    // time entries) honor `since` so a daily mirror pulls only what changed —
    // the tiny structural streams (subsidiaries, accounts, departments, terms,
    // time types) always pull in full: they're a handful of rows and must never
    // go stale. A full migration (since=null) pulls everything.
    return [
      { resource: "subsidiaries", records: await this.subsidiaries() },
      { resource: "accounts", records: await this.accounts() },
      { resource: "departments", records: await this.departments() },
      { resource: "payment_terms", records: await this.paymentTerms() },
      { resource: "time_types", records: await this.timeTypes() },
      { resource: "items", records: await this.items(since) },
      { resource: "parties", records: await this.parties(since) },
      { resource: "projects", records: await this.projects(since) },
      { resource: "addresses", records: await this.addresses(since) },
      { resource: "contacts", records: await this.contacts(since) },
      { resource: "time_entries", records: await this.timeEntries(since ?? null) },
    ];
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    const rows = await this.q<Record<string, string>>(`
      SELECT id, periodname, startdate, enddate, isposting, isadjust,
             isyear, isquarter, closed, alllocked, aplocked, arlocked,
             closedondate, lastmodifieddate
        FROM accountingperiod
       ORDER BY startdate, enddate, id`);
    return normalizeNetSuiteAccountingPeriods(rows);
  }

  private async subsidiaries(): Promise<SourceEntity[]> {
    const rows = await this.q<Record<string, string>>(`
      SELECT id, name, legalname, parent, currency,
             BUILTIN.DF(currency) AS currencylabel,
             country, isinactive, iselimination
        FROM subsidiary`);
    const currencyById = new Map<string, string>();
    try {
      const currencies = await this.q<Record<string, string>>(
        "SELECT id, symbol, name FROM currency",
      );
      for (const currency of currencies) {
        const symbol = s(currency.symbol)?.toUpperCase();
        if (symbol && /^[A-Z]{3}$/.test(symbol)) currencyById.set(String(currency.id), symbol);
      }
    } catch {
      // Single-currency accounts do not expose the currency record to SuiteQL.
      // Their one root is unambiguously the connection's configured base.
    }
    const aliases: Record<string, string> = {
      CAN: "CAD", CDN: "CAD", "CANADIAN DOLLAR": "CAD",
      USA: "USD", "US DOLLAR": "USD", "U.S. DOLLAR": "USD",
    };
    return rows.map((row) => {
      const label = s(row.currencylabel)?.toUpperCase() ?? "";
      const detected = currencyById.get(String(row.currency))
        ?? aliases[label]
        ?? (/^[A-Z]{3}$/.test(label) ? label : null);
      const baseCurrency = detected ?? (!s(row.parent) ? this.baseCurrency : null);
      if (!baseCurrency) {
        throw new Error(
          `cannot resolve ISO currency for subsidiary ${row.name ?? row.id} (${row.currencylabel ?? row.currency})`,
        );
      }
      return {
        sourceRef: String(row.id),
        parentRef: s(row.parent),
        fields: {
          name: s(row.name) ?? `Subsidiary ${row.id}`,
          legalName: s(row.legalname),
          baseCurrency,
          country: s(row.country) ?? "US",
          isActive: !isT(row.isinactive),
          isElimination: isT(row.iselimination),
        },
      };
    });
  }

  private async accounts(): Promise<SourceEntity[]> {
    const rows = await this.q<{
      id: string; acctnumber?: string; fullname?: string; dispname?: string;
      accttype: string; parent?: string; issummary?: string; isinactive?: string;
      eliminate?: string; reconcile?: string;
    }>(`
      SELECT id, acctnumber, fullname, accountsearchdisplaynamecopy AS dispname,
             accttype, parent, issummary, isinactive, eliminate,
             reconcilewithmatching AS reconcile
        FROM account`);
    const out: SourceEntity[] = [];
    for (const a of rows) {
      const type = NS_ACCOUNT_TYPE[a.accttype];
      if (!type) continue;
      out.push({
        sourceRef: String(a.id),
        naturalKey: a.acctnumber || null,
        parentRef: a.parent ? String(a.parent) : null,
        fields: {
          number: a.acctnumber || null,
          name: a.dispname ?? a.fullname ?? `Account ${a.id}`,
          type,
          isSummary: isT(a.issummary),
          isActive: !isT(a.isinactive),
          eliminate: isT(a.eliminate),
          reconcilable: isT(a.reconcile),
        },
      });
    }
    return out;
  }

  private async departments(): Promise<SourceEntity[]> {
    const rows = await this.q<{ id: string; name?: string; fullname?: string }>(
      "SELECT id, name, fullname FROM department",
    );
    return rows.map((d) => ({
      sourceRef: String(d.id),
      fields: { name: d.name ?? d.fullname ?? `Dept ${d.id}` },
    }));
  }

  private async projects(since?: Date | null): Promise<SourceEntity[]> {
    const foreman = this.mappings.projectForemanField
      ? `${this.mappings.projectForemanField} AS foreman`
      : "NULL AS foreman";
    const purchaseOrder = this.mappings.projectPurchaseOrderField
      ? `${this.mappings.projectPurchaseOrderField} AS ponumber`
      : "NULL AS ponumber";
    const rows = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, companyname, isinactive, entitystatus, jobbillingtype,
             BUILTIN.DF(entitystatus) AS statuslabel,
             customer, projectmanager, ${foreman}, ${purchaseOrder},
             TO_CHAR(startdate, 'MM/DD/YYYY') AS startdate,
             TO_CHAR(scheduledenddate, 'MM/DD/YYYY') AS enddate
        FROM job`, since);
    // `jobprice` (fixed-bid contract price; the RESTlet reads the same field) is
    // feature-gated on some accounts, so fetch it in a separate guarded query —
    // a missing optional field degrades contractValue to null instead of
    // aborting the whole migration. (SuiteQL rejects `projectprice`.)
    const priceByRef = new Map<string, string>();
    try {
      for (const p of await this.qSince<{ id: string; jobprice?: string }>(
        "SELECT id, jobprice FROM job WHERE jobprice IS NOT NULL",
        since,
        since ? `SELECT id, jobprice FROM job WHERE jobprice IS NOT NULL AND lastmodifieddate >= ${this.ts(since)}` : undefined,
      )) {
        if (s(p.jobprice)) priceByRef.set(String(p.id), String(p.jobprice));
      }
    } catch {
      // jobprice not available in this account's feature set — leave unset.
    }
    return rows.map((j) => ({
      sourceRef: String(j.id),
      fields: {
        code: s(j.entityid),
        name: String(j.companyname ?? j.entityid ?? `Job ${j.id}`).slice(0, 500),
        isActive: !isT(j.isinactive),
        status: this.projectStatus(j),
        billingMethod: NS_BILLING[String(j.jobbillingtype)] ?? null,
        // NetSuite `jobprice` — the fixed-bid contract price. T&M/cost-billed
        // jobs price from billable work, so 0/blank stays unset.
        contractValue: moneyValue(priceByRef.get(String(j.id))),
        customerRef: s(j.customer),
        foremanRef: s(j.foreman),
        managerRef: s(j.projectmanager),
        customerPoNumber: s(j.ponumber),
        startsOn: isoDate(j.startdate),
        endsOn: isoDate(j.enddate),
      },
    }));
  }

  private async items(since?: Date | null): Promise<SourceEntity[]> {
    const category = this.mappings.itemCategoryField
      ? `BUILTIN.DF(${this.mappings.itemCategoryField}) AS category`
      : "NULL AS category";
    // NetSuite exposes the ordinary base selling price through `pricing`, not
    // the item row. Quantity = 1 is the simple item Price used when no
    // OpenBooks rate-book override applies. Keep item sync usable for roles or
    // accounts that cannot expose the pricing workbook.
    let pricingRows: { item: string; unitprice: string | null }[] = [];
    try {
      pricingRows = await this.q("SELECT item, unitprice FROM pricing WHERE quantity = 1");
    } catch {
      pricingRows = [];
    }
    const priceByItem = new Map(pricingRows.map((row) => [String(row.item), moneyValue(row.unitprice)]));
    const rows = await this.qSince<{
      id: string; itemid?: string; displayname?: string; itemtype: string; isinactive?: string; category?: string;
      cost?: string; averagecost?: string; lastpurchaseprice?: string; costestimate?: string; saleunit?: string;
    }>(
      `SELECT id, itemid, displayname, itemtype, isinactive, cost, averagecost,
              lastpurchaseprice, costestimate, BUILTIN.DF(saleunit) AS saleunit, ${category}
         FROM item`,
      since,
    );
    const out: SourceEntity[] = [];
    for (const i of rows) {
      const kind = NS_ITEM_KIND[i.itemtype];
      if (!kind) continue;
      out.push({
        sourceRef: String(i.id),
        naturalKey: i.itemid || null,
        fields: {
          code: i.itemid || `ns-${i.id}`,
          name: String(i.displayname ?? i.itemid ?? `Item ${i.id}`).slice(0, 500),
          kind,
          category: s(i.category),
          defaultCost: moneyValue(i.cost ?? i.averagecost ?? i.lastpurchaseprice ?? i.costestimate),
          defaultRate: priceByItem.get(String(i.id)) ?? null,
          unit: s(i.saleunit),
          isActive: !isT(i.isinactive),
        },
      });
    }
    return out;
  }

  private async paymentTerms(): Promise<SourceEntity[]> {
    return (await this.bridge.paymentTerms()).map((term) => ({
      sourceRef: term.id,
      naturalKey: term.name,
      fields: {
        name: term.name,
        netDays: term.netDays,
        discountDays: term.discountDays,
        discountPercent: term.discountPercent,
      },
    }));
  }

  private async timeTypes(): Promise<SourceEntity[]> {
    if (!this.mappings.timeTypeRecord) return [];
    const multiplier = this.mappings.timeTypeMultiplierField
      ? `${this.mappings.timeTypeMultiplierField} AS multiplier`
      : "NULL AS multiplier";
    const rows = await this.q<{ id: string; name?: string; multiplier?: string; isinactive?: string }>(
      `SELECT id, name, ${multiplier}, isinactive FROM ${this.mappings.timeTypeRecord}`,
    );
    return rows.map((t) => ({
      sourceRef: String(t.id),
      fields: { name: s(t.name) ?? `Time type ${t.id}`, costMultiplier: s(t.multiplier) ?? "1", isActive: !isT(t.isinactive) },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    const shortCode = this.mappings.customerShortCodeField
      ? `${this.mappings.customerShortCodeField} AS shortform`
      : "NULL AS shortform";
    const benefits = this.mappings.employeeBenefitsField
      ? `${this.mappings.employeeBenefitsField} AS benefits`
      : "NULL AS benefits";
    const customers = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, companyname, altname, isperson, isinactive, email, phone,
             url, terms, creditlimit, salesrep, taxitem, receivablesaccount, subsidiary,
             ${shortCode}
        FROM customer`, since);
    const vendors = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, companyname, altname, isperson, isinactive, email, phone,
             terms, legalname, taxidnum, is1099eligible, payablesaccount, expenseaccount, subsidiary
        FROM vendor`, since);
    const employees = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, firstname, lastname, isinactive, email, homephone,
             mobilephone, phone, department, supervisor,
             subsidiary,
             TO_CHAR(hiredate, 'MM/DD/YYYY') AS hiredate,
             TO_CHAR(releasedate, 'MM/DD/YYYY') AS releasedate,
             ${benefits}, initials
        FROM employee`, since);

    const out: SourceEntity[] = [];
    for (const c of customers) {
      out.push({
        sourceRef: String(c.id),
        fields: {
          displayName: String(c.companyname ?? c.altname ?? c.entityid ?? `Customer ${c.id}`).slice(0, 500),
          kind: isT(c.isperson) ? "person" : "company",
          isActive: !isT(c.isinactive),
          email: s(c.email), phone: s(c.phone), website: s(c.url), shortCode: s(c.shortform),
          subsidiaryRef: s(c.subsidiary),
          customerRole: {
            arAccountRef: s(c.receivablesaccount), termsRef: s(c.terms),
            creditLimit: s(c.creditlimit), salesRepRef: s(c.salesrep), taxCodeRef: s(c.taxitem),
          },
        },
      });
    }
    for (const v of vendors) {
      const taxIds: Record<string, string> = {};
      if (s(v.taxidnum)) taxIds.businessNumber = String(v.taxidnum).trim();
      out.push({
        sourceRef: String(v.id),
        fields: {
          displayName: String(v.companyname ?? v.altname ?? v.entityid ?? `Vendor ${v.id}`).slice(0, 500),
          kind: isT(v.isperson) ? "person" : "company",
          isActive: !isT(v.isinactive),
          email: s(v.email), phone: s(v.phone), legalName: s(v.legalname), taxIds,
          subsidiaryRef: s(v.subsidiary),
          vendorRole: {
            apAccountRef: s(v.payablesaccount), termsRef: s(v.terms),
            defaultExpenseAccountRef: s(v.expenseaccount), is1099OrT4a: isT(v.is1099eligible),
          },
        },
      });
    }
    for (const e of employees) {
      out.push({
        sourceRef: String(e.id),
        fields: {
          displayName: String(e.entityid ?? [e.firstname, e.lastname].filter(Boolean).join(" ") ?? `Employee ${e.id}`).slice(0, 500),
          kind: "person",
          isActive: !isT(e.isinactive),
          email: s(e.email), phone: s(e.mobilephone) ?? s(e.phone) ?? s(e.homephone),
          subsidiaryRef: s(e.subsidiary),
          employeeRole: {
            employeeNumber: s(e.initials), departmentRef: s(e.department), supervisorRef: s(e.supervisor),
            hiredOn: isoDate(e.hiredate), terminatedOn: isoDate(e.releasedate), hasBenefits: isT(e.benefits),
          },
        },
      });
    }
    return out;
  }

  private async addresses(since?: Date | null): Promise<SourceEntity[]> {
    const out: SourceEntity[] = [];
    for (const kind of ["customer", "vendor", "employee"] as const) {
      const label = kind === "vendor" ? "" : "ab.label,";
      const full = `
        SELECT ab.internalid AS abid, ab.entity, ab.defaultbilling, ab.defaultshipping, ${label}
               ea.addr1, ea.addr2, ea.addr3, ea.city, ea.state, ea.zip, ea.country
          FROM ${kind}addressbook ab
          JOIN ${kind}addressbookentityaddress ea ON ea.nkey = ab.addressbookaddress`;
      // Address books carry no timestamp of their own; editing one bumps the
      // parent record's lastmodifieddate, so filter through the parent.
      const rows = await this.qSince<Record<string, string>>(
        full,
        since,
        since ? `${full} WHERE ab.entity IN (SELECT id FROM ${kind} WHERE lastmodifieddate >= ${this.ts(since)})` : undefined,
      );
      for (const a of rows) {
        out.push({
          sourceRef: `${kind}:${a.abid}`,
          fields: {
            entityRef: s(a.entity),
            label: s(a.label), line1: s(a.addr1),
            line2: [s(a.addr2), s(a.addr3)].filter(Boolean).join(", ") || null,
            city: s(a.city), region: s(a.state), postalCode: s(a.zip), country: s(a.country),
            isDefaultBilling: isT(a.defaultbilling), isDefaultShipping: isT(a.defaultshipping),
          },
        });
      }
    }
    return out;
  }

  private async contacts(since?: Date | null): Promise<SourceEntity[]> {
    const rows = await this.qSince<Record<string, string>>(`
      SELECT id, company, contactrole, BUILTIN.DF(contactrole) AS contactrolelabel,
             email, phone, officephone, mobilephone,
             title, entityid, firstname, lastname, fax, isinactive
        FROM contact`, since);
    return rows.map((c) => ({
      sourceRef: String(c.id),
      fields: {
        companyRef: s(c.company),
        name: s(c.entityid) ?? ([s(c.firstname), s(c.lastname)].filter(Boolean).join(" ") || "Contact"),
        firstName: s(c.firstname), lastName: s(c.lastname), title: s(c.title),
        role: s(c.contactrolelabel),
        email: s(c.email), phone: s(c.phone) ?? s(c.officephone), mobilePhone: s(c.mobilephone),
        fax: s(c.fax), isPrimary: /primary/i.test(s(c.contactrolelabel) ?? ""), isActive: !isT(c.isinactive),
      },
    }));
  }

  private async timeEntries(since: Date | null): Promise<SourceEntity[]> {
    const changed = since ? `tb.lastmodifieddate >= ${this.ts(since)}` : null;
    const timeType = this.mappings.timeEntryTypeField
      ? `tb.${this.mappings.timeEntryTypeField} AS timetype`
      : "NULL AS timetype";
    const maxRows = await this.q<{ m?: string }>(`
      SELECT MAX(tb.id) AS m
        FROM timebill tb
       ${changed ? `WHERE ${changed}` : ""}`);
    const maxId = Number(maxRows[0]?.m ?? 0);
    const rows: Record<string, string>[] = [];
    // SuiteQL paged queries are capped account-wide. Time is commonly the
    // largest master-data stream, so keep every request bounded independently
    // of account size while preserving the incremental watermark.
    const partitions = numericIdWindows(maxId).map(([lo, hi], index) => {
      const conditions = [`tb.id > ${lo}`, `tb.id <= ${hi}`];
      if (changed) conditions.push(changed);
      return {
        id: `time-${String(index).padStart(4, "0")}`,
        sql: `
        SELECT tb.id, tb.employee, tb.customer, tb.department, tb.item, tb.hours,
               tb.rate, tb.laborcost, tb.isbillable,
               ${timeType},
               TO_CHAR(tb.trandate, 'MM/DD/YYYY') AS trandate
          FROM timebill tb
         WHERE ${conditions.join(" AND ")}
         ORDER BY tb.id`,
      };
    });
    if (since) {
      for (const partition of partitions) rows.push(...(await this.q<Record<string, string>>(partition.sql)));
    } else {
      const exported = await this.bridge.bulkQuery<Record<string, string>>(partitions);
      for (const partition of partitions) rows.push(...(exported.get(partition.id) ?? []));
    }
    return rows.map((tb) => ({
      sourceRef: String(tb.id),
      fields: {
        employeeRef: s(tb.employee), projectRef: s(tb.customer), itemRef: s(tb.item),
        departmentRef: s(tb.department), timeTypeRef: s(tb.timetype),
        workedOn: isoDate(tb.trandate), hours: s(tb.hours) ?? "0",
        costRate: s(tb.laborcost), billRate: s(tb.rate), isBillable: isT(tb.isbillable),
      },
    }));
  }

  private projectStatus(row: Record<string, string>): string {
    const id = String(row.entitystatus ?? "").toLowerCase();
    const label = String(row.statuslabel ?? "").trim().toLowerCase();
    const configured = this.mappings.projectStatuses?.[id] ?? this.mappings.projectStatuses?.[label];
    if (configured) return configured;
    if (/cancel/.test(label)) return "cancelled";
    if (/substantial/.test(label)) return "substantially_complete";
    if (/award|won/.test(label)) return "awarded";
    if (/close|complete|finish/.test(label)) return "closed";
    return "active";
  }

  // --- native transactions -------------------------------------------------------

  /** Source transaction ids whose posted GL touches the supplied FAM accounts. */
  async fixedAssetTransactionIds(accountRefs: string[]): Promise<string[]> {
    const refs = [...new Set(accountRefs)].filter((ref) => /^\d+$/.test(ref));
    if (!refs.length) return [];
    const rows = await this.q<{ id: string }>(`
      SELECT DISTINCT t.id
        FROM transaction t
        JOIN transactionaccountingline tal ON tal.transaction = t.id
       WHERE tal.posting = 'T' AND tal.account IN (${refs.join(",")})
       ORDER BY t.id`);
    return rows.map((row) => String(row.id));
  }

  /** Exact live GL balances for the supplied FAM accounts. */
  async fixedAssetAccountBalances(accountRefs: string[]): Promise<Map<string, string>> {
    const refs = [...new Set(accountRefs)].filter((ref) => /^\d+$/.test(ref));
    if (!refs.length) return new Map();
    const rows = await this.q<{ account: string; debit: string; credit: string }>(`
      SELECT tal.account,
             SUM(COALESCE(tal.debit, 0)) AS debit,
             SUM(COALESCE(tal.credit, 0)) AS credit
        FROM transactionaccountingline tal
       WHERE tal.posting = 'T' AND tal.account IN (${refs.join(",")})
       GROUP BY tal.account`);
    return new Map(rows.map((row) => [
      String(row.account),
      fromUnits(toUnits(row.debit ?? "0") - toUnits(row.credit ?? "0")),
    ]));
  }

  /**
   * Build native documents for an explicit id set.  Used by focused module
   * mirrors (FAM here) so they reuse the normal NetSuite builder without
   * enumerating the account's entire transaction universe.
   */
  async nativeTransactionsByIds(transactionIds: string[], ctx: NativeContext): Promise<NativeChanges> {
    const ids = [...new Set(transactionIds)];
    if (ids.some((id) => !/^\d+$/.test(id))) throw new Error("NetSuite transaction ids must be numeric");
    const nowRows = await this.q<{ now: string }>(NETSUITE_TRANSACTION_WATERMARK_QUERY);
    if (!nowRows[0]?.now) throw new Error("NetSuite has no transaction watermark");
    const syncedThrough = new Date(nowRows[0]!.now.replace(" ", "T") + "Z");
    if (!ids.length) return { documents: [], applications: [], deletedRefs: [], syncedThrough, unbuildable: [], nonLedgerRefs: [] };

    const headers: NsHeader[] = [];
    const linesByTxn = new Map<string, NsLine[]>();
    for (let index = 0; index < ids.length; index += 150) {
      const chunk = ids.slice(index, index + 150);
      headers.push(...await this.q<NsHeader>(
        `SELECT ${HEADER_COLS} FROM transaction t WHERE t.id IN (${chunk.join(",")}) ORDER BY t.id`,
      ));
      for (const line of await this.q<NsLine>(
        `SELECT ${lineCols(this.mappings)} FROM transactionline tl WHERE tl.transaction IN (${chunk.join(",")}) ORDER BY tl.transaction, tl.id`,
      )) {
        const key = String(line.transaction);
        linesByTxn.set(key, [...(linesByTxn.get(key) ?? []), line]);
      }
    }
    for (const [transactionId, rows] of linesByTxn) {
      linesByTxn.set(transactionId, uniqueNetSuiteTransactionLines(rows).sort((a, b) => Number(a.id) - Number(b.id)));
    }
    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    const nonLedgerRefs: string[] = [];
    for (const header of headers) {
      const raw = linesByTxn.get(String(header.id));
      if (!raw?.length) continue;
      const built = buildNativeFromNetSuite(ctx, { ...header, id: String(header.id) }, raw);
      if ("skip" in built) {
        if (built.skip.startsWith("non-ledger source transaction")) nonLedgerRefs.push(String(header.id));
        else unbuildable.push({ ref: String(header.id), reason: built.skip });
      } else {
        documents.push(built.doc);
      }
    }
    return { documents, applications: [], deletedRefs: [], syncedThrough, unbuildable, nonLedgerRefs };
  }

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    // High-water mark from NetSuite's clock, not ours.
    const nowRows = await this.q<{ now: string }>(NETSUITE_TRANSACTION_WATERMARK_QUERY);
    if (!nowRows[0]?.now) throw new Error("NetSuite has no transaction watermark");
    const syncedThrough = new Date(nowRows[0]!.now.replace(" ", "T") + "Z");
    const effectiveSince = since ? new Date(since.getTime() - 15 * 60 * 1000) : null;

    // Headers: changed-since (incremental) or full id-window sweep. A COUNT
    // first gives a real total so the UI shows "pulling X of Y transactions".
    const [{ n: totalStr }] = await this.q<{ n: string }>(
      effectiveSince
        ? `SELECT COUNT(*) AS n FROM transaction t WHERE t.lastmodifieddate >= ${this.ts(effectiveSince)} AND t.lastmodifieddate <= ${this.ts(syncedThrough)}`
        : "SELECT COUNT(*) AS n FROM transaction t",
    );
    const totalTxns = Number(totalStr ?? 0);
    const headers: NsHeader[] = [];
    let fullWindows: Array<[number, number]> = [];
    if (effectiveSince) {
      const clause = `t.lastmodifieddate >= ${this.ts(effectiveSince)} AND t.lastmodifieddate <= ${this.ts(syncedThrough)}`;
      headers.push(...(await this.q<NsHeader>(`SELECT ${HEADER_COLS} FROM transaction t WHERE ${clause} ORDER BY t.id`)));
      ctx.onProgress?.({ phase: "pull", message: "Pulling transactions…", current: headers.length, total: totalTxns });
    } else {
      const [{ m }] = await this.q<{ m: string }>("SELECT MAX(t.id) AS m FROM transaction t");
      const maxId = Number(m ?? 0);
      fullWindows = numericIdWindows(maxId);
      const partitions = fullWindows.map(([lo, hi], index) => ({
        id: `header-${String(index).padStart(4, "0")}`,
        sql: `SELECT ${HEADER_COLS} FROM transaction t WHERE t.id > ${lo} AND t.id <= ${hi} ORDER BY t.id`,
      }));
      const exported = await this.bridge.bulkQuery<NsHeader>(partitions);
      for (const partition of partitions) {
        headers.push(...(exported.get(partition.id) ?? []));
        ctx.onProgress?.({ phase: "pull", message: "Pulling transactions…", current: headers.length, total: totalTxns });
      }
    }

    // Lines for exactly those transactions (chunked IN lists).
    const linesByTxn = new Map<string, NsLine[]>();
    const tids = headers.map((h) => String(h.id));
    const collectLines = (rows: NsLine[]) => {
      for (const l of rows) {
        const key = String(l.transaction);
        const arr = linesByTxn.get(key);
        if (arr) arr.push(l);
        else linesByTxn.set(key, [l]);
      }
    };
    if (effectiveSince) {
      for (let i = 0; i < tids.length; i += 150) {
        const chunk = tids.slice(i, i + 150);
        if (chunk.length === 0) continue;
        ctx.onProgress?.({ phase: "pull", message: "Pulling transaction lines…", current: Math.min(i + 150, tids.length), total: tids.length });
        collectLines(await this.q<NsLine>(
          `SELECT ${lineCols(this.mappings)} FROM transactionline tl WHERE tl.transaction IN (${chunk.join(",")}) ORDER BY tl.transaction, tl.id`,
        ));
      }
    } else {
      const occupiedWindows = new Set(headers.map((header) => Math.floor((Number(header.id) - 1) / NETSUITE_ID_WINDOW)));
      const windowsWithHeaders = fullWindows.filter((_, index) => occupiedWindows.has(index));
      const partitions = windowsWithHeaders.map(([lo, hi], index) => ({
        id: `line-${String(index).padStart(4, "0")}`,
        sql: `SELECT ${lineCols(this.mappings)} FROM transactionline tl WHERE tl.transaction > ${lo} AND tl.transaction <= ${hi} ORDER BY tl.transaction, tl.id`,
      }));
      const exported = await this.bridge.bulkQuery<NsLine>(partitions);
      let windowsRead = 0;
      for (const partition of partitions) {
        collectLines(exported.get(partition.id) ?? []);
        windowsRead += 1;
        ctx.onProgress?.({
          phase: "pull",
          message: "Pulling transaction lines…",
          current: Math.round((windowsRead / Math.max(1, partitions.length)) * tids.length),
          total: tids.length,
        });
      }
    }
    for (const [transactionId, rows] of linesByTxn) {
      linesByTxn.set(
        transactionId,
        uniqueNetSuiteTransactionLines(rows).sort((a, b) => Number(a.id) - Number(b.id)),
      );
    }

    // Build native documents.
    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    const nonLedgerRefs: string[] = [];
    for (const h of headers) {
      const raw = linesByTxn.get(String(h.id));
      if (!raw || raw.length === 0) continue;
      const built = buildNativeFromNetSuite(ctx, { ...h, id: String(h.id) }, raw);
      if ("skip" in built) {
        if (built.skip.startsWith("non-ledger source transaction")) {
          nonLedgerRefs.push(String(h.id));
          continue;
        }
        // Silent for genuinely non-posting rows; everything else is diagnostic.
        if (h.posting === "T") unbuildable.push({ ref: String(h.id), reason: built.skip });
        else if (built.skip.startsWith("order")) unbuildable.push({ ref: String(h.id), reason: built.skip });
        continue;
      }
      documents.push(built.doc);
    }

    // The application graph. A full sweep pulls the whole universe (~19 pages);
    // an incremental mirror pulls links touched by THIS pull's changed set on
    // EITHER side. NetSuite does not guarantee which side's lastmodifieddate a
    // link change bumps: applying a journal to an invoice bumps the INVOICE
    // while the paying journal keeps its old timestamp, so filtering on the
    // paying side (nextdoc) alone silently misses settlements whose payer
    // didn't change — the open item then stays open here while the source
    // shows it settled, and the open-item gate fails deterministically.
    // Duplicate rows from links whose both sides changed collapse in
    // uniqueNetSuiteApplicationLinks, and the reconciler is delta-safe/
    // insert-only so a wider pull never disturbs existing applications.
    const links: NsApplicationLink[] = [];
    if (effectiveSince) {
      for (let i = 0; i < tids.length; i += 150) {
        const chunk = tids.slice(i, i + 150);
        if (chunk.length === 0) continue;
        links.push(...(await this.q<NsApplicationLink>(
          `SELECT previousdoc, previousline, nextdoc, nextline, foreignamount FROM nexttransactionlinelink WHERE linktype = 'Payment' AND (nextdoc IN (${chunk.join(",")}) OR previousdoc IN (${chunk.join(",")})) ORDER BY previousdoc, previousline, nextdoc, nextline`,
        )));
      }
    } else {
      const partition = {
        id: "applications",
        sql: "SELECT previousdoc, previousline, nextdoc, nextline, foreignamount FROM nexttransactionlinelink WHERE linktype = 'Payment' ORDER BY previousdoc, previousline, nextdoc, nextline",
      };
      const exported = await this.bridge.bulkQuery<NsApplicationLink>([partition]);
      links.push(...(exported.get(partition.id) ?? []));
    }
    const applications = uniqueNetSuiteApplicationLinks(links)
      .filter((l) => l.foreignamount != null && toUnits(l.foreignamount) > 0n)
      .map((l) => ({
        paymentRef: String(l.nextdoc),
        appliedRef: String(l.previousdoc),
        amount: String(l.foreignamount),
      }));

    // Pull deletion tombstones without attaching code to transaction saves.
    // The feed is account-wide, so retain only financially meaningful record
    // labels; a full sweep remains the authoritative fallback for custom types.
    const deletedRefs: string[] = [];
    if (effectiveSince) {
      const deleted = await this.bridge.deletedRecords(effectiveSince);
      const transactionLabel = /invoice|bill|payment|credit|journal|check|deposit|transfer|expense report|sales order|purchase order/i;
      for (const row of deleted) {
        if (row.internalId && transactionLabel.test(row.recordType)) deletedRefs.push(row.internalId);
      }
    }
    return {
      documents,
      applications,
      deletedRefs: [...new Set(deletedRefs)],
      syncedThrough,
      unbuildable,
      nonLedgerRefs,
    };
  }

  // --- verification -----------------------------------------------------------------

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const rows = await this.q<{ acct?: string; d: string; c: string }>(`
      SELECT tal.account AS acct, SUM(COALESCE(tal.debit, 0)) AS d, SUM(COALESCE(tal.credit, 0)) AS c
        FROM transactionaccountingline tal
       WHERE tal.posting = 'T'
       GROUP BY tal.account`);
    return rows
      .filter((r) => r.acct)
      .map((r) => ({ accountRef: String(r.acct), balance: fromUnits(toUnits(r.d) - toUnits(r.c)) }));
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    const rows = await this.q<{ acct?: string; m: string; d: string; c: string }>(`
      SELECT tal.account AS acct, TO_CHAR(t.trandate, 'YYYY-MM') AS m,
             SUM(COALESCE(tal.debit, 0)) AS d, SUM(COALESCE(tal.credit, 0)) AS c
        FROM transactionaccountingline tal
        JOIN transaction t ON t.id = tal.transaction
       WHERE tal.posting = 'T'
       GROUP BY tal.account, TO_CHAR(t.trandate, 'YYYY-MM')`);
    return rows
      .filter((r) => r.acct)
      .map((r) => ({
        accountRef: String(r.acct),
        month: r.m,
        amount: fromUnits(toUnits(r.d ?? "0") - toUnits(r.c ?? "0")),
      }));
  }

  async openItems(): Promise<SourceOpenItem[]> {
    const rows = await this.q<{ id: string; unpaid: string | null }>(`
      SELECT id, foreignamountunpaid AS unpaid FROM transaction
       WHERE type IN ('CustInvc', 'VendBill', 'ExpRept') AND posting = 'T'`);
    const credits = await this.q<{ id: string; total: string; applied: string }>(`
      SELECT t.id,
             MAX(ABS(COALESCE(tl.foreignamount, tl.netamount, 0))) AS total,
             COALESCE(SUM(ABS(COALESCE(n.foreignamount, 0))), 0) AS applied
        FROM transaction t
        JOIN transactionline tl ON tl.transaction = t.id AND tl.mainline = 'T'
        LEFT JOIN nexttransactionlinelink n
          ON n.nextdoc = t.id AND n.linktype = 'Payment'
       WHERE t.type IN ('VendCred', 'CustCred') AND t.posting = 'T'
       GROUP BY t.id`);
    return [
      ...rows.map((r) => ({ ref: String(r.id), unpaid: String(r.unpaid ?? "0") })),
      ...credits.map((r) => ({
        ref: String(r.id),
        unpaid: netSuiteCreditOpenBalance(String(r.total ?? "0"), String(r.applied ?? "0")),
      })),
    ];
  }
}
