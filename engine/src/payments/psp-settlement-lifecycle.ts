import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { assertPeriodModulesOpen } from "../periods/period-policy.ts";
import { neg } from "../money/money.ts";
import { sealJson } from "../platform/secrets.ts";
import { assertNotSandbox } from "../organization/sandbox-guard.ts";
import {
  ScopeNotFoundError,
  assertUnrestrictedScope,
  subsidiaryScopeAllows,
} from "../organization/subsidiary-scope.ts";
import { markEntryReversed, postEntry } from "../journal/post-entry.ts";
import { PspSettlementError, isPspProvider } from "./psp-settlement-core.ts";
import type { PspProvider } from "./psp-settlement-core.ts";
import {
  periodForDate,
  validateSettlementPostingAccounts,
} from "./psp-settlement-posting-context.ts";
import { reverseOpenPayoutAccrualsForBatch } from "./psp-payout-accrual-reversal.ts";

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
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<{ entryId: string }> {
  await assertNotSandbox(orgId, "reverse a PSP settlement");
  const reason = input.reason.trim();
  if (reason.length < 5 || reason.length > 500) {
    throw new PspSettlementError("reversal reason must be between 5 and 500 characters");
  }
  return withOrg(orgId, () =>
    db.transaction(async (tx) => {
      const batch = await tx.execute<{
        status: string;
        journal_entry_id: string | null;
        reversal_entry_id: string | null;
        provider: string;
        external_ref: string;
        subsidiary_id: string | null;
      }>(
        sql`
      select status, journal_entry_id, reversal_entry_id, provider,
             external_ref, subsidiary_id
        from psp_settlement_batches
       where id = ${batchId} and org_id = ${orgId}
       for update
    `,
        "objects",
      );
      const b = batch[0];
      if (!b) throw new ScopeNotFoundError();
      if (!subsidiaryScopeAllows(allowedSubsidiaryIds, b.subsidiary_id))
        throw new ScopeNotFoundError();
      if (b.status === "void") {
        if (!b.reversal_entry_id) {
          throw new PspSettlementError("void batch is missing reversal evidence");
        }
        if (!b.subsidiary_id) {
          throw new PspSettlementError(
            "void batch is missing its subsidiary for payout-accrual reversal",
          );
        }
        const reversal = (
          await tx.execute<{ posting_date: string }>(
            sql`
        select posting_date::text from journal_entries
         where id = ${b.reversal_entry_id} and org_id = ${orgId}
      `,
            "objects",
          )
        )[0];
        if (!reversal) throw new PspSettlementError("void batch reversal journal is missing");
        await reverseOpenPayoutAccrualsForBatch(tx, {
          orgId,
          batchId,
          actorId,
          allowedSubsidiaryIds,
          subsidiaryId: b.subsidiary_id,
          postingDate: reversal.posting_date,
        });
        return { entryId: b.reversal_entry_id };
      }
      if (b.status !== "posted" || !b.journal_entry_id || !b.subsidiary_id) {
        throw new PspSettlementError("only a posted settlement batch can be reversed");
      }

      const source = await tx.execute<{
        book_id: string;
        subsidiary_id: string;
        entry_number: string;
        status: string;
        origin: string;
      }>(
        sql`
      select book_id, subsidiary_id, entry_number, status, origin
        from journal_entries
       where id = ${b.journal_entry_id} and org_id = ${orgId}
       for update
    `,
        "objects",
      );
      const original = source[0];
      if (!original || original.status !== "posted") {
        throw new PspSettlementError("settlement source journal is missing or already reversed");
      }
      const periodId = await periodForDate(orgId, input.reversalDate, original.subsidiary_id, tx);
      if (!periodId) {
        throw new PspSettlementError(`no open accounting period for ${input.reversalDate}`);
      }
      await assertPeriodModulesOpen(tx, {
        orgId,
        periodId,
        bookId: original.book_id,
        subsidiaryIds: [original.subsidiary_id],
        modules: ["banking"],
      });
      const lines = await tx.execute<Record<string, unknown>>(
        sql`
      select line_number, account_id, subsidiary_id, amount::text, currency,
             txn_amount::text, fx_rate::text, memo, party_id, department_id,
             project_id, location_id, class_id, equipment_unit_id,
             payment_card_id, tax_code_id, extra_dims
        from journal_lines
       where entry_id = ${b.journal_entry_id} and org_id = ${orgId}
       order by line_number
    `,
        "objects",
      );
      if (lines.length === 0) {
        throw new PspSettlementError("settlement source journal has no lines");
      }

      // The reversal mirrors the source lines exactly through the ONE ledger
      // API; the source entry is then marked reversed — never edited.
      const entryId = randomUUID();
      const postedReversal = await postEntry(tx, {
        id: entryId,
        orgId,
        bookId: original.book_id,
        subsidiaryId: original.subsidiary_id,
        entryNumber: `${original.entry_number}-VOID`,
        postingDate: input.reversalDate,
        periodId,
        memo: `Reversal: ${reason}`,
        origin: original.origin,
        reversesEntryId: b.journal_entry_id,
        actorId,
        lines: lines.map((line) => ({
          accountId: String(line.account_id),
          subsidiaryId: String(line.subsidiary_id),
          amount: neg(String(line.amount)),
          currency: String(line.currency),
          txnAmount: neg(String(line.txn_amount)),
          fxRate: String(line.fx_rate),
          memo: line.memo == null ? null : String(line.memo),
          partyId: line.party_id == null ? null : String(line.party_id),
          departmentId: line.department_id == null ? null : String(line.department_id),
          projectId: line.project_id == null ? null : String(line.project_id),
          locationId: line.location_id == null ? null : String(line.location_id),
          classId: line.class_id == null ? null : String(line.class_id),
          equipmentUnitId: line.equipment_unit_id == null ? null : String(line.equipment_unit_id),
          paymentCardId: line.payment_card_id == null ? null : String(line.payment_card_id),
          taxCodeId: line.tax_code_id == null ? null : String(line.tax_code_id),
          extraDims: (line.extra_dims ?? {}) as Record<string, string>,
          lineNumber: Number(line.line_number),
        })),
      });
      if (postedReversal.entryId !== entryId)
        throw new PspSettlementError("settlement reversal was not posted");
      await markEntryReversed(tx, {
        orgId,
        entryId: b.journal_entry_id,
        actorId,
      });
      await reverseOpenPayoutAccrualsForBatch(tx, {
        orgId,
        batchId,
        actorId,
        allowedSubsidiaryIds,
        subsidiaryId: original.subsidiary_id,
        postingDate: input.reversalDate,
      });
      const updated = await tx.execute<never>(sql`
      update psp_settlement_batches
         set status = 'void', reversal_entry_id = ${entryId},
             reversal_reason = ${reason}, reversed_at = now(),
             reversed_by = ${actorId}, updated_at = now(), updated_by = ${actorId}
       where id = ${batchId} and org_id = ${orgId}
    `);
      if ((updated.rowCount ?? 0) !== 1) {
        throw new PspSettlementError(
          "settlement batch could not be marked reversed; retry the reversal",
        );
      }
      const audited = await tx.execute<never>(sql`
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
      if ((audited.rowCount ?? 0) !== 1) {
        throw new PspSettlementError(
          "settlement batch reversal could not be audited; retry the reversal",
        );
      }
      return { entryId };
    }),
  );
}

/** Providers a scheduled payout pull serves; every other provider imports. */
export const PSP_PULL_PROVIDERS = [
  "stripe",
  "paypal",
  "shopify_payments",
] as const satisfies readonly PspProvider[];

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
    defaultDisputedFundsAccountId?: string | null;
    defaultChargebackLossAccountId?: string | null;
    defaultDisputeFeeAccountId?: string | null;
    pullEnabled?: boolean;
    apiKey?: string | null;
  },
  actorId: string | null,
  allowedSubsidiaryIds: ReadonlySet<string> | null,
): Promise<void> {
  assertUnrestrictedScope(allowedSubsidiaryIds);
  // Fail closed before any write: without this the storage CHECK surfaces
  // an unknown provider as a raw 500. The registry is the single list, so a
  // new provider cannot strand this guard behind the migration.
  if (!isPspProvider(input.provider)) {
    throw new PspSettlementError(`unknown provider ${String(input.provider)}`);
  }

  // A pull switch on a provider no scheduled pull serves would read as
  // automated while nothing ever imports.
  if (
    input.pullEnabled === true &&
    !(PSP_PULL_PROVIDERS as readonly string[]).includes(input.provider)
  ) {
    throw new PspSettlementError(
      `scheduled pull is not available for ${input.provider}; import its payouts instead`,
    );
  }
  // Default posting accounts are validated like any other settlement
  // reference: a foreign or unpostable id must not persist to detonate at
  // posting time.
  await validateSettlementPostingAccounts(orgId, [
    { label: "bank", id: input.defaultBankAccountId },
    { label: "fee", id: input.defaultFeeAccountId },
    { label: "dispute", id: input.defaultDisputeAccountId },
    { label: "disputed-funds", id: input.defaultDisputedFundsAccountId },
    { label: "chargeback-loss", id: input.defaultChargebackLossAccountId },
    { label: "dispute-fee", id: input.defaultDisputeFeeAccountId },
    { label: "fx", id: input.defaultFxAccountId },
    { label: "clearing", id: input.defaultClearingAccountId },
  ]);
  let secrets: string | null = null;
  if (input.apiKey)
    secrets = await sealJson(
      { apiKey: input.apiKey },
      { orgId, purpose: "payment.provider.secrets" },
    );
  await db.execute(sql`
    insert into psp_provider_configs
      (org_id, provider, display_name, is_enabled, default_bank_account_id, default_fee_account_id,
       default_dispute_account_id, default_fx_account_id, default_clearing_account_id,
       default_disputed_funds_account_id, default_chargeback_loss_account_id, default_dispute_fee_account_id,
       pull_enabled, secrets, created_by, updated_by)
    values (${orgId}, ${input.provider}, ${input.displayName ?? input.provider}, ${input.isEnabled},
            ${input.defaultBankAccountId ?? null}, ${input.defaultFeeAccountId ?? null},
            ${input.defaultDisputeAccountId ?? null}, ${input.defaultFxAccountId ?? null},
            ${input.defaultClearingAccountId ?? null},
            ${input.defaultDisputedFundsAccountId ?? null}, ${input.defaultChargebackLossAccountId ?? null},
            ${input.defaultDisputeFeeAccountId ?? null},
            coalesce(${input.pullEnabled ?? null}, false),
            ${secrets}, ${actorId}, ${actorId})
    on conflict (org_id, provider) do update set
      display_name = excluded.display_name,
      is_enabled = excluded.is_enabled,
      default_bank_account_id = excluded.default_bank_account_id,
      default_fee_account_id = excluded.default_fee_account_id,
      default_dispute_account_id = excluded.default_dispute_account_id,
      default_fx_account_id = excluded.default_fx_account_id,
      default_clearing_account_id = excluded.default_clearing_account_id,
      -- Automation fields are owned by the provider setup screen: an import
      -- save that omits them (it renders only posting defaults) keeps the
      -- stored policy instead of silently resetting review to automatic.
      -- Insert defaults live in the values above; updates preserve them.
      default_disputed_funds_account_id = coalesce(${input.defaultDisputedFundsAccountId ?? null}::uuid, psp_provider_configs.default_disputed_funds_account_id),
      default_chargeback_loss_account_id = coalesce(${input.defaultChargebackLossAccountId ?? null}::uuid, psp_provider_configs.default_chargeback_loss_account_id),
      default_dispute_fee_account_id = coalesce(${input.defaultDisputeFeeAccountId ?? null}::uuid, psp_provider_configs.default_dispute_fee_account_id),
      pull_enabled = coalesce(${input.pullEnabled ?? null}::boolean, psp_provider_configs.pull_enabled),
      secrets = coalesce(excluded.secrets, psp_provider_configs.secrets),
      updated_at = now(), updated_by = ${actorId}
    where psp_provider_configs.org_id = ${orgId}
  `);
}
