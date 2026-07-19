import { suiteql, type NetSuiteCreds } from "../netsuite.ts";
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

// NetSuite job entitystatus → openbooks projects.status enum.
const NS_PROJECT_STATUS: Record<string, string> = {
  "1": "closed", "2": "active", "3": "cancelled", "18": "substantially_complete",
  "19": "closed", "21": "substantially_complete", "22": "active", "23": "awarded",
};
// NetSuite jobbillingtype → openbooks projects.billing_method enum.
const NS_BILLING: Record<string, string> = {
  TM: "time_and_materials", FBI: "fixed_price", FBM: "fixed_price",
};
// NetSuite standard contact-role internal ids → label.
const NS_CONTACT_ROLE: Record<string, string> = { "-10": "Primary" };
// The payment terms actually used here (SuiteQL can't read the `term` record).
const NS_TERM_LABELS: Record<string, string> = {
  "2": "Net 30", "3": "Net 60", "4": "Due on receipt", "7": "Net 15",
  "8": "2%/10, Net 30", "9": "1%/10, Net 30", "10": "Net 7", "11": "Net 45",
  "12": "Net 30th Following", "13": "Net 90", "14": "Net 25", "15": "1.5%/10, Net 30",
  "16": "1%/15, Net 30", "17": "Net 10th Following", "18": "Net 15th Following",
  "19": "Net 20th Following", "20": "Net 5", "21": "Net 10", "22": "0.5%/10, Net 30",
  "23": "2%/15, Net 30", "24": "Net 30th Following", "25": "Net 1st Following",
  "26": "Net 30, 1st Following", "27": "Net 5th Following",
};

const isT = (v: unknown) => v === "T" || v === true;
const s = (v: unknown): string | null => {
  const t = (v == null ? "" : String(v)).trim();
  return t === "" ? null : t;
};
/** Parse a NetSuite numeric field; null for blank or zero (nothing to carry). */
const num = (v: unknown): number | null => {
  const t = s(v);
  if (!t) return null;
  const n = Number(t.replace(/[$,]/g, ""));
  return Number.isFinite(n) && n !== 0 ? n : null;
};
/** MM/DD/YYYY → ISO YYYY-MM-DD (NetSuite date columns come back US-formatted). */
const isoDate = (v: unknown): string | null => {
  const t = s(v);
  if (!t) return null;
  const [m, d, y] = t.split("/");
  return m && d && y ? `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}` : t;
};
const parseTerm = (label: string) => {
  const netM = label.match(/Net\s+(\d+)/i);
  const disc = label.match(/([\d.]+)%\/(\d+)/);
  return {
    netDays: /due on receipt/i.test(label) ? 0 : netM ? Number(netM[1]) : 30,
    discountPercent: disc ? disc[1] : null,
    discountDays: disc ? Number(disc[2]) : null,
  };
};
const HEADER_COLS = `t.id, t.type AS ttype, t.tranid, TO_CHAR(t.trandate, 'MM/DD/YYYY') AS trandate,
  TO_CHAR(t.duedate, 'MM/DD/YYYY') AS duedate, t.entity, t.currency, t.memo, t.status,
  t.otherrefnum, t.posting`;
