import { sql } from "drizzle-orm";
import { db, withOrgTransaction } from "../platform/db.ts";
import { isIsoCalendarDate } from "../platform/iso-date.ts";
import { cmp, normalizeMoney } from "../money/money.ts";
import { PayrollError } from "./error.ts";
import { priceRunHolidayHours } from "./run-holiday-input.ts";
import { invalidateCalculatedRun } from "./run-lifecycle.ts";
import {
  finalPayEmploymentIdentity,
  namedFinalPayEmployment,
  namedSupplementalEmployment,
  supplementalEmploymentIdentity,
} from "./employment-roster.ts";
import { assertBankDepositAdjustment } from "./run-bank-input.ts";
import { isBankCashInputEvidenceCandidate } from "./run-bank-cash-evidence.ts";
import {
  isDeclaredVacationAccrualCandidate,
  parseDeclaredVacationAccrualEvidence,
} from "./run-vacation-accrual-input.ts";
import {
  lockAndCheckPayrollRunPopulation,
  payrollSubsidiaryInScope,
  type PayrollSubsidiaryScope,
} from "./scope.ts";
import { lockActorCommandAuthority } from "../organization/actor-command-authority.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { takeEmployeeConfigurationFence } from "./fences.ts";
import { isEmployerLevyAdjustmentEvidenceCandidate } from "./run-levy-adjustment-evidence.ts";
import { isUuid } from "../platform/uuid.ts";
import {
  PayRunAdjustmentIdempotencyConflict,
  persistAdjustmentMoney,
  persistAdjustmentHours,
  canonicalAdjustmentHours,
  parseIncomeTaxOverrideEvidence,
  type PayRunAdjustmentMutation,
} from "./run-adjustment-values.ts";
import {
  applyBankCashInput,
  applyDeclaredVacationAccrual,
  applyEmployerLevyAdjustment,
  applyIncomeTaxOverride,
} from "./run-adjustment-audited.ts";

export {
  PayRunAdjustmentIdempotencyConflict,
  payRunBulkAdjustmentId,
  canonicalAdjustmentHours,
  type PayRunAdjustmentMutation,
} from "./run-adjustment-values.ts";

type ScheduleMember =
  | {
      display_name: string | null;
      party_active: boolean;
      profile_active: boolean | null;
      terminated_on: string | null;
      final_pay_eligible: boolean;
    }
  | undefined;

/**
 * Refusal for a move TOWARD paying someone (include, line adjustment) when
 * they are not an active member of the run's schedule. Names the employee
 * and the exact failed predicate: no such employee, a deactivated employee,
 * no profile on this schedule, or an inactive profile — each with the remedy
 * that fixes it.
 */
