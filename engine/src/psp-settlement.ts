import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "./db.ts";
import { assertPeriodModulesOpen } from "./close.ts";
import { cmp, fromUnits, isZero, neg, toUnits } from "./money.ts";
import { sealJson } from "./secrets.ts";
import { assertNotSandbox } from "./sandbox/guard.ts";

/**
 * PSP settlement import — Stripe / Recurly / Chargebee payout batches post
 * through the inventory-style kernel path (balanced journal_entries origin
 * `document` or allocation). Fees, disputes, refunds, and FX legs are
 * evidence-backed settlement_lines. Idempotent on (org, provider, externalRef).
 */

export type PspProvider = "stripe" | "recurly" | "chargebee";
export type SettlementLineKind =
  | "charge"
  | "refund"
  | "fee"
  | "dispute"
  | "dispute_reversal"
  | "fx_adjustment"
  | "transfer"
  | "other";

export class PspSettlementError extends Error {}

export interface ParsedSettlementLine {
  kind: SettlementLineKind;
  amount: string; // signed; fees/refunds usually negative of gross narrative in provider but we store natural sign by kind
  externalRef?: string | null;
  description?: string | null;
  currency?: string | null;
  meta?: Record<string, unknown>;
}

export interface ParsedSettlement {
  provider: PspProvider;
  externalRef: string;
  settlementDate: string;
  currency: string;
  lines: ParsedSettlementLine[];
  memo?: string | null;
  raw?: Record<string, unknown>;
}

function fromPspMinorUnits(
  amount: number,
  field: string,
  absolute = false,
): string {
  if (!Number.isSafeInteger(amount)) {
    throw new PspSettlementError(
      `${field} must be a safe integer in provider minor units`,
    );
  }
  const units = BigInt(amount);
  return fromUnits((absolute && units < 0n ? -units : units) * 100n);
}

/** Pure: roll line-level amounts into batch totals. */
export function summarizeSettlement(lines: ParsedSettlementLine[]): {
  grossAmount: string;
  feeAmount: string;
  refundAmount: string;
  disputeAmount: string;
  fxAmount: string;
  netAmount: string;
} {
  let gross = 0n;
  let fee = 0n;
  let refund = 0n;
  let dispute = 0n;
  let fx = 0n;
  for (const l of lines) {
    const u = toUnits(l.amount);
    switch (l.kind) {
      case "charge":
      case "transfer":
        gross += u;
        break;
      case "fee":
        fee += u < 0n ? -u : u;
        break;
      case "refund":
        refund += u < 0n ? -u : u;
        break;
      case "dispute":
        dispute += u < 0n ? -u : u;
        break;
      case "dispute_reversal":
        dispute -= u < 0n ? -u : u;
        break;
      case "fx_adjustment":
        fx += u;
        break;
      default:
        gross += u;
    }
  }
  // Net = gross − fees − refunds − disputes + fx
  const net = gross - fee - refund - dispute + fx;
  return {
    grossAmount: fromUnits(gross),
    feeAmount: fromUnits(fee),
    refundAmount: fromUnits(refund),
    disputeAmount: fromUnits(dispute < 0n ? 0n : dispute),
    fxAmount: fromUnits(fx),
    netAmount: fromUnits(net),
  };
}