const LINE_COLS = `tl.transaction, tl.id, tl.mainline, tl.taxline, tl.item, tl.account,
  tl.expenseaccount, tl.netamount, tl.foreignamount, tl.department, tl.entity, tl.subsidiary,
  tl.memo, tl.taxrate1`;

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
  private readonly creds: NetSuiteCreds;

  constructor(creds: NetSuiteCreds, opts: { baseCurrency?: string } = {}) {
    this.creds = creds;
    this.baseCurrency = opts.baseCurrency ?? "CAD";
  }

  private q<T = Record<string, unknown>>(query: string): Promise<T[]> {
    return suiteql<T>(query, this.creds);
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const rows = await this.q<{ n: string }>("SELECT COUNT(*) AS n FROM account");
    return { ok: true, detail: `${rows[0]?.n ?? 0} accounts visible` };
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
      { resource: "payment_terms", records: this.paymentTerms() },
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
    const rows = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, companyname, isinactive, entitystatus, jobbillingtype,
             customer, projectmanager, custentityproject_foreman AS foreman,
             custentityproject_po_number AS ponumber,
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
        status: NS_PROJECT_STATUS[String(j.entitystatus)] ?? "active",
        billingMethod: NS_BILLING[String(j.jobbillingtype)] ?? null,
        // NetSuite `jobprice` — the fixed-bid contract price. T&M/cost-billed
        // jobs price from billable work, so 0/blank stays unset.
        contractValue: num(priceByRef.get(String(j.id))),
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
    const rows = await this.qSince<{ id: string; itemid?: string; displayname?: string; itemtype: string; isinactive?: string; category?: string }>(
      "SELECT id, itemid, displayname, itemtype, isinactive, BUILTIN.DF(custitem_category) AS category FROM item",
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
          isActive: !isT(i.isinactive),
        },
      });
    }
    return out;
  }

  private paymentTerms(): SourceEntity[] {
    return Object.entries(NS_TERM_LABELS).map(([id, label]) => {
      const p = parseTerm(label);
      return {
        sourceRef: id,
        naturalKey: label,
        fields: { name: label, netDays: p.netDays, discountDays: p.discountDays, discountPercent: p.discountPercent },
      };
    });
  }

  private async timeTypes(): Promise<SourceEntity[]> {
    const rows = await this.q<{ id: string; name?: string; multiplier?: string; isinactive?: string }>(
      "SELECT id, name, custrecord_bit_cost_multiplier AS multiplier, isinactive FROM customrecord_bit_time_type",
    );
    return rows.map((t) => ({
      sourceRef: String(t.id),
      fields: { name: s(t.name) ?? `Time type ${t.id}`, costMultiplier: s(t.multiplier) ?? "1", isActive: !isT(t.isinactive) },
    }));
  }

  private async parties(since?: Date | null): Promise<SourceEntity[]> {
    const customers = await this.qSince<Record<string, string>>(`
      SELECT id, entityid, companyname, altname, isperson, isinactive, email, phone,
             url, terms, creditlimit, salesrep, taxitem, receivablesaccount, subsidiary,
             custentitycustomer_shortform AS shortform
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
             custentityemployee_has_benefits AS benefits, initials
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
      SELECT id, company, contactrole, email, phone, officephone, mobilephone,
             title, entityid, firstname, lastname, fax, isinactive
        FROM contact`, since);
    return rows.map((c) => ({
      sourceRef: String(c.id),
      fields: {
        companyRef: s(c.company),
        name: s(c.entityid) ?? ([s(c.firstname), s(c.lastname)].filter(Boolean).join(" ") || "Contact"),
        firstName: s(c.firstname), lastName: s(c.lastname), title: s(c.title),
        role: c.contactrole ? NS_CONTACT_ROLE[String(c.contactrole)] ?? null : null,
        email: s(c.email), phone: s(c.phone) ?? s(c.officephone), mobilePhone: s(c.mobilephone),
        fax: s(c.fax), isPrimary: String(c.contactrole) === "-10", isActive: !isT(c.isinactive),
      },
    }));
  }

  private async timeEntries(since: Date | null): Promise<SourceEntity[]> {
    const where = since
      ? `WHERE tb.lastmodifieddate >= TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`
      : "";
    const rows = await this.q<Record<string, string>>(`
      SELECT tb.id, tb.employee, tb.customer, tb.department, tb.item, tb.hours,
             tb.rate, tb.laborcost, tb.isbillable,
             tb.custcol_bit_cost_multiplier AS timetype,
             TO_CHAR(tb.trandate, 'MM/DD/YYYY') AS trandate
        FROM timebill tb ${where}`);
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

  // --- native transactions -------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    // High-water mark from NetSuite's clock, not ours.
    const nowRows = await this.q<{ now: string }>(
      "SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL",
    );
    const syncedThrough = new Date(nowRows[0]!.now.replace(" ", "T") + "Z");

    // Headers: changed-since (incremental) or full id-window sweep. A COUNT
    // first gives a real total so the UI shows "pulling X of Y transactions".
    const [{ n: totalStr }] = await this.q<{ n: string }>(
      since
        ? `SELECT COUNT(*) AS n FROM transaction t WHERE t.lastmodifieddate >= TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`
        : "SELECT COUNT(*) AS n FROM transaction t",
    );
    const totalTxns = Number(totalStr ?? 0);
    const headers: NsHeader[] = [];
    if (since) {
      const clause = `t.lastmodifieddate >= TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`;
      headers.push(...(await this.q<NsHeader>(`SELECT ${HEADER_COLS} FROM transaction t WHERE ${clause}`)));
      ctx.onProgress?.({ phase: "pull", message: "Pulling transactions…", current: headers.length, total: totalTxns });
    } else {
      const [{ m }] = await this.q<{ m: string }>("SELECT MAX(t.id) AS m FROM transaction t");
      const maxId = Number(m ?? 0);
      const W = 5000;
      for (let lo = 0; lo <= maxId; lo += W) {
        headers.push(
          ...(await this.q<NsHeader>(
            `SELECT ${HEADER_COLS} FROM transaction t WHERE t.id > ${lo} AND t.id <= ${lo + W}`,
          )),
        );
        ctx.onProgress?.({ phase: "pull", message: "Pulling transactions…", current: headers.length, total: totalTxns });
      }
    }

    // Lines for exactly those transactions (chunked IN lists).
    const linesByTxn = new Map<string, NsLine[]>();
    const tids = headers.map((h) => String(h.id));
    for (let i = 0; i < tids.length; i += 150) {
      const chunk = tids.slice(i, i + 150);
      if (chunk.length === 0) continue;
      ctx.onProgress?.({ phase: "pull", message: "Pulling transaction lines…", current: Math.min(i + 150, tids.length), total: tids.length });
      const rows = await this.q<NsLine>(
        `SELECT ${LINE_COLS} FROM transactionline tl WHERE tl.transaction IN (${chunk.join(",")})`,
      );
      for (const l of rows) {
        const key = String(l.transaction);
        const arr = linesByTxn.get(key);
        if (arr) arr.push(l);
        else linesByTxn.set(key, [l]);
      }
    }
    for (const arr of linesByTxn.values()) arr.sort((a, b) => Number(a.id) - Number(b.id));

    // Build native documents.
    const documents: NativeDocument[] = [];
    const unbuildable: { ref: string; reason: string }[] = [];
    for (const h of headers) {
      const raw = linesByTxn.get(String(h.id));
      if (!raw || raw.length === 0) continue;
      const built = buildNativeFromNetSuite(ctx, { ...h, id: String(h.id) }, raw);
      if ("skip" in built) {
        // Silent for genuinely non-posting rows; everything else is diagnostic.
        if (h.posting === "T") unbuildable.push({ ref: String(h.id), reason: built.skip });
        else if (built.skip.startsWith("order")) unbuildable.push({ ref: String(h.id), reason: built.skip });
        continue;
      }
      documents.push(built.doc);
    }

    // The application graph. A full sweep pulls the whole universe (~19 pages);
    // an incremental mirror pulls only links whose PAYING document is in this
    // pull's changed set — applying, editing, or unapplying an application
    // always bumps the payment/credit's lastmodifieddate, so every new or
    // changed link has its nextdoc here. Filtering on nextdoc alone keeps the
    // chunks disjoint (no duplicate rows to double-count), and the reconciler
    // is delta-safe/insert-only so a narrower pull never disturbs existing
    // applications.
    type Link = { previousdoc: string; nextdoc: string; foreignamount: string };
    const links: Link[] = [];
    if (since) {
      for (let i = 0; i < tids.length; i += 150) {
        const chunk = tids.slice(i, i + 150);
        if (chunk.length === 0) continue;
        links.push(...(await this.q<Link>(
          `SELECT previousdoc, nextdoc, foreignamount FROM nexttransactionlinelink WHERE linktype = 'Payment' AND nextdoc IN (${chunk.join(",")})`,
        )));
      }
    } else {
      links.push(...(await this.q<Link>(
        "SELECT previousdoc, nextdoc, foreignamount FROM nexttransactionlinelink WHERE linktype = 'Payment'",
      )));
    }
    const applications = links
      .filter((l) => l.foreignamount != null && Number(l.foreignamount) > 0)
      .map((l) => ({
        paymentRef: String(l.nextdoc),
        appliedRef: String(l.previousdoc),
        amount: String(l.foreignamount),
      }));

    // The deletedrecord feed is now role-visible; on a FULL sweep the reconciler
    // already derives deletions from refs that vanished from the pulled universe
    // (see runSync step 5), so we leave deletedRefs empty here rather than
    // mapping the account-wide deletedrecord table (all record types) per pull.
    return { documents, applications, deletedRefs: [], syncedThrough, unbuildable };
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
       WHERE type IN ('CustInvc', 'VendBill', 'VendCred', 'ExpRept') AND posting = 'T'`);
    return rows.map((r) => ({ ref: String(r.id), unpaid: String(r.unpaid ?? "0") }));
  }
}
