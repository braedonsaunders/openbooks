import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { businessToday } from "@openbooks/engine/src/business-date.ts";
import { db } from "@openbooks/engine/src/db.ts";
import { can, type Authz } from "../authz";
import { accountsWithBalances, entryDetail } from "../data";
import {
  accountRegister,
  agingByParty,
  balanceSheet,
  cashFlow,
  financialTrends as financialTrendRows,
  profitAndLoss,
  trialBalance,
} from "../reports";
import { openItems } from "../cash/open-items";
import { truncateText, type AssistantToolDef, type ToolResult } from "./types";
import { orgToday, rangeInputFields, resolveToolRange, type RangeArgs } from "./tools-shared";
import { readableContinuousCloseAgents } from "../continuous-close";
import { budgetScenarioOptions, budgetVsActualView } from "../budget-report";
import { projectCostSummary } from "../project-costing";
import { documentRevisionSql, isDocKindEnabled } from "../documents";
import { isFeatureEnabled } from "../features";

/**
 * Read/search tools for the agentic assistant. Every tool is permission-gated
 * (same keys the pages use), returns capped result sets, and reuses the exact
 * query layer the UI renders from (web/lib/data.ts, web/lib/reports.ts) so the
 * assistant can never disagree with the screens.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

const dateInput = z.string().regex(ISO_DATE, "YYYY-MM-DD");
const uuidInput = z.string().regex(UUID_RE, "uuid");

function num(v: unknown): number {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// ---------------------------------------------------------------------------
// whoami
// ---------------------------------------------------------------------------

const whoami: AssistantToolDef = {
  name: "whoami",
  description:
    "The current user's name, role, and permissions, plus the org name and base currency. Call this when unsure what the user may see or do. Read-only.",
  category: "read",
  gate: { mode: "public" },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    const org = (await db.execute<{ name: string; base_currency: string }>(
      sql`select name, base_currency from orgs where id = ${authz.user.orgId}`,
    ));
    return {
      ok: true,
      data: {
        name: authz.user.name,
        email: authz.user.email,
        roles: authz.user.roles.map(({ key }) => key),
        org: org.rows[0]?.name ?? null,
        baseCurrency: org.rows[0]?.base_currency ?? null,
        permissions: [...authz.permissions].sort(),
        canDraft: can(authz, "assistant.write") && can(authz, "gl.post"),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Chart of accounts
// ---------------------------------------------------------------------------

const findAccounts: AssistantToolDef = {
  name: "find_accounts",
  description:
    "Search the chart of accounts by number, name, or type, with current balances (balance-sheet accounts cumulative, P&L accounts fiscal-year-to-date, natural sign). Returns a capped list. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["gl.read"] },
  inputSchema: z.object({
    query: z.string().max(100).optional().describe("Match against account number or name"),
    type: z.string().max(40).optional().describe("Account type, e.g. asset_bank, expense, income"),
    asOf: dateInput.optional(),
    includeInactive: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as {
      query?: string;
      type?: string;
      asOf?: string;
      includeInactive?: boolean;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 25, 50);
    const all = await accountsWithBalances(authz.user.orgId, a.asOf);
    const q = a.query?.trim().toLowerCase();
    const matches = all.filter((r) => {
      if (!a.includeInactive && !r.is_active) return false;
      if (a.type && r.type !== a.type) return false;
      if (q && !(`${r.number ?? ""} ${r.name}`.toLowerCase().includes(q))) return false;
      return true;
    });
    return {
      ok: true,
      data: {
        total: matches.length,
        returned: Math.min(matches.length, limit),
        truncated: matches.length > limit,
        asOf: a.asOf ?? (await orgToday(authz.user.orgId)),
        items: matches.slice(0, limit).map((r) => ({
          id: r.id,
          number: r.number,
          name: r.name,
          type: r.type,
          isSummary: r.is_summary,
          isActive: r.is_active,
          balance: num(r.balance),
        })),
      },
    };
  },
};

const accountRegisterTool: AssistantToolDef = {
  name: "account_register",
  description:
    "The journal-line register for one account (most recent first): posting date, entry number, memo, party, signed amount — plus the account's lifetime balance. Use find_accounts first to get the account id. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["gl.read"] },
  inputSchema: z.object({
    accountId: uuidInput,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { accountId: string; limit?: number };
    const limit = Math.min(a.limit ?? 25, 50);
    const r = await accountRegister(authz.user.orgId, a.accountId, limit, 0, undefined, authz.allowedSubsidiaryIds);
    if (!r.account) return { ok: false, error: "account_not_found" };
    return {
      ok: true,
      data: {
        account: r.account,
        totalLines: r.total,
        returned: r.lines.length,
        truncated: r.total > r.lines.length,
        balanceDebitSigned: num(r.balance),
        lines: r.lines.map((l: any) => ({
          entryId: l.entry_id,
          entryNumber: l.entry_number,
          postingDate: l.posting_date,
          memo: truncateText(l.memo ?? l.entry_memo, 200),
          party: l.party,
          amount: num(l.amount),
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Journal entries
// ---------------------------------------------------------------------------

const findJournalEntries: AssistantToolDef = {
  name: "find_journal_entries",
  description:
    "List posted-ledger journal entries with optional filters (free-text on entry number/memo, status, origin, posting-date range). Returns a capped list plus the total match count. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["gl.read"] },
  inputSchema: z.object({
    query: z.string().max(100).optional(),
    status: z.enum(["draft", "posted", "reversed"]).optional(),
    origin: z.string().max(40).optional(),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as {
      query?: string;
      status?: string;
      origin?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    };
    const limit = Math.min(a.limit ?? 20, 50);
    let where = sql`e.org_id = ${authz.user.orgId}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (e.entry_number ilike ${like} or e.memo ilike ${like})`;
    }
    if (a.status) where = sql`${where} and e.status = ${a.status}`;
    if (a.origin) where = sql`${where} and e.origin = ${a.origin}`;
    if (a.fromDate) where = sql`${where} and e.posting_date >= ${a.fromDate}`;
    if (a.toDate) where = sql`${where} and e.posting_date <= ${a.toDate}`;
    const rows = (await db.execute<any>(sql`
      select e.id, e.entry_number, e.posting_date, e.memo, e.status, e.origin,
             e.source_document_id,
             count(l.id) as line_count,
             sum(case when l.amount > 0 then l.amount else 0 end) as total_debits
        from journal_entries e
        join journal_lines l on l.entry_id = e.id and l.org_id = e.org_id
       where ${where}
       group by e.id
       order by e.posting_date desc, e.entry_number desc
       limit ${limit}
    `));
    const c = (await db.execute<{ n: string }>(
      sql`select count(*) as n from journal_entries e where ${where}`,
    ));
    const total = Number(c.rows[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        returned: rows.rows.length,
        truncated: total > rows.rows.length,
        items: rows.rows.map((r) => ({
          id: r.id,
          entryNumber: r.entry_number,
          postingDate: r.posting_date,
          memo: truncateText(r.memo, 200),
          status: r.status,
          origin: r.origin,
          sourceDocumentId: r.source_document_id,
          lineCount: Number(r.line_count),
          totalDebits: num(r.total_debits),
        })),
      },
    };
  },
};

const getJournalEntry: AssistantToolDef = {
  name: "get_journal_entry",
  description:
    "One journal entry in full: header (entry number, posting date, memo, status, origin) plus every line with account, party, department, and signed amount. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["gl.read"] },
  inputSchema: z.object({ entryId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { entryId: string };
    const r = await entryDetail(authz.user.orgId, a.entryId);
    if (!r.entry) return { ok: false, error: "entry_not_found" };
    const e = r.entry as any;
    return {
      ok: true,
      data: {
        id: e.id,
        entryNumber: e.entry_number,
        postingDate: e.posting_date,
        memo: truncateText(e.memo, 500),
        status: e.status,
        origin: e.origin,
        sourceDocumentId: e.source_document_id,
        reversesEntryNumber: e.reverses_number,
        lines: r.lines.map((l: any) => ({
          lineNumber: l.line_number,
          account: `${l.account_number ?? ""} ${l.account_name}`.trim(),
          amount: num(l.amount),
          memo: truncateText(l.memo, 200),
          party: l.party,
          department: l.department,
          isOpenItem: l.is_open_item,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Documents (bills, invoices, expenses, payments…)
// ---------------------------------------------------------------------------

/** Which permission covers each document kind — mirrors the module pages. */
const KIND_PERM: Record<string, string> = {
  vendor_bill: "ap.read",
  vendor_payment: "ap.read",
  vendor_credit: "ap.read",
  purchase_order: "ap.read",
  check: "ap.read",
  card_charge: "ap.read",
  card_refund: "ap.read",
  customer_invoice: "ar.read",
  customer_credit: "ar.read",
  sales_order: "ar.read",
  quote: "ar.read",
  expense_report: "expenses.read",
  journal: "gl.read",
  transfer: "gl.read",
};

