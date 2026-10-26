import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/business-date.ts";
import { canonicalJson } from "../platform/canonical-json.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { subsidiaryScopeAllows } from "../organization/subsidiary-scope.ts";
import {
  loadSubsidiaryContext,
  validateSubsidiaryRestrictions,
} from "../organization/subsidiaries.ts";
import { PaymentError } from "./payment-errors.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { assertProviderReturnPosting } from "./provider-return-posting.ts";

export const PROCESSOR_RECEIPT_POLICY_KEY = "processorReceiptPolicies";
export interface ProcessorReceiptPolicy {
  id: string;
  accountId: string;
  subsidiaryId: string;
  currency: string;
  effectiveFrom: string;
  effectiveTo: string | null;
}
export type ProcessorReceiptFunding = ProcessorReceiptPolicy & { provider: string };

export function processorReceiptPolicies(settings: unknown): ProcessorReceiptPolicy[] {
  const raw =
    settings && typeof settings === "object"
      ? (settings as Record<string, unknown>)[PROCESSOR_RECEIPT_POLICY_KEY]
      : undefined;
  if (raw === undefined) return [];
  if (!Array.isArray(raw))
    throw new PaymentError(
      "Processor receipt funding policy is invalid; review Payment Providers in Setup.",
    );
  return raw.map((value) => {
    if (!value || typeof value !== "object")
      throw new PaymentError("Processor receipt funding policy is invalid.");
    const row = value as ProcessorReceiptPolicy;
    if (
      !isUuid(row.id) ||
      !isUuid(row.accountId) ||
      !isUuid(row.subsidiaryId) ||
      typeof row.currency !== "string" ||
      !/^[A-Z]{3}$/.test(row.currency) ||
      !isIsoCalendarDate(row.effectiveFrom) ||
      (row.effectiveTo !== null && !isIsoCalendarDate(row.effectiveTo)) ||
      (row.effectiveTo !== null && row.effectiveTo < row.effectiveFrom)
    ) {
      throw new PaymentError(
        "Processor receipt funding policy has invalid identity, currency or effective dates.",
      );
    }
    return {
      id: row.id,
      accountId: row.accountId,
      subsidiaryId: row.subsidiaryId,
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
      effectiveTo: row.effectiveTo,
    };
  });
}

export function receiptPolicyWindowsOverlap(
  a: ProcessorReceiptPolicy,
  b: ProcessorReceiptPolicy,
): boolean {
  return (
    a.subsidiaryId === b.subsidiaryId &&
    a.currency === b.currency &&
    a.effectiveFrom <= (b.effectiveTo ?? "9999-12-31") &&
    b.effectiveFrom <= (a.effectiveTo ?? "9999-12-31")
  );
}

/** One provider-row authority for receipt eligibility. Posted receipts retain
 * their funding snapshot; draft saves and posting revalidate its live policy. */
