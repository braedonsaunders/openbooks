import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import { latestWebConnectorHeartbeat, prepareCapture, releaseCapture, waitForCapture, type CaptureResponse } from "../qbd/bridge.ts";
import { nodes, parseReportRows, parseXml } from "../qbd/qbxml.ts";
import type { NativeContext } from "./native.ts";
import { allModules, fiscalYearsForRange, monthlySourcePeriods } from "./periods.ts";
import { buildQbdLedgerDocuments } from "./qbd-native.ts";
import type { EntityStream, MigrationSource, NativeChanges, SourceAccountMonthRow, SourceEntity, SourceTrialBalanceRow } from "./source.ts";

export interface QbdSourceConfig {
  orgId: string;
  connectionId: string;
  historyStartDate: string;
  baseCurrency?: string;
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
    this.baseCurrency = config.baseCurrency ?? "USD";
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
    const captured = (await db.execute(sql`select captured_through as through from qbd_captures where id = ${this.captureId}`)) as unknown as { rows: { through: Date }[] };
    this.capturedThrough = captured.rows[0]?.through ?? new Date();
    this.captureReady = true;
  }

  private async responseRows(family: string): Promise<CaptureResponse[]> {
    await this.capture();
    const result = (await db.execute(sql`
      select family, request_kind as "requestKind", page, response_xml as "responseXml"
        from qbd_requests where capture_id = ${this.captureId} and family = ${family} and status = 'complete'
       order by sequence`)) as unknown as { rows: CaptureResponse[] };
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
    const horizon = new Date();
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
    const result = (await db.execute(sql`
      select distinct family from qbd_requests
       where capture_id = ${this.captureId} and family like 'ledger:%' and status = 'complete'
       order by family`)) as unknown as { rows: { family: string }[] };
    return result.rows.map((row) => row.family);
  }

  private async ledgerRows(family: string) {
    const responses = await this.responseRows(family);
    return responses.flatMap((response) => parseReportRows(response.responseXml).filter((row) => row.rowType === "DataRow"));
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
    const partiesByName = new Map<string, string>();
    for (const [family, suffix, prefix] of [["customer", "CustomerRet", "C"], ["vendor", "VendorRet", "V"], ["employee", "EmployeeRet", "E"]] as const) {
      for (const xml of await this.parsedFamily(family)) for (const p of nodes(xml, suffix)) {
        const id = text(p.ListID);
        if (id) partiesByName.set(text(p.FullName) || text(p.Name), `${prefix}:${id}`);
      }
    }

    const documents: NativeChanges["documents"] = [];
    const unbuildable: NativeChanges["unbuildable"] = [];
    for (const family of await this.ledgerFamilies()) {
      const built = buildQbdLedgerDocuments({
        rows: await this.ledgerRows(family),
        accountRefByName,
        partyRefByName: partiesByName,
        ctx,
        baseCurrency: this.baseCurrency,
      });
      documents.push(...built.documents);
      unbuildable.push(...built.unbuildable);
    }
    const existing = (await db.execute(sql`
      select custom->>'qbdId' as ref from documents
       where org_id = ${ctx.orgId} and custom->>'qbdId' is not null`)) as unknown as { rows: { ref: string }[] };
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
      if (!accountRef) return [];
      const balance = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
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
        const month = row.columns.Date?.slice(0, 7);
        if (!accountRef || !month || !row.columns.TxnID) continue;
        const amount = toUnits(cleanAmount(row.columns.Debit)) - toUnits(cleanAmount(row.columns.Credit));
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