/** Stripe balance transaction export row shape (subset). */
export function parseStripeBalanceTransactions(
  rows: {
    id: string;
    type: string;
    amount: number; // cents
    fee?: number;
    net?: number;
    currency: string;
    created?: number;
    description?: string | null;
    available_on?: number;
  }[],
  payoutId: string,
  settlementDate: string,
): ParsedSettlement {
  const lines: ParsedSettlementLine[] = [];
  let currency = "USD";
  for (const r of rows) {
    currency = (r.currency ?? currency).toUpperCase();
    // Stripe amounts are in the smallest currency unit (cents). money uses 4dp of major unit.
    // 123 cents = 1.2300 → units = 12300 = cents * 100
    const major = fromPspMinorUnits(r.amount, "Stripe amount");
    const fee =
      r.fee == null
        ? null
        : fromPspMinorUnits(r.fee, "Stripe fee", true);
    if (r.net != null) {
      fromPspMinorUnits(r.net, "Stripe net amount");
    }
    const kind: SettlementLineKind =
      r.type === "stripe_fee" || r.type === "fee"
        ? "fee"
        : r.type === "refund" || r.type === "payment_refund"
          ? "refund"
          : r.type === "adjustment" &&
              (r.description ?? "").toLowerCase().includes("dispute")
            ? "dispute"
            : r.type === "payout" || r.type === "transfer"
              ? "transfer"
              : r.type.includes("dispute")
                ? "dispute"
                : "charge";
    lines.push({
      kind,
      amount: major,
      externalRef: r.id,
      description: r.description ?? r.type,
      currency,
      meta: { stripeType: r.type, fee: r.fee, net: r.net },
    });
    if (fee != null && r.fee !== 0 && kind === "charge") {
      lines.push({
        kind: "fee",
        amount: fee,
        externalRef: `${r.id}_fee`,
        description: "Stripe processing fee",
        currency,
      });
    }
  }
  return {
    provider: "stripe",
    externalRef: payoutId,
    settlementDate,
    currency,
    lines,
    memo: `Stripe payout ${payoutId}`,
    raw: { rowCount: rows.length },
  };
}

/** Recurly invoices_revenue_report / transactions export subset. */
export function parseRecurlySettlement(payload: {
  id: string;
  closed_at?: string;
  currency?: string;
  charge_amount?: string | number;
  refund_amount?: string | number;
  fee_amount?: string | number;
  net_amount?: string | number;
  lines?: {
    type: string;
    amount: string | number;
    id?: string;
    description?: string;
  }[];
}, fallbackDate?: string): ParsedSettlement {
  const currency = (payload.currency ?? "USD").toUpperCase();
  const date = (payload.closed_at ?? fallbackDate ?? new Date().toISOString()).slice(0, 10);
  const lines: ParsedSettlementLine[] = [];
  if (payload.lines?.length) {
    for (const l of payload.lines) {
      const kind: SettlementLineKind =
        l.type === "refund"
          ? "refund"
          : l.type === "fee"
            ? "fee"
            : l.type === "dispute"
              ? "dispute"
              : "charge";
      lines.push({
        kind,
        amount: fromUnits(toUnits(String(l.amount))),
        externalRef: l.id ?? null,
        description: l.description ?? l.type,
        currency,
      });
    }
  } else {
    if (payload.charge_amount)
      lines.push({
        kind: "charge",
        amount: fromUnits(toUnits(String(payload.charge_amount))),
        currency,
      });
    if (payload.refund_amount)
      lines.push({
        kind: "refund",
        amount: fromUnits(toUnits(String(payload.refund_amount))),
        currency,
      });
    if (payload.fee_amount)
      lines.push({
        kind: "fee",
        amount: fromUnits(toUnits(String(payload.fee_amount))),
        currency,
      });
  }
  return {
    provider: "recurly",
    externalRef: payload.id,
    settlementDate: date,
    currency,
    lines,
    memo: `Recurly settlement ${payload.id}`,
    raw: payload as unknown as Record<string, unknown>,
  };
}

