import "server-only";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/platform/db.ts";
import { normalizeMoney } from "@openbooks/engine/src/money/money.ts";
import { isFeatureEnabled } from "../features";
import { subsidiaryVisibleFilter } from "../subsidiaries";
import type { AssistantToolDef, ToolResult } from "./types";
import { dateInput, orgToday } from "./tools-shared";

/**
 * Construction-billing reads. Retainage (holdback) is not a separate document
 * in openbooks: a progress invoice carries one negative line to the org's
 * Retainage Receivable control account (settings.controlAccounts), and a
 * release re-invoices it. The held balance is therefore the ledger balance
 * of that control account — this tool reads it exactly as the balance sheet
 * would and breaks it down by party, project, or source document.
 */

const money = (v: unknown) => normalizeMoney(v == null ? "0" : String(v));

const retainageBalances: AssistantToolDef = {
  name: "retainage_balances",
  description:
    "Retainage/holdback control balances as of a date (receivable and payable), by party, project, or document, with total. Reports whether the control account is configured. Read-only.",
  category: "read",
  gate: { mode: "anyOf", perms: ["ar.read", "ap.read", "projects.read", "gl.read"] },
  feature: "projects",
  inputSchema: z.object({
    side: z.enum(["receivable", "payable"]).optional().describe("Default receivable (customer holdbacks)"),
    asOf: dateInput.optional().describe("Default today"),
    groupBy: z.enum(["party", "project", "document"]).optional().describe("Default party"),
    limit: z.number().int().min(1).max(200).optional().describe("Default 50"),
  }),
  execute: async (raw, authz): Promise<ToolResult> => {
    if (!(await isFeatureEnabled(authz.user.orgId, "projects"))) return { ok: false, error: "projects_feature_disabled" };
    const a = raw as { side?: "receivable" | "payable"; asOf?: string; groupBy?: "party" | "project" | "document"; limit?: number };
    const side = a.side ?? "receivable";
    const groupBy = a.groupBy ?? "party";
    const limit = Math.min(a.limit ?? 50, 200);
    const asOf = a.asOf ?? (await orgToday(authz.user.orgId));
    const orgId = authz.user.orgId;
    const roleKey = side === "receivable" ? "retainageReceivable" : "retainagePayable";
    const acct = (await db.execute<{ id: string; number: string | null; name: string; type: string }>(sql`
      select a.id, a.number, a.name, a.type
        from orgs o
        join accounts a on a.id = nullif(o.settings->'controlAccounts'->>${roleKey}, '')::uuid and a.org_id = o.id
       where o.id = ${orgId}
    `)).rows[0];
    if (!acct) {
      return {
        ok: true,
        note: `No ${side === "receivable" ? "retainage receivable" : "retainage payable"} control account is configured (Setup → Control accounts). Retainage cannot be tracked separately until one is assigned; open invoices may still carry holdback lines.`,
        data: { side, asOf, configured: false, total: "0.0000", rows: [], href: "/admin/setup/control-accounts" },
      };
    }
    // Receivable is debit-normal (held = positive); payable is credit-normal.
    const signed = side === "receivable" ? sql`sum(l.amount)` : sql`-sum(l.amount)`;
    const lineScope = subsidiaryVisibleFilter(sql`l.subsidiary_id`, authz.allowedSubsidiaryIds);
    const base = sql`
      from journal_lines l
      join journal_entries e on e.id = l.entry_id and e.org_id = l.org_id
     where l.org_id = ${orgId}
       and l.account_id = ${acct.id}
       and e.status in ('posted', 'reversed')
       and e.book_id = (select b.id from accounting_books b
                          where b.org_id = ${orgId} and b.is_primary and b.is_active and b.posts_gl limit 1)
       and e.posting_date <= ${asOf}
       ${lineScope}
    `;
    const total = (await db.execute<{ total: string; lines: number }>(sql`
      select coalesce(${signed}, 0) as total, count(*)::int as lines ${base}
    `)).rows[0];
    let rows: Record<string, unknown>[];
    if (groupBy === "party") {
      rows = (await db.execute<Record<string, unknown>>(sql`
        select p.id as party_id, p.display_name as party, coalesce(${signed}, 0) as balance, count(*)::int as lines
          ${base}
          left join parties p on p.id = l.party_id and p.org_id = l.org_id
         group by p.id, p.display_name
        having coalesce(${signed}, 0) <> 0
         order by abs(coalesce(${signed}, 0)) desc
         limit ${limit}
      `)).rows;
    } else if (groupBy === "project") {
      rows = (await db.execute<Record<string, unknown>>(sql`
        select pr.id as project_id, pr.name as project, pr.code as project_code, coalesce(${signed}, 0) as balance, count(*)::int as lines
          ${base}
          left join projects pr on pr.id = l.project_id and pr.org_id = l.org_id
         group by pr.id, pr.name, pr.code
        having coalesce(${signed}, 0) <> 0
         order by abs(coalesce(${signed}, 0)) desc
         limit ${limit}
      `)).rows;
    } else {
      rows = (await db.execute<Record<string, unknown>>(sql`
        select d.id as document_id, d.kind, d.document_number, d.document_date, d.status,
               p.display_name as party, coalesce(${signed}, 0) as balance
          ${base}
          left join documents d on d.id = e.source_document_id and d.org_id = e.org_id
          left join parties p on p.id = d.party_id and p.org_id = d.org_id
         group by d.id, d.kind, d.document_number, d.document_date, d.status, p.display_name
        having coalesce(${signed}, 0) <> 0
         order by abs(coalesce(${signed}, 0)) desc
         limit ${limit}
      `)).rows;
    }
    return {
      ok: true,
      data: {
        side,
        asOf,
        configured: true,
        account: { id: acct.id, number: acct.number, name: acct.name, type: acct.type },
        total: money(total?.total),
        lines: total?.lines ?? 0,
        groupBy,
        returned: rows.length,
        truncated: rows.length === limit,
        rows: rows.map((r) => ({ ...r, balance: money(r.balance) })),
        href: `/accounts?account=${acct.id}`,
      },
    };
  },
};

export const CONSTRUCTION_TOOLS: AssistantToolDef[] = [retainageBalances];