export async function resolveReceiptFunding(
  tx: SqlExecutor,
  input: {
    orgId: string;
    accountId: string;
    kind: string;
    subsidiaryId: string | null;
    currency: string;
    onDate: string;
    allowedSubsidiaryIds: ReadonlySet<string> | null;
    snapshot?: unknown;
    lock?: boolean;
  },
): Promise<ProcessorReceiptFunding | null> {
  if (!isUuid(input.accountId) || !isIsoCalendarDate(input.onDate))
    throw new PaymentError("Receipt funding account or business date is invalid.");
  const account = (
    await tx.execute<{ id: string; type: string; currency_restriction: string | null }>(
      sql`
    select id, type, currency_restriction from accounts where org_id = ${input.orgId} and id = ${input.accountId}
      and is_active and not is_summary ${input.lock ? sql`for share` : sql``}`,
      "objects",
    )
  )[0];
  if (
    !account ||
    (account.currency_restriction !== null && account.currency_restriction !== input.currency)
  ) {
    throw new PaymentError("Receipt funding account is inactive or does not admit this currency.");
  }
  const ctx = await loadSubsidiaryContext(tx, input.orgId);
  const subsidiaryId = input.subsidiaryId ?? (account.type === "asset_bank" ? ctx.rootId : null);
  if (!subsidiaryId || !subsidiaryScopeAllows(input.allowedSubsidiaryIds, subsidiaryId))
    throw new PaymentError("Receipt funding account is not available in this legal entity.");
  try {
    await validateSubsidiaryRestrictions(tx, {
      orgId: input.orgId,
      ctx,
      docSubsidiaryId: subsidiaryId,
      lines: [{ accountId: input.accountId, subsidiaryId, amount: "0" }],
    });
  } catch (error) {
    throw new PaymentError(
      error instanceof Error
        ? error.message
        : "Receipt funding account belongs to another legal entity.",
    );
  }
  if (account.type === "asset_bank") {
    if (input.snapshot != null)
      throw new PaymentError(
        "The receipt's processor funding snapshot does not match its bank account; save and approve the corrected receipt.",
      );
    return null;
  }
  if (
    input.kind !== "customer_payment" ||
    account.type !== "asset_current_other" ||
    !(await lockAndCheckOrgFeature(tx, input.orgId, "banking"))
  ) {
    throw new PaymentError(
      "This funding account requires an effective processor receipt policy in Payment Providers → Setup.",
    );
  }
  const configs = await tx.execute<{
    provider: string;
    default_clearing_account_id: string | null;
    settings: unknown;
  }>(
    sql`
    select provider, default_clearing_account_id, settings from psp_provider_configs where org_id = ${input.orgId} and is_enabled
      order by provider ${input.lock ? sql`for share` : sql``}`,
    "objects",
  );
  const matching = configs.flatMap((config) =>
    processorReceiptPolicies(config.settings)
      .filter(
        (policy) =>
          policy.accountId === input.accountId &&
          config.default_clearing_account_id === policy.accountId &&
          policy.subsidiaryId === input.subsidiaryId &&
          policy.currency === input.currency &&
          policy.effectiveFrom <= input.onDate &&
          (policy.effectiveTo === null || policy.effectiveTo >= input.onDate),
      )
      .map((policy) => ({ ...policy, provider: config.provider })),
  );
  if (matching.length !== 1)
    throw new PaymentError(
      "No unique effective processor receipt policy admits this account, legal entity and currency; configure Payment Providers in Setup.",
    );
  const resolved = matching[0]!;
  if (input.snapshot != null) {
    const frozen = input.snapshot as ProcessorReceiptFunding;
    // Closing a future policy window does not rewrite a receipt's original
    // mapping; posting still requires its business date to remain admitted.
    const identity = (row: ProcessorReceiptFunding) => ({
      id: row.id,
      provider: row.provider,
      accountId: row.accountId,
      subsidiaryId: row.subsidiaryId,
      currency: row.currency,
      effectiveFrom: row.effectiveFrom,
    });
    if (canonicalJson(identity(frozen)) !== canonicalJson(identity(resolved)))
      throw new PaymentError(
        "Processor receipt funding changed; save the receipt and complete approval again.",
      );
  }
  return resolved;
}

/** Posting cannot turn an arbitrary asset line into a processor receipt. */
export async function assertReceiptFundingPosting(
  tx: SqlExecutor,
  document: {
    orgId: string;
    id: string;
    kind: string;
    subsidiaryId: string | null;
    currency: string;
    documentDate: string;
    postingDate?: string | null;
    custom: unknown;
  },
  actorId: string | null,
  actualAccountIds: readonly (string | null)[] = [],
): Promise<void> {
  if (document.kind !== "customer_payment" && document.kind !== "vendor_payment") return;
  const custom = (document.custom ?? {}) as Record<string, unknown>;
  if (custom.providerReturn !== undefined) {
    assertProviderReturnPosting(document);
    return;
  }
  let allowed: ReadonlySet<string> | null = null;
  if (custom.processorFunding != null) {
    if (!actorId)
      throw new PaymentError("Processor receipt posting requires an authorized receipt actor.");
    allowed = await lockActorCommandAuthority(
      tx,
      document.orgId,
      actorId,
      document.subsidiaryId,
      "ar.pay",
    );
  }
  const tenders = Array.isArray(custom.storedValueTenders)
    ? (custom.storedValueTenders as { liabilityAccountId: string }[])
    : [];
  const storedValueAccounts = new Set(tenders.map((tender) => tender.liabilityAccountId));
  const cashAccounts = actualAccountIds.filter(
    (id): id is string => id !== null && !storedValueAccounts.has(id),
  );
  const selected = typeof custom.bankAccountId === "string" ? custom.bankAccountId : null;
  const accounts = [...new Set([...(selected ? [selected] : []), ...cashAccounts])];
  for (const accountId of accounts) {
    const funding = await resolveReceiptFunding(tx, {
      orgId: document.orgId,
      accountId,
      kind: document.kind,
      subsidiaryId: document.subsidiaryId,
      currency: document.currency,
      onDate: document.postingDate ?? document.documentDate,
      allowedSubsidiaryIds: allowed,
      snapshot: accountId === selected ? custom.processorFunding : undefined,
      lock: true,
    });
    if (funding) {
      if (
        custom.processorFunding == null ||
        accountId !== selected ||
        cashAccounts.some((id) => id !== accountId)
      ) {
        throw new PaymentError(
          "Save this processor receipt with its authorized clearing account, then complete approval before posting.",
        );
      }
    }
  }
}