/** Chargebee invoice / transaction settlement subset. */
export function parseChargebeeSettlement(payload: {
  id: string;
  date?: number | string;
  currency_code?: string;
  total?: number;
  amount_paid?: number;
  amount_adjusted?: number;
  credits_applied?: number;
  line_items?: {
    id?: string;
    description?: string;
    amount?: number;
    entity_type?: string;
  }[];
  // taxes/fees may appear as special entity types
}, fallbackDate?: string): ParsedSettlement {
  const currency = (payload.currency_code ?? "USD").toUpperCase();
  const total =
    payload.total == null
      ? null
      : fromPspMinorUnits(payload.total, "Chargebee total");
  if (payload.amount_paid != null) {
    fromPspMinorUnits(payload.amount_paid, "Chargebee amount paid");
  }
  if (payload.amount_adjusted != null) {
    fromPspMinorUnits(payload.amount_adjusted, "Chargebee amount adjusted");
  }
  const settlementDate =
    typeof payload.date === "number"
      ? new Date(payload.date * 1000).toISOString().slice(0, 10)
      : String(payload.date ?? fallbackDate ?? new Date().toISOString()).slice(0, 10);
  const lines: ParsedSettlementLine[] = [];
  if (payload.line_items?.length) {
    for (const li of payload.line_items) {
      const et = (li.entity_type ?? "").toLowerCase();
      const kind: SettlementLineKind = et.includes("tax")
        ? "other"
        : et.includes("addon") || et.includes("plan")
          ? "charge"
          : "charge";
      lines.push({
        kind,
        amount: fromPspMinorUnits(
          li.amount ?? 0,
          "Chargebee line-item amount",
        ),
        externalRef: li.id ?? null,
        description: li.description ?? et,
        currency,
      });
    }
  } else if (total != null) {
    lines.push({
      kind: "charge",
      amount: total,
      currency,
    });
  }
  // Chargebee often separate-refunds via credits
  const creditsApplied =
    payload.credits_applied == null
      ? null
      : fromPspMinorUnits(
          payload.credits_applied,
          "Chargebee credits applied",
          true,
        );
  if (creditsApplied != null && payload.credits_applied !== 0) {
    lines.push({
      kind: "refund",
      amount: creditsApplied,
      description: "Credits applied",
      currency,
    });
  }
  return {
    provider: "chargebee",
    externalRef: payload.id,
    settlementDate,
    currency,
    lines,
    memo: `Chargebee settlement ${payload.id}`,
    raw: payload as unknown as Record<string, unknown>,
  };
}

async function primaryBookId(orgId: string): Promise<string> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from accounting_books where org_id = ${orgId} and is_primary limit 1
  `));
  const id = r.rows[0]?.id;
  if (!id) throw new PspSettlementError("no primary accounting book");
  return id;
}

async function periodForDate(
  orgId: string,
  date: string,
): Promise<string | null> {
  const r = (await db.execute<{ id: string }>(sql`
    select id from accounting_periods
     where org_id = ${orgId} and is_adjustment = false and starts_on <= ${date} and ends_on >= ${date}
     limit 1
  `));
  return r.rows[0]?.id ?? null;
}

export interface ImportAccounts {
  bankAccountId: string;
  feeAccountId: string;
  disputeAccountId: string;
  fxAccountId: string;
  clearingAccountId: string;
  subsidiaryId: string;
}

/**
 * Persist a draft batch + lines (idempotent). Does not post GL.
 */
export async function importSettlementBatch(
  orgId: string,
  actorId: string | null,
  parsed: ParsedSettlement,
  accounts: Partial<ImportAccounts>,
): Promise<{ batchId: string; created: boolean }> {
  if (!parsed.externalRef.trim()) {
    throw new PspSettlementError("provider settlement reference is required");
  }
  if (parsed.lines.length === 0) {
    throw new PspSettlementError("settlement batch has no evidence lines");
  }
  const currency = parsed.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PspSettlementError(
      "settlement currency must be a three-letter code",
    );
  }
  for (const line of parsed.lines) {
    if (line.currency && line.currency.toUpperCase() !== currency) {
      throw new PspSettlementError(
        "mixed-currency settlement lines require explicit conversion evidence",
      );
    }
  }
  const totals = summarizeSettlement(parsed.lines);
  return withOrg(orgId, async () => {
    const proposedId = randomUUID();
    const inserted = (await db.execute<{ id: string }>(sql`
      insert into psp_settlement_batches (
        id, org_id, provider, external_ref, status, currency,
        gross_amount, fee_amount, refund_amount, dispute_amount, net_amount, fx_amount,
        settlement_date, bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
        clearing_account_id, subsidiary_id, source_payload, line_count, memo, created_by, updated_by
      ) values (
        ${proposedId}, ${orgId}, ${parsed.provider}, ${parsed.externalRef}, 'draft', ${currency},
        ${totals.grossAmount}, ${totals.feeAmount}, ${totals.refundAmount}, ${totals.disputeAmount},
        ${totals.netAmount}, ${totals.fxAmount}, ${parsed.settlementDate},
        ${accounts.bankAccountId ?? null}, ${accounts.feeAccountId ?? null},
        ${accounts.disputeAccountId ?? null}, ${accounts.fxAccountId ?? null},
        ${accounts.clearingAccountId ?? null}, ${accounts.subsidiaryId ?? null},
        ${parsed.raw ? JSON.stringify(parsed.raw) : null}::jsonb, ${parsed.lines.length},
        ${parsed.memo ?? null}, ${actorId}, ${actorId}
      )
      on conflict (org_id, provider, external_ref) do nothing
      returning id
    `));
    const created = inserted.rows.length === 1;
    const current = (await db.execute<{ id: string; status: string }>(sql`
      select id, status
        from psp_settlement_batches
       where org_id = ${orgId}
         and provider = ${parsed.provider}
         and external_ref = ${parsed.externalRef}
       for update
    `));
    const row = current.rows[0];
    if (!row)
      throw new PspSettlementError("settlement batch could not be locked");
    if (row.status === "posted") return { batchId: row.id, created: false };
    if (row.status === "void") {
      throw new PspSettlementError(
        "a voided provider settlement reference cannot be reused",
      );
    }
    const batchId = row.id;
    if (!created) {
      await db.execute(sql`
        delete from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${orgId}
      `);
    }
    await db.execute(sql`
      update psp_settlement_batches set
        currency = ${currency},
        gross_amount = ${totals.grossAmount},
        fee_amount = ${totals.feeAmount},
        refund_amount = ${totals.refundAmount},
        dispute_amount = ${totals.disputeAmount},
        net_amount = ${totals.netAmount},
        fx_amount = ${totals.fxAmount},
        settlement_date = ${parsed.settlementDate},
        bank_account_id = coalesce(${accounts.bankAccountId ?? null}, bank_account_id),
        fee_account_id = coalesce(${accounts.feeAccountId ?? null}, fee_account_id),
        dispute_account_id = coalesce(${accounts.disputeAccountId ?? null}, dispute_account_id),
        fx_account_id = coalesce(${accounts.fxAccountId ?? null}, fx_account_id),
        clearing_account_id = coalesce(${accounts.clearingAccountId ?? null}, clearing_account_id),
        subsidiary_id = coalesce(${accounts.subsidiaryId ?? null}, subsidiary_id),
        source_payload = ${parsed.raw ? JSON.stringify(parsed.raw) : null}::jsonb,
        line_count = ${parsed.lines.length},
        memo = ${parsed.memo ?? null},
        updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await insertLines(orgId, batchId, parsed.lines, actorId);
    return { batchId, created };
  });
}

