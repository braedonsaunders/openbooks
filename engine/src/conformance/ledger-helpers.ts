/**
 * Ledger-tier helpers.
 *
 * A `ledger` case proves a requirement by driving the REAL posting kernel and
 * the real subledger services, then reading the general ledger back. Nothing
 * here computes accounting — it only sets up source documents and observes the
 * ledger.
 *
 * `capture` is the core primitive: it snapshots every account balance in the
 * tenant, runs a step, snapshots again, and returns the non-zero deltas as one
 * entry. Observing the whole account set (rather than one journal entry) means
 * a case sees the COMPLETE accounting consequence of a business step, including
 * subledger entries the step posts indirectly. Because the set is complete and
 * every posting balances, the delta always sums to zero — the runner asserts
 * that independently.
 */

import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../db.ts";
import { fromUnits, toUnits } from "../money.ts";
import { postDocument, type PostingDeps } from "../posting.ts";
import type { ActualEntry, ActualLine, CaseContext, LedgerContext } from "./types.ts";

/** Posting dependencies for the conformance tenant. */
export function deps(ctx: CaseContext): PostingDeps {
  return {
    control: {
      ar: ctx.roles.ar,
      ap: ctx.roles.ap,
      bank: ctx.roles.bank,
      taxCollected: ctx.roles.taxPayable,
      taxPaid: ctx.roles.taxRecoverable,
      fxRealizedGainLoss: ctx.roles.fxRealizedGainLoss,
    },
  };
}

/**
 * Every account balance in the tenant, keyed by account id.
 *
 * `asOf` bounds the balance by POSTING DATE, which is what makes period-end
 * processes observable: a period-end adjustment and its next-period reversal
 * both exist in the ledger the moment the process runs, and a balance-sheet
 * date is the only thing that separates them.
 */
async function balances(orgId: string, asOf?: string): Promise<Map<string, bigint>> {
  const rows = (await db.execute(sql`
    select l.account_id as account_id, coalesce(sum(l.amount), 0)::text as balance
      from journal_lines l
      join journal_entries e on e.id = l.entry_id
     where l.org_id = ${orgId} and e.status in ('posted', 'reversed')
       and (${asOf ?? null}::date is null or e.posting_date <= ${asOf ?? null}::date)
     group by l.account_id`)) as unknown as {
    rows: { account_id: string; balance: string }[];
  };
  const map = new Map<string, bigint>();
  for (const row of rows.rows) map.set(row.account_id, toUnits(row.balance));
  return map;
}

/**
 * Run `step` and return the complete general-ledger movement it caused, as one
 * entry labelled `label`. Accounts whose balance did not move are omitted.
 * With `asOf`, the movement is measured as at that balance-sheet date.
 */
export async function capture(
  ctx: CaseContext,
  label: string,
  step: () => Promise<void>,
  options: { asOf?: string } = {},
): Promise<ActualEntry> {
  const orgId = ctx.ledger!.orgId;
  const before = await balances(orgId, options.asOf);
  await step();
  const after = await balances(orgId, options.asOf);

  const accounts = new Set<string>([...before.keys(), ...after.keys()]);
  const lines: ActualLine[] = [];
  for (const accountId of [...accounts].sort()) {
    const delta = (after.get(accountId) ?? 0n) - (before.get(accountId) ?? 0n);
    if (delta !== 0n) lines.push({ accountId, amount: fromUnits(delta) });
  }
  return { step: label, lines };
}

export interface DraftLine {
  itemId?: string | null;
  accountId?: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
  stockLocationId?: string | null;
}

export interface DraftDocumentInput {
  kind: "customer_invoice" | "vendor_bill" | "journal";
  number: string;
  lines: DraftLine[];
  partyId?: string | null;
  /** Transaction currency; defaults to the tenant base currency. */
  currency?: string;
  /** Transaction→functional rate; defaults to 1. */
  fxRate?: string;
  date?: string;
}

/**
 * Insert an APPROVED source document with its lines. Approved, not draft:
 * `postDocument` refuses anything that has not completed the approval
 * lifecycle, and the approval workflow is not what these cases are testing.
 */
export async function draftDocument(
  ledger: LedgerContext,
  input: DraftDocumentInput,
): Promise<string> {
  const documentId = randomUUID();
  const date = input.date ?? ledger.date;
  const currency = input.currency ?? "CAD";
  const fxRate = input.fxRate ?? "1";
  const subtotal = fromUnits(input.lines.reduce((sum, l) => sum + toUnits(l.amount), 0n));

  await db.execute(sql`
    insert into documents (id, org_id, kind, document_number, party_id, subsidiary_id, document_date, posting_date,
                           currency, fx_rate, status, subtotal, tax_total, total, is_final_invoice, custom, extra_dims)
    values (${documentId}, ${ledger.orgId}, ${input.kind}, ${input.number}, ${input.partyId ?? null},
            ${ledger.subsidiaryId}, ${date}, ${date}, ${currency}, ${fxRate}, 'approved',
            ${subtotal}, '0', ${subtotal}, false, '{}'::jsonb, '{}'::jsonb)`);

  let lineNumber = 1;
  for (const line of input.lines) {
    await db.execute(sql`
      insert into document_lines (id, org_id, document_id, line_number, item_id, account_id, quantity, unit_price,
                                  amount, tax_amount, is_billable, quantity_fulfilled, quantity_billed,
                                  stock_location_id, custom, tax_overridden, extra_dims)
      values (${randomUUID()}, ${ledger.orgId}, ${documentId}, ${lineNumber}, ${line.itemId ?? null},
              ${line.accountId ?? null}, ${line.quantity}, ${line.unitPrice}, ${line.amount}, '0',
              false, '0', '0', ${line.stockLocationId ?? null}, '{}'::jsonb, false, '{}'::jsonb)`);
    lineNumber++;
  }
  return documentId;
}

/** Draft + post in one step; returns the posted journal entry id. */
export async function postNewDocument(
  ctx: CaseContext,
  input: DraftDocumentInput,
): Promise<string> {
  const documentId = await draftDocument(ctx.ledger!, input);
  return await postDocument(documentId, deps(ctx));
}

/** Record a spot rate the posting kernel and revaluation service will resolve. */
export async function setSpotRate(
  ledger: LedgerContext,
  from: string,
  to: string,
  asOf: string,
  rate: string,
): Promise<void> {
  await db.execute(sql`
    insert into fx_rates (id, org_id, from_currency, to_currency, as_of, rate_type, rate, source)
    values (${randomUUID()}, ${ledger.orgId}, ${from}, ${to}, ${asOf}, 'spot', ${rate}, 'manual')
    on conflict (org_id, from_currency, to_currency, as_of, rate_type)
      do update set rate = excluded.rate`);
}

/** The accounting period covering a date, for services that take a period id. */
export async function periodFor(ledger: LedgerContext, date: string): Promise<string> {
  const rows = (await db.execute(sql`
    select id from accounting_periods
     where org_id = ${ledger.orgId} and not is_adjustment and starts_on <= ${date} and ends_on >= ${date}
     limit 1`)) as unknown as { rows: { id: string }[] };
  const id = rows.rows[0]?.id;
  if (!id) throw new Error(`no accounting period covers ${date}`);
  return id;
}
