import "server-only";
import { sql } from "drizzle-orm";
import { db } from "@openbooks/engine/src/db.ts";
import type { DimFilter } from "./reports";

/**
 * Layout-driven statement rendering. A layout is ordered rows of:
 *  - group:    accounts matched by number prefix and/or account type
 *  - subtotal: sum of named groups
 *  - formula:  plus/minus over any previously computed labeled row
 *  - spacer:   visual break
 * Accounts match the FIRST group that claims them; anything left over
 * lands in an automatic "Other" group — statements never silently drop
 * activity.
 */

export type LayoutRow =
  | { kind: "group"; label: string; match: { numberPrefixes?: string[]; types?: string[] }; collapsed?: boolean }
  | { kind: "subtotal"; label: string; of: string[] }
  | { kind: "formula"; label: string; plus?: string[]; minus?: string[] }
  | { kind: "spacer" };

export interface RenderedLine {
  kind: "header" | "account" | "total" | "spacer";
  label: string;
  amount?: number;
  accountId?: string;
  number?: string | null;
  emphasis?: boolean;
}

const CREDIT_NORMAL = new Set([
  "income", "income_other",
  "liability_payable", "liability_card", "liability_current_other", "liability_long_term",
  "equity",
]);
const PNL_TYPES = ["income", "income_other", "cogs", "expense", "expense_other", "expense_deferred"];

export async function layoutsFor(statement: "pnl" | "balance_sheet") {
  const r = (await db.execute(sql`
    select id, name, is_default from statement_layouts
     where statement = ${statement} order by is_default desc, name`)) as any;
  return r.rows as { id: string; name: string; is_default: boolean }[];
}

export async function renderLayout(
  layoutId: string,
  from: string,
  to: string,
  dims?: DimFilter,
): Promise<{ name: string; lines: RenderedLine[] } | null> {
  const lay = (await db.execute(sql`select name, statement, rows from statement_layouts where id = ${layoutId}`)) as any;
  if (!lay.rows[0]) return null;
  const rows = lay.rows[0].rows as LayoutRow[];

  let dimSql = sql`true`;
  if (dims?.departmentId) dimSql = sql`${dimSql} and l.department_id = ${dims.departmentId}`;
  if (dims?.projectId) dimSql = sql`${dimSql} and l.project_id = ${dims.projectId}`;

  const balances = (await db.execute(sql`
    select a.id, a.number, a.name, a.type, sum(l.amount) as raw
      from journal_lines l
      join accounts a on a.id = l.account_id
      join journal_entries e on e.id = l.entry_id
     where a.type in ${PNL_TYPES}
       and e.posting_date >= ${from} and e.posting_date <= ${to}
       and ${dimSql}
     group by a.id having abs(sum(l.amount)) >= 0.005
     order by a.number nulls last, a.name
  `)) as any;

  type Acct = { id: string; number: string | null; name: string; type: string; value: number };
  const accounts: Acct[] = balances.rows.map((r: any) => ({
    id: r.id, number: r.number, name: r.name, type: r.type,
    value: CREDIT_NORMAL.has(r.type) ? -Number(r.raw) : Number(r.raw),
  }));

  const claimed = new Set<string>();
  const computed = new Map<string, number>();
  const lines: RenderedLine[] = [];

  const emitGroup = (label: string, members: Acct[], collapsed: boolean) => {
    const total = members.reduce((a, m) => a + m.value, 0);
    lines.push({ kind: "header", label });
    if (!collapsed) {
      for (const m of members) {
        lines.push({ kind: "account", label: m.name, number: m.number, accountId: m.id, amount: m.value });
      }
    }
    lines.push({ kind: "total", label: `Total ${label}`, amount: total });
    computed.set(label, total);
  };

  for (const row of rows) {
    if (row.kind === "spacer") { lines.push({ kind: "spacer", label: "" }); continue; }
    if (row.kind === "group") {
      const members = accounts.filter((a) => {
        if (claimed.has(a.id)) return false;
        const m = row.match ?? {};
        const byPrefix = m.numberPrefixes?.some((p) => (a.number ?? "").startsWith(p)) ?? false;
        const byType = m.types?.includes(a.type) ?? false;
        return byPrefix || byType;
      });
      members.forEach((m) => claimed.add(m.id));
      emitGroup(row.label, members, row.collapsed ?? false);
      continue;
    }
    if (row.kind === "subtotal") {
      const total = row.of.reduce((a, label) => a + (computed.get(label) ?? 0), 0);
      lines.push({ kind: "total", label: row.label, amount: total, emphasis: true });
      computed.set(row.label, total);
      continue;
    }
    // formula
    const total =
      (row.plus ?? []).reduce((a, l) => a + (computed.get(l) ?? 0), 0) -
      (row.minus ?? []).reduce((a, l) => a + (computed.get(l) ?? 0), 0);
    lines.push({ kind: "total", label: row.label, amount: total, emphasis: true });
    computed.set(row.label, total);
  }

  const leftovers = accounts.filter((a) => !claimed.has(a.id));
  if (leftovers.length > 0) emitGroup("Other", leftovers, false);

  return { name: lay.rows[0].name, lines };
}
