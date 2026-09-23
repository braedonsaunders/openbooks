import { sql } from "drizzle-orm";
import { businessToday, parseIsoDate } from "../platform/business-date.ts";
import { db } from "../platform/db.ts";
import { fromUnits, toUnits } from "../money/money.ts";
import { latestWebConnectorHeartbeat, prepareCapture, releaseCapture, waitForCapture, type CaptureResponse } from "../qbd/bridge.ts";
import { nodes, parseQbdReportDate, parseReportRows, parseXml } from "../qbd/qbxml.ts";
import type { NativeContext } from "./native.ts";
import { allModules, fiscalYearsForRange, monthlySourcePeriods } from "./periods.ts";
import { buildQbdLedgerDocuments } from "./qbd-native.ts";
import type { EntityStream, MigrationSource, NativeChanges, SourceAccountMonthRow, SourceEntity, SourceTrialBalanceRow } from "./source.ts";

export interface QbdSourceConfig {
  orgId: string;
  connectionId: string;
  historyStartDate: string;
  baseCurrency: string;
}

const ACCOUNT_TYPE: Record<string, string> = {
  Bank: "asset_bank",
  AccountsReceivable: "asset_receivable",
  OtherCurrentAsset: "asset_current_other",
  FixedAsset: "asset_fixed",
  OtherAsset: "asset_other",
  AccountsPayable: "liability_payable",
  CreditCard: "liability_card",
  OtherCurrentLiability: "liability_current_other",
  LongTermLiability: "liability_long_term",
  Equity: "equity",
  Income: "income",
  OtherIncome: "income_other",
  CostOfGoodsSold: "cogs",
  Expense: "expense",
  OtherExpense: "expense_other",
};

function text(value: unknown): string {
  if (value && typeof value === "object" && "#text" in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>)["#text"] ?? "");
  }
  return value == null ? "" : String(value);
}

function ref(value: unknown): { id: string; name: string } | null {
  if (!value || typeof value !== "object") return null;
  const node = value as Record<string, unknown>;
  const id = text(node.ListID);
  return id ? { id, name: text(node.FullName) } : null;
}

function bool(value: unknown, fallback = true): boolean {
  const v = text(value).toLowerCase();
  return v ? v === "true" || v === "1" : fallback;
}

function findDeep(value: unknown, key: string): unknown {
  if (Array.isArray(value)) {
    for (const child of value) { const found = findDeep(child, key); if (found !== undefined) return found; }
    return undefined;
  }
  if (!value || typeof value !== "object") return undefined;
  const node = value as Record<string, unknown>;
  if (key in node) return node[key];
  for (const child of Object.values(node)) { const found = findDeep(child, key); if (found !== undefined) return found; }
  return undefined;
}

function cleanAmount(value: string | undefined): string {
  const normalized = String(value ?? "").replaceAll(",", "").trim();
  return normalized === "" ? "0" : normalized;
}

export class QbdSource implements MigrationSource {
  readonly name = "qbd";
  readonly refKey = "qbdId";
  readonly baseCurrency: string;
  private captureId: string | null = null;
  private captureReady = false;
  private capturedThrough: Date | null = null;

  constructor(private readonly config: QbdSourceConfig) {
    // No default: the constructor must never invent a currency. buildSource
    // refuses a missing or invalid base currency before constructing.
    this.baseCurrency = config.baseCurrency;
  }

  async ping(): Promise<{ ok: boolean; detail?: string }> {
    const heartbeat = await latestWebConnectorHeartbeat(this.config.orgId, this.config.connectionId);
    if (!heartbeat) return { ok: false, detail: "Web Connector has not authenticated yet" };
    const ageMinutes = Math.floor((Date.now() - new Date(heartbeat).getTime()) / 60_000);
    return ageMinutes <= 15
      ? { ok: true, detail: "QuickBooks Web Connector is online" }
      : { ok: false, detail: `Last Web Connector contact was ${ageMinutes} minutes ago` };
  }

