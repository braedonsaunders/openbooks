import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { cmp, fromUnits, isZero, mulRate, neg, toUnits } from "../money/money.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  loadSubsidiaryContext,
  SubsidiaryError,
  uuidArray,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { postEntry } from "../journal/post-entry.ts";
import {
  PspSettlementError,
  requireFxRate,
  settlementFxRealizedDelta,
  type SettlementLineKind,
} from "./psp-settlement-core.ts";
import { periodForDate, primaryBookId } from "./psp-settlement-posting-context.ts";

function absoluteUnits(value: bigint): bigint {
  return value < 0n ? -value : value;
}

/**
 * Convert one FX batch into base-currency legs. Every foreign line converts
 * at its own exchange_rate (or the batch conversion_rate) into payout
 * currency, then at payout_rate into base — exact decimal math, no floats.
 * Legs with receipt booking (a linked posted receipt in the line currency,
 * or explicit bookedAmount evidence) post at the booked amount; realized FX
 * follows each leg's cash-flow direction around that booked amount.
 * Legs without booking post at converted and contribute nothing.
 */
async function buildFxLegs(
  orgId: string,
  batchId: string,
  b: {
    currency: string;
    net_amount: string;
    fee_amount: string;
  },
  fxPlan: { sourceCurrency: string; conversionRate: string; payoutRate: string },
): Promise<{
  bank: string;
  fee: string;
  refund: string;
  dispute: string;
  adjustment: string;
  realized: string;
}> {
  const rows = await db.execute<{
    line_number: number;
    kind: SettlementLineKind;
    amount: string;
    currency: string | null;
    document_id: string | null;
    meta: unknown;
  }>(
    sql`
    select line_number, kind, amount::text, currency, document_id, meta
      from psp_settlement_lines
     where batch_id = ${batchId} and org_id = ${orgId}
     order by line_number
  `,
    "objects",
  );
  const bookedKinds = new Set([
    "charge",
    "refund",
    "dispute",
    "dispute_reversal",
    "adjustment",
    "transfer",
  ]);
  let refund = 0n;
  let dispute = 0n;
  let adjustment = 0n;
  let realized = 0n;
  for (const row of rows) {
    const lineCurrency = (row.currency ?? b.currency).toUpperCase();
    const meta = (row.meta ?? {}) as Record<string, unknown>;
    const rateIntoPayout =
      lineCurrency === b.currency
        ? "1"
        : requireFxRate(
            meta.exchangeRate ?? fxPlan.conversionRate,
            `settlement line ${row.line_number} exchange_rate`,
          );
    const convertedBase = toUnits(mulRate(mulRate(row.amount, rateIntoPayout), fxPlan.payoutRate));
    let bookedBase = convertedBase;
    if (bookedKinds.has(row.kind)) {
      if (meta.bookedAmount != null) {
        try {
          bookedBase = toUnits(fromUnits(toUnits(String(meta.bookedAmount))));
        } catch {
          throw new PspSettlementError(
            `settlement line ${row.line_number} bookedAmount must be an exact decimal amount`,
          );
        }
      } else if (row.document_id != null) {
        const receipt = (
          await db.execute<{
            status: string;
            currency: string;
            total: string;
            fx_rate: string;
          }>(
            sql`
          select status, currency, total::text, fx_rate::text
            from documents
           where id = ${row.document_id} and org_id = ${orgId}
        `,
            "objects",
          )
        )[0];
        if (!receipt) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} links receipt ${row.document_id}, which is not in this organization; relink the line and import again`,
          );
        }
        if (receipt.status !== "posted") {
          throw new PspSettlementError(
            `settlement line ${row.line_number} links receipt ${row.document_id}, which is ${receipt.status}; realized FX posts only against posted receipts`,
          );
        }
        if (receipt.currency.toUpperCase() !== lineCurrency) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} in ${lineCurrency} links receipt ${row.document_id} in ${receipt.currency}; realized FX needs the receipt in the line currency`,
          );
        }
        if (absoluteUnits(toUnits(row.amount)) !== absoluteUnits(toUnits(receipt.total))) {
          throw new PspSettlementError(
            `settlement line ${row.line_number} amount ${row.amount} does not match linked receipt ${row.document_id} total ${receipt.total}; link one line per receipt or supply bookedAmount evidence`,
          );
        }
        bookedBase = toUnits(mulRate(receipt.total, receipt.fx_rate));
      }
      realized += settlementFxRealizedDelta(row.kind, convertedBase, bookedBase);
    }
    if (row.kind === "refund") refund += bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "dispute") dispute += bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "dispute_reversal") dispute -= bookedBase < 0n ? -bookedBase : bookedBase;
    else if (row.kind === "adjustment") adjustment += bookedBase < 0n ? -bookedBase : bookedBase;
  }
  return {
    bank: mulRate(b.net_amount, fxPlan.payoutRate),
    fee: mulRate(b.fee_amount, fxPlan.payoutRate),
    refund: fromUnits(refund),
    dispute: fromUnits(dispute),
    adjustment: fromUnits(adjustment),
    realized: fromUnits(realized),
  };
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
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "post a PSP settlement");
  return await withOrg(orgId, async () => {
    const batch = await db.execute<{
      id: string;
      status: string;
      currency: string;
      gross_amount: string;
      fee_amount: string;
      refund_amount: string;
      dispute_amount: string;
      adjustment_amount: string;
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
      source_currency: string | null;
      conversion_rate: string | null;
      conversion_rate_source: string | null;
      payout_rate: string | null;
      payout_rate_source: string | null;
    }>(
      sql`
      select b.*
        from psp_settlement_batches b
       where b.id = ${batchId} and b.org_id = ${orgId}
       for update of b
    `,
      "objects",
    );
    const b = batch[0];
    if (!b) throw new ScopeNotFoundError();
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, b.subsidiary_id))
      throw new ScopeNotFoundError();
    if (b.status === "posted") {
      if (!b.journal_entry_id) {
        throw new PspSettlementError("posted batch is missing its journal entry");
      }
      return { entryId: b.journal_entry_id };
    }
    if (b.status === "void") throw new PspSettlementError("batch is void");
    const controls = await db.execute<{ c: Record<string, string> | null }>(
      sql`
      select settings->'controlAccounts' as c from orgs where id = ${orgId} for share
    `,
      "objects",
    );
    const c = controls[0]?.c ?? {};
    // Keep hierarchy and functional currency stable through validation and posting.
    await db.execute(sql`select id from subsidiaries where org_id=${orgId} order by id for share`);
    const ctx = await loadSubsidiaryContext(db, orgId);
    // Only a genuinely ambiguous choice (a multi-entity org with none named)
    // refuses, and then the refusal names exactly what is missing: the old
    // combined check blamed accounts the batch already carried.
    // Either way the draft is repairable by re-importing the same provider
    // reference with the missing details (the import path fills them in).
    // The outer disjunct keeps every account narrowed past the refusal.
    if (
      !b.bank_account_id ||
      !b.clearing_account_id ||
      !b.fee_account_id ||
      (!b.subsidiary_id && ctx.multi)
    ) {
      const missing: string[] = [];
      if (!b.bank_account_id) missing.push("bank account");
      if (!b.clearing_account_id) missing.push("clearing account");
      if (!b.fee_account_id) missing.push("fee account");
      if (!b.subsidiary_id) missing.push("subsidiary");
      throw new PspSettlementError(
        `settlement batch cannot post without ${missing.join(", ")}; re-import the same provider reference with the missing details to repair this draft (the draft keeps its evidence lines and only its missing configuration is filled in)`,
      );
    }
    // An absent subsidiary resolves to the org root — the same contract the
    // posting kernel gives every other document (posting.ts: docSubId ??
    // root). Past the refusal above this is unambiguous: a named subsidiary,
    // or a single-entity org whose only choice is the root.
    const subsidiaryId: string = b.subsidiary_id ?? ctx.rootId;
    const subsidiary = ctx.byId.get(subsidiaryId);
    if (!subsidiary?.baseCurrency) {
      throw new PspSettlementError("settlement subsidiary is missing");
    }
    if (!subsidiary.isActive)
      throw new PspSettlementError(`subsidiary "${subsidiary.name}" is inactive`);
    // Cross-currency batches post at evidenced rates: every foreign leg
    // converts through the batch conversion_rate (or its own exchange_rate)
    // into payout currency, then through payout_rate into base. A missing
    // rate stays a named refusal — converting at an assumed rate would book
    // money nobody evidenced.
    const baseCurrency = subsidiary.baseCurrency;
    const fxBatch = b.source_currency != null || b.currency !== baseCurrency;
    let fxPlan: {
      sourceCurrency: string;
      conversionRate: string;
      payoutRate: string;
    } | null = null;
    if (fxBatch) {
      const sourceCurrency = (b.source_currency ?? b.currency).toUpperCase();
      const conversionRate =
        b.source_currency != null
          ? requireFxRate(b.conversion_rate, "settlement conversion_rate")
          : "1";
      if (b.currency !== baseCurrency && b.payout_rate == null) {
        throw new PspSettlementError(
          `cross-currency PSP settlement ${b.currency}→${baseCurrency} requires payout_rate evidence; re-import the same provider reference with payout_rate to repair this draft`,
        );
      }
      if (b.source_currency != null && b.conversion_rate == null) {
        throw new PspSettlementError(
          `cross-currency PSP settlement carries source currency ${sourceCurrency} without conversion_rate evidence; re-import the same provider reference with conversion_rate to repair this draft`,
        );
      }
      const payoutRate =
        b.currency === baseCurrency ? "1" : requireFxRate(b.payout_rate, "settlement payout_rate");
      fxPlan = { sourceCurrency, conversionRate, payoutRate };
    }

    const fxAcct = b.fx_account_id ?? c.fxRealizedGainLoss ?? null;
    if (!isZero(b.fx_amount) && !fxAcct) {
      throw new PspSettlementError("realized FX gain/loss account is not configured");
    }
    const disputeAcct = b.dispute_account_id ?? b.fee_account_id;

    const periodId = await periodForDate(orgId, b.settlement_date, subsidiaryId);
    if (!periodId)
      throw new PspSettlementError(`no open accounting period for ${b.settlement_date}`);
    const bookId = await primaryBookId(orgId);
    await assertPeriodModulesOpen(db, {
      orgId,
      periodId,
      bookId,
      subsidiaryIds: [subsidiaryId],
      modules: ["banking"],
    });

    // Build balanced lines in the subsidiary's functional currency. Legs paid
    // in a foreign payout currency carry that currency's amount and the
    // evidenced payout rate, so the ledger records the real foreign balance.
    type JL = {
      accountId: string;
      amount: string;
      memo: string;
      currency?: string;
      txnAmount?: string;
      fxRate?: string;
    };
    const jlines: JL[] = [];

    // A cross-currency batch converts every leg to base at evidenced rates and
    // books the realized difference against the receipts' booked amounts to
    // the FX gain/loss account. Single-currency batches keep the stored
    // totals path below unchanged.
    let fxRealized: string | null = null;
    if (fxPlan) {
      const fxLegs = await buildFxLegs(orgId, batchId, b, fxPlan);
      fxRealized = fxLegs.realized;
      if (!isZero(fxRealized) && !fxAcct) {
        throw new PspSettlementError("realized FX gain/loss account is not configured");
      }
      const payoutDetail = (txnAmount: string) =>
        b.currency === baseCurrency
          ? {}
          : { currency: b.currency, txnAmount, fxRate: fxPlan!.payoutRate };
      if (!isZero(fxLegs.bank)) {
        jlines.push({
          accountId: b.bank_account_id!,
          amount: fxLegs.bank,
          memo: "PSP net deposit",
          ...payoutDetail(b.net_amount),
        });
      }
      if (!isZero(fxLegs.fee)) {
        jlines.push({
          accountId: b.fee_account_id!,
          amount: fxLegs.fee,
          memo: "PSP processing fees",
          ...payoutDetail(b.fee_amount),
        });
      }
      if (!isZero(fxLegs.refund)) {
        jlines.push({
          accountId: b.clearing_account_id!,
          amount: fxLegs.refund,
          memo: "PSP refunds",
        });
      }
      if (!isZero(fxLegs.dispute)) {
        jlines.push({ accountId: disputeAcct!, amount: fxLegs.dispute, memo: "PSP disputes" });
      }
      if (!isZero(fxLegs.adjustment)) {
        jlines.push({
          accountId: b.clearing_account_id!,
          amount: fxLegs.adjustment,
          memo: "PSP adjustments",
        });
      }
      if (!isZero(fxRealized)) {
        jlines.push({
          accountId: fxAcct!,
          amount: neg(fxRealized), // realized gain (converted above booked) = credit
          memo: `PSP realized FX at ${fxPlan.sourceCurrency} evidence`,
        });
      }
      const fxRunning = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
      const fxClear = fromUnits(-fxRunning);
      if (!isZero(fxClear)) {
        jlines.push({
          accountId: b.clearing_account_id!,
          amount: fxClear,
          memo: "PSP clearing / charges",
        });
      }
      // The realized plug is posting evidence: stamp it onto the batch so the
      // stored row shows the booked FX, not just the import-time fx legs.
      const stamped = await db.execute<never>(sql`
        update psp_settlement_batches set fx_amount = ${fxRealized}, updated_at = now(), updated_by = ${actorId}
         where id = ${batchId} and org_id = ${orgId}
      `);
      if ((stamped.rowCount ?? 0) !== 1) {
        throw new PspSettlementError("settlement batch could not be stamped with realized FX");
      }
    } else {
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
      // Adjustments (e.g. Chargebee amount_adjusted) clear against the same
      // customer-balance pool as refunds — the gross charges credited clearing,
      // so the write-off/credit leg debits it — but on their own journal line
      // so the GL tells write-offs apart from cash refunds.
      if (!isZero(b.adjustment_amount)) {
        jlines.push({
          accountId: b.clearing_account_id,
          amount: b.adjustment_amount,
          memo: "PSP adjustments",
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
    }

    // Verify balance.
    const bal = jlines.reduce((s, l) => s + toUnits(l.amount), 0n);
    if (bal !== 0n)
      throw new PspSettlementError(`settlement journal does not balance: ${fromUnits(bal)}`);

    const accountIds = [...new Set(jlines.map((line) => line.accountId))];
    const locked = await db.execute<{ id: string }>(
      sql`select id from accounts where org_id=${orgId}
      and is_active and not is_summary
      and id=any(${uuidArray(accountIds)}::uuid[]) order by id for share`,
      "objects",
    );
    // Accounts can leave the org (or postability) after import: re-resolve
    // every posting account under the batch lock so a stale reference fails
    // closed naming the account instead of escaping as a raw FK 500.
    const lockedIds = new Set(locked.map((r) => r.id.toLowerCase()));
    const stale = accountIds.find((id) => !lockedIds.has(id.toLowerCase()));
    if (stale) {
      throw new PspSettlementError(
        `settlement posting account is not a postable account in this organization`,
      );
    }
    try {
      await validateSubsidiaryRestrictions(db, {
        orgId,
        ctx,
        docSubsidiaryId: subsidiaryId,
        lines: jlines.map((line) => ({ ...line, subsidiaryId })),
      });
    } catch (error) {
      if (error instanceof SubsidiaryError) throw new PspSettlementError(error.message);
      throw error;
    }

    // Every journal write routes through the ONE ledger API.
    const entryId = randomUUID();
    // The full provider reference is the entry number, never truncated:
    // distinct provider references stay distinct ledger identities, so two
    // long references sharing a prefix can no longer collide on the
    // (org_id, entry_number) integrity guard and block posting. Uniqueness
    // holds because imports dedupe on (org_id, provider, external_ref),
    // re-posting a posted batch returns its existing entry, and reversals
    // suffix -VOID. Both entry_number and memo are unbounded text, so the
    // complete external reference is retained in the ledger.
    const entryNumber = `PSP-${b.provider.toUpperCase()}-${b.external_ref}`;
    const postedEntry = await postEntry(db, {
      id: entryId,
      orgId,
      bookId,
      subsidiaryId,
      entryNumber,
      postingDate: b.settlement_date,
      periodId,
      memo: b.memo ?? `PSP ${b.provider} ${b.external_ref}`,
      origin: "document",
      actorId,
      // A cross-currency batch's legs are converted to the functional currency.
      currency: fxPlan ? baseCurrency : b.currency,
      lines: jlines.map((l) => ({
        accountId: l.accountId,
        amount: l.amount,
        memo: l.memo,
        ...(l.currency ? { currency: l.currency, txnAmount: l.txnAmount, fxRate: l.fxRate } : {}),
      })),
    });
    if (postedEntry.entryId !== entryId)
      throw new PspSettlementError("settlement journal was not posted");
    await db.execute(sql`
      update psp_settlement_batches set status = 'posted', journal_entry_id = ${entryId}, posted_at = now(),
             subsidiary_id = ${subsidiaryId}, updated_at = now(), updated_by = ${actorId}
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
