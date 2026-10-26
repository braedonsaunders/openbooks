import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { mulRate, toUnits } from "../money/money.ts";
import { ScopeNotFoundError, subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  PspSettlementConflictError,
  PspSettlementError,
  requireFxRate,
  requireSettlementCurrency,
  summarizeSettlement,
} from "./psp-settlement-core.ts";
import type { ParsedSettlement, ParsedSettlementLine } from "./psp-settlement-core.ts";
import { validateSettlementPostingAccounts } from "./psp-settlement-posting-context.ts";
import type { ImportAccounts } from "./psp-settlement-posting-context.ts";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

type StoredSettlementHeader = {
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
  source_currency: string | null;
  conversion_rate: string | null;
  conversion_rate_source: string | null;
  payout_rate: string | null;
  payout_rate_source: string | null;
  source_payload: unknown;
  line_count: number;
  memo: string | null;
};

type StoredSettlementLine = {
  line_number: number;
  kind: string;
  external_ref: string | null;
  description: string | null;
  amount: string;
  currency: string | null;
  document_id: string | null;
  meta: unknown;
};

type SettlementFxPlan = {
  sourceCurrency: string;
  conversionRate: string;
  conversionRateSource: string;
  payoutRate: string | null;
  payoutRateSource: string | null;
} | null;

/**
 * Compare provider evidence only — everything the provider asserted about
 * the payout (currency, footed totals, settlement day, FX evidence, raw
 * payload, memo, and every evidence line). Posting configuration (bank,
 * fee, dispute, FX and clearing accounts, subsidiary) is deliberately
 * excluded: an unposted draft carries whatever configuration the first
 * import supplied, and re-importing the same reference with the missing
 * configuration repairs the draft instead of conflicting with it.
 * Returns null when the evidence is identical, otherwise a short
 * operator-readable description of the first difference.
 */
function settlementEvidenceDifference(
  row: StoredSettlementHeader,
  lines: StoredSettlementLine[],
  parsed: ParsedSettlement,
  currency: string,
  totals: ReturnType<typeof summarizeSettlement>,
  fx: SettlementFxPlan,
): string | null {
  const sameAmount = (stored: string, expected: string) => toUnits(stored) === toUnits(expected);
  const totalPairs: Array<[label: string, stored: string, expected: string]> = [
    ["gross amount", row.gross_amount, totals.grossAmount],
    ["fee amount", row.fee_amount, totals.feeAmount],
    ["refund amount", row.refund_amount, totals.refundAmount],
    ["dispute amount", row.dispute_amount, totals.disputeAmount],
    ["adjustment amount", row.adjustment_amount, totals.adjustmentAmount],
    ["net amount", row.net_amount, totals.netAmount],
    ["fx amount", row.fx_amount, totals.fxAmount],
  ];
  if (row.currency !== currency) {
    return `currency differs (stored ${row.currency} vs imported ${currency})`;
  }
  for (const [label, stored, expected] of totalPairs) {
    if (!sameAmount(stored, expected)) {
      return `${label} differs (stored ${stored} vs imported ${expected})`;
    }
  }
  if (row.settlement_date !== parsed.settlementDate) {
    return `settlement date differs (stored ${row.settlement_date} vs imported ${parsed.settlementDate})`;
  }
  const fxPairs: Array<[label: string, stored: string | null, expected: string | null]> = [
    ["source currency", row.source_currency ?? null, fx?.sourceCurrency ?? null],
    ["conversion rate", row.conversion_rate ?? null, fx?.conversionRate ?? null],
    [
      "conversion rate source",
      row.conversion_rate_source ?? null,
      fx?.conversionRateSource ?? null,
    ],
    ["payout rate", row.payout_rate ?? null, fx?.payoutRate ?? null],
    ["payout rate source", row.payout_rate_source ?? null, fx?.payoutRateSource ?? null],
  ];
  for (const [label, stored, expected] of fxPairs) {
    if (stored !== expected) {
      return `${label} differs (stored ${stored ?? "(none)"} vs imported ${expected ?? "(none)"})`;
    }
  }
  if (stableJson(row.source_payload) !== stableJson(parsed.raw ?? null)) {
    return "provider payload differs from the persisted import";
  }
  if (row.memo !== (parsed.memo ?? null)) {
    return "memo differs from the persisted import";
  }
  if (row.line_count !== parsed.lines.length || lines.length !== parsed.lines.length) {
    return `line count differs (stored ${row.line_count} vs imported ${parsed.lines.length})`;
  }
  for (const [index, line] of parsed.lines.entries()) {
    const stored = lines[index];
    const label = `line ${index + 1}`;
    if (stored === undefined || stored.line_number !== index + 1 || stored.kind !== line.kind) {
      return `${label} kind differs (stored ${stored?.kind ?? "(missing)"} vs imported ${line.kind})`;
    }
    if (stored.external_ref !== (line.externalRef ?? null)) {
      return `${label} reference differs (stored ${stored.external_ref ?? "(none)"} vs imported ${line.externalRef ?? "(none)"})`;
    }
    if (stored.description !== (line.description ?? null)) {
      return `${label} description differs from the persisted import`;
    }
    if (!sameAmount(stored.amount, line.amount)) {
      return `${label} amount differs (stored ${stored.amount} vs imported ${line.amount})`;
    }
    if (stored.currency !== (line.currency ?? null)) {
      return `${label} currency differs (stored ${stored.currency ?? "(none)"} vs imported ${line.currency ?? "(none)"})`;
    }
    // The document link is operator matching evidence, never provider
    // evidence: no parser sets documentId, so a stored link must not turn a
    // same-reference refetch into a conflict. Provider evidence (kind, ref,
    // description, amount, currency, meta) still refuses on any drift.
    if (stableJson(stored.meta) !== stableJson(line.meta ?? {})) {
      return `${label} detail differs from the persisted import`;
    }
  }
  return null;
}

