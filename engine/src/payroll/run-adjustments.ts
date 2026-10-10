import { createHash } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { canonicalDecimal } from "../money/exact-decimal.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { priceRunHolidayHours } from "./run-holiday-input.ts";
import { invalidateCalculatedRun } from "./run-lifecycle.ts";
import { finalPayEmploymentIdentity, namedFinalPayEmployment, namedSupplementalEmployment, supplementalEmploymentIdentity } from "./employment-roster.ts";
import { assertBankDepositAdjustment } from "./run-bank-input.ts";
import { lockAndCheckPayrollRunPopulation, payrollSubsidiaryInScope, type PayrollSubsidiaryScope } from "./scope.ts";

/**
 * Refusal when a reused adjustment idempotency key cannot replay: the key
 * names another org's row, or the same key arrived with different details.
 * The route maps this to 409 invalid_idempotency_key — fail closed, never
 * the older row as though it matched. The message names the remedy (send a
 * fresh key), and the remedy exists: the wizard mints one key per form
 * session and rotates it after every successful add.
 */
export class PayRunAdjustmentIdempotencyConflict extends Error {
  readonly status = 409 as const;
  readonly code = "idempotency-conflict" as const;
  constructor(reason: "changed-payload" | "foreign-key") {
    super(reason === "foreign-key"
      ? "This request key is already in use by another organization. Reopen the adjustment form to try again with a fresh request."
      : "This adjustment was already saved with different details. Reopen the adjustment form to try again with a fresh request.");
  }
}

/**
 * Deterministic adjustment row id for one member of an idempotent bulk
 * batch: UUIDv5 over (batch key, employee), so a replayed batch addresses
 * the same rows and the engine's per-row claim-or-replay applies unchanged.
 * The namespace is this derivation's own fixed identity, not a claim about
 * any external system.
 */
const BULK_ADJUSTMENT_NAMESPACE = Buffer.from("payroll.bulk.adj.", "utf8");
export function payRunBulkAdjustmentId(batchKey: string, employeePartyId: string): string {
  const hash = createHash("sha1")
    .update(BULK_ADJUSTMENT_NAMESPACE)
    .update(batchKey, "utf8")
    .update(":")
    .update(employeePartyId, "utf8")
    .digest();
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Adjustment money must be an exact 4dp amount the numeric(19,4) column can
 * hold: anything wider died at storage with a driver error.
 */
function persistAdjustmentMoney(value: unknown): string {
  const exact = canonicalDecimal(value, 4);
  if (exact === null) {
    throw new PayrollError("adjustment amount must be an exact decimal of at most 4 decimal places");
  }
  let amount: string;
  try {
    amount = normalizeMoney(exact);
  } catch {
    throw new PayrollError("adjustment amount must be an exact decimal of at most 4 decimal places");
  }
  if (amount.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 15) {
    throw new PayrollError("adjustment amount is out of range — at most 15 whole digits fit the ledger");
  }
  return amount;
}

/**
 * Adjustment hours persist into numeric(12,2): at most 2dp and ten whole
 * digits. Anything past 2dp was silently rounded by the column; anything
 * wider died at storage. Signed bank-deposit candidates are validated against
 * their native plan before a fresh write; ordinary worked hours stay non-negative.
 */
function persistAdjustmentHours(value: unknown, amount: string): string {
  const exact = canonicalDecimal(value, 2);
  if (exact === null || exact.startsWith("-") && !amount.startsWith("-")) {
    throw new PayrollError("adjustment hours must be a non-negative decimal of at most 2 decimal places");
  }
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) {
    throw new PayrollError("adjustment hours are out of range — at most 10 whole digits fit the ledger");
  }
  return exact;
}

/**
 * Canonicalize API-supplied adjustment hours for the numeric(12,2) column:
 * at most 2dp and ten whole digits. Negative hours require a negative amount
 * to become a deposit candidate; the writer must still validate the bank.
 * With no amount supplied, only non-negative hours are accepted. Returns null
 * for absent input (no hours) and for anything unpersistable. HTTP seams must use this — NOT
 * the 4dp money normalizer, which pads every value past the column scale so
 * the engine gate below rejects even whole hours.
 */