  private async capture(since: Date | null = null): Promise<void> {
    if (this.captureReady) return;
    this.captureId = await prepareCapture({
      orgId: this.config.orgId,
      connectionId: this.config.connectionId,
      historyStartDate: this.config.historyStartDate,
      since,
    });
    await waitForCapture(this.config.orgId, this.captureId);
    const captured = (await db.execute<{ through: Date }>(sql`select captured_through as through from qbd_captures where id = ${this.captureId} and org_id = ${this.config.orgId}`));
    this.capturedThrough = captured.rows[0]?.through ?? new Date();
    this.captureReady = true;
  }

  private async responseRows(family: string): Promise<CaptureResponse[]> {
    await this.capture();
    const result = (await db.execute<CaptureResponse>(sql`
      select family, request_kind as "requestKind", page, response_xml as "responseXml"
        from qbd_requests where capture_id = ${this.captureId} and org_id = ${this.config.orgId} and family = ${family} and status = 'complete'
       order by sequence`));
    if (result.rows.some((row) => !row.responseXml)) throw new Error(`QuickBooks capture family ${family} contains an empty response`);
    return result.rows;
  }

  private async parsedFamily(family: string): Promise<Record<string, unknown>[]> {
    const responses = await this.responseRows(family);
    return responses.map((r) => parseXml(r.responseXml));
  }

  private async accountRecords(): Promise<Array<Record<string, unknown>>> {
    return (await this.parsedFamily("account")).flatMap((xml) => nodes(xml, "AccountRet"));
  }

  async entities(since?: Date | null): Promise<EntityStream[]> {
    await this.capture(since ?? null);
    const accounts: SourceEntity[] = [];
    for (const a of await this.accountRecords()) {
      const listId = text(a.ListID);
      const type = ACCOUNT_TYPE[text(a.AccountType)];
      if (!listId || !type) continue;
      accounts.push({
        sourceRef: listId,
        naturalKey: text(a.AccountNumber) || null,
        parentRef: ref(a.ParentRef)?.id ?? null,
        fields: {
          number: text(a.AccountNumber) || null,
          name: text(a.Name) || text(a.FullName),
          type,
          isActive: bool(a.IsActive),
          isSummary: false,
        },
      });
    }

    const parties: SourceEntity[] = [];
    for (const [family, suffix, prefix, kind] of [
      ["customer", "CustomerRet", "C", "company"],
      ["vendor", "VendorRet", "V", "company"],
      ["employee", "EmployeeRet", "E", "person"],
    ] as const) {
      for (const xml of await this.parsedFamily(family)) {
        for (const p of nodes(xml, suffix)) {
          const id = text(p.ListID);
          if (!id) continue;
          // Merge signals: qbXML list rows expose ListID + IsActive only — no
          // successor pointer. No mergedIntoRef is emitted; disappearances
          // take the held path.
          parties.push({
            sourceRef: `${prefix}:${id}`,
            fields: { displayName: (text(p.Name) || text(p.FullName) || `${prefix} ${id}`).slice(0, 500), kind, isActive: bool(p.IsActive) },
          });
        }
      }
    }

    const items: SourceEntity[] = [];
    for (const xml of await this.parsedFamily("item")) {
      for (const item of nodes(xml, "Ret")) {
        const id = text(item.ListID);
        const name = text(item.Name) || text(item.FullName);
        if (!id || !name) continue;
        const income = ref(findDeep(item, "IncomeAccountRef"));
        const expense = ref(findDeep(item, "ExpenseAccountRef"));
        const inventory = ref(findDeep(item, "AssetAccountRef"));
        items.push({
          sourceRef: id,
          naturalKey: text(item.Name) || null,
          fields: {
            code: (text(item.Name) || `qbd-${id}`).slice(0, 100),
            name: name.slice(0, 500),
            kind: inventory ? "inventory" : /service/i.test(JSON.stringify(item)) ? "service" : "non_inventory",
            incomeAccountRef: income?.id ?? null,
            expenseAccountRef: expense?.id ?? null,
            inventoryAccountRef: inventory?.id ?? null,
            isActive: bool(item.IsActive),
          },
        });
      }
    }
    return [
      { resource: "accounts", records: accounts },
      { resource: "parties", records: parties },
      { resource: "items", records: items },
    ];
  }

