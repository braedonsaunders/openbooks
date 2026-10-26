import { sql } from "drizzle-orm";
import { db, withOrg } from "../platform/db.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import {
  type AcceptanceProvider,
  type OffSessionChargeOutcome,
  type OffSessionChargeRequest,
} from "./acceptance.ts";

/** Autopay policy: decline classification, the effective policy resolver and its refusals, and the feature gate every autopay write passes through. */

export class AutopayError extends Error {
  /** Stable machine-readable refusal code; the message stays human copy and may change. */
  code?: string;
}

/** Refusal code when no active collection policy exists for the billed scope. */
export const MISSING_COLLECTION_POLICY = "missing_collection_policy";

export type AutopayProvider = AcceptanceProvider;

export type ChargeFn = (
  provider: AcceptanceProvider,
  req: OffSessionChargeRequest,
) => Promise<OffSessionChargeOutcome>;

export type DeclineClass = "hard" | "soft" | "insufficient_funds" | "needs_authentication";

/**
 * Compare provider decline codes across naming habits: Stripe sends
 * snake_case (`authentication_required`), Adyen sends titled phrases
 * (`Authentication Required`), so classification strips case and every
 * non-alphanumeric before matching. Pure.
 */
export function normalizeDeclineCode(declineCode: string): string {
  return declineCode.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Provider decline codes that must never retry: the instrument is gone
 * (stolen/lost/expired card, closed account) or the mandate is dead, so
 * another charge can only fail the same way and the customer must supply
 * new payment details. Entries are normalized (see normalizeDeclineCode).
 */
const HARD_DECLINE_CODES: ReadonlySet<string> = new Set([
  // Stripe card errors that never clear on retry.
  "lostcard",
  "stolencard",
  "expiredcard",
  "cardclosed",
  "pickupcard",
  "restrictedcard",
  "accountclosed",
  "invalidaccount",
  "incorrectnumber",
  "invalidexpirymonth",
  "invalidexpiryyear",
  "revocationofauthorization",
  "revocationofallauthorizations",
  "fraudulent",
  // GoCardless bank-debit terminal states.
  "closedaccount",
  "invalidaccountholdername",
  "invalidbankaccount",
  "directdebitnotenabled",
  "mandatecancelled",
  "mandateexpired",
  "mandatefailed",
  "cancelled",
  "customerapprovaldenied",
  // Adyen refusal reasons that never clear on retry.
  "cancelorrefund",
  "blockedcard",
  "stolencard",
  "lostcard",
  "expiredcard",
  "invalidcardnumber",
  "invalidaccount",
  "closedaccount",
  "noaccount",
  "referral",
  "fraud",
  // Autopay's own terminal markers (missing linkage, not a provider retry).
  "missingshopperreference",
]);

/**
 * Declines that clear when money arrives: the instrument is fine but empty.
 * These retry near typical paydays instead of on the generic cadence.
 */
const INSUFFICIENT_FUNDS_CODES: ReadonlySet<string> = new Set([
  "insufficientfunds",
  "balanceinsufficient",
  "notenoughbalance",
]);

/**
 * Declines that clear when the customer proves it is them: 3DS and
 * issuer-mandated authentication. These never retry automatically — the
 * customer gets an authentication link instead.
 */
const NEEDS_AUTHENTICATION_CODES: ReadonlySet<string> = new Set([
  "authenticationrequired",
  "authenticationfailed",
  "threedsrequired",
]);

/**
 * Classify a provider decline code, or null when nothing declined. Pure.
 * Everything unrecognized retries as soft — a new code fails open toward
 * collection, and the schedule bounds the attempts.
 */
export function classifyDecline(declineCode: string | null | undefined): DeclineClass | null {
  if (declineCode == null || declineCode === "") return null;
  const code = normalizeDeclineCode(declineCode);
  if (HARD_DECLINE_CODES.has(code)) return "hard";
  if (INSUFFICIENT_FUNDS_CODES.has(code)) return "insufficient_funds";
  if (NEEDS_AUTHENTICATION_CODES.has(code)) return "needs_authentication";
  return "soft";
}

export type AutopayFinalAction = "none" | "suspend" | "cancel";

export interface AutopayPolicy {
  policyId: string;
  policyName: string;
  retryOffsetsDays: number[];
  insufficientFundsOffsetsDays: number[];
  finalAction: AutopayFinalAction;
  gracePeriodDays: number;
  expiryNoticeDays: number;
}

/**
 * The retry ladder a decline class runs on: soft declines use the generic
 * cadence, insufficient-funds declines use the payday-adjacent ladder, and
 * hard or authentication-required declines run no ladder at all — the first
 * waits for new payment details, the second for the customer. Pure.
 */
export function retryLadderForClass(policy: AutopayPolicy, declineClass: DeclineClass): number[] {
  switch (declineClass) {
    case "soft":
      return policy.retryOffsetsDays;
    case "insufficient_funds":
      return policy.insufficientFundsOffsetsDays;
    case "hard":
    case "needs_authentication":
      return [];
  }
}

/**
 * Validate retry offsets from the dunning policy write boundary: whole days,
 * each at least a day out, bounded so a misconfigured ladder cannot spin a
 * charge loop. Pure — throws AutopayError naming the fix.
 */
export function parseRetryOffsetsDays(value: unknown): number[] {
  if (!Array.isArray(value))
    throw new AutopayError("retry offsets must be a list of whole days, e.g. [1, 3, 7]");
  if (value.length > 8)
    throw new AutopayError(
      "retry offsets hold at most 8 entries; shorten the schedule in Setup → Collections",
    );
  const offsets: number[] = [];
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isInteger(entry) || entry < 1 || entry > 90) {
      throw new AutopayError(
        `retry offset ${JSON.stringify(entry)} is not a whole day between 1 and 90; fix it in Setup → Collections`,
      );
    }
    offsets.push(entry);
  }
  return offsets;
}

