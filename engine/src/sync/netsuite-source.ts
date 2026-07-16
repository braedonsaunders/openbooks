import { suiteql, type NetSuiteCreds } from "../netsuite.ts";
import { fromUnits, toUnits } from "../money.ts";
import { buildNativeFromNetSuite, type NsHeader, type NsLine } from "./netsuite-native.ts";
import type { NativeContext, NativeDocument } from "./native.ts";
import type {
  EntityStream,
  MigrationSource,
  NativeChanges,
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
 * KNOWN ROLE LIMITATION (surfaced by the live probes, must be fixed in
 * NetSuite by granting the integration role the permissions): CustPymt,
 * Deposit and deletedrecord are invisible to the current token's role — their
 * GL and headers are filtered out server-side. Everything this adapter reads
 * is the role-visible view; once the role can see them, they import natively
 * with zero code change (TTYPE_KIND already classifies them).
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

const isT = (v: unknown) => v === "T" || v === true;
const HEADER_COLS = `t.id, t.type AS ttype, t.tranid, TO_CHAR(t.trandate, 'MM/DD/YYYY') AS trandate,
  TO_CHAR(t.duedate, 'MM/DD/YYYY') AS duedate, t.entity, t.currency, t.memo, t.status,
  t.otherrefnum, t.posting`;
const LINE_COLS = `tl.transaction, tl.id, tl.mainline, tl.taxline, tl.item, tl.account,
  tl.expenseaccount, tl.netamount, tl.foreignamount, tl.department, tl.entity, tl.memo, tl.taxrate1`;

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

  // --- master data ------------------------------------------------------------

  async entities(): Promise<EntityStream[]> {
    return [
      { resource: "accounts", records: await this.accounts() },
      { resource: "departments", records: await this.departments() },
      { resource: "projects", records: await this.projects() },
      { resource: "parties", records: await this.parties() },
      { resource: "items", records: await this.items() },
    ];
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

  private async projects(): Promise<SourceEntity[]> {
    const rows = await this.q<{ id: string; companyname?: string; entityid?: string }>(
      "SELECT id, companyname, entityid FROM job",
    );
    return rows.map((j) => ({
      sourceRef: String(j.id),
      fields: { name: String(j.companyname ?? j.entityid ?? `Job ${j.id}`).slice(0, 500) },
    }));
  }

  private async items(): Promise<SourceEntity[]> {
    const rows = await this.q<{ id: string; itemid?: string; displayname?: string; itemtype: string; isinactive?: string }>(
      "SELECT id, itemid, displayname, itemtype, isinactive FROM item",
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
          isActive: !isT(i.isinactive),
        },
      });
    }
    return out;
  }

  private async parties(): Promise<SourceEntity[]> {
    const [customers, vendors, employees] = [
      await this.q<{ id: string; entityid?: string; companyname?: string; altname?: string; isinactive?: string }>(
        "SELECT id, entityid, companyname, altname, isinactive FROM customer",
      ),
      await this.q<{ id: string; entityid?: string; companyname?: string; altname?: string; isinactive?: string }>(
        "SELECT id, entityid, companyname, altname, isinactive FROM vendor",
      ),
      await this.q<{ id: string; entityid?: string; firstname?: string; lastname?: string; isinactive?: string }>(
        "SELECT id, entityid, firstname, lastname, isinactive FROM employee",
      ),
    ];
    const company = (r: { id: string; entityid?: string; companyname?: string; altname?: string; isinactive?: string }): SourceEntity => ({
      sourceRef: String(r.id),
      fields: {
        displayName: String(r.altname ?? r.companyname ?? r.entityid ?? `Party ${r.id}`).slice(0, 500),
        kind: "company",
        isActive: !isT(r.isinactive),
      },
    });
    return [
      ...customers.map(company),
      ...vendors.map(company),
      ...employees.map((e) => ({
        sourceRef: String(e.id),
        fields: {
          displayName: String(
            e.entityid ?? [e.firstname, e.lastname].filter(Boolean).join(" ") ?? `Employee ${e.id}`,
          ).slice(0, 500),
          kind: "person",
          isActive: !isT(e.isinactive),
        },
      })),
    ];
  }

  // --- native transactions -------------------------------------------------------

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    // High-water mark from NetSuite's clock, not ours.
    const nowRows = await this.q<{ now: string }>(
      "SELECT TO_CHAR(SYSDATE, 'YYYY-MM-DD HH24:MI:SS') AS now FROM DUAL",
    );
    const syncedThrough = new Date(nowRows[0]!.now.replace(" ", "T") + "Z");

    // Headers: changed-since (incremental) or full id-window sweep.
    const headers: NsHeader[] = [];
    if (since) {
      const clause = `t.lastmodifieddate >= TO_DATE('${since.toISOString().slice(0, 19).replace("T", " ")}', 'YYYY-MM-DD HH24:MI:SS')`;
      headers.push(...(await this.q<NsHeader>(`SELECT ${HEADER_COLS} FROM transaction t WHERE ${clause}`)));
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
      }
    }

    // Lines for exactly those transactions (chunked IN lists).
    const linesByTxn = new Map<string, NsLine[]>();
    const tids = headers.map((h) => String(h.id));
    for (let i = 0; i < tids.length; i += 150) {
      const chunk = tids.slice(i, i + 150);
      if (chunk.length === 0) continue;
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

    // The FULL application graph (the reconciler is delta-safe; ~19 pages).
    const links = await this.q<{ previousdoc: string; nextdoc: string; foreignamount: string }>(
      "SELECT previousdoc, nextdoc, foreignamount FROM nexttransactionlinelink WHERE linktype = 'Payment'",
    );
    const applications = links
      .filter((l) => l.foreignamount != null && Number(l.foreignamount) > 0)
      .map((l) => ({
        paymentRef: String(l.nextdoc),
        appliedRef: String(l.previousdoc),
        amount: String(l.foreignamount),
      }));

    // deletedrecord is not visible to the current role — deletions unreported.
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

  async openItems(): Promise<SourceOpenItem[]> {
    const rows = await this.q<{ id: string; unpaid: string | null }>(`
      SELECT id, foreignamountunpaid AS unpaid FROM transaction
       WHERE type IN ('CustInvc', 'VendBill', 'VendCred', 'ExpRept') AND posting = 'T'`);
    return rows.map((r) => ({ ref: String(r.id), unpaid: String(r.unpaid ?? "0") }));
  }
}
