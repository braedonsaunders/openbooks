import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import { reconciliationTotals } from "@openbooks/engine/src/banking.ts";
import { isFeatureEnabled } from "../features";
import type { AssistantToolDef, ToolResult } from "./types";
import { uuidInput, num, capList } from "./tools-shared";

/**
 * Banking read/search tools for the agentic assistant. Every tool is
 * permission-gated with the same keys the banking pages use and reuses the
 * exact SQL shapes those pages render from, so the assistant can never
 * disagree with the screens. Bank feed credentials are sealed at rest and are
 * NEVER selected here.
 */

const listBankReconciliations: AssistantToolDef = {
  name: "list_bank_reconciliations",
  description:
    "List bank reconciliation sessions (newest first), optionally for one account: through-date, statement balance, status, sign-off timestamp, and the reconciled account. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["banking.read"] },
  inputSchema: z.object({
    accountId: uuidInput.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { accountId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
             r.signed_off_at, r.created_at,
             a.number as account_number, a.name as account_name
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.org_id = ${authz.user.orgId}
         ${a.accountId ? sql` and r.account_id = ${a.accountId}` : sql``}
       order by r.created_at desc
       limit ${limit}
    `));
    return {
      ok: true,
      data: {
        returned: rows.rows.length,
        reconciliations: rows.rows.map((r) => ({
          id: r.id,
          accountId: r.account_id,
          accountNumber: r.account_number,
          accountName: r.account_name,
          throughDate: r.through_date,
          statementBalance: num(r.statement_balance),
          status: r.status,
          signedOffAt: r.signed_off_at,
          createdAt: r.created_at,
        })),
        href: "/banking/reconcile",
      },
    };
  },
};

const getBankReconciliation: AssistantToolDef = {
  name: "get_bank_reconciliation",
  description:
    "One reconciliation session's detail: account, through-date, status, plus running totals (statement balance, cleared balance, difference, matched/unmatched line counts) — the same numbers the workspace badge and sign-off gate use. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["banking.read"] },
  inputSchema: z.object({ reconciliationId: uuidInput }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { reconciliationId: string };
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select r.id, r.account_id, r.through_date, r.statement_balance, r.status,
             r.signed_off_at, r.created_at,
             a.number as account_number, a.name as account_name
        from reconciliations r
        join accounts a on a.id = r.account_id and a.org_id = r.org_id
       where r.org_id = ${authz.user.orgId} and r.id = ${a.reconciliationId}
    `));
    const recon = rows.rows[0];
    if (!recon) return { ok: false, error: "reconciliation_not_found" };
    const totals = await reconciliationTotals(a.reconciliationId, {
      orgId: authz.user.orgId,
      userId: authz.user.id,
    });
    return {
      ok: true,
      data: {
        id: recon.id,
        accountId: recon.account_id,
        accountNumber: recon.account_number,
        accountName: recon.account_name,
        throughDate: recon.through_date,
        status: recon.status,
        signedOffAt: recon.signed_off_at,
        createdAt: recon.created_at,
        statementBalance: num(totals.statementBalance),
        clearedBalance: num(totals.clearedBalance),
        difference: num(totals.difference),
        matchedStatementLines: totals.matchedStatementLines,
        unmatchedStatementLines: totals.unmatchedStatementLines,
        matchedJournalLines: totals.matchedJournalLines,
        href: "/banking/reconcile",
      },
    };
  },
};

const listUnmatchedBankLines: AssistantToolDef = {
  name: "list_unmatched_bank_lines",
  description:
    "List imported bank statement lines still awaiting a match (no reconciliation match, not excluded), optionally for one account: date, description, counterparty reference, amount, and the bank account, with the total unmatched count. Read-only.",
  category: "search",
  gate: { mode: "anyOf", perms: ["banking.reconcile"] },
  inputSchema: z.object({
    accountId: uuidInput.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    const a = raw as { accountId?: string; limit?: number };
    const limit = Math.min(a.limit ?? 50, 200);
    const where = sql`l.org_id = ${authz.user.orgId} and l.match_status = 'unmatched'
      ${a.accountId ? sql` and l.account_id = ${a.accountId}` : sql``}`;
    const [rows, count] = (await Promise.all([
      db.execute<Record<string, unknown>>(sql`
        select l.id, l.posted_on, l.amount, l.description, l.counterparty_ref,
               l.account_id, a.number as account_number, a.name as account_name
          from bank_statement_lines l
          join accounts a on a.id = l.account_id and a.org_id = l.org_id
         where ${where}
         order by l.posted_on desc, l.line_number
         limit ${limit}
      `),
      db.execute<{ n: string }>(sql`select count(*) as n from bank_statement_lines l where ${where}`),
    ]));
    const total = Number(count.rows[0]?.n ?? 0);
    const { items, truncated } = capList(
      rows.rows.map((l) => ({
        id: l.id,
        date: l.posted_on,
        description: l.description,
        counterpartyRef: l.counterparty_ref,
        amount: num(l.amount),
        accountId: l.account_id,
        accountNumber: l.account_number,
        accountName: l.account_name,
      })),
      limit,
    );
    return {
      ok: true,
      data: {
        total,
        returned: items.length,
        truncated: truncated || total > items.length,
        lines: items,
        href: "/banking/match",
      },
    };
  },
};

const listBankFeeds: AssistantToolDef = {
  name: "list_bank_feeds",
  description:
    "List bank feed connections: provider, name, linked GL account, status, sync cadence, next/last sync timestamps, last result, and whether credentials are configured. Credentials themselves are sealed and never returned. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["admin.setup.manage"] },
  inputSchema: z.object({}),
  execute: async (_raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "bankFeeds"))) {
      return { ok: false, error: "bank_feeds_feature_disabled" };
    }
    // Deliberately never selects the sealed `credentials` column — only the
    // fact that credentials exist.
    const rows = (await db.execute<Record<string, unknown>>(sql`
      select c.id, c.name, c.provider, c.account_id, c.status,
             c.external_account_id, c.sync_cadence,
             c.next_sync_at, c.last_sync_at, c.last_result, c.last_error, c.is_active,
             (c.credentials is not null) as has_credentials,
             a.number as account_number, a.name as account_name
        from bank_feed_connections c
        join accounts a on a.id = c.account_id and a.org_id = c.org_id
       where c.org_id = ${authz.user.orgId}
       order by c.created_at desc
       limit 200
    `));
    return {
      ok: true,
      data: {
        returned: rows.rows.length,
        connections: rows.rows.map((c) => ({
          id: c.id,
          name: c.name,
          provider: c.provider,
          accountId: c.account_id,
          accountNumber: c.account_number,
          accountName: c.account_name,
          status: c.status,
          externalAccountId: c.external_account_id,
          syncCadence: c.sync_cadence,
          nextSyncAt: c.next_sync_at,
          lastSyncAt: c.last_sync_at,
          lastResult: c.last_result,
          lastError: c.last_error,
          isActive: c.is_active,
          hasCredentials: c.has_credentials,
        })),
        href: "/admin/setup/bank-feeds",
      },
    };
  },
};

export const BANKING_TOOLS: AssistantToolDef[] = [
  listBankReconciliations,
  getBankReconciliation,
  listUnmatchedBankLines,
  listBankFeeds,
];