export function parseFinalAction(value: unknown): AutopayFinalAction {
  if (value === "none" || value === "suspend" || value === "cancel") return value;
  throw new AutopayError(
    `final action ${JSON.stringify(value)} is not one of none, suspend or cancel; fix it in Setup → Collections`,
  );
}

/**
 * Validate the pre-expiry outreach window from the policy write boundary:
 * whole days, at least a day out, bounded so a misconfigured window cannot
 * notify a year ahead. Pure — throws AutopayError naming the fix.
 */
export function parseExpiryNoticeDays(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 90) {
    throw new AutopayError(
      `pre-expiry notice window ${JSON.stringify(value)} is not a whole day between 1 and 90; fix it in Setup → Collections`,
    );
  }
  return value;
}

/**
 * The autopay policy for an org: the latest-updated active customer-invoice
 * dunning policy, which is also where the operator edits the retry schedule.
 * Refuses by name when no active policy exists — retrying without a schedule
 * would charge on an invisible timetable.
 */
export async function resolveAutopayPolicy(orgId: string): Promise<AutopayPolicy> {
  const rows = await db.execute<{
    policyId: string;
    policyName: string;
    retryOffsets: unknown;
    insufficientFundsOffsets: unknown;
    finalAction: unknown;
    gracePeriodDays: number;
    expiryNoticeDays: unknown;
  }>(
    sql`
    select id as "policyId", name as "policyName",
           autopay_retry_offsets_days as "retryOffsets",
           autopay_insufficient_funds_offsets_days as "insufficientFundsOffsets",
           autopay_final_action as "finalAction",
           grace_period_days as "gracePeriodDays",
           autopay_expiry_notice_days as "expiryNoticeDays"
      from dunning_policies
     where org_id = ${orgId} and is_active and applies_to_kind = 'customer_invoice'
     order by updated_at desc limit 1
  `,
    "objects",
  );
  const policy = rows[0];
  if (!policy) {
    const missing = new AutopayError(
      "no active collection policy for customer invoices; activate one in Setup → Collections before enrolling customers in autopay",
    );
    missing.code = MISSING_COLLECTION_POLICY;
    throw missing;
  }
  return {
    policyId: policy.policyId,
    policyName: policy.policyName,
    retryOffsetsDays: parseRetryOffsetsDays(policy.retryOffsets),
    insufficientFundsOffsetsDays: parseRetryOffsetsDays(policy.insufficientFundsOffsets),
    finalAction: parseFinalAction(policy.finalAction),
    gracePeriodDays: policy.gracePeriodDays,
    expiryNoticeDays: parseExpiryNoticeDays(policy.expiryNoticeDays),
  };
}

/** Fail closed when the autopay surface is off: hidden means refused, never charged. */
export async function requireAutopayFeature(orgId: string): Promise<void> {
  if (!(await lockAndCheckOrgFeature(db, orgId, "autopay"))) {
    throw new AutopayError(
      "Autopay is disabled; enable it in Company Settings → Features before changing payment methods or enrollments",
    );
  }
}