async function insertLines(
  orgId: string,
  batchId: string,
  lines: ParsedSettlementLine[],
  actorId: string | null,
): Promise<void> {
  let n = 0;
  for (const l of lines) {
    n++;
    await db.execute(sql`
      insert into psp_settlement_lines
        (org_id, batch_id, line_number, kind, external_ref, description, amount, currency, meta, created_by, updated_by)
      values (${orgId}, ${batchId}, ${n}, ${l.kind}, ${l.externalRef ?? null}, ${l.description ?? null},
              ${l.amount}, ${l.currency ?? null}, ${JSON.stringify(l.meta ?? {})}::jsonb, ${actorId}, ${actorId})
    `);
  }
}

/**
 * Post a draft settlement as one balanced journal:
 *   DR bank net
 *   DR fee expense
 *   DR refunds/disputes (clearing or expense)
 *   CR clearing (gross charges)
 *   DR/CR FX gain/loss
 *
 * Clearing is typically undeposited funds / PSP receivable that matches prior
 * AR cash applications, or the batch can CR income if configured as direct.
 */
export async function postSettlementBatch(
  orgId: string,
  batchId: string,
  actorId: string | null,
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "post a PSP settlement");
  return await withOrg(orgId, async () => {
    const batch = (await db.execute<{
        id: string;
        status: string;
        currency: string;
        gross_amount: string;
        fee_amount: string;
        refund_amount: string;
        dispute_amount: string;
        net_amount: string;
        fx_amount: string;
        settlement_date: string;
        bank_account_id: string | null;
        fee_account_id: string | null;
        dispute_account_id: string | null;
        fx_account_id: string | null;
        clearing_account_id: string | null;
        subsidiary_id: string | null;
        provider: string;
        external_ref: string;
        memo: string | null;
        journal_entry_id: string | null;
        subsidiary_base_currency: string | null;
      }>(sql`
      select b.*, s.base_currency as subsidiary_base_currency
        from psp_settlement_batches b
        left join subsidiaries s
          on s.id = b.subsidiary_id and s.org_id = b.org_id
       where b.id = ${batchId} and b.org_id = ${orgId}
       for update of b
    `));
    const b = batch.rows[0];
    if (!b) throw new PspSettlementError("settlement batch not found");
    if (b.status === "posted") {
      if (!b.journal_entry_id) {
        throw new PspSettlementError(
          "posted batch is missing its journal entry",
        );
      }
      return { entryId: b.journal_entry_id };
    }
    if (b.status === "void") throw new PspSettlementError("batch is void");
    if (
      !b.bank_account_id ||
      !b.clearing_account_id ||
      !b.fee_account_id ||
      !b.subsidiary_id
    ) {
      throw new PspSettlementError(
        "bank, clearing, fee accounts and subsidiary are required to post",
      );
    }
    if (!b.subsidiary_base_currency) {
      throw new PspSettlementError("settlement subsidiary is missing");
    }
    if (b.currency !== b.subsidiary_base_currency) {
      throw new PspSettlementError(
        `cross-currency PSP settlement ${b.currency}→${b.subsidiary_base_currency} requires explicit rate and functional-currency evidence`,
      );
    }

    const controls = (await db.execute<{ c: Record<string, string> | null }>(sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId}
    `));
    const c = controls.rows[0]?.c ?? {};
    const fxAcct = b.fx_account_id ?? c.fxRealizedGainLoss ?? null;
    if (!isZero(b.fx_amount) && !fxAcct) {
      throw new PspSettlementError(
        "realized FX gain/loss account is not configured",
      );
    }
    const disputeAcct = b.dispute_account_id ?? b.fee_account_id;

    const periodId = await periodForDate(orgId, b.settlement_date);
    if (!periodId)
      throw new PspSettlementError(
        `no open accounting period for ${b.settlement_date}`,
      );
    const bookId = await primaryBookId(orgId);
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [b.subsidiary_id],
      modules: ["banking"],
    });

    // Build balanced lines in base/settlement currency (txn = amount, rate 1).
    type JL = { accountId: string; amount: string; memo: string };
    const jlines: JL[] = [];

    if (!isZero(b.net_amount) && cmp(b.net_amount, "0") !== 0) {
      jlines.push({
        accountId: b.bank_account_id,
        amount: b.net_amount, // DR bank when positive net deposit
        memo: "PSP net deposit",
      });
    }
    if (!isZero(b.fee_amount)) {
      jlines.push({
        accountId: b.fee_account_id,
        amount: b.fee_amount,
        memo: "PSP processing fees",
      });
    }
    if (!isZero(b.refund_amount)) {
      jlines.push({
        accountId: b.clearing_account_id,
        amount: b.refund_amount,
        memo: "PSP refunds",
      });
    }
    if (!isZero(b.dispute_amount)) {
      jlines.push({
        accountId: disputeAcct!,
        amount: b.dispute_amount,
        memo: "PSP disputes",
      });
    }
    // CR clearing for gross charges (or residual).
    // Balance: sum(DR) + sum(CR signed) = 0 with DR+, CR− convention.
    const debitSum = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
    // We need clearing credit = −(gross) typically when landing charges
    // Recompute so entry balances: clearing takes residual opposite of debs + fx.
    // Residual amount so total = 0.
    let running = debitSum;
    if (!isZero(b.fx_amount) && fxAcct) {
      // FX: positive gain = credit (negative amount)
      jlines.push({
        accountId: fxAcct,
        amount: neg(b.fx_amount), // if fx positive gain → CR
        memo: "PSP FX",
      });
      running += toUnits(neg(b.fx_amount));
    }
    // Clearing residual to balance
    const clearAmount = fromUnits(-running);
    if (!isZero(clearAmount)) {
      jlines.push({
        accountId: b.clearing_account_id,
        amount: clearAmount,
        memo: "PSP clearing / charges",
      });
    }

    // Verify balance.
    const bal = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
    if (bal !== 0n)
      throw new PspSettlementError(
        `settlement journal does not balance: ${fromUnits(bal)}`,
      );

    const entryId = randomUUID();
    const entryNumber =
      `PSP-${b.provider.toUpperCase()}-${b.external_ref}`.slice(0, 64);
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date, period_id, memo, status, origin, created_by, updated_by)
      values (${entryId}, ${orgId}, ${bookId}, ${b.subsidiary_id}, ${entryNumber}, ${b.settlement_date}, ${periodId},
              ${b.memo ?? `PSP ${b.provider} ${b.external_ref}`}, 'draft', 'document', ${actorId}, ${actorId})
    `);
    let ln = 0;
    for (const l of jlines) {
      ln++;
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount, currency, txn_amount, fx_rate, memo)
        values (${orgId}, ${entryId}, ${ln}, ${l.accountId}, ${b.subsidiary_id}, ${l.amount},
                ${b.currency}, ${l.amount}, 1, ${l.memo})
      `);
    }
    await db.execute(
      sql`update journal_entries set status = 'posted', posted_at = now(), posted_by = ${actorId} where id = ${entryId} and org_id = ${orgId}`,
    );
    await db.execute(sql`
      update psp_settlement_batches set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(),
             updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'psp_settlement_batches', ${batchId}, 'post',
              ${JSON.stringify({ after: { journalEntryId: entryId, netAmount: b.net_amount } })}::jsonb, ${actorId})
    `);
    return { entryId };
  });
}

/**
 * Controlled correction for a posted PSP batch. Posted evidence is never
 * edited or deleted: the service mirrors every source journal line exactly in
 * a requested open period, links both sides of the reversal, and records the
 * actor/reason on the batch and audit log. Repeated calls return the same
 * reversal entry.
 */
export async function reverseSettlementBatch(
  orgId: string,
  batchId: string,
  actorId: string,
  input: { reversalDate: string; reason: string },
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "reverse a PSP settlement");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new PspSettlementError(
      "reversal reason must be between 5 and 500 characters",
    );
  }
  return withOrg(orgId, async () => {
    const batch = (await db.execute<{
        status: string;
        journal_entry_id: string | null;
        reversal_entry_id: string | null;
        provider: string;
        external_ref: string;
        subsidiary_id: string | null;
      }>(sql`
      select status, journal_entry_id, reversal_entry_id, provider,
             external_ref, subsidiary_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
       for update
    `));
    const b = batch.rows[0];
    if (!b) throw new PspSettlementError("settlement batch not found");
    if (b.status === "void") {
      if (!b.reversal_entry_id) {
        throw new PspSettlementError("void batch is missing reversal evidence");
      }
      return { entryId: b.reversal_entry_id };
    }
    if (b.status !== "posted" || !b.journal_entry_id || !b.subsidiary_id) {
      throw new PspSettlementError(
        "only a posted settlement batch can be reversed",
      );
    }

    const source = (await db.execute<{
        book_id: string;
        subsidiary_id: string;
        entry_number: string;
        status: string;
        origin: string;
      }>(sql`
      select book_id, subsidiary_id, entry_number, status, origin
        from journal_entries
       where id = ${b.journal_entry_id} and org_id = ${orgId}
       for update
    `));
    const original = source.rows[0];
    if (!original || original.status !== "posted") {
      throw new PspSettlementError(
        "settlement source journal is missing or already reversed",
      );
    }
    const periodId = await periodForDate(orgId, input.reversalDate);
    if (!periodId) {
      throw new PspSettlementError(
        `no open accounting period for ${input.reversalDate}`,
      );
    }
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId: original.book_id,
      subsidiaryIds: [original.subsidiary_id],
      modules: ["banking"],
    });
    const lines = (await db.execute<Record<string, unknown>>(sql`
      select line_number, account_id, subsidiary_id, amount::text, currency,
             txn_amount::text, fx_rate::text, memo, party_id, department_id,
             project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, tax_code_id, extra_dims
        from journal_lines
       where entry_id = ${b.journal_entry_id} and org_id = ${orgId}
       order by line_number
    `));
    if (lines.rows.length === 0) {
      throw new PspSettlementError("settlement source journal has no lines");
    }

    const entryId = randomUUID();
    await db.execute(sql`
      insert into journal_entries
        (id, org_id, book_id, subsidiary_id, entry_number, posting_date,
         period_id, memo, status, origin, reverses_entry_id, created_by, updated_by)
      values
        (${entryId}, ${orgId}, ${original.book_id}, ${original.subsidiary_id},
         ${`${original.entry_number}-VOID`}, ${input.reversalDate}, ${periodId},
         ${`Reversal: ${reason}`}, 'draft', ${original.origin},
         ${b.journal_entry_id}, ${actorId}, ${actorId})
    `);
    for (const line of lines.rows) {
      await db.execute(sql`
        insert into journal_lines
          (org_id, entry_id, line_number, account_id, subsidiary_id, amount,
           currency, txn_amount, fx_rate, memo, party_id, department_id,
           project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, tax_code_id, extra_dims)
        values
          (${orgId}, ${entryId}, ${Number(line.line_number)},
           ${String(line.account_id)}, ${String(line.subsidiary_id)},
           ${neg(String(line.amount))}, ${String(line.currency)},
           ${neg(String(line.txn_amount))}, ${String(line.fx_rate)},
           ${line.memo == null ? null : String(line.memo)},
           ${line.party_id ?? null}, ${line.department_id ?? null},
           ${line.project_id ?? null}, ${line.location_id ?? null},
           ${line.class_id ?? null}, ${line.equipment_unit_id ?? null},
           ${line.payment_card_id ?? null}, ${line.tax_code_id ?? null},
             ${JSON.stringify(line.extra_dims ?? {})}::jsonb)
      `);
    }
    await db.execute(sql`
      update journal_entries
         set status = 'posted', posted_at = now(), posted_by = ${actorId},
             updated_at = now(), updated_by = ${actorId}
       where id = ${entryId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update journal_entries
         set status = 'reversed', updated_at = now(), updated_by = ${actorId}
       where id = ${b.journal_entry_id} and org_id = ${orgId}
    `);
    await db.execute(sql`
      update psp_settlement_batches
         set status = 'void', reversal_entry_id = ${entryId},
             reversal_reason = ${reason}, reversed_at = now(),
             reversed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
    await db.execute(sql`
      insert into audit_log
        (org_id, table_name, row_id, action, changes, actor_id)
      values
        (${orgId}, 'psp_settlement_batches', ${batchId}, 'reverse',
         ${JSON.stringify({
           reason,
           before: { status: "posted", journalEntryId: b.journal_entry_id },
           after: { status: "void", reversalEntryId: entryId },
         })}::jsonb, ${actorId})
    `);
    return { entryId };
  });
}

