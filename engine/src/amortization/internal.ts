/** Shared amortization internals: gates, authority, audit, numbering and plan rows. */
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { fromUnits, toUnits } from "../money/money.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import {
  acquireOrgFeatureGateLock,
  lockAndCheckOrgFeature,
} from "../organization/org-feature-lock.ts";
import type { SqlExecutor } from "../platform/db.ts";
import {
  AMORTIZATION_FEATURE_KEY,
  AMORTIZATION_FEATURE_REMEDY,
  AmortizationError,
} from "./errors.ts";
import type {
  AmortizationMethod,
  AmortizationPolicy,
  AmortizationTermSource,
  PlannedPeriod,
} from "./plan.ts";

export type AmortizationPermission = "amortization.read" | "amortization.manage";

/**
 * Hold the organization's feature fence and refuse when Expense
 * amortization is off, so a disable and a write serialize.
 */
export async function assertAmortizationFeature(runner: SqlExecutor, orgId: string): Promise<void> {
  await acquireOrgFeatureGateLock(runner, orgId);
  if (!(await lockAndCheckOrgFeature(runner, orgId, AMORTIZATION_FEATURE_KEY))) {
    throw new AmortizationError("Expense amortization is not enabled for this organization.", {
      status: 403,
      code: "amortization_feature_off",
      remedy: AMORTIZATION_FEATURE_REMEDY,
    });
  }
}

/**
 * Service-boundary authority: the actor's live grants must hold the duty and
 * reach the subsidiary. Returns the subsidiaries the actor reaches (null when
 * unrestricted). The refusal names the permission and who grants it.
 */
export async function requireAmortizationAuthority(
  runner: SqlExecutor,
  orgId: string,
  actorId: string,
  subsidiaryId: string | null,
  permission: AmortizationPermission,
): Promise<ReadonlySet<string> | null> {
  try {
    return await lockActorCommandAuthority(runner, orgId, actorId, subsidiaryId, permission);
  } catch {
    throw new AmortizationError(
      subsidiaryId
        ? `This action requires the ${permission} permission for the schedule's subsidiary.`
        : `This action requires the ${permission} permission.`,
      {
        status: 403,
        code: "amortization_forbidden",
        remedy: `Ask an administrator to grant ${permission} and access to the subsidiary (Company Settings → Roles), then try again.`,
      },
    );
  }
}

/** One audit_log row; a write that stores nothing is a failure. */
export async function writeAmortizationAudit(
  runner: SqlExecutor,
  input: {
    orgId: string;
    table: string;
    rowId: string;
    action: string;
    actorId: string | null;
    changes: Record<string, unknown>;
  },
): Promise<void> {
  const written = await runner.execute<{ id: string }>(
    sql`
    insert into audit_log (id, org_id, table_name, row_id, action, changes, actor_id)
    values (${randomUUID()}, ${input.orgId}, ${input.table}, ${input.rowId}, ${input.action},
      ${JSON.stringify(input.changes)}::jsonb, ${input.actorId})
    returning id`,
    "objects",
  );
  if (written.length !== 1) {
    throw new AmortizationError("The audit record was not written; the change was not saved.", {
      status: 409,
      code: "amortization_audit_unwritten",
      remedy: "Try the change again.",
    });
  }
}

/** ISO minor-unit exponent of a currency; an unknown code refuses by name. */
export async function amortizationCurrencyExponent(
  runner: SqlExecutor,
  currency: string,
): Promise<number> {
  const row = (
    await runner.execute<{ minor_units: number }>(
      sql`
    select minor_units from currencies where code = ${currency}`,
      "objects",
    )
  )[0];
  const exponent = row?.minor_units;
  if (exponent === undefined || !Number.isInteger(exponent) || exponent < 0 || exponent > 4) {
    throw new AmortizationError(
      `Currency ${currency} has no supported precision in the currency registry.`,
      {
        code: "amortization_currency_unknown",
        remedy: `Restore ${currency} in the currency registry (Company Settings → Currencies) before amortizing in it.`,
      },
    );
  }
  return exponent;
}

/**
 * Next schedule number for the organization (AMS-000001, …). Serialized per
 * organization by a transaction-scoped advisory lock, so concurrent postings
 * never race for the same number.
 */
export async function nextScheduleNumber(runner: SqlExecutor, orgId: string): Promise<string> {
  await runner.execute(sql`
    select pg_advisory_xact_lock(hashtextextended(${`openbooks:amortization-schedule-number:${orgId}`}, 0))`);
  const row = (
    await runner.execute<{ next: string }>(
      sql`
    select (coalesce(max(substring(schedule_number from '^AMS-([0-9]+)$')::bigint), 0) + 1)::text as next
      from expense_amortization_schedules
     where org_id = ${orgId}`,
      "objects",
    )
  )[0];
  return `AMS-${(row?.next ?? "1").padStart(6, "0")}`;
}

/** A template version as stored, with its policy parsed for the plan math. */
export interface TemplateVersion {
  id: string;
  code: string;
  name: string;
  effectiveFrom: string;
  isActive: boolean;
  policy: AmortizationPolicy;
  deferralAccountId: string;
  destinationAccountId: string | null;
}

/**
 * One row of a stored percentage table. The setup form stores each period
 * as `{ "percent": "<decimal>" }`; a bare decimal string is read the same.
 * Anything else stays unparseable text, so the plan math refuses it by name.
 */
export function percentageEntry(entry: unknown): string {
  if (typeof entry === "string") return entry;
  if (entry !== null && typeof entry === "object" && "percent" in entry) {
    const percent = (entry as { percent: unknown }).percent;
    return typeof percent === "string" ? percent : JSON.stringify(percent);
  }
  return JSON.stringify(entry);
}