export function auditAutopay(
  orgId: string,
  table: string,
  rowId: string,
  changes: Record<string, unknown>,
  actorId: string | null,
) {
  return db.execute(sql`
    insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
    values (${orgId}, ${table}, ${rowId}, 'update', ${JSON.stringify(changes)}::jsonb, ${actorId})
  `);
}

/**
 * Save the autopay retry schedule and final action on a dunning policy. The
 * schedule runs from the policy the scan reads, so the write validates
 * exactly what the scan will execute.
 */
export async function saveAutopayPolicy(
  orgId: string,
  input: {
    policyId: string;
    retryOffsetsDays: unknown;
    insufficientFundsOffsetsDays?: unknown;
    expiryNoticeDays?: unknown;
    finalAction: unknown;
    actorId?: string | null;
  },
): Promise<AutopayPolicy> {
  const offsets = parseRetryOffsetsDays(input.retryOffsetsDays);
  const insufficientOffsets =
    input.insufficientFundsOffsetsDays === undefined
      ? null
      : parseRetryOffsetsDays(input.insufficientFundsOffsetsDays);
  const expiryNoticeDays =
    input.expiryNoticeDays === undefined ? null : parseExpiryNoticeDays(input.expiryNoticeDays);
  const finalAction = parseFinalAction(input.finalAction);
  const offsetsList = (list: number[]) =>
    list.length > 0
      ? sql`ARRAY[${sql.join(
          list.map((offset) => sql`${offset}`),
          sql`, `,
        )}]`
      : sql`'{}'::integer[]`;
  return withOrg(orgId, async () => {
    await requireAutopayFeature(orgId);
    const updated = await db.execute<{
      id: string;
      name: string;
      grace_period_days: number;
      insufficient_funds_offsets: unknown;
      expiry_notice_days: number;
    }>(
      sql`
      update dunning_policies
         set autopay_retry_offsets_days = ${offsetsList(offsets)},
             autopay_insufficient_funds_offsets_days = coalesce(${insufficientOffsets === null ? sql`null::integer[]` : offsetsList(insufficientOffsets)}, autopay_insufficient_funds_offsets_days),
             autopay_expiry_notice_days = coalesce(${expiryNoticeDays}, autopay_expiry_notice_days),
             autopay_final_action = ${finalAction},
             updated_at = now(), updated_by = ${input.actorId ?? null}
       where id = ${input.policyId} and org_id = ${orgId}
       returning id, name, grace_period_days as "grace_period_days",
                 autopay_insufficient_funds_offsets_days as "insufficient_funds_offsets",
                 autopay_expiry_notice_days as "expiry_notice_days"
    `,
      "objects",
    );
    const row = updated[0];
    if (!row) throw new AutopayError("collection policy not found");
    const resolvedInsufficient =
      insufficientOffsets ?? parseRetryOffsetsDays(row.insufficient_funds_offsets);
    const resolvedExpiry = expiryNoticeDays ?? parseExpiryNoticeDays(row.expiry_notice_days);
    await auditAutopay(
      orgId,
      "dunning_policies",
      row.id,
      {
        event: "autopay_policy_saved",
        after: {
          retryOffsetsDays: offsets,
          insufficientFundsOffsetsDays: resolvedInsufficient,
          expiryNoticeDays: resolvedExpiry,
          finalAction,
        },
        reason: "Operator changed the autopay retry schedule or final action.",
      },
      input.actorId ?? null,
    );
    return {
      policyId: row.id,
      policyName: row.name,
      retryOffsetsDays: offsets,
      insufficientFundsOffsetsDays: resolvedInsufficient,
      finalAction,
      gracePeriodDays: row.grace_period_days,
      expiryNoticeDays: resolvedExpiry,
    };
  });
}

/**
 * The operator-facing remedy for a terminal decline: hard declines need new
 * payment details, authentication-required declines need the customer to
 * verify, and an exhausted ladder has nothing left to try. Pure.
 */
export function terminalDeclineDetail(kind: DeclineClass, declineCode: string | null): string {
  if (kind === "hard") {
    return `declined (${declineCode ?? "unknown reason"}) — no retry; ask the customer to update the payment method`;
  }
  if (kind === "needs_authentication") {
    return `declined (${declineCode ?? "unknown reason"}) — send the customer the authentication link to verify the payment`;
  }
  return `final retry declined${declineCode ? ` (${declineCode})` : ""}`;
}
