import { sql } from "drizzle-orm";
import type { SqlExecutor } from "../platform/db.ts";
import { isUuid } from "../platform/uuid.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { PayrollError } from "./error.ts";

/**
 * Net-pay settlement clearing designations.
 *
 * Recording a pay run's payment normally relieves the net-pay payable against
 * a bank account. Some employers settle a run's net pay into a clearing
 * account instead and pay the individual cheques out of that clearing account
 * through their own bank transactions. A designation names that clearing
 * account for an inclusive date window; a payment dated inside the window may
 * settle to it. Designations live in the organization's payroll settings,
 * windows never overlap, and a window that a recorded payment used keeps its
 * identity, account, start and reason: it can only be end-dated on or after
 * the last payment date that used it.
 *
 * Callers hold the ledger-setup fence: settings changes take it exclusively,
 * payments take it shared, so a designation cannot change while a payment
 * that relies on it is being recorded.
 */
export interface NetPayClearingWindow {
  id: string;
  accountId: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string;
}

/** Account types that already have their own settlement semantics. */
const EXCLUDED_ACCOUNT_TYPES = new Set(["asset_bank", "asset_receivable", "liability_payable"]);

export const NET_PAY_CLEARING_SETTINGS_KEY = "netPaySettlementClearing";

/**
 * The designations as stored, checked for shape only. Used to read the
 * previous state of a settings change, so corrupted storage can still be
 * repaired by a valid replacement.
 */
function parseNetPayClearingShape(value: unknown): NetPayClearingWindow[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new PayrollError(
      "the net-pay settlement clearing designations are malformed — review them in Payroll setup → Accounts & posting",
    );
  }
  return value.map((entry, index) => {
    const row = entry as Record<string, unknown> | null;
    const reason = typeof row?.reason === "string" ? row.reason.trim() : "";
    if (
      !row ||
      typeof row !== "object" ||
      Array.isArray(row) ||
      !isUuid(row.id) ||
      !isUuid(row.accountId) ||
      !isIsoCalendarDate(row.effectiveFrom) ||
      !(
        row.effectiveTo === null ||
        (isIsoCalendarDate(row.effectiveTo) && row.effectiveTo >= row.effectiveFrom)
      ) ||
      reason.length === 0 ||
      reason.length > 500
    ) {
      throw new PayrollError(
        `net-pay settlement clearing designation ${index + 1} needs an id, an account, a start date, an end date on or after the start (or none) and a reason of 1–500 characters`,
      );
    }
    return {
      id: String(row.id).toLowerCase(),
      accountId: String(row.accountId).toLowerCase(),
      effectiveFrom: row.effectiveFrom as string,
      effectiveTo: (row.effectiveTo as string | null) ?? null,
      reason,
    };
  });
}

/**
 * The designations; absent settings mean none. Malformed storage, a repeated
 * id or overlapping windows refuse, so a payment date can never be covered by
 * more than one designation.
 */
export function parseNetPayClearingWindows(value: unknown): NetPayClearingWindow[] {
  const windows = parseNetPayClearingShape(value);
  if (new Set(windows.map((window) => window.id)).size !== windows.length) {
    throw new PayrollError("each net-pay settlement clearing designation needs its own id");
  }
  const ordered = [...windows].sort((a, b) => a.effectiveFrom.localeCompare(b.effectiveFrom));
  for (let index = 1; index < ordered.length; index++) {
    const previous = ordered[index - 1]!;
    if (previous.effectiveTo === null || previous.effectiveTo >= ordered[index]!.effectiveFrom) {
      throw new PayrollError(
        `net-pay settlement clearing designations overlap from ${ordered[index]!.effectiveFrom} — end the earlier designation before the next one starts`,
      );
    }
  }
  return windows;
}

function covers(window: NetPayClearingWindow, date: string): boolean {
  return (
    window.effectiveFrom <= date && (window.effectiveTo === null || date <= window.effectiveTo)
  );
}

/** The last payment date that settled to each designation. */
async function designationUsage(tx: SqlExecutor, orgId: string): Promise<Map<string, string>> {
  const rows = await tx.execute<{ id: string; last_paid_on: string }>(
    sql`
    select lower(changes->'settlement'->'designation'->>'id') as id, max(changes->>'paidOn') as last_paid_on
      from audit_log
     where org_id = ${orgId} and table_name = 'pay_runs'
       and changes->>'operation' = 'record_pay_run_payment'
       and changes->'settlement'->>'kind' = 'clearing'
     group by 1
  `,
    "objects",
  );
  return new Map(rows.filter((row) => row.id).map((row) => [row.id, row.last_paid_on]));
}