async function allowedKinds(authz: Authz): Promise<string[]> {
  const kinds: string[] = []
  for (const kind of Object.keys(KIND_PERM)) {
    if (!can(authz, KIND_PERM[kind]!)) continue
    if (!(await isDocKindEnabled(authz.user.orgId, kind))) continue
    kinds.push(kind)
  }
  return kinds
}

const findDocuments: AssistantToolDef = {
  name: "find_documents",
  description:
    "Search transaction documents — vendor bills, customer invoices, expense reports, payments, orders, journals — by kind, status, document number, party name, or date range. Returns a capped list plus the total match count and each exact persisted updatedAt revision. Read-only.",
  category: "search",
  gate: {
    mode: "anyOf",
    perms: ["ap.read", "ar.read", "gl.read", "expenses.read"],
  },
  inputSchema: z.object({
    kind: z.string().max(40).optional()
      .describe("e.g. vendor_bill, customer_invoice, expense_report, vendor_payment, journal"),
    status: z.enum(["draft", "pending_approval", "approved", "posted", "voided"]).optional(),
    query: z.string().max(100).optional().describe("Match document number, reference, or memo"),
    partyQuery: z.string().max(100).optional().describe("Match the party (vendor/customer) name"),
    fromDate: dateInput.optional(),
    toDate: dateInput.optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as {
      kind?: string;
      status?: string;
      query?: string;
      partyQuery?: string;
      fromDate?: string;
      toDate?: string;
      limit?: number;
    };
    const kinds = await allowedKinds(authz);
    if (a.kind && !kinds.includes(a.kind)) {
      return {
        ok: false,
        error: KIND_PERM[a.kind] ? "forbidden" : `unknown kind; use one of: ${kinds.join(", ")}`,
      };
    }
    const limit = Math.min(a.limit ?? 20, 50);
    let where = a.kind
      ? sql`d.kind = ${a.kind} and d.org_id = ${authz.user.orgId}`
      : sql`d.org_id = ${authz.user.orgId} and d.kind in ${kinds}`;
    if (a.status) where = sql`${where} and d.status = ${a.status}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (d.document_number ilike ${like} or d.reference_number ilike ${like} or d.memo ilike ${like})`;
    }
    if (a.partyQuery) where = sql`${where} and p.display_name ilike ${`%${a.partyQuery}%`}`;
    if (a.fromDate) where = sql`${where} and d.document_date >= ${a.fromDate}`;
    if (a.toDate) where = sql`${where} and d.document_date <= ${a.toDate}`;
    const rows = (await db.execute<any>(sql`
      select d.id, d.kind, d.document_number, d.reference_number, d.document_date,
             d.due_date, d.status, d.currency, d.total, d.memo, d.posted_entry_id,
             ${documentRevisionSql(sql.raw("d.updated_at"))} as "documentRevision",
             p.id as party_id, p.display_name as party
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where ${where}
       order by d.document_date desc, d.document_number desc
       limit ${limit}
    `));
    const c = (await db.execute<{ n: string }>(sql`
      select count(*) as n
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where ${where}
    `));
    const total = Number(c.rows[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        returned: rows.rows.length,
        truncated: total > rows.rows.length,
        items: rows.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          documentNumber: r.document_number,
          referenceNumber: r.reference_number,
          documentDate: r.document_date,
          dueDate: r.due_date,
          status: r.status,
          currency: r.currency,
          total: num(r.total),
          party: r.party,
          partyId: r.party_id,
          postedEntryId: r.posted_entry_id,
          updatedAt: r.documentRevision,
          memo: truncateText(r.memo, 160),
        })),
      },
    };
  },
};