  async accountingPeriods(): Promise<SourceEntity[]> {
    await this.capture();
    const preferences = (await this.parsedFamily("preferences"))[0];
    const closeDateRaw = preferences ? findDeep(preferences, "ClosingDate") : undefined;
    const closeDate = text(closeDateRaw) || null;
    const horizon = parseIsoDate(await businessToday(this.config.orgId));
    horizon.setUTCFullYear(horizon.getUTCFullYear() + 1);
    return monthlySourcePeriods(
      "qbd-period",
      fiscalYearsForRange(this.config.historyStartDate, horizon.toISOString().slice(0, 10), 1),
      (endsOn) => allModules(closeDate && endsOn <= closeDate ? "closed" : "open"),
    );
  }

  async controlAccounts(): Promise<Partial<Record<"ar" | "ap" | "bank" | "taxCollected" | "taxPaid", string>>> {
    const accounts = await this.accountRecords();
    const first = (type: string) => accounts.find((a) => text(a.AccountType) === type && bool(a.IsActive));
    const tax = accounts.find((a) => /(?:sales tax|gst|hst|vat).*(?:payable|liability)/i.test(text(a.FullName) || text(a.Name)));
    return {
      ar: text(first("AccountsReceivable")?.ListID) || undefined,
      ap: text(first("AccountsPayable")?.ListID) || undefined,
      bank: text(first("Bank")?.ListID) || undefined,
      taxCollected: text(tax?.ListID) || undefined,
      taxPaid: text(tax?.ListID) || undefined,
    };
  }

  private async ledgerFamilies(): Promise<string[]> {
    await this.capture();
    const result = (await db.execute<{ family: string }>(sql`
      select distinct family from qbd_requests
       where capture_id = ${this.captureId} and org_id = ${this.config.orgId} and family like 'ledger:%' and status = 'complete'
       order by family`));
    return result.rows.map((row) => row.family);
  }

  private async ledgerRows(family: string) {
    const responses = await this.responseRows(family);
    const rows = responses.flatMap((response) => parseReportRows(response.responseXml).filter((row) => row.rowType === "DataRow"));
    // A nonzero GeneralLedger DataRow without a TxnID cannot be grouped into
    // its transaction: buildQbdLedgerDocuments would silently drop the leg
    // (and a fully TxnID-less transaction would vanish from the pulled set
    // and become a source-deletion candidate). Refuse by month and row BEFORE
    // any deletion inference. Zero-amount TxnID-less rows (headings, blanks)
    // carry no balance and stay skippable downstream.
    const month = family.startsWith("ledger:") ? family.slice("ledger:".length) : family;
    rows.forEach((row, index) => {
      if (row.columns.TxnID) return;
      const amount = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
      if (amount !== 0n) {
        throw new Error(`QuickBooks GeneralLedger response for month ${month} contains a nonzero row without a TxnID (row ${index + 1}, account "${row.columns.Account ?? ""}", debit "${row.columns.Debit ?? ""}", credit "${row.columns.Credit ?? ""}"); the sync is refused before any deletion inference`);
      }
    });
    return rows;
  }

  async nativeChanges(since: Date | null, ctx: NativeContext): Promise<NativeChanges> {
    const accounts = await this.accountRecords();
    const accountRefByName = new Map<string, string>();
    for (const a of accounts) {
      const id = text(a.ListID);
      if (id) {
        accountRefByName.set(text(a.FullName), id);
        accountRefByName.set(text(a.Name), id);
      }
    }
    // Names stay per family: a customer and a vendor sharing one FullName
    // must never overwrite each other in a single map — the ledger builder
    // resolves each line by its account class (AR → customer, AP → vendor).
    const partyRefByFamily = {
      customer: new Map<string, string>(),
      vendor: new Map<string, string>(),
      employee: new Map<string, string>(),
    };
    for (const [family, suffix, prefix] of [["customer", "CustomerRet", "C"], ["vendor", "VendorRet", "V"], ["employee", "EmployeeRet", "E"]] as const) {
      for (const xml of await this.parsedFamily(family)) for (const p of nodes(xml, suffix)) {
        const id = text(p.ListID);
        if (id) partyRefByFamily[family].set(text(p.FullName) || text(p.Name), `${prefix}:${id}`);
      }
    }

    const documents: NativeChanges["documents"] = [];
    const unbuildable: NativeChanges["unbuildable"] = [];
    for (const family of await this.ledgerFamilies()) {
      const built = buildQbdLedgerDocuments({
        rows: await this.ledgerRows(family),
        accountRefByName,
        partyRefByFamily,
        ctx,
        baseCurrency: this.baseCurrency,
      });
      documents.push(...built.documents);
      unbuildable.push(...built.unbuildable);
    }
    const existing = (await db.execute<{ ref: string }>(sql`
      select custom->>'qbdId' as ref from documents
       where org_id = ${ctx.orgId} and custom->>'qbdId' is not null`));
    const pulled = new Set([...documents.map((d) => d.sourceRef), ...unbuildable.map((u) => u.ref)]);
    const deletedRefs = existing.rows.map((r) => r.ref).filter((ref) => !pulled.has(ref));
    return {
      documents,
      applications: [],
      deletedRefs,
      syncedThrough: this.capturedThrough ?? since ?? new Date(),
      unbuildable,
    };
  }

