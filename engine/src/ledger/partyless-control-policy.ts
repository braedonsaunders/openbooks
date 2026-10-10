import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { type KernelLine, PostingError } from "../journal/posting-contracts.ts";

/**
 * Direct postings to receivable/payable accounts from manual journals and
 * bank deposits.
 *
 * A journal or deposit line on a receivable or payable account that names a
 * customer or vendor becomes an open item and stays inside the sub-ledger.
 * A line that names no party moves the GL balance without any open item, so
 * the receivable/payable sub-ledger (aging, statements, open balances) and
 * the GL no longer agree on that account. The organization chooses whether
 * such a posting is accepted with a warning or refused (Setup → Company & Accounting →
 * Control accounts). The project-tracked retainage controls are exempt: held
 * retainage is tracked per project, not per open item.
 */
export type PartylessControlPolicy = "warn" | "refuse";

export const PARTYLESS_CONTROL_POLICIES: readonly PartylessControlPolicy[] = ["warn", "refuse"];

/** Kinds whose lines an operator authors directly against any account. */
export const DIRECT_LEDGER_KINDS: ReadonlySet<string> = new Set(["journal", "deposit"]);

export function parsePartylessControlPolicy(value: unknown): PartylessControlPolicy {
  return value === "refuse" ? "refuse" : "warn";
}

export async function partylessControlPolicy(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
): Promise<PartylessControlPolicy> {
  const row = (await runner.execute<{ policy: string | null }>(sql`
    select settings->'ledger'->>'partylessControlPolicy' as policy from orgs where id = ${orgId}`)).rows[0];
  return parsePartylessControlPolicy(row?.policy);
}

export interface PartylessControlAccount {
  id: string;
  number: string | null;
  name: string;
  type: "asset_receivable" | "liability_payable";
}

/**
 * Receivable/payable accounts whose party-less lines leave the sub-ledger:
 * every asset_receivable / liability_payable account except the configured
 * retainage receivable and retainage payable controls.
 */
export async function partylessControlAccounts(
  runner: Pick<SqlExecutor, "execute">,
  orgId: string,
): Promise<Map<string, PartylessControlAccount>> {
  const rows = (await runner.execute<PartylessControlAccount>(sql`
    select a.id, a.number, a.name, a.type
      from accounts a
      join orgs o on o.id = a.org_id
     where a.org_id = ${orgId}
       and a.type in ('asset_receivable', 'liability_payable')
       and a.id::text is distinct from nullif(o.settings->'controlAccounts'->>'retainageReceivable', '')
       and a.id::text is distinct from nullif(o.settings->'controlAccounts'->>'retainagePayable', '')`)).rows;
  return new Map(rows.map((row) => [row.id, row]));
}

/**
 * Refuse a journal or deposit that would post a party-less line to a
 * receivable/payable account when the organization's policy is "refuse".
 * Under "warn" the posting proceeds and the caller reports the lines.
 */
export async function assertPartylessControlPolicy(
  runner: Pick<SqlExecutor, "execute">,
  doc: { orgId: string; kind: string; documentNumber: string },
  lines: readonly Pick<KernelLine, "accountId" | "partyId">[],
): Promise<void> {
  if (!DIRECT_LEDGER_KINDS.has(doc.kind)) return;
  if (!lines.some((line) => !line.partyId)) return;
  if ((await partylessControlPolicy(runner, doc.orgId)) !== "refuse") return;
  const accounts = await partylessControlAccounts(runner, doc.orgId);
  const hit = lines.find((line) => !line.partyId && accounts.has(line.accountId));
  if (!hit) return;
  const account = accounts.get(hit.accountId)!;
  const display = `${account.number ? `${account.number} · ` : ""}${account.name}`;
  const receivable = account.type === "asset_receivable";
  throw new PostingError(
    `${doc.documentNumber} posts to ${receivable ? "receivable" : "payable"} account ${display} without a ${receivable ? "customer" : "vendor"}, ` +
      `which would put the GL out of agreement with the ${receivable ? "receivable" : "payable"} sub-ledger — ` +
      (receivable
        ? "record customer receipts with Receive payment (Customer Payments) and adjustments with a credit memo, or name the customer on the line"
        : "record supplier payments with Pay bills (Payments) and adjustments with a vendor credit, or name the vendor on the line") +
      "; the organization refuses these postings under Setup → Company & Accounting → Control accounts",
  );
}