export async function savePspProviderConfig(
  orgId: string,
  input: {
    provider: PspProvider;
    displayName?: string;
    isEnabled: boolean;
    defaultBankAccountId?: string | null;
    defaultFeeAccountId?: string | null;
    defaultDisputeAccountId?: string | null;
    defaultFxAccountId?: string | null;
    defaultClearingAccountId?: string | null;
    apiKey?: string | null;
  },
  actorId: string | null,
): Promise<void> {
  let secrets: string | null = null;
  if (input.apiKey) secrets = await sealJson({ apiKey: input.apiKey });
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, default_bank_account_id, default_fee_account_id,
       default_dispute_account_id, default_fx_account_id, default_clearing_account_id, secrets, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
            ${input.defaultBankAccountId ?? null}, ${input.defaultFeeAccountId ?? null},
            ${input.defaultDisputeAccountId ?? null}, ${input.defaultFxAccountId ?? null},
            ${input.defaultClearingAccountId ?? null}, ${secrets}, ${actorId}, ${actorId})
    on conflict (org_id, provider) do update set
      display_name = excluded.display_name,
      is_enabled = excluded.is_enabled,
      default_bank_account_id = excluded.default_bank_account_id,
      default_fee_account_id = excluded.default_fee_account_id,
      default_dispute_account_id = excluded.default_dispute_account_id,
      default_fx_account_id = excluded.default_fx_account_id,
      default_clearing_account_id = excluded.default_clearing_account_id,
      secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
      updated_at = now(), updated_by = ${actorId}
    where psp_provider_configs.org_id = ${orgId}
  `);
}