async function assertClearingAccount(
  tx: SqlExecutor,
  orgId: string,
  accountId: string,
  netPayAccountId: string | null,
): Promise<void> {
  const account = (
    await tx.execute<{ type: string; is_active: boolean; is_summary: boolean }>(
      sql`
    select type, is_active, is_summary from accounts where org_id = ${orgId} and id = ${accountId} for share
  `,
      "objects",
    )
  )[0];
  if (!account)
    throw new PayrollError(
      "the net-pay settlement clearing account does not exist in this organization",
    );
  if (!account.is_active || account.is_summary) {
    throw new PayrollError(
      "the net-pay settlement clearing account must be an active posting account — choose another account or reactivate it",
    );
  }
  if (EXCLUDED_ACCOUNT_TYPES.has(account.type)) {
    throw new PayrollError(
      account.type === "asset_bank"
        ? "a bank account is not a clearing account — record the payment against the bank instead"
        : "a receivable or payable control account cannot be a net-pay settlement clearing account",
    );
  }
  if (netPayAccountId && accountId === netPayAccountId) {
    throw new PayrollError(
      "the net-pay payable cannot also be its own settlement clearing account",
    );
  }
}

/**
 * Validate a change to the designations inside the settings transaction.
 * Returns the normalized windows to store.
 */
export async function validateNetPayClearingChange(
  tx: SqlExecutor,
  input: {
    orgId: string;
    actorId: string;
    before: unknown;
    after: unknown;
    /** The net-pay payable the settings will carry after this change. */
    netPayAccountId: string | null;
  },
): Promise<NetPayClearingWindow[]> {
  await lockActorCommandAuthority(tx, input.orgId, input.actorId, null, "payroll.manage");
  const before = parseNetPayClearingShape(input.before);
  const after = parseNetPayClearingWindows(input.after);
  for (const window of after)
    await assertClearingAccount(tx, input.orgId, window.accountId, input.netPayAccountId);
  const usage = await designationUsage(tx, input.orgId);
  for (const used of before) {
    const lastPaidOn = usage.get(used.id);
    if (!lastPaidOn) continue;
    const kept = after.find((window) => window.id === used.id);
    if (
      !kept ||
      kept.accountId !== used.accountId ||
      kept.effectiveFrom !== used.effectiveFrom ||
      kept.reason !== used.reason
    ) {
      throw new PayrollError(
        `the net-pay settlement clearing designation from ${used.effectiveFrom} settled a payment on ${lastPaidOn} — it can only be end-dated, not removed or changed`,
      );
    }
    if (kept.effectiveTo !== null && kept.effectiveTo < lastPaidOn) {
      throw new PayrollError(
        `the net-pay settlement clearing designation from ${used.effectiveFrom} settled a payment on ${lastPaidOn} — end it on or after that date`,
      );
    }
  }
  return after;
}

/**
 * The designation a payment dated `paidOn` may settle to, which must name
 * `accountId`. Read under the caller's shared ledger-setup fence.
 */
export async function resolveNetPayClearingDesignation(
  tx: SqlExecutor,
  input: {
    orgId: string;
    accountId: string;
    paidOn: string;
  },
): Promise<NetPayClearingWindow> {
  const settings = (
    await tx.execute<{ windows: unknown; net_pay_account_id: string | null }>(
      sql`
    select settings->'payroll'->${NET_PAY_CLEARING_SETTINGS_KEY} as windows,
           settings->'payroll'->>'netPayAccountId' as net_pay_account_id
      from orgs where id = ${input.orgId}
  `,
      "objects",
    )
  )[0];
  const covering = parseNetPayClearingWindows(settings?.windows).filter((candidate) =>
    covers(candidate, input.paidOn),
  );
  const window = covering.length === 1 ? covering[0] : undefined;
  if (!window || window.accountId !== input.accountId.toLowerCase()) {
    throw new PayrollError(
      `no net-pay settlement clearing designation names this account on ${input.paidOn} — designate it in Payroll setup → Accounts & posting, or record the payment against a bank account`,
    );
  }
  await assertClearingAccount(
    tx,
    input.orgId,
    window.accountId,
    settings?.net_pay_account_id ?? null,
  );
  return window;
}