/**
 * Compare the posting configuration a re-import carries against the
 * persisted draft's. Returns the labels of the fields that would change;
 * empty when the configuration already matches.
 */
function settlementConfigChanges(
  row: StoredSettlementHeader,
  accounts: Partial<ImportAccounts>,
  subsidiaryId: string | null,
): string[] {
  const changes: string[] = [];
  const pairs: Array<[label: string, stored: string | null, incoming: string | null | undefined]> =
    [
      ["bank account", row.bank_account_id, accounts.bankAccountId],
      ["fee account", row.fee_account_id, accounts.feeAccountId],
      ["dispute account", row.dispute_account_id, accounts.disputeAccountId],
      ["fx account", row.fx_account_id, accounts.fxAccountId],
      ["clearing account", row.clearing_account_id, accounts.clearingAccountId],
    ];
  for (const [label, stored, incoming] of pairs) {
    if (stored !== (incoming ?? null)) changes.push(label);
  }
  if (row.subsidiary_id !== subsidiaryId) changes.push("subsidiary");
  return changes;
}

/**
 * Persist a draft batch + lines (idempotent). Does not post GL.
 */
export async function importSettlementBatch(
  orgId: string,
  actorId: string | null,
  parsed: ParsedSettlement,
  accounts: Partial<ImportAccounts>,
  allowedSubsidiaryIds: ReadonlySet<string> | null = null,
): Promise<{ batchId: string; created: boolean }> {
  if (!parsed.externalRef.trim()) {
    throw new PspSettlementError("provider settlement reference is required");
  }
  if (parsed.lines.length === 0) {
    throw new PspSettlementError("settlement batch has no evidence lines");
  }
  // Provider parsers forward closed_at/date/fallback timestamps as a sliced
  // calendar day without checking calendar reality, so an impossible day
  // would otherwise die in Postgres as a raw cast failure (a 500 at the
  // route, which maps only PspSettlementError to 422). Fail closed here —
  // the single pre-write choke point every provider and direct caller
  // passes through — with the same shape the reverse action requires.
  if (!isIsoCalendarDate(parsed.settlementDate)) {
    throw new PspSettlementError("settlement date must be a real calendar date (YYYY-MM-DD)");
  }
  const currency = parsed.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new PspSettlementError("settlement currency must be a three-letter code");
  }
  // Cross-currency batches convert at evidenced rates only. Every line is in
  // the batch currency or the evidenced source currency, and every
  // source-currency line carries its own exchange_rate or rides the batch
  // conversion_rate. A foreign line with neither names exchange_rate, so an
  // operator knows exactly which evidence to supply.
  const fx = parsed.fx ?? null;
  let sourceCurrency = "";
  let conversionRate = "";
  let conversionRateSource = "";
  let payoutRate: string | null = null;
  let payoutRateSource: string | null = null;
  if (fx) {
    sourceCurrency = requireSettlementCurrency(
      fx.sourceCurrency,
      "settlement source currency is required whenever conversion evidence is supplied",
      "settlement source currency must be a three-letter currency code",
    );
    if (sourceCurrency === currency) {
      throw new PspSettlementError(
        "settlement source currency must differ from the batch currency",
      );
    }
    conversionRate = requireFxRate(fx.rate, "settlement conversion_rate");
    conversionRateSource = (fx.rateSource ?? "").trim();
    if (conversionRateSource === "") {
      throw new PspSettlementError(
        "settlement conversion_rate_source is required alongside conversion_rate",
      );
    }
    if (fx.payoutRate != null) {
      payoutRate = requireFxRate(fx.payoutRate, "settlement payout_rate");
      payoutRateSource = (fx.payoutRateSource ?? "").trim() || null;
      if (!payoutRateSource) {
        throw new PspSettlementError(
          "settlement payout_rate_source is required alongside payout_rate",
        );
      }
    }
  }
  for (const [lineIndex, line] of parsed.lines.entries()) {
    const lineCurrency = (line.currency ?? "").toUpperCase() || currency;
    if (lineCurrency !== currency && lineCurrency !== sourceCurrency) {
      throw new PspSettlementError(
        `settlement line ${lineIndex + 1} in ${lineCurrency} matches neither the batch currency ${currency} nor the evidenced source currency ${sourceCurrency || "(none)"}; re-import with conversion_rate evidence for that currency`,
      );
    }
    if (lineCurrency !== currency) {
      const meta = line.meta ?? {};
      if (meta.exchangeRate == null && conversionRate === "") {
        throw new PspSettlementError(
          `settlement line ${lineIndex + 1} in ${lineCurrency} has no exchange-rate evidence; supply exchange_rate on the balance transaction or conversion_rate on the batch import`,
        );
      }
      if (meta.exchangeRate != null) {
        requireFxRate(meta.exchangeRate, `settlement line ${lineIndex + 1} exchange_rate`);
      }
      if (meta.bookedAmount != null) {
        try {
          toUnits(String(meta.bookedAmount));
        } catch {
          throw new PspSettlementError(
            `settlement line ${lineIndex + 1} bookedAmount must be an exact decimal amount`,
          );
        }
      }
    }
    if (line.documentId != null && !isUuid(line.documentId)) {
      throw new PspSettlementError(
        `settlement line ${lineIndex + 1} receipt reference is not a valid document id`,
      );
    }
  }
  // The subsidiary reference enters the lifecycle here too: a malformed id
  // would otherwise die in Postgres as a raw uuid-cast 500, and a foreign
  // or inactive id would persist to strand the draft at posting.
  // Absence stays lenient — the import form asks up front, and posting
  // resolves an absent subsidiary exactly like every other document.
  const subsidiaryId =
    typeof accounts.subsidiaryId === "string" && accounts.subsidiaryId !== ""
      ? accounts.subsidiaryId
      : null;
  if (subsidiaryId !== null) {
    if (!isUuid(subsidiaryId)) {
      throw new PspSettlementError(
        `settlement subsidiary ${subsidiaryId} is not a valid subsidiary reference`,
      );
    }
    const sub = (
      await db.execute<{ name: string; isActive: boolean }>(
        sql`
      select name, is_active as "isActive"
        from subsidiaries
       where org_id = ${orgId} and id = ${subsidiaryId}
    `,
        "objects",
      )
    )[0];
    if (!sub) {
      throw new PspSettlementError(
        "settlement subsidiary is not a subsidiary of this organization",
      );
    }
    if (!sub.isActive) {
      throw new PspSettlementError(`subsidiary "${sub.name}" is inactive`);
    }
  }
  if (!subsidiaryScopeAllows(allowedSubsidiaryIds, subsidiaryId)) {
    throw new ScopeNotFoundError();
  }
  // Resolve and authorize posting accounts before any write: direct API
  // callers must satisfy the same subsidiary boundary as the import picker.
  await validateSettlementPostingAccounts(
    orgId,
    [
      { label: "bank", id: accounts.bankAccountId },
      { label: "fee", id: accounts.feeAccountId },
      { label: "dispute", id: accounts.disputeAccountId },
      { label: "fx", id: accounts.fxAccountId },
      { label: "clearing", id: accounts.clearingAccountId },
    ],
    allowedSubsidiaryIds,
    subsidiaryId,
  );
  // Stored totals are always in payout (batch) currency: a cross-currency
  // batch converts each line at its evidenced rate before footing, so the
  // bank leg matches the payout the provider actually paid. Lines keep their
  // source amounts with the rate evidence; posting reconciles the two.
  const totals = fx
    ? summarizeSettlement(
        parsed.lines.map((line) => {
          const lineCurrency = (line.currency ?? "").toUpperCase() || currency;
          if (lineCurrency === currency) return line;
          const rate = requireFxRate(
            (line.meta ?? {}).exchangeRate ?? conversionRate,
            "settlement conversion_rate",
          );
          return { ...line, amount: mulRate(line.amount, rate), currency };
        }),
      )
    : summarizeSettlement(parsed.lines);
  return withOrg(orgId, async () => {
    const proposedId = randomUUID();
    const inserted = await db.execute<{ id: string }>(
      sql`
      insert into psp_settlement_batches (
        id, org_id, provider, external_ref, status, currency,
        gross_amount, fee_amount, refund_amount, dispute_amount, adjustment_amount, net_amount, fx_amount,
        settlement_date, bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
        clearing_account_id, subsidiary_id, source_currency, conversion_rate, conversion_rate_source,
        payout_rate, payout_rate_source, source_payload, line_count, memo, created_by, updated_by
      ) values (
        ${proposedId}, ${orgId}, ${parsed.provider}, ${parsed.externalRef}, 'draft', ${currency},
        ${totals.grossAmount}, ${totals.feeAmount}, ${totals.refundAmount}, ${totals.disputeAmount},
        ${totals.adjustmentAmount}, ${totals.netAmount}, ${totals.fxAmount}, ${parsed.settlementDate},
        ${accounts.bankAccountId ?? null}, ${accounts.feeAccountId ?? null},
        ${accounts.disputeAccountId ?? null}, ${accounts.fxAccountId ?? null},
        ${accounts.clearingAccountId ?? null}, ${subsidiaryId},
        ${sourceCurrency || null}, ${conversionRate || null}, ${conversionRateSource || null},
        ${payoutRate}, ${payoutRateSource},
        ${parsed.raw ? JSON.stringify(parsed.raw) : null}::jsonb, ${parsed.lines.length},
        ${parsed.memo ?? null}, ${actorId}, ${actorId}
      )
      -- A redelivered provider batch collides here by design: the persisted
      -- batch selected below is reused and reconciled, so the first insert wins.
      on conflict (org_id, provider, external_ref) do nothing
      returning id
    `,
      "objects",
    );
    const created = inserted.length === 1;
    const current = await db.execute<{ id: string; status: string; subsidiary_id: string | null }>(
      sql`
      select id, status, subsidiary_id
        from psp_settlement_batches
       where org_id = ${orgId}
         and provider = ${parsed.provider}
         and external_ref = ${parsed.externalRef}
       for update
    `,
      "objects",
    );
    const row = current[0];
    if (!row) throw new PspSettlementError("settlement batch could not be locked");
    if (!subsidiaryScopeAllows(allowedSubsidiaryIds, row.subsidiary_id)) {
      throw new ScopeNotFoundError();
    }
    if (row.status === "void") {
      throw new PspSettlementError("a voided provider settlement reference cannot be reused");
    }
    const batchId = row.id;
    if (!created) {
      const stored = (
        await db.execute<{
          status: string;
          provider: string;
          external_ref: string;
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
          source_currency: string | null;
          conversion_rate: string | null;
          conversion_rate_source: string | null;
          payout_rate: string | null;
          payout_rate_source: string | null;
          source_payload: unknown;
          line_count: number;
          memo: string | null;
        }>(
          sql`
        select status, provider, external_ref, currency, gross_amount::text, fee_amount::text,
               refund_amount::text, dispute_amount::text, adjustment_amount::text,
               net_amount::text, fx_amount::text, settlement_date::text,
               bank_account_id, fee_account_id, dispute_account_id, fx_account_id,
               clearing_account_id, subsidiary_id, source_currency, conversion_rate::text,
               conversion_rate_source, payout_rate::text, payout_rate_source,
               source_payload, line_count, memo
          from psp_settlement_batches
         where id = ${batchId} and org_id = ${orgId}
      `,
          "objects",
        )
      )[0];
      const storedLines = await db.execute<{
        line_number: number;
        kind: string;
        external_ref: string | null;
        description: string | null;
        amount: string;
        currency: string | null;
        document_id: string | null;
        meta: unknown;
      }>(
        sql`
        select line_number, kind, external_ref, description, amount::text, currency, document_id, meta
          from psp_settlement_lines
         where batch_id = ${batchId} and org_id = ${orgId}
         order by line_number
      `,
        "objects",
      );
      if (!stored) throw new PspSettlementError("settlement batch could not be read");
      const persistedTotals = {
        grossAmount: stored.gross_amount,
        feeAmount: stored.fee_amount,
        refundAmount: stored.refund_amount,
        disputeAmount: stored.dispute_amount,
        adjustmentAmount: stored.adjustment_amount,
        netAmount: stored.net_amount,
        fxAmount: stored.fx_amount,
      };
      const conflict = (difference: string) =>
        new PspSettlementConflictError(
          `provider settlement reference already has different evidence (${difference}); use the persisted batch, then reverse it or record a separate adjustment`,
          {
            batchId,
            status: stored.status,
            provider: stored.provider,
            externalRef: stored.external_ref,
            currency: stored.currency,
            totals: persistedTotals,
          },
        );
      const evidenceDifference = settlementEvidenceDifference(
        stored,
        storedLines,
        parsed,
        currency,
        totals,
        sourceCurrency
          ? {
              sourceCurrency,
              conversionRate,
              conversionRateSource,
              payoutRate,
              payoutRateSource,
            }
          : null,
      );
      if (evidenceDifference) throw conflict(evidenceDifference);
      const configChanges = settlementConfigChanges(stored, accounts, subsidiaryId);
      if (configChanges.length === 0) return { batchId, created: false };
      // The evidence matches but the configuration drifted. A posted batch
      // is history and stays immutable; an unposted draft is repairable —
      // the re-import fills in (or corrects) its bank, clearing, fee,
      // dispute and FX accounts and subsidiary, audited, without touching
      // a single evidence line. This is the repair the post refusal advises.
      if (stored.status !== "draft") {
        throw conflict(
          `only the posting configuration differs (${configChanges.join(", ")}), and a ${stored.status} batch is immutable`,
        );
      }
      const before = {
        bankAccountId: stored.bank_account_id,
        feeAccountId: stored.fee_account_id,
        disputeAccountId: stored.dispute_account_id,
        fxAccountId: stored.fx_account_id,
        clearingAccountId: stored.clearing_account_id,
        subsidiaryId: stored.subsidiary_id,
      };
      const after = {
        bankAccountId: accounts.bankAccountId ?? null,
        feeAccountId: accounts.feeAccountId ?? null,
        disputeAccountId: accounts.disputeAccountId ?? null,
        fxAccountId: accounts.fxAccountId ?? null,
        clearingAccountId: accounts.clearingAccountId ?? null,
        subsidiaryId,
      };
      const repaired = await db.execute<never>(sql`
        update psp_settlement_batches
           set bank_account_id = ${after.bankAccountId},
               fee_account_id = ${after.feeAccountId},
               dispute_account_id = ${after.disputeAccountId},
               fx_account_id = ${after.fxAccountId},
               clearing_account_id = ${after.clearingAccountId},
               subsidiary_id = ${after.subsidiaryId},
               updated_at = now(), updated_by = ${actorId}
         where id = ${batchId} and org_id = ${orgId} and status = 'draft'
      `);
      if ((repaired.rowCount ?? 0) !== 1) {
        throw new PspSettlementError(
          "settlement draft changed while repairing it; reload and import again",
        );
      }
      await db.execute(sql`
        insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
        values (${orgId}, 'psp_settlement_batches', ${batchId}, 'update',
                ${JSON.stringify({
                  mode: "draft_configuration_repair",
                  changed: configChanges,
                  before,
                  after,
                })}::jsonb, ${actorId})
      `);
      return { batchId, created: false };
    }
    await insertLines(orgId, batchId, parsed.lines, actorId);
    // Margin restatement for the channel orders named in this payout. The
    // commerce module owns the restatement queue and this module cannot
    // import it (commerce already depends on payments, so the edge would
    // cycle), hence the direct insert. A payout with no channel orders
    // matches zero rows by design.
    await db.execute(sql`
      insert into channel_order_economics_pending (org_id, order_id, reason)
      select ${orgId}, o.id, ${`payout ${parsed.externalRef} settled`}
        from channel_orders o
       where o.org_id = ${orgId}
         and o.external_id in (
           select distinct l.meta->>'sourceOrderId'
             from psp_settlement_lines l
            where l.org_id = ${orgId} and l.batch_id = ${batchId} and l.meta ? 'sourceOrderId')
      -- A retried import collides here with the first mark winning: that mark
      -- already requires a full restatement including payout settlement costs.
      on conflict (org_id, order_id) do nothing`);
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
        (org_id, batch_id, line_number, kind, external_ref, description, amount, currency, document_id, meta, created_by, updated_by)
      values (${orgId}, ${batchId}, ${n}, ${l.kind}, ${l.externalRef ?? null}, ${l.description ?? null},
              ${l.amount}, ${l.currency ?? null}, ${l.documentId ?? null},
              ${JSON.stringify(l.meta ?? {})}::jsonb, ${actorId}, ${actorId})
    `);
  }
}