export function templateVersionFromRow(row: {
  id: string;
  code: string;
  name: string;
  effective_from: string;
  is_active: boolean;
  method: string;
  term_source: string;
  period_count: number | null;
  percentages: unknown;
  period_offset: number;
  deferral_account_id: string;
  destination_account_id: string | null;
}): TemplateVersion {
  const percentages = Array.isArray(row.percentages) ? row.percentages.map(percentageEntry) : null;
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    effectiveFrom: row.effective_from,
    isActive: row.is_active,
    policy: {
      method: row.method as AmortizationMethod,
      termSource: row.term_source as AmortizationTermSource,
      periodCount: row.period_count,
      percentages,
      periodOffset: row.period_offset,
    },
    deferralAccountId: row.deferral_account_id,
    destinationAccountId: row.destination_account_id,
  };
}

export const TEMPLATE_COLUMNS = sql`id, code, name, effective_from::text as effective_from, is_active, method, term_source,
  period_count, percentages, period_offset, deferral_account_id, destination_account_id`;

/** Insert one plan revision's lines; every row must land. */
export async function insertPlanLines(
  runner: SqlExecutor,
  input: {
    orgId: string;
    scheduleId: string;
    planRevision: number;
    lines: readonly (PlannedPeriod & { weight: bigint })[];
    destinationAccountId: string;
    actorId: string | null;
  },
): Promise<void> {
  if (input.lines.length === 0) return;
  const values = input.lines.map(
    (line) => sql`(${input.orgId}, ${input.scheduleId}, ${input.planRevision},
    ${line.periodStart}::date, ${line.periodEnd}::date, ${line.weight.toString()}::bigint, ${fromUnits(line.amount)}::numeric,
    ${input.destinationAccountId}, 'planned', ${input.actorId})`,
  );
  const inserted = await runner.execute<{ id: string }>(
    sql`
    insert into expense_amortization_schedule_lines
      (org_id, schedule_id, plan_revision, period_start, period_end, weight, planned_amount,
       destination_account_id, status, created_by)
    values ${sql.join(values, sql`, `)}
    returning id`,
    "objects",
  );
  if (inserted.length !== input.lines.length) {
    throw new AmortizationError(
      "The amortization plan was not stored completely; nothing was saved.",
      {
        status: 409,
        code: "amortization_plan_unwritten",
        remedy: "Try again.",
      },
    );
  }
}

/** Append one schedule event; the history is append-only. */
export async function recordScheduleEvent(
  runner: SqlExecutor,
  input: {
    orgId: string;
    scheduleId: string;
    kind: string;
    reason: string;
    effectivePeriodOn?: string | null;
    /** Accounting date of the balance change (the event date when none). */
    effectiveOn: string;
    /** Signed change to the unamortized balance besides posted plan lines. */
    balanceDelta?: bigint;
    before?: Record<string, unknown> | null;
    after: Record<string, unknown>;
    journalEntryId?: string | null;
    relatedDocumentId?: string | null;
    actorId: string | null;
  },
): Promise<string> {
  const row = (
    await runner.execute<{ id: string }>(
      sql`
    insert into expense_amortization_schedule_events
      (org_id, schedule_id, kind, effective_period_on, effective_on, balance_delta, reason,
       before_state, after_state, journal_entry_id, related_document_id, created_by)
    values (${input.orgId}, ${input.scheduleId}, ${input.kind}, ${input.effectivePeriodOn ?? null},
      ${input.effectiveOn}, ${fromUnits(input.balanceDelta ?? 0n)}::numeric, ${input.reason}, ${input.before ? JSON.stringify(input.before) : null}::jsonb,
      ${JSON.stringify(input.after)}::jsonb, ${input.journalEntryId ?? null},
      ${input.relatedDocumentId ?? null}, ${input.actorId})
    returning id`,
      "objects",
    )
  )[0];
  if (!row) {
    throw new AmortizationError("The schedule history was not written; the change was not saved.", {
      status: 409,
      code: "amortization_event_unwritten",
      remedy: "Try the change again.",
    });
  }
  await writeAmortizationAudit(runner, {
    orgId: input.orgId,
    table: "expense_amortization_schedules",
    rowId: input.scheduleId,
    action: input.kind,
    actorId: input.actorId,
    changes: {
      before: input.before ?? null,
      after: input.after,
      reason: input.reason,
      effectivePeriodOn: input.effectivePeriodOn ?? null,
      effectiveOn: input.effectiveOn,
      balanceDelta: fromUnits(input.balanceDelta ?? 0n),
      journalEntryId: input.journalEntryId ?? null,
    },
  });
  return row.id;
}

/** A required reason: trimmed, 5 to 2000 characters. */
export function requireReason(reason: unknown): string {
  const text = typeof reason === "string" ? reason.trim() : "";
  if (text.length < 5 || text.length > 2000) {
    throw new AmortizationError("Record a reason of 5 to 2000 characters for this change.", {
      code: "amortization_reason_required",
      remedy:
        "Describe why the schedule changes (for example, the contract was extended), then submit again.",
    });
  }
  return text;
}

/** Decimal ledger string to bigint units, refusing anything that is not an exact amount. */
export function ledgerUnits(value: string, label: string): bigint {
  try {
    return toUnits(value);
  } catch {
    throw new AmortizationError(`${label} is not an exact decimal amount.`, {
      code: "amortization_amount_invalid",
      remedy: `Enter ${label} as a plain decimal such as 1200.00.`,
    });
  }
}