function inactiveMemberRefusal(
  member: ScheduleMember,
  employeeId: string,
  periodStart: string,
): string {
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
  if (
    !member.party_active &&
    !(typeof member.terminated_on === "string" && member.terminated_on >= periodStart)
  ) {
    if (member.terminated_on)
      return `employee "${name}" is not eligible for this historical period — recorded employment ended ${member.terminated_on}; review their employment dates and the pay run period before importing`;
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
function excludeStrangerRefusal(
  displayName: string | null | undefined,
  employeeId: string,
): string {
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

export async function mutatePayRunAdjustment(
  input: PayRunAdjustmentInput,
): Promise<{ changed: boolean; replayed: boolean }> {
  return executePayRunAdjustment(input, false);
}

/** Record paid holiday hours through the ordinary audited payroll input lifecycle. */
export async function recordPayRunHolidayHours(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  employeePartyId: string;
  hours: string;
  earnedOn?: string;
  reason: string;
  note?: string;
  idempotencyKey?: string;
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ changed: boolean; replayed: boolean }> {
  return db.transaction(async (tx) => {
    const components = await tx.execute<{ id: string }>(
      sql`
      select id from pay_components where org_id=${input.orgId}
        and system_key='stat_holiday' and kind='earning' and is_active
    `,
      "objects",
    );
    if (components.length !== 1)
      throw new PayrollError(
        "Configure one active statutory holiday earning component before recording paid holiday hours.",
      );
    const amount = await priceRunHolidayHours(tx, input);
    return mutatePayRunAdjustment({
      orgId: input.orgId,
      documentId: input.documentId,
      actorId: input.actorId,
      reason: input.reason,
      allowedSubsidiaryIds: input.allowedSubsidiaryIds,
      mutation: {
        action: "add",
        employeePartyId: input.employeePartyId,
        componentId: components[0]!.id,
        amount,
        hours: input.hours,
        earnedFrom: input.earnedOn,
        earnedTo: input.earnedOn,
        replaceComponent: true,
        note: input.note,
        idempotencyKey: input.idempotencyKey,
      },
    });
  });
}

/** Validate an imported line through the writer's guards without changing inputs or calculated stubs. */
export async function preflightPayRunAdjustment(
  input: PayRunAdjustmentInput & { mutation: Extract<PayRunAdjustmentMutation, { action: "add" }> },
): Promise<{ replayed: boolean }> {
  const result = await executePayRunAdjustment(input, true);
  return { replayed: result.replayed };
}

async function executePayRunAdjustment(
  input: PayRunAdjustmentInput,
  validateOnly: boolean,
): Promise<{ changed: boolean; replayed: boolean }> {
  const { orgId, actorId } = input;
  const auditedMutation =
    input.mutation.action === "override_income_tax" ||
    input.mutation.action === "bank_cash_input" ||
    input.mutation.action === "declared_vacation_accrual" ||
    input.mutation.action === "employer_levy_adjustment"
      ? input.mutation
      : null;
  if (
    auditedMutation &&
    (!isUuid(input.documentId) ||
      !isUuid(auditedMutation.employeePartyId) ||
      (auditedMutation.action === "bank_cash_input" && !isUuid(auditedMutation.componentId)) ||
      (auditedMutation.action === "employer_levy_adjustment" &&
        auditedMutation.workerCompGroupId != null &&
        !isUuid(auditedMutation.workerCompGroupId)))
  ) {
    throw new PayrollError(
      "Audited payroll inputs require valid pay run, employee and component or group identities; select the recorded run and employee before saving.",
    );
  }
  const documentId = auditedMutation ? input.documentId.toLowerCase() : input.documentId;
  const mutation = auditedMutation
    ? {
        ...auditedMutation,
        employeePartyId: auditedMutation.employeePartyId.toLowerCase(),
        ...(auditedMutation.action === "bank_cash_input"
          ? { componentId: auditedMutation.componentId.toLowerCase() }
          : {}),
        ...(auditedMutation.action === "employer_levy_adjustment" &&
        auditedMutation.workerCompGroupId != null
          ? { workerCompGroupId: auditedMutation.workerCompGroupId.toLowerCase() }
          : {}),
      }
    : input.mutation;
  if (input.reason !== undefined && (!input.reason.trim() || input.reason.length > 500)) {
    throw new PayrollError("adjustment correction reason must contain 1 to 500 characters");
  }
  if (validateOnly && mutation.action !== "add")
    throw new PayrollError("adjustment preflight only supports adding a line");
  return withOrgTransaction(orgId, () =>
    db.transaction(async (tx) => {
      if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
        throw new PayrollError("Payroll feature is disabled");
      const runRows = await tx.execute<{
        run_status: string;
        run_type: string;
        pay_schedule_id: string;
        period_start: string;
        period_end: string;
        pay_date: string;
        tax_year: number;
        currency: string;
        document_status: string;
        subsidiary_id: string | null;
      }>(
        sql`
      select r.run_status, r.run_type, r.pay_schedule_id, r.period_start::text, r.period_end::text,
             r.pay_date::text, r.tax_year, d.currency, d.status as document_status, d.subsidiary_id
        from pay_runs r
        join documents d on d.id = r.document_id and d.org_id = r.org_id
       where r.org_id = ${orgId} and r.document_id = ${documentId}
       for update of r, d
    `,
        "objects",
      );
      const run = runRows[0];
      if (!run || !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
        throw new PayrollError("pay run not found");
      }
      if (run.run_status === "committed" || run.document_status !== "draft") {
        throw new PayrollError("pay run is not editable");
      }
      const deletedAdjustment =
        mutation.action === "delete"
          ? (
              await tx.execute<{
                employee_party_id: string;
                replace_component: boolean;
                system_key: string | null;
                note: string | null;
              }>(
                sql`
          select a.employee_party_id, a.replace_component, c.system_key, a.note
            from pay_run_adjustments a
            left join pay_components c on c.org_id=a.org_id and c.id=a.component_id
           where a.org_id=${orgId} and a.pay_run_document_id=${documentId} and a.id=${mutation.adjustmentId}
           for update of a`,
                "objects",
              )
            )[0]
          : undefined;
      const target =
        mutation.action === "delete"
          ? deletedAdjustment?.employee_party_id
          : mutation.employeePartyId;
      if (mutation.action === "delete" && !target)
        throw new PayrollError("pay run adjustment not found");
      const deletesIncomeTaxOverride =
        deletedAdjustment?.replace_component === true &&
        (deletedAdjustment.system_key === "income_tax" ||
          parseIncomeTaxOverrideEvidence(deletedAdjustment.note) !== null);
      const deletesBankCashInput = isBankCashInputEvidenceCandidate(
        deletedAdjustment?.note ?? null,
      );
      const deletesLevyAdjustment = isEmployerLevyAdjustmentEvidenceCandidate(
        deletedAdjustment?.note ?? null,
      );
      const deletesDeclaredVacationAccrual = isDeclaredVacationAccrualCandidate(
        deletedAdjustment?.note ?? null,
      );
      if (
        mutation.action === "override_income_tax" ||
        mutation.action === "bank_cash_input" ||
        mutation.action === "declared_vacation_accrual" ||
        mutation.action === "employer_levy_adjustment" ||
        deletesIncomeTaxOverride ||
        deletesBankCashInput ||
        deletesDeclaredVacationAccrual ||
        deletesLevyAdjustment
      ) {
        if (!run.subsidiary_id || (run.run_status !== "draft" && run.run_status !== "calculated")) {
          throw new PayrollError(
            "audited cheque inputs require an editable pay run with a legal entity",
          );
        }
        const liveScope = await lockActorCommandAuthority(
          tx,
          orgId,
          actorId,
          run.subsidiary_id,
          "payroll.manage",
        );
        if (!payrollSubsidiaryInScope(liveScope, run.subsidiary_id))
          throw new PayrollError("pay run not found");
        await takeEmployeeConfigurationFence(tx, orgId, target!);
        await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, liveScope, [{ id: target! }]);
      }
      // A changed adjustment invalidates the complete run snapshot.
      await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds, [
        { id: target! },
      ]);

      const employeeId = mutation.action === "delete" ? null : mutation.employeePartyId;
      if (employeeId) {
        const rosterColumns = {
          org: sql`prof.org_id`,
          employee: sql`p.id`,
          employment: sql`prof.employment_id`,
          employer: sql`p.subsidiary_id`,
          hiredOn: sql`er.hired_on`,
          terminatedOn: sql`er.terminated_on`,
          periodStart: sql`${run.period_start}`,
          periodEnd: sql`${run.period_end}`,
          runType: sql`${run.run_type}`,
          document: sql`${documentId}`,
        };
        // The first earning must be authorable before it can admit the employee.
        // Existing exclusions still govern whether calculation will pay them.
        const pendingEarning =
          mutation.action === "add" ? persistAdjustmentMoney(mutation.amount) : null;
        const supplementalAdmission =
          mutation.action === "add" && pendingEarning !== null
            ? sql`(${supplementalEmploymentIdentity(rosterColumns)} and ${pendingEarning}::numeric>0
            and exists(select 1 from pay_components pending_component
              where pending_component.org_id=${orgId} and pending_component.id=${mutation.componentId}
                and pending_component.is_active and pending_component.kind='earning'))`
            : namedSupplementalEmployment(rosterColumns);
        // The party row rides along so a refusal can name the employee and the
        // exact failed predicate — on a roster of up to 2000 an unnamed refusal
        // is unactionable.
        const membership = await tx.execute<{
          display_name: string | null;
          party_active: boolean;
          profile_active: boolean | null;
          terminated_on: string | null;
          final_pay_eligible: boolean;
        }>(
          sql`
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
      `,
          "objects",
        );
        const member = membership[0];
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
        } else if (
          !member ||
          member.profile_active !== true ||
          (!member.party_active &&
            !(
              typeof member.terminated_on === "string" && member.terminated_on >= run.period_start
            ) &&
            !member.final_pay_eligible)
        ) {
          throw new PayrollError(inactiveMemberRefusal(member, employeeId, run.period_start));
        }
      }

      let changed = false;
      const auditChanges: {
        id: string;
        before: Record<string, unknown> | null;
        after: Record<string, unknown> | null;
      }[] = [];
      if (mutation.action === "bank_cash_input") {
        const outcome = await applyBankCashInput({ tx, orgId, actorId, documentId, run }, mutation);
        if ("replayed" in outcome) return { changed: false, replayed: true };
        auditChanges.push(...outcome.changes);
        changed = true;
      } else if (mutation.action === "employer_levy_adjustment") {
        const outcome = await applyEmployerLevyAdjustment(
          { tx, orgId, actorId, documentId, run },
          mutation,
        );
        if ("replayed" in outcome) return { changed: false, replayed: true };
        auditChanges.push(...outcome.changes);
        changed = true;
      } else if (mutation.action === "declared_vacation_accrual") {
        const outcome = await applyDeclaredVacationAccrual(
          { tx, orgId, actorId, documentId, run },
          mutation,
        );
        if ("replayed" in outcome) return { changed: false, replayed: true };
        auditChanges.push(...outcome.changes);
        changed = true;
      } else if (mutation.action === "override_income_tax") {
        const outcome = await applyIncomeTaxOverride(
          { tx, orgId, actorId, documentId, run },
          mutation,
        );
        if ("replayed" in outcome) return { changed: false, replayed: true };
        auditChanges.push(...outcome.changes);
        changed = true;
      } else if (mutation.action === "add") {
        // amount is numeric(19,4) and hours numeric(12,2): the values reach the
        // columns verbatim, so an oversized paste died at storage with a driver
        // error and 4dp hours were silently rounded to the column scale. Fail
        // closed here with a named error before any write. Canonicalized up
        // front, because the idempotency probe below compares request against
        // stored row — and a malformed retry must 422 here, never 409 there.
        const amount = persistAdjustmentMoney(mutation.amount);
        const hours =
          mutation.hours == null || mutation.hours === ""
            ? null
            : persistAdjustmentHours(mutation.hours, amount);
        const earnedFrom = mutation.earnedFrom ?? null;
        const earnedTo = mutation.earnedTo ?? null;
        if (
          (earnedFrom === null) !== (earnedTo === null) ||
          (earnedFrom !== null &&
            (!isIsoCalendarDate(earnedFrom) ||
              !isIsoCalendarDate(earnedTo) ||
              earnedFrom > earnedTo))
        ) {
          throw new PayrollError(
            "Supply both earned dates as valid YYYY-MM-DD dates, with the end on or after the start, or omit both.",
          );
        }
        const replaceComponent = mutation.replaceComponent === true;
        const note = mutation.note ?? null;
        if (isBankCashInputEvidenceCandidate(note)) {
          throw new PayrollError(
            "audited bank cash evidence must be recorded through the bank cash input command with its reason, source reference and request key",
          );
        }
        if (
          isDeclaredVacationAccrualCandidate(note) ||
          parseDeclaredVacationAccrualEvidence(note) !== null
        ) {
          throw new PayrollError(
            "Record declared vacation accruals through the audited vacation-accrual command; ordinary line notes cannot create accrual authority.",
          );
        }
        if (isEmployerLevyAdjustmentEvidenceCandidate(note)) {
          throw new PayrollError(
            "audited employer levy evidence must be recorded through the employer levy adjustment command with its reason, source reference and request key",
          );
        }
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
          const prior = (
            await tx.execute<{
              org_id: string;
              pay_run_document_id: string;
              employee_party_id: string;
              component_id: string | null;
              amount: string | null;
              hours: string | null;
              replace_component: boolean;
              note: string | null;
              earned_from: string | null;
              earned_to: string | null;
            }>(
              sql`
          select org_id, pay_run_document_id::text, employee_party_id::text,
                 component_id::text, amount::text as amount, hours::text as hours,
                 replace_component, note, earned_from::text, earned_to::text
            from pay_run_adjustments where id = ${key}
        `,
              "objects",
            )
          )[0];
          if (prior) {
            if (prior.org_id !== orgId)
              throw new PayRunAdjustmentIdempotencyConflict("foreign-key");
            const same =
              prior.pay_run_document_id === documentId &&
              prior.employee_party_id === mutation.employeePartyId &&
              prior.component_id === mutation.componentId &&
              normalizeMoney(prior.amount ?? "0") === amount &&
              canonicalAdjustmentHours(prior.hours, prior.amount) === hours &&
              prior.earned_from === earnedFrom &&
              prior.earned_to === earnedTo &&
              prior.replace_component === replaceComponent &&
              (prior.note ?? null) === note;
            if (!same) throw new PayRunAdjustmentIdempotencyConflict("changed-payload");
            return { changed: false, replayed: true };
          }
        }
        const component = await tx.execute(
          sql`
        select system_key, kind, payment_kind
          from pay_components
         where org_id = ${orgId} and id = ${mutation.componentId} and is_active
           and (system_key is null or system_key in ('base_pay','overtime','allowance','bonus','vacation_payout','stat_holiday','income_tax'))
         limit 1
      `,
          "objects",
        );
        if (component.length === 0) throw new PayrollError("component cannot be adjusted");
        if (earnedFrom !== null && component[0]!.kind !== "earning") {
          throw new PayrollError("Earned dates apply only to earning adjustments.");
        }
        // An employee may ask for extra income tax on one cheque. It is withheld
        // through the statutory income-tax line, never as a separate deduction.
        if (
          component[0]!.system_key === "income_tax" &&
          (replaceComponent ||
            hours !== null ||
            earnedFrom !== null ||
            cmp(amount, "0") <= 0 ||
            !(input.reason ?? note)?.trim())
        ) {
          throw new PayrollError(
            "Additional income tax for this run must be a positive amount added to the calculated tax, without hours or dates, with a supporting reason.",
          );
        }
        if (component[0]!.system_key === "stat_holiday") {
          if (
            earnedFrom !== null &&
            (earnedFrom !== earnedTo ||
              earnedFrom < run.period_start ||
              earnedFrom > run.period_end)
          ) {
            throw new PayrollError("Record holiday hours on one date within this pay period.");
          }
          if (
            component[0]!.kind !== "earning" ||
            component[0]!.payment_kind !== "cash" ||
            !replaceComponent ||
            !hours ||
            !(input.reason ?? note)?.trim()
          ) {
            throw new PayrollError(
              "Recorded holiday pay requires a cash earning component, non-negative paid hours, component replacement and a supporting reason.",
            );
          }
          const priced = await priceRunHolidayHours(tx, {
            orgId,
            documentId,
            employeePartyId: mutation.employeePartyId,
            hours,
            earnedOn: earnedFrom ?? undefined,
          });
          if (cmp(amount, priced) !== 0)
            throw new PayrollError(
              "Holiday pay must equal the native dated wage calculation; supply paid hours instead of a cash override.",
            );
        }

        await assertBankDepositAdjustment(tx, {
          orgId,
          componentId: mutation.componentId,
          amount,
          hours,
          terminationRun: run.run_type === "termination",
        });
        if (hours?.startsWith("-") && !(input.reason ?? note)?.trim()) {
          throw new PayrollError(
            "a bank deposit needs a supporting reason — enter the source or reason in the adjustment note",
          );
        }
        if (validateOnly) return { changed: false, replayed: false };
        if (key != null) {
          const inserted = (
            await tx.execute<Record<string, unknown> & { id: string }>(
              sql`
          insert into pay_run_adjustments
            (id, org_id, pay_run_document_id, employee_party_id, adjustment_type,
             component_id, amount, hours, earned_from, earned_to, replace_component, note, created_by, updated_by)
          values
            (${key}, ${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
             ${mutation.componentId}, ${amount}, ${hours}, ${earnedFrom}, ${earnedTo},
             ${replaceComponent}, ${note}, ${actorId}, ${actorId})
          returning *
        `,
              "objects",
            )
          )[0];
          if (!inserted) throw new PayrollError("pay run adjustment was not saved");
          auditChanges.push({ id: inserted.id, before: null, after: inserted });
        } else {
          const inserted = (
            await tx.execute<Record<string, unknown> & { id: string }>(
              sql`
          insert into pay_run_adjustments
            (org_id, pay_run_document_id, employee_party_id, adjustment_type,
             component_id, amount, hours, earned_from, earned_to, replace_component, note, created_by, updated_by)
          values
            (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'line',
             ${mutation.componentId}, ${amount}, ${hours}, ${earnedFrom}, ${earnedTo},
             ${replaceComponent}, ${mutation.note ?? null}, ${actorId}, ${actorId})
          returning *
        `,
              "objects",
            )
          )[0];
          if (!inserted) throw new PayrollError("pay run adjustment was not saved");
          auditChanges.push({ id: inserted.id, before: null, after: inserted });
        }
        changed = true;
      } else if (mutation.action === "delete") {
        const deleted = await tx.execute<Record<string, unknown> & { id: string }>(
          sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and id = ${mutation.adjustmentId}
         returning *
      `,
          "objects",
        );
        if (deleted.length === 0) throw new PayrollError("pay run adjustment not found");
        for (const row of deleted) auditChanges.push({ id: row.id, before: row, after: null });
        changed = true;
      } else if (mutation.action === "exclude") {
        const inserted = await tx.execute<Record<string, unknown> & { id: string }>(
          sql`
        insert into pay_run_adjustments
          (org_id, pay_run_document_id, employee_party_id, adjustment_type, created_by, updated_by)
        values (${orgId}, ${documentId}, ${mutation.employeePartyId}, 'exclude', ${actorId}, ${actorId})
        -- An existing exclusion already omits this employee; changed=false records a repeated request.
        on conflict (pay_run_document_id, employee_party_id)
          where adjustment_type = 'exclude'
        do nothing
        returning *
      `,
          "objects",
        );
        changed = inserted.length > 0;
        for (const row of inserted) auditChanges.push({ id: row.id, before: null, after: row });
      } else {
        const deleted = await tx.execute<Record<string, unknown> & { id: string }>(
          sql`
        delete from pay_run_adjustments
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
           and employee_party_id = ${mutation.employeePartyId} and adjustment_type = 'exclude'
         returning *
      `,
          "objects",
        );
        changed = deleted.length > 0;
        for (const row of deleted) auditChanges.push({ id: row.id, before: row, after: null });
      }

      if (changed) {
        // Record each actual row change before invalidating the derived result.
        // Replays and previews return earlier and leave no duplicate audit event.
        for (const row of auditChanges) {
          const recordedAudit = await tx.execute<{ id: string }>(
            sql`insert into audit_log(org_id,table_name,row_id,action,changes,actor_id)
          values (${orgId},'pay_run_adjustments',${row.id},${row.after ? (row.before ? "update" : "insert") : "delete"},
            ${JSON.stringify({
              before: row.before,
              after: row.after,
              source: input.source ?? "payroll",
              reason:
                mutation.action === "override_income_tax" ||
                mutation.action === "declared_vacation_accrual" ||
                mutation.action === "employer_levy_adjustment"
                  ? mutation.reason.trim()
                  : (input.reason ?? row.after?.note ?? row.before?.note ?? null),
            })}::jsonb,${actorId}) returning id`,
            "objects",
          );
          if (recordedAudit.length !== 1)
            throw new PayrollError(
              "The adjustment audit event was not retained; no payroll input was saved.",
            );
        }
        // Calculated stubs are a derived snapshot. Invalidate them through the
        // one shared helper — stubs, errors and acknowledgement together — in
        // the same transaction as the input change.
        await invalidateCalculatedRun(tx, { orgId, actorId, documentId });
      }
      return { changed, replayed: false };
    }),
  );
}