export function canonicalAdjustmentHours(value: unknown, bankDepositAmount?: unknown): string | null {
  if (value == null || value === "") return null;
  const exact = canonicalDecimal(value, 2);
  if (exact === null) return null;
  const amount = canonicalDecimal(bankDepositAmount, 4);
  if (exact.startsWith("-") && (amount === null || !amount.startsWith("-"))) return null;
  if (exact.replace(/^[+-]/, "").split(".")[0]!.replace(/^0+/, "").length > 10) return null;
  return exact;
}

export type PayRunAdjustmentMutation =
  | {
      action: "add";
      employeePartyId: string;
      componentId: string;
      amount: string;
      hours?: string | null;
      /** Inclusive source dates for the earning; absent retains legacy period-wide treatment. */
      earnedFrom?: string | null;
      earnedTo?: string | null;
      replaceComponent?: boolean;
      note?: string | null;
      /**
       * Client-minted idempotency key (UUID). The key BECOMES the adjustment
       * row id — the same contract as document creates — so a replayed
       * request addresses the same row: identical details replay the
       * original result, anything else (or another org's row) is refused.
       * Absent for legacy callers, which keep generated ids.
       */
      idempotencyKey?: string;
    }
  | { action: "delete"; adjustmentId: string }
  | { action: "exclude"; employeePartyId: string }
  | { action: "include"; employeePartyId: string };

type ScheduleMember = {
  display_name: string | null;
  party_active: boolean;
  profile_active: boolean | null;
  terminated_on: string | null;
  final_pay_eligible: boolean;
} | undefined;

/**
 * Refusal for a move TOWARD paying someone (include, line adjustment) when
 * they are not an active member of the run's schedule. Names the employee
 * and the exact failed predicate: no such employee, a deactivated employee,
 * no profile on this schedule, or an inactive profile — each with the remedy
 * that fixes it.
 */
function inactiveMemberRefusal(member: ScheduleMember, employeeId: string, periodStart: string): string {
  if (!member) {
    return `employee "${employeeId}" is not an active member of this pay run's schedule — no employee with that id; check the id and try again`;
  }
  const name = member.display_name ?? employeeId;
  if (member.profile_active === null) {
    return `employee "${name}" has no payroll profile on this run's pay schedule; link them to the schedule before adding them`;
  }
  if (member.profile_active !== true) {
    return `employee "${name}" has an inactive payroll profile on this run's pay schedule; reactivate it before adding them`;
  }
  if (!member.party_active && !(typeof member.terminated_on === 'string' && member.terminated_on >= periodStart)) {
    if (member.terminated_on) return `employee "${name}" is not eligible for this historical period — recorded employment ended ${member.terminated_on}; review their employment dates and the pay run period before importing`;
    return `employee "${name}" is not an active member of this pay run's schedule — they are deactivated; reactivate them before adding them to a pay run`;
  }
  return `employee "${name}" is not eligible for this pay run; review their linked employment and the run's scope`;
}

/**
 * Refusal for a removal (exclude) of someone who was never on the run's
 * schedule. Names who was passed — the display name when the id belongs to a
 * real employee on another schedule, the raw id when it belongs to nobody —
 * so the operator can tell a mistyped id from a wrong-schedule employee.
 */
function excludeStrangerRefusal(displayName: string | null | undefined, employeeId: string): string {
  if (displayName) {
    return `employee "${displayName}" is not on this run's pay schedule — nothing to remove; they were never linked to this schedule`;
  }
  return `employee "${employeeId}" is not on this run's pay schedule — no employee with that id; check the id and try again`;
}

/**
 * Mutate the inputs of one pay run under the same row lock used by calculate
 * and commit. Every successful change invalidates the calculated snapshot so
 * a caller cannot commit stubs that no longer represent the inputs.
 */