  async trialBalance(): Promise<SourceTrialBalanceRow[]> {
    const response = (await this.responseRows("trial-balance"))[0];
    if (!response) throw new Error("QuickBooks capture omitted the trial balance");
    const accounts = await this.accountRecords();
    const byName = new Map(accounts.flatMap((a) => {
      const id = text(a.ListID);
      return id ? [[text(a.FullName), id] as const, [text(a.Name), id] as const] : [];
    }));
    return parseReportRows(response.responseXml).flatMap((row) => {
      if (row.rowType !== "DataRow") return [];
      const accountRef = byName.get(row.columns.Account ?? "");
      const balance = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
      if (!accountRef) {
        // A nonzero source balance with no ListID mapping must REFUSE
        // verification by name: silently dropping it makes the account
        // invisible to the union check in verifyCurrentLedgerState (0
        // mismatches) while the ledgers genuinely differ. A truly zero row
        // is deliberately skipped — there is nothing to verify.
        if (balance !== 0n) {
          throw new Error(`QuickBooks trial balance reports ${fromUnits(balance)} for unmapped account "${row.columns.Account ?? ""}"; map the account before verification can pass`);
        }
        return [];
      }
      return [{ accountRef, balance: fromUnits(balance) }];
    });
  }

  async monthlyActivity(): Promise<SourceAccountMonthRow[]> {
    const accounts = await this.accountRecords();
    const byName = new Map(accounts.flatMap((a) => {
      const id = text(a.ListID);
      return id ? [[text(a.FullName), id] as const, [text(a.Name), id] as const] : [];
    }));
    const buckets = new Map<string, bigint>();
    for (const family of await this.ledgerFamilies()) {
      for (const row of await this.ledgerRows(family)) {
        const accountRef = byName.get(row.columns.Account ?? "");
        if (!row.columns.TxnID) continue;
        // Report dates are locale display strings (M/D/YYYY); month buckets
        // require ISO. Fail closed on an unparseable date rather than
        // bucketing source truth into a garbage month.
        const month = parseQbdReportDate(row.columns.Date).slice(0, 7);
        const amount = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
        if (!accountRef) {
          // Same fail-closed rule as trialBalance above: nonzero source
          // activity with no ListID mapping refuses by name (account, month,
          // amount) instead of vanishing from the true-up. A truly zero row
          // is deliberately skipped — there is nothing to reconcile.
          if (amount !== 0n) {
            throw new Error(`QuickBooks ledger reports ${fromUnits(amount)} for unmapped account "${row.columns.Account ?? ""}" in ${month}; map the account before sync can proceed`);
          }
          continue;
        }
        const key = `${accountRef}|${month}`;
        buckets.set(key, (buckets.get(key) ?? 0n) + amount);
      }
    }
    return [...buckets.entries()].map(([key, amount]) => {
      const [accountRef, month] = key.split("|");
      return { accountRef: accountRef!, month: month!, amount: fromUnits(amount) };
    });
  }

  async dispose(): Promise<void> {
    if (this.captureId) await releaseCapture(this.config.orgId, this.captureId);
    this.captureReady = false;
  }
}