const getDocument: AssistantToolDef = {
  name: "get_document",
  description:
    "One transaction document in full: header (number, party, dates, status, totals), its exact persisted updatedAt revision, plus every line with account/item, description, quantity, and amount. Copy updatedAt verbatim to expectedUpdatedAt for a write; never parse or reformat it. Read-only.",
  category: "read",
  gate: {
    mode: "anyOf",
    perms: ["ap.read", "ar.read", "gl.read", "expenses.read"],
  },
  inputSchema: z.object({ documentId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { documentId: string };
    const doc = (await db.execute<any>(sql`
      select d.*, ${documentRevisionSql(sql.raw("d.updated_at"))} as "documentRevision",
             p.display_name as party
        from documents d
        left join parties p on p.id = d.party_id and p.org_id = d.org_id
       where d.id = ${a.documentId} and d.org_id = ${authz.user.orgId}
    `));
    const d = doc.rows[0];
    if (!d) return { ok: false, error: "document_not_found" };
    if (!(await isDocKindEnabled(authz.user.orgId, d.kind))) return { ok: false, error: "document_not_found" };
    const perm = KIND_PERM[d.kind];
    if (!perm || !can(authz, perm)) return { ok: false, error: "forbidden" };
    const lines = (await db.execute<any>(sql`
      select l.line_number, l.description, l.quantity, l.unit, l.unit_price, l.amount,
             l.tax_amount, a.number as account_number, a.name as account_name,
             i.name as item_name
        from document_lines l
       left join accounts a on a.id = l.account_id and a.org_id = l.org_id
       left join items i on i.id = l.item_id and i.org_id = l.org_id
       where l.document_id = ${a.documentId} and l.org_id = ${authz.user.orgId}
       order by l.line_number
    `));
    return {
      ok: true,
      data: {
        id: d.id,
        kind: d.kind,
        documentNumber: d.document_number,
        referenceNumber: d.reference_number,
        party: d.party,
        partyId: d.party_id,
        documentDate: d.document_date,
        postingDate: d.posting_date,
        dueDate: d.due_date,
        status: d.status,
        currency: d.currency,
        subtotal: num(d.subtotal),
        taxTotal: num(d.tax_total),
        total: num(d.total),
        memo: truncateText(d.memo, 500),
        postedEntryId: d.posted_entry_id,
        updatedAt: d.documentRevision,
        lines: lines.rows.map((l) => ({
          lineNumber: l.line_number,
          account: l.account_name ? `${l.account_number ?? ""} ${l.account_name}`.trim() : null,
          item: l.item_name,
          description: truncateText(l.description, 200),
          quantity: l.quantity === null ? null : num(l.quantity),
          unit: l.unit,
          unitPrice: l.unit_price === null ? null : num(l.unit_price),
          amount: num(l.amount),
          taxAmount: l.tax_amount === null ? null : num(l.tax_amount),
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Parties
// ---------------------------------------------------------------------------

const findParties: AssistantToolDef = {
  name: "find_parties",
  description:
    "Find vendors, customers, and other parties by name, short code, or email. Returns a capped list. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["parties.read"] },
  inputSchema: z.object({
    query: z.string().max(100).optional(),
    includeInactive: z.boolean().optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { query?: string; includeInactive?: boolean; limit?: number };
    const limit = Math.min(a.limit ?? 20, 50);
    let where = sql`org_id = ${authz.user.orgId} and ${a.includeInactive ? sql`true` : sql`is_active`}`;
    if (a.query) {
      const like = `%${a.query}%`;
      where = sql`${where} and (display_name ilike ${like} or short_code ilike ${like} or email ilike ${like})`;
    }
    const rows = (await db.execute<any>(sql`
      select id, kind, display_name, short_code, email, phone, is_active
        from parties where ${where}
       order by display_name
       limit ${limit}
    `));
    const c = (await db.execute<{ n: string }>(
      sql`select count(*) as n from parties where ${where}`,
    ));
    const total = Number(c.rows[0]?.n ?? 0);
    return {
      ok: true,
      data: {
        total,
        returned: rows.rows.length,
        truncated: total > rows.rows.length,
        items: rows.rows.map((r) => ({
          id: r.id,
          kind: r.kind,
          displayName: r.display_name,
          shortCode: r.short_code,
          email: r.email,
          phone: r.phone,
          isActive: r.is_active,
        })),
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Financial statements
// ---------------------------------------------------------------------------

const MAX_STATEMENT_ROWS = 200;

function capItems<T>(items: T[]): { items: T[]; truncated: boolean } {
  return {
    items: items.slice(0, MAX_STATEMENT_ROWS),
    truncated: items.length > MAX_STATEMENT_ROWS,
  };
}

const profitAndLossTool: AssistantToolDef = {
  name: "profit_and_loss",
  description:
    "Profit & loss statement for a posting-date range, optionally filtered by department or project: per-account rows (reader-signed, hierarchical) plus revenue, COGS, gross profit, expenses, and net income totals. For any relative period ('YTD', 'this quarter', 'last year') pass a `period` preset — it resolves server-side against the org's fiscal calendar. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({
    ...rangeInputFields,
    departmentId: uuidInput.optional(),
    projectId: uuidInput.optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { departmentId?: string; projectId?: string };
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const r = await profitAndLoss(range.from, range.to, {
      departmentId: a.departmentId,
      projectId: a.projectId,
    }, authz.user.orgId);
    const { items, truncated } = capItems(
      r.items.map((i) => ({
        number: i.number,
        name: i.name,
        type: i.type,
        depth: i.depth,
        isSummary: i.isSummary,
        balance: num(i.balance),
      })),
    );
    return {
      ok: true,
      data: {
        periodLabel: range.label,
        fromDate: range.from,
        toDate: range.to,
        revenue: num(r.revenue),
        cogs: num(r.cogs),
        grossProfit: num(r.grossProfit),
        expenses: num(r.expenses),
        netIncome: num(r.netIncome),
        href: `/reports/pnl?from=${range.from}&to=${range.to}`,
        truncated,
        items,
      },
    };
  },
};

const balanceSheetTool: AssistantToolDef = {
  name: "balance_sheet",
  description:
    "Balance sheet as of a date: assets, liabilities, and equity account rows (reader-signed, hierarchical, incl. computed accumulated earnings) with section totals. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ asOf: dateInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { asOf: string };
    const r = await balanceSheet(a.asOf, authz.user.orgId);
    const section = (rows: typeof r.assets) =>
      capItems(
        rows.map((i) => ({
          number: i.number,
          name: i.name,
          depth: i.depth,
          isSummary: i.isSummary,
          balance: num(i.balance),
        })),
      );
    return {
      ok: true,
      data: {
        asOf: a.asOf,
        totalAssets: num(r.totalAssets),
        totalLiabilities: num(r.totalLiabilities),
        totalEquity: num(r.totalEquity),
        href: `/reports/balance-sheet?asOf=${a.asOf}`,
        assets: section(r.assets),
        liabilities: section(r.liabilities),
        equity: section(r.equity),
      },
    };
  },
};

const trialBalanceTool: AssistantToolDef = {
  name: "trial_balance",
  description:
    "Trial balance as of a date: every account with nonzero activity, with lifetime debits, credits, and the debit-signed balance. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ asOf: dateInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { asOf: string };
    const rows = await trialBalance(a.asOf, undefined, authz.user.orgId);
    const { items, truncated } = capItems(
      rows.map((r) => ({
        number: r.number,
        name: r.name,
        type: r.type,
        debits: num(r.debits),
        credits: num(r.credits),
        balance: num(r.balance),
      })),
    );
    return { ok: true, data: { asOf: a.asOf, accounts: rows.length, truncated, items } };
  },
};

const agingTool: AssistantToolDef = {
  name: "aging",
  description:
    "AR or AP aging by customer/vendor as of a date: open-item balances bucketed into current, 1–30, 31–60, 61–90, and 90+ days past due, plus totals. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  inputSchema: z.object({
    side: z.enum(["ar", "ap"]),
    asOf: dateInput.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { side: "ar" | "ap"; asOf?: string; limit?: number };
    if (!can(authz, a.side === "ar" ? "ar.read" : "ap.read")) {
      return { ok: false, error: "forbidden" };
    }
    const limit = Math.min(a.limit ?? 30, 100);
    const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
    const r = await agingByParty(a.side, asOf, undefined, authz.user.orgId);
    return {
      ok: true,
      data: {
        side: a.side,
        asOf: r.asOf,
        totals: r.totals,
        parties: r.rows.length,
        returned: Math.min(r.rows.length, limit),
        truncated: r.rows.length > limit,
        rows: r.rows.slice(0, limit).map((row) => ({
          party: row.partyName,
          current: row.current,
          days1to30: row.b1,
          days31to60: row.b2,
          days61to90: row.b3,
          over90: row.b4,
          total: row.total,
        })),
        href: `/reports/aging?side=${a.side}&asOf=${asOf}`,
      },
    };
  },
};

const cashFlowTool: AssistantToolDef = {
  name: "cash_flow",
  description:
    "Direct-method cash flow statement for a posting-date range: operating / investing / financing sections with per-account-type lines, net change in cash, and the opening/closing bank balances that prove it. For relative periods pass a `period` preset (fiscal-calendar-resolved). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ ...rangeInputFields }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const range = await resolveToolRange(authz.user.orgId, raw as RangeArgs);
    if ("error" in range) return { ok: false, error: range.error };
    const r = await cashFlow(range.from, range.to, undefined, authz.user.orgId);
    return {
      ok: true,
      data: {
        periodLabel: range.label,
        fromDate: range.from,
        toDate: range.to,
        sections: r.sections.map((s) => ({
          section: s.section,
          subtotal: num(s.subtotal),
          lines: s.lines.map((l) => ({ label: l.label, amount: num(l.amount) })),
        })),
        netChange: num(r.netChange),
        openingCash: num(r.openingCash),
        closingCash: num(r.closingCash),
        reconciliationGap: num(r.reconciliationGap),
        href: `/reports/cash-flow?from=${range.from}&to=${range.to}`,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Agent-grade financial context (shared by chat and scheduled agents)
// ---------------------------------------------------------------------------

const financialPeriods: AssistantToolDef = {
  name: "financial_periods",
  description:
    "List recent fiscal periods with exact boundaries, period-close run status, readiness, and locked accounting scopes. Use this before choosing comparison dates. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read", "close.read"] },
  inputSchema: z.object({
    completedOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(24).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { completedOnly?: boolean; limit?: number };
    const limit = Math.min(a.limit ?? 15, 24);
    const today = await businessToday(authz.user.orgId);
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select p.id, p.name, p.fiscal_year, p.period_number,
             p.starts_on::text, p.ends_on::text, p.is_adjustment,
             r.status as close_status, r.readiness_score,
             coalesce(array_agg(distinct (l.module || ':' || l.state)) filter (where l.id is not null), '{}') as locked_scopes
        from accounting_periods p
        join fiscal_calendars fc on fc.id = p.fiscal_calendar_id and fc.org_id = p.org_id
        left join close_runs r on r.period_id = p.id and r.org_id = p.org_id
        left join period_locks l on l.period_id = p.id and l.org_id = p.org_id and l.state <> 'open'
       where p.org_id = ${authz.user.orgId} and fc.is_default and fc.is_active
         ${a.completedOnly === false ? sql`` : sql`and p.ends_on < ${today}`}
       group by p.id, r.id
       order by p.ends_on desc, p.period_number desc
       limit ${limit}
    `));
    return {
      ok: true,
      data: {
        returned: rows.rows.length,
        href: "/close",
        periods: rows.rows.map((row) => ({
          id: row.id,
          name: row.name,
          fiscalYear: row.fiscal_year,
          periodNumber: row.period_number,
          fromDate: row.starts_on,
          toDate: row.ends_on,
          adjustment: row.is_adjustment,
          closeStatus: row.close_status,
          readinessScore: row.readiness_score,
          lockedScopes: row.locked_scopes,
        })),
      },
    };
  },
};

const financialTrends: AssistantToolDef = {
  name: "financial_trends",
  description:
    "Return up to 15 completed fiscal periods of exact revenue, COGS, gross profit, operating expense, net income, gross-margin percentage, and period-end cash. Use for trend and anomaly analysis without making many report calls. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["reports.read"] },
  inputSchema: z.object({ limit: z.number().int().min(2).max(15).optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const limit = Math.min((raw as { limit?: number }).limit ?? 15, 15);
    return {
      ok: true,
      data: { periods: await financialTrendRows(authz.user.orgId, limit), href: "/reports/pnl" },
    };
  },
};

const budgetVsActualTool: AssistantToolDef = {
  name: "budget_vs_actual",
  description:
    "List budget scenarios or return one scenario's P&L budget-versus-actual statement with account rows and exact actual, budget, variance amount, and variance percent. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["budgets.read", "reports.read"] },
  inputSchema: z.object({ scenarioId: uuidInput.optional() }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "budgets"))) {
      return { ok: false, error: "budgets_feature_disabled" };
    }
    const scenarioId = (raw as { scenarioId?: string }).scenarioId;
    if (!scenarioId) {
      return { ok: true, data: { scenarios: await budgetScenarioOptions(authz.user.orgId), href: "/budgets" } };
    }
    const view = await budgetVsActualView(scenarioId, authz.user.orgId, {
      actual: "Actual",
      budget: "Budget",
      variance: "Variance",
      variancePct: "Variance %",
      revenue: "Revenue",
      costOfGoodsSold: "Cost of goods sold",
      grossProfit: "Gross profit",
      expenses: "Expenses",
      netIncome: "Net income",
      totalOf: (section) => `Total ${section}`,
    });
    if (!view) return { ok: false, error: "budget_not_found" };
    return {
      ok: true,
      data: {
        columns: view.columns.map((column) => ({ key: column.key, label: column.label })),
        lines: view.lines.slice(0, MAX_STATEMENT_ROWS).map((line) => ({
          kind: line.kind,
          label: line.label,
          number: "number" in line ? line.number : null,
          accountId: "accountId" in line ? line.accountId : null,
          values: "values" in line ? line.values : null,
        })),
        truncated: view.lines.length > MAX_STATEMENT_ROWS,
        href: `/reports/budget?scenario=${scenarioId}`,
      },
    };
  },
};

const partyConcentration: AssistantToolDef = {
  name: "party_concentration",
  description:
    "Rank customer revenue or vendor spend for a date range, with share of total and source-document counts. Use for concentration, dependency, and change-driver analysis. For relative periods pass a `period` preset (fiscal-calendar-resolved). Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read", "reports.read"] },
  inputSchema: z.object({
    side: z.enum(["customer", "vendor"]),
    ...rangeInputFields,
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as RangeArgs & { side: "customer" | "vendor"; limit?: number };
    if (!can(authz, a.side === "customer" ? "ar.read" : "ap.read") && !can(authz, "reports.read")) {
      return { ok: false, error: "forbidden" };
    }
    const range = await resolveToolRange(authz.user.orgId, a);
    if ("error" in range) return { ok: false, error: range.error };
    const kinds = a.side === "customer"
      ? ["customer_invoice", "customer_credit"]
      : ["vendor_bill", "vendor_credit"];
    const limit = Math.min(a.limit ?? 20, 50);
    const rows = (await db.execute<Record<string, unknown>>(sql`
      with ranked as (
        select p.id, p.display_name,
               sum(case when d.kind in ('customer_credit','vendor_credit') then -abs(d.total) else abs(d.total) end) as amount,
               count(*)::int as document_count
          from documents d join parties p on p.id = d.party_id and p.org_id = d.org_id
         where d.org_id = ${authz.user.orgId} and d.status = 'posted'
           and d.kind in (${sql.join(kinds.map((kind) => sql`${kind}`), sql`, `)})
           and d.document_date between ${range.from} and ${range.to}
         group by p.id, p.display_name
      ), totals as (select coalesce(sum(amount), 0) as total from ranked)
      select r.id, r.display_name, r.amount::text, r.document_count,
             case when t.total = 0 then 0 else round((r.amount / t.total) * 100, 2) end::text as share_percent
        from ranked r cross join totals t
       order by r.amount desc limit ${limit}
    `));
    return { ok: true, data: { side: a.side, periodLabel: range.label, fromDate: range.from, toDate: range.to, rows: rows.rows, href: a.side === "customer" ? "/ar" : "/ap" } };
  },
};

const projectProfitability: AssistantToolDef = {
  name: "project_profitability",
  description:
    "List active projects, or return one project's budget, posted revenue/cost/margin, commitments, forecast, cost drivers, and source documents. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["projects.read", "reports.read"] },
  inputSchema: z.object({
    projectId: uuidInput.optional(),
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "projects"))) return { ok: false, error: "projects_feature_disabled" };
    const a = raw as { projectId?: string; query?: string; limit?: number };
    if (a.projectId) {
      const exists = (await db.execute<{ id: string; name: string; status: string }>(sql`
        select id, name, status from projects where id = ${a.projectId} and org_id = ${authz.user.orgId}
      `));
      if (!exists.rows[0]) return { ok: false, error: "project_not_found" };
      return { ok: true, data: { project: exists.rows[0], ...(await projectCostSummary(authz.user.orgId, a.projectId)), href: `/projects/${a.projectId}` } };
    }
    const limit = Math.min(a.limit ?? 20, 50);
    const like = a.query ? `%${a.query}%` : null;
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select p.id, p.name, p.status, p.starts_on, p.ends_on, c.display_name as customer
        from projects p left join parties c on c.id = p.customer_id and c.org_id = p.org_id
       where p.org_id = ${authz.user.orgId}
         ${like ? sql`and (p.name ilike ${like} or c.display_name ilike ${like})` : sql``}
       order by case p.status when 'active' then 0 when 'awarded' then 1 else 2 end, p.name
       limit ${limit}
    `));
    return { ok: true, data: { returned: rows.rows.length, projects: rows.rows, href: "/projects" } };
  },
};

// ---------------------------------------------------------------------------
// Continuous close work queue
// ---------------------------------------------------------------------------

const continuousCloseFindings: AssistantToolDef = {
  name: "continuous_close_findings",
  description:
    "List evidence-backed Accounting or Finance continuous-close findings. Defaults to active findings and returns exact materiality, detector summary, evidence count, and a link to review each item. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["banking.read", "gl.read", "close.read", "reports.read", "budgets.read"] },
  inputSchema: z.object({
    agent: z.enum(["accounting", "finance"]).optional(),
    status: z.enum(["open", "in_review", "resolved", "dismissed"]).optional(),
    severity: z.enum(["info", "warning", "critical"]).optional(),
    query: z.string().max(100).optional(),
    limit: z.number().int().min(1).max(50).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "continuousClose"))) {
      return { ok: false, error: "continuous_close_feature_disabled" };
    }
    const a = raw as {
      agent?: "accounting" | "finance";
      status?: "open" | "in_review" | "resolved" | "dismissed";
      severity?: "info" | "warning" | "critical";
      query?: string;
      limit?: number;
    };
    const readable = readableContinuousCloseAgents(authz);
    if (a.agent && !readable.includes(a.agent)) return { ok: false, error: "forbidden" };
    const agents = a.agent ? [a.agent] : readable;
    if (agents.length === 0) return { ok: false, error: "forbidden" };
    const statuses = a.status ? [a.status] : ["open", "in_review"];
    const limit = Math.min(a.limit ?? 20, 50);
    const q = a.query?.trim();
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select w.id, w.agent_key, w.finding_type, w.severity, w.status,
             w.confidence::text, w.materiality::text, w.summary,
             w.last_detected_at,
             (select count(*)::int from ai_work_item_evidence e
               where e.org_id = w.org_id and e.work_item_id = w.id) as evidence_count
        from ai_work_items w
       where w.org_id = ${authz.user.orgId}
         and w.agent_key in (${sql.join(agents.map((agent) => sql`${agent}`), sql`, `)})
         and w.status in (${sql.join(statuses.map((status) => sql`${status}`), sql`, `)})
         ${a.severity ? sql`and w.severity = ${a.severity}` : sql``}
         ${q ? sql`and (w.finding_type ilike ${`%${q}%`} or w.summary::text ilike ${`%${q}%`})` : sql``}
       order by case w.severity when 'critical' then 3 when 'warning' then 2 else 1 end desc,
                w.materiality desc, w.last_detected_at desc
       limit ${limit}
    `));
    return {
      ok: true,
      data: {
        returned: rows.rows.length,
        truncated: rows.rows.length === limit,
        items: rows.rows.map((row) => ({
          id: row.id,
          agent: row.agent_key,
          findingType: row.finding_type,
          severity: row.severity,
          status: row.status,
          confidence: row.confidence,
          materiality: row.materiality,
          summary: row.summary,
          evidenceCount: row.evidence_count,
          lastDetectedAt: row.last_detected_at,
          href: `/continuous-close?item=${row.id}`,
        })),
      },
    };
  },
};

const getContinuousCloseFinding: AssistantToolDef = {
  name: "get_continuous_close_finding",
  description:
    "Load one continuous-close finding with its exact detector summary and complete evidence packet. Use this before explaining root cause or recommending action. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["banking.read", "gl.read", "close.read", "reports.read", "budgets.read"] },
  inputSchema: z.object({ findingId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "continuousClose"))) {
      return { ok: false, error: "continuous_close_feature_disabled" };
    }
    const findingId = (raw as { findingId: string }).findingId;
    const item = (await db.execute<Record<string, unknown>>(sql`
      select id, agent_key, finding_type, detector_version, severity, status,
             confidence::text, materiality::text, subject_type, subject_id,
             summary, first_detected_at, last_detected_at
        from ai_work_items
       where id = ${findingId} and org_id = ${authz.user.orgId}
    `));
    const row = item.rows[0];
    if (!row) return { ok: false, error: "finding_not_found" };
    if (!readableContinuousCloseAgents(authz).includes(row.agent_key as "accounting" | "finance")) {
      return { ok: false, error: "forbidden" };
    }
    const evidence = (await db.execute<Record<string, unknown>>(sql`
      select id, kind, source_type, source_id, data, created_at
        from ai_work_item_evidence
       where org_id = ${authz.user.orgId} and work_item_id = ${findingId}
       order by created_at, id
       limit 100
    `));
    return {
      ok: true,
      data: {
        ...row,
        evidence: evidence.rows,
        evidenceTruncated: evidence.rows.length === 100,
        href: `/continuous-close?item=${findingId}`,
      },
    };
  },
};

// ---------------------------------------------------------------------------
// Open items — the allocation resolver for payments
// ---------------------------------------------------------------------------

const listOpenItems: AssistantToolDef = {
  name: "list_open_items",
  description:
    "Open (unpaid/unapplied) AR or AP items as of a date, optionally for one party. Each item carries the openLineId that payment allocations require, its source document, due date, and remaining amount — resolve allocations from here, never by guessing ids. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read"] },
  inputSchema: z.object({
    side: z.enum(["ar", "ap"]),
    asOf: dateInput.optional(),
    partyId: uuidInput.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { side: "ar" | "ap"; asOf?: string; partyId?: string; limit?: number };
    if (!can(authz, a.side === "ar" ? "ar.read" : "ap.read")) {
      return { ok: false, error: "forbidden" };
    }
    const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
    const all = await openItems(authz.user.orgId, a.side, asOf);
    const scoped = a.partyId ? all.filter((item) => item.partyId === a.partyId) : all;
    scoped.sort((x, y) =>
      (x.dueDate ?? x.tranDate).getTime() - (y.dueDate ?? y.tranDate).getTime());
    const items = scoped.slice(0, a.limit ?? 100).map((item) => ({
      openLineId: item.id,
      documentId: item.docId,
      documentKind: item.docKind,
      documentNumber: item.docNumber,
      partyId: item.partyId,
      party: item.partyName,
      tranDate: item.tranDate.toISOString().slice(0, 10),
      dueDate: item.dueDate ? item.dueDate.toISOString().slice(0, 10) : null,
      remaining: num(item.remaining),
    }));
    return {
      ok: true,
      data: { side: a.side, asOf, totalCount: scoped.length, items },
      note: `${scoped.length} open ${a.side.toUpperCase()} item${scoped.length === 1 ? "" : "s"} as of ${asOf}${items.length < scoped.length ? ` (showing ${items.length})` : ""}`,
    };
  },
};

export const READ_TOOLS: AssistantToolDef[] = [
  whoami,
  findAccounts,
  accountRegisterTool,
  findJournalEntries,
  getJournalEntry,
  findDocuments,
  getDocument,
  findParties,
  profitAndLossTool,
  balanceSheetTool,
  trialBalanceTool,
  agingTool,
  listOpenItems,
  cashFlowTool,
  financialPeriods,
  financialTrends,
  budgetVsActualTool,
  partyConcentration,
  projectProfitability,
  continuousCloseFindings,
  getContinuousCloseFinding,
];