type PayRunAdjustmentInput = {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Supporting reason for a controlled correction or scope change. */
  reason?: string;
  source?: "payroll" | "data_import";
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
  mutation: PayRunAdjustmentMutation;
};

export async function mutatePayRunAdjustment(input: PayRunAdjustmentInput): Promise<{ changed: boolean; replayed: boolean }> {
  return executePayRunAdjustment(input, false);
}

/** Record paid holiday hours through the ordinary audited payroll input lifecycle. */
export async function recordPayRunHolidayHours(input: {
  orgId: string; documentId: string; actorId: string; employeePartyId: string;
  hours: string; earnedOn?: string; reason: string; note?: string; idempotencyKey?: string;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ changed: boolean; replayed: boolean }> {
  return db.transaction(async tx => {
    const components = await tx.execute<{ id: string }>(sql`
      select id from pay_components where org_id=${input.orgId}
        and system_key='stat_holiday' and kind='earning' and is_active
    `);
    if (components.rows.length !== 1) throw new PayrollError("Configure one active statutory holiday earning component before recording paid holiday hours.");
    const amount = await priceRunHolidayHours(tx, input);
    return mutatePayRunAdjustment({ orgId: input.orgId, documentId: input.documentId,
      actorId: input.actorId, reason: input.reason, allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      mutation: { action: "add", employeePartyId: input.employeePartyId, componentId: components.rows[0]!.id,
        amount, hours: input.hours, earnedFrom: input.earnedOn, earnedTo: input.earnedOn, replaceComponent: true, note: input.note, idempotencyKey: input.idempotencyKey } });
  });
}

/** Validate an imported line through the writer's guards without changing inputs or calculated stubs. */
export async function preflightPayRunAdjustment(
  input: PayRunAdjustmentInput & { mutation: Extract<PayRunAdjustmentMutation, { action: "add" }> },
): Promise<{ replayed: boolean }> {
  const result = await executePayRunAdjustment(input, true);
  return { replayed: result.replayed };
}

async function executePayRunAdjustment(input: PayRunAdjustmentInput, validateOnly: boolean): Promise<{ changed: boolean; replayed: boolean }> {
  const { orgId, documentId, actorId, mutation } = input;
  if (input.reason !== undefined && (!input.reason.trim() || input.reason.length > 500)) {
    throw new PayrollError("adjustment correction reason must contain 1 to 500 characters");
  }
  if (validateOnly && mutation.action !== "add") throw new PayrollError("adjustment preflight only supports adding a line");
  return db.transaction(async (tx) => {
    const runRows = (await tx.execute<{ run_status: string; run_type: string; pay_schedule_id: string; period_start: string; period_end: string; document_status: string; subsidiary_id: string | null }>(sql`
      select r.run_status, r.run_type, r.pay_schedule_id, r.period_start::text, r.period_end::text, d.status as document_status, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `));
    const run = runRows.rows[0];
    if (!run || !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status === "committed" || run.document_status !== "draft") {
      throw new PayrollError("pay run is not editable");
    }

    const target = mutation.action === "delete"
      ? (await tx.execute<{ employee_party_id: string }>(sql`
          select employee_party_id from pay_run_adjustments
           where org_id=${orgId} and pay_run_document_id=${documentId} and id=${mutation.adjustmentId}
           for update`)).rows[0]?.employee_party_id
      : mutation.employeePartyId;
    if (mutation.action === "delete" && !target) throw new PayrollError("pay run adjustment not found");
    // A changed adjustment invalidates the complete run snapshot.
    await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds, [{ id: target! }]);

    const employeeId = mutation.action === "delete" ? null : mutation.employeePartyId;
    if (employeeId) {
      const rosterColumns = {
        org: sql`prof.org_id`, employee: sql`p.id`, employment: sql`prof.employment_id`,
        employer: sql`p.subsidiary_id`, hiredOn: sql`er.hired_on`, terminatedOn: sql`er.terminated_on`,
        periodStart: sql`${run.period_start}`, periodEnd: sql`${run.period_end}`,
        runType: sql`${run.run_type}`, document: sql`${documentId}`,
      };
      // The first earning must be authorable before it can admit the employee.
      // Existing exclusions still govern whether calculation will pay them.
      const pendingEarning = mutation.action === "add" ? persistAdjustmentMoney(mutation.amount) : null;
      const supplementalAdmission = mutation.action === "add" && pendingEarning !== null
        ? sql`(${supplementalEmploymentIdentity(rosterColumns)} and ${pendingEarning}::numeric>0
            and exists(select 1 from pay_components pending_component
              where pending_component.org_id=${orgId} and pending_component.id=${mutation.componentId}
                and pending_component.is_active and pending_component.kind='earning'))`
        : namedSupplementalEmployment(rosterColumns);
      // The party row rides along so a refusal can name the employee and the
      // exact failed predicate — on a roster of up to 2000 an unnamed refusal
      // is unactionable.
      const membership = (await tx.execute<{
        display_name: string | null; party_active: boolean; profile_active: boolean | null; terminated_on: string | null; final_pay_eligible: boolean;
      }>(sql`
        select p.display_name, p.is_active as party_active, prof.is_active as profile_active, er.terminated_on::text,
               (${mutation.action === "include" ? finalPayEmploymentIdentity(rosterColumns) : namedFinalPayEmployment(rosterColumns)}
                or ${supplementalAdmission}) as final_pay_eligible
          from parties p
          left join employee_roles er on er.org_id=p.org_id and er.party_id=p.id
          left join employee_payroll_profiles prof
            on prof.org_id = p.org_id
           and prof.employee_party_id = p.id
           and prof.pay_schedule_id = ${run.pay_schedule_id}
         where p.org_id = ${orgId} and p.id = ${employeeId}
         limit 1
      `));
      const member = membership.rows[0];
      // A validity precondition belongs on the state being moved TOWARD, not
      // the state being moved AWAY FROM. Adding someone (include, or a line
      // adjustment for them) moves toward paying them, so a configured active
      // payroll profile is required. A former employee can still receive a
      // historical cheque for a covered period, or a scoped final settlement
      // after termination. Their inactive party status remains unchanged. Removing
      // someone (exclude) moves away: the inactive
      // member is exactly who must stay removable — refusing to remove them
      // bars the only exit from the invalid state the check detects
      // (deactivating an employee once bricked scope editing on every run
      // whose roster held them). Exclude still requires a profile on this
      // run's schedule, so a stranger or a mistyped id is refused, not
      // recorded. Do NOT "restore symmetry" by re-adding the active check
      // to exclude.
      if (mutation.action === "exclude") {
        if (!member || member.profile_active === null) {
          throw new PayrollError(excludeStrangerRefusal(member?.display_name, employeeId));
        }
      } else if (!member || member.profile_active !== true || !member.party_active
          && !(typeof member.terminated_on === 'string' && member.terminated_on >= run.period_start)
          && !member.final_pay_eligible) {
        throw new PayrollError(inactiveMemberRefusal(member, employeeId, run.period_start));
      }
    }

    let changed = false;
    const auditChanges: { id: string; before: Record<string, unknown> | null; after: Record<string, unknown> | null }[] = [];
    if (mutation.action === "add") {
      // amount is numeric(19,4) and hours numeric(12,2): the values reach the
      // columns verbatim, so an oversized paste died at storage with a driver
      // error and 4dp hours were silently rounded to the column scale. Fail
      // closed here with a named error before any write. Canonicalized up
      // front, because the idempotency probe below compares request against
      // stored row — and a malformed retry must 422 here, never 409 there.
      const amount = persistAdjustmentMoney(mutation.amount);
      const hours = mutation.hours == null || mutation.hours === ""
        ? null
        : persistAdjustmentHours(mutation.hours, amount);
      const earnedFrom = mutation.earnedFrom ?? null;
      const earnedTo = mutation.earnedTo ?? null;
      if ((earnedFrom === null) !== (earnedTo === null)
        || earnedFrom !== null && (!isIsoCalendarDate(earnedFrom) || !isIsoCalendarDate(earnedTo) || earnedFrom > earnedTo)) {
        throw new PayrollError("Supply both earned dates as valid YYYY-MM-DD dates, with the end on or after the start, or omit both.");
      }
      const replaceComponent = mutation.replaceComponent === true;
      const note = mutation.note ?? null;
      // Idempotent add: the key becomes the row id (the document-create
      // contract), so a replayed request addresses the same row. Serialized
      // on the key's advisory lock: a concurrent duplicate waits, then sees
      // the winner's committed row and replays instead of inserting twice.
      // Nothing is claimed on failure — validation below still runs first on
      // a fresh key, so fixing a refused request and retrying with the same
      // key works.
      const key = mutation.idempotencyKey ?? null;
      if (key != null) {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${key}))`);
        const prior = (await tx.execute<{
          org_id: string; pay_run_document_id: string; employee_party_id: string;
          component_id: string | null; amount: string | null; hours: string | null;
          replace_component: boolean; note: string | null; earned_from: string | null; earned_to: string | null;
        }>(sql`
          select org_id, pay_run_document_id::text, employee_party_id::text,
                 component_id::text, amount::text as amount, hours::text as hours,
                 replace_component, note, earned_from::text, earned_to::text
            from pay_run_adjustments where id = ${key}
        `)).rows[0];
        if (prior) {
          if (prior.org_id !== orgId) throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
          const same = prior.pay_run_document_id === documentId
            && prior.employee_party_id === mutation.employeePartyId
            && prior.component_id === mutation.componentId
            && normalizeMoney(prior.amount ?? "0") === amount
            && canonicalAdjustmentHours(prior.hours, prior.amount) === hours
            && prior.earned_from === earnedFrom && prior.earned_to === earnedTo
            && prior.replace_component === replaceComponent
            && (prior.note ?? null) === note;
          if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
          return { changed: false, replayed: true };
        }
      }
      const component = (await tx.execute(sql`
        select system_key, kind, payment_kind
          from pay_components
         where org_id = ${orgId} and id = ${mutation.componentId} and is_active
           and (system_key is null or system_key in ('base_pay','overtime','allowance','bonus','vacation_payout','stat_holiday','income_tax'))
         limit 1
      `));
      if (component.rows.length === 0) throw new PayrollError("component cannot be adjusted");
      if (earnedFrom !== null && component.rows[0]!.kind !== "earning") {
        throw new PayrollError("Earned dates apply only to earning adjustments.");
      }
      // An employee may ask for extra income tax on one cheque. It is withheld
      // through the statutory income-tax line, never as a separate deduction.
      if (component.rows[0]!.system_key === "income_tax"
        && (replaceComponent || hours !== null || earnedFrom !== null || cmp(amount, "0") <= 0 || !(input.reason ?? note)?.trim())) {
        throw new PayrollError("Additional income tax for this run must be a positive amount added to the calculated tax, without hours or dates, with a supporting reason.");
      }
      if (component.rows[0]!.system_key === "stat_holiday") {
        if (earnedFrom !== null && (earnedFrom !== earnedTo || earnedFrom < run.period_start || earnedFrom > run.period_end)) {
          throw new PayrollError("Record holiday hours on one date within this pay period.");
        }
        if (component.rows[0]!.kind !== "earning" || component.rows[0]!.payment_kind !== "cash"
          || !replaceComponent || !hours || !(input.reason ?? note)?.trim()) {
          throw new PayrollError("Recorded holiday pay requires a cash earning component, non-negative paid hours, component replacement and a supporting reason.");
        }
        const priced = await priceRunHolidayHours(tx, { orgId, documentId, employeePartyId: mutation.employeePartyId, hours, earnedOn: earnedFrom ?? undefined });
        if (cmp(amount, priced) !== 0) throw new PayrollError("Holiday pay must equal the native dated wage calculation; supply paid hours instead of a cash override.");
      }

      await assertBankDepositAdjustment(tx, { orgId, componentId: mutation.componentId, amount, hours,
        terminationRun: run.run_type === "termination" });
      if (hours?.startsWith("-") && !(input.reason ?? note)?.trim()) {
        throw new PayrollError("a bank deposit needs a supporting reason — enter the source or reason in the adjustment note");
      }
      if (validateOnly) return { changed: false, replayed: false };
      if (key != null) {
        const inserted = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
          insert into pay_run_adjustments
            (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
             component_id, amount, hours, earned_from, earned_to, replace_component, note, created_by, updated_by)
          values
            (${key}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
             ${mutation.componentId}, ${amount}, ${hours}, ${earnedFrom}, ${earnedTo},
             ${replaceComponent}, ${note}, ${actorId}, ${actorId})
          returning *
        `)).rows[0];
        if (!inserted) throw new PayrollError("pay run adjustment was not saved");
        auditChanges.push({ id: inserted.id, before: null, after: inserted });
      } else {
        const inserted = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
          insert into pay_run_adjustments
            (org_id, pay_run_document_id, employee_party_id, adjustment_type,
             component_id, amount, hours, earned_from, earned_to, replace_component, note, created_by, updated_by)
          values
            (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
             ${mutation.componentId}, ${amount}, ${hours}, ${earnedFrom}, ${earnedTo},
             ${replaceComponent}, ${mutation.note ?? null}, ${actorId}, ${actorId})
          returning *
        `)).rows[0];
        if (!inserted) throw new PayrollError("pay run adjustment was not saved");
        auditChanges.push({ id: inserted.id, before: null, after: inserted });
      }
      changed = true;
    } else if (mutation.action === "delete") {
      const deleted = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and id = ${mutation.adjustmentId}
         returning *
      `));
      if (deleted.rows.length === 0) throw new PayrollError("pay run adjustment not found");
      for (const row of deleted.rows) auditChanges.push({ id: row.id, before: row, after: null });
      changed = true;
    } else if (mutation.action === "exclude") {
      const inserted = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type, created_by, updated_by)
        values (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'exclude', ${actorId}, ${actorId})
        -- An existing exclusion already omits this employee; changed=false records a repeated request.
        on conflict (pay_run_document_id, employee_party_id)
          where adjustment_type = 'exclude'
        do nothing
        returning *
      `));
      changed = inserted.rows.length > 0;
      for (const row of inserted.rows) auditChanges.push({ id: row.id, before: null, after: row });
    } else {
      const deleted = (await tx.execute<Record<string, unknown> & { id: string }>(sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and employee_party_id = ${mutation.employeePartyId} and adjustment_type = 'exclude'
         returning *
      `));
      changed = deleted.rows.length > 0;
      for (const row of deleted.rows) auditChanges.push({ id: row.id, before: row, after: null });
    }

    if (changed) {
      // Record each actual row change before invalidating the derived result.
      // Replays and previews return earlier and leave no duplicate audit event.
      for (const row of auditChanges) {
        await tx.execute(sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values (${orgId},'pay_run_adjustments',${row.id},${row.after ? 'insert' : 'delete'},
            ${JSON.stringify({ before: row.before, after: row.after, source: input.source ?? 'payroll',
              reason: input.reason ?? row.after?.note ?? row.before?.note ?? null })}::jsonb,${actorId})`);
      }
      // Calculated stubs are a derived snapshot. Invalidate them through the
      // one shared helper — stubs, errors and acknowledgement together — in
      // the same transaction as the input change.
      await invalidateCalculatedRun(tx, { orgId, actorId, documentId });
    }
    return { changed, replayed: false };
  });
}
