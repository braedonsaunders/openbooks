import { withOpeningReportingSnapshot } from "./opening-reporting-snapshot.ts";
import { takeOpeningSourceYearFence } from "../organization/payroll-source-fence.ts";
import { lockPayrollEmploymentRoster } from "./employment-roster.ts";
import { requireCompensationPackageConfiguration } from "./compensation-package-payroll.ts";
import { lockEmployerAssignmentProfiles } from "./employer-assignment-history.ts";
import { lockPayrollServiceConfiguration } from "./service-credit.ts";
import { assertRecurringBenefitsRunFresh } from "./benefit-plan-inputs.ts";
/**
 * Refusal acknowledgement, commit (GL projection write), and pre-commit preview.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import {
  lockAndCheckPayrollRunPopulation,
  payrollSubsidiaryInScope,
  payrollSubsidiaryScopeFilter,
  type PayrollSubsidiaryScope,
} from "./scope.ts";
import {
  employeeTaxYearFenceKey,
  employerLevyFenceKey,
  takeEmployeeTaxYearFences,
  takeEmployerLevyFences,
} from "./fences.ts";
import { sql } from "drizzle-orm";
import { db, withOrgTransaction, withTransactionSavepoint } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import {
  canonicalJson,
  payRunCalculationSourceDigest,
  parsePayRunCalculationSource,
  payRunCalculationSource,
  payRunCalculationSourceChanges,
  type PayRunCalculationError,
  type PayRunRefusalAcknowledgement,
  payRunCalculationRefusals,
  payRunRefusalDigest,
  parsePayRunCalculationErrors,
  parsePayRunRefusalAcknowledgement,
} from "./run-calculation-evidence.ts";
import { lockStatutoryRatesForPayRun } from "./statutory-rates.ts";
import { PERIODIC_RUN_TYPES } from "./run-contracts.ts";
import { assertPeriodSequence, periodRunIdentity } from "./period-priors.ts";
import { lockPayrollAnomalyReview, payrollAnomalyFinalizeCheck } from "./anomaly-finalize-gate.ts";
import { leavePayrollInputProblems } from "./leave-payroll-inputs.ts";
import { allowancePayrollInputProblem } from "./allowance-payroll-inputs.ts";
import { type PayRunGlLeg, payRunGlLegCustom, payRunGlLegs } from "./run-gl-legs.ts";
export { payRunGlLegCustom, payRunGlCodingKey, payRunGlLegs } from "./run-gl-legs.ts";
export type {
  PayRunGlLegKind,
  EntitlementReliefBasis,
  EntitlementReliefLine,
  PayRunGlLeg,
  FrozenPayRunGlBasis,
  PayRunGlRelief,
} from "./run-gl-legs.ts";
/**
 * The commit refusal: names every refused in-scope employee WITH the pack's
 * own words for why, so the operator sees at POST exactly what the exception
 * list showed at calculate — and how a posted partial run is completed.
 */
function refusedCommitMessage(refusals: PayRunCalculationError[]): string {
  const shown = refusals.slice(0, 10).map((entry) => `${entry.employee}: ${entry.message}`);
  const more = refusals.length > shown.length ? `, and ${refusals.length - shown.length} more` : "";
  const count = `${refusals.length} in-scope ${refusals.length === 1 ? "employee was" : "employees were"}`;
  return (
    `pay run cannot be committed — ${count} refused at calculation ` +
    `(${shown.join("; ")}${more}) — acknowledge the refused employees on the run ` +
    `or fix the input and recalculate. A posted partial run can only be completed ` +
    `with an off-cycle run once the missing input is supplied.`
  );
}

/**
 * Record an explicit, auditable decision to commit a run that leaves in-scope
 * employees unpaid. The acknowledgement is taken against the run's CURRENT
 * stored refusal set — never a caller-supplied list — so it necessarily names
 * exactly who is being left out and carries the pack's own refusal text for
 * each of them. There are legitimate partial runs (a mid-period hire, unpaid
 * leave); silence is not one of them, so this is the only path past the
 * commit gate besides fixing the input and recalculating.
 *
 * Like commit, this enforces on its own transaction: the run must be
 * calculated and its document editable, and acknowledging a clean run (or one
 * that was never calculated) is refused rather than recorded vacuously.
 */
export async function acknowledgePayRunRefusals(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<PayRunRefusalAcknowledgement> {
  const { orgId, documentId, actorId } = input;
  return await withOrgTransaction(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db;
      const sourceIdentity = await tx.execute<{ taxYear: number }>(
        sql`
      select r.tax_year as "taxYear" from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
       where r.org_id=${orgId} and r.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
    `,
        "objects",
      );
      if (sourceIdentity.length !== 1) throw new PayrollError("pay run not found");
      await takeOpeningSourceYearFence(tx, orgId, sourceIdentity[0]!.taxYear);
      if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
        throw new PayrollError("Payroll feature is disabled");
      const runRows = await tx.execute<Record<string, unknown>>(
        sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `,
        "objects",
      );
      const run = runRows[0];
      if (!run) throw new PayrollError("pay run not found");
      if (Number(run.tax_year) !== sourceIdentity[0]!.taxYear)
        throw new PayrollError(
          "The payroll source year changed — reload and calculate the run before committing",
        );
      if (
        !payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id as string | null)
      ) {
        throw new PayrollError("pay run not found");
      }
      if (run.run_status === "committed") throw new PayrollError("pay run is already committed");
      if (run.run_status !== "calculated") {
        throw new PayrollError("calculate the pay run before acknowledging its refusals");
      }
      if (run.doc_status !== "draft" && run.doc_status !== "approved") {
        throw new PayrollError("pay run document is not editable");
      }
      const storedErrors = parsePayRunCalculationErrors(run.calculation_errors);
      if (!storedErrors) {
        throw new PayrollError(
          "recalculate the pay run before acknowledging its refusals — its calculation predates refusal tracking",
        );
      }
      const refusals = payRunCalculationRefusals(storedErrors);
      if (refusals.length === 0) {
        throw new PayrollError("no refused employees to acknowledge on this pay run");
      }
      const acknowledgement: PayRunRefusalAcknowledgement = {
        version: 1,
        acknowledgedBy: actorId,
        acknowledgedAt: new Date().toISOString(),
        errorsDigest: payRunRefusalDigest(refusals),
        refusals,
      };
      await tx.execute(sql`
      update pay_runs set refusal_acknowledgement = ${JSON.stringify(acknowledgement)}::jsonb,
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
      const afterRun = (
        await tx.execute<Record<string, unknown>>(
          sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `,
          "objects",
        )
      )[0];
      if (!afterRun) throw new PayrollError("pay run not found");
      // Committing authorizes pay; acknowledging authorizes leaving people out.
      // Same evidence shape as the commit transition, so an auditor finds both
      // decisions in the same place, months later.
      await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_runs', ${documentId}, 'update',
              ${JSON.stringify({ operation: "acknowledge-refusals", before: run, after: afterRun })}::jsonb, ${actorId})
    `);
      return acknowledgement;
    }),
  );
}

/**
 * Commit: materialize the balanced GL projection into document_lines and claim
 * the period's time entries. The document then posts through the standard
 * submit/post action (RULES.pay_run maps lines 1:1, signed, like a journal).
 *
 * Freshness is enforced HERE, on this transaction's own read — not only by
 * the route's pre-flight and the wizard's disabled button. A run whose inputs
 * changed after Calculate is refused before anything is written, which is
 * what keeps newly approved time from being claimed by a stub that never
 * priced it.
 */
export async function commitPayRun(input: {
  orgId: string;
  documentId: string;
  actorId: string;
  /** Caller role scope; null/undefined is unrestricted. */
  allowedSubsidiaryIds?: PayrollSubsidiaryScope;
}): Promise<{ lines: number }> {
  const { orgId, documentId, actorId } = input;
  // A caller may catch the late freshness refusal inside its own transaction.
  // Restore our projection, liability stamps, and time claims before returning it.
  return await withOrgTransaction(orgId, () =>
    withTransactionSavepoint(db, async () => {
      const tx = db;
      const sourceIdentity = await tx.execute<{ taxYear: number }>(
        sql`
      select r.tax_year as "taxYear" from pay_runs r join documents d on d.org_id=r.org_id and d.id=r.document_id
       where r.org_id=${orgId} and r.document_id=${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, input.allowedSubsidiaryIds)}
    `,
        "objects",
      );
      if (sourceIdentity.length !== 1) throw new PayrollError("pay run not found");
      await takeOpeningSourceYearFence(tx, orgId, sourceIdentity[0]!.taxYear);
      if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll")))
        throw new PayrollError("Payroll feature is disabled");
      const runRows = await tx.execute<Record<string, string>>(
        sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id, d.document_number from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `,
        "objects",
      );
      const run = runRows[0];
      if (!run) throw new PayrollError("pay run not found");
      if (Number(run.tax_year) !== sourceIdentity[0]!.taxYear)
        throw new PayrollError(
          "The payroll source year changed — reload and calculate the run before committing",
        );
      if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
        throw new PayrollError("pay run not found");
      }
      if (run.run_status !== "calculated")
        throw new PayrollError("calculate the pay run before committing");
      // Approval moves the document from draft to approved, so both are
      // committable; anything else (posted, voided) is not.
      if (run.doc_status !== "draft" && run.doc_status !== "approved") {
        throw new PayrollError("pay run document is not editable");
      }
      await lockPayrollEmploymentRoster(tx, orgId, documentId);
      await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, input.allowedSubsidiaryIds);

      // Fence the commit on the EMPLOYEE-AND-TAX-YEAR identity every racing run
      // must hold (see `employeeTaxYearFenceKey`) — not on this run's own row,
      // which a concurrent same-year run never contends on. Taken BEFORE the
      // freshness gate below, so the gate's answer describes the world as of
      // THIS RUN'S TURN IN THE FENCE ORDER: if another run for one of these
      // employees committed while this transaction waited, the gate sees its
      // committed stubs ("ytd" staleness) and refuses, which is exactly what
      // makes exactly ONE of two racing runs able to commit. Sorted key order —
      // the order `calculatePayRun` already acquires in — so overlapping
      // rosters queue instead of deadlocking mid-set.
      const fencedEmployees = await tx.execute<{ employee_party_id: string }>(
        sql`
      select distinct s.employee_party_id
        from pay_stubs s
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    `,
        "objects",
      );
      await takeEmployeeTaxYearFences(
        tx,
        fencedEmployees.map((e) =>
          employeeTaxYearFenceKey(orgId, e.employee_party_id, run.tax_year),
        ),
      );
      await lockEmployerAssignmentProfiles(
        tx,
        orgId,
        fencedEmployees.map((e) => e.employee_party_id),
      );
      await lockPayrollAnomalyReview(tx, orgId);
      const anomalyGate = await payrollAnomalyFinalizeCheck(tx, { orgId, documentId });
      if (anomalyGate.openBlockCount > 0) {
        throw new PayrollError(
          `pay run cannot be committed — ${anomalyGate.openBlockCount} blocking payroll check(s) are open ` +
            `for this run — review Payroll → Anomalies and resolve or acknowledge each flag before committing`,
        );
      }
      // Employer-aggregate room is shared across rosters, so the employee
      // fence above cannot serialize it: two runs on disjoint rosters hold no
      // common employee key. Every commit takes each declared per-run levy's
      // employer key too — AFTER the employee keys, always in that order —
      // so the freshness gate below sees competing commits in fence order and
      // refuses the run whose room is gone. Declarations are read off every
      // pack (the key carries its country, so packs never contend); packs
      // that declare none add no keys and behave exactly as before. A pack
      // that refuses the year contributes no keys here, as in readiness —
      // otherwise one pack's untranscribed year would abort every other
      // pack's commit.
      const levyFenceKeys: string[] = [];
      for (const [packCountry, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
        let levies: readonly { key: string; timing: string }[];
        try {
          levies = pack.employerAggregateLevies?.(Number(run.tax_year)) ?? [];
        } catch {
          continue;
        }
        for (const levy of levies) {
          if (levy.timing === "per_run") {
            levyFenceKeys.push(employerLevyFenceKey(orgId, run.tax_year, packCountry, levy.key));
          }
        }
      }
      await takeEmployerLevyFences(tx, levyFenceKeys);
      // Historical component policy changes and deletes take the component
      // row's write lock. Hold the same rows through freshness and commit:
      // a later editor waits, then the database history guard sees the committed
      // run; an earlier editor finishes before this transaction checks freshness.
      await tx.execute(sql`
      select c.id from pay_components c
       where c.org_id = ${orgId} and exists (
         select 1 from pay_stub_lines l
         join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
          where l.org_id = c.org_id and l.component_id = c.id
            and s.pay_run_document_id = ${documentId}
       )
       order by c.id for share of c
    `);
      // The freshness gate, asked ON THIS TRANSACTION so an engine caller that
      // skips the route's pre-flight gets the same refusal, against the same
      // snapshot the claim below will run under. Dynamic import keeps the
      // payroll-run ↔ payroll-readiness cycle out of the engine's load order
      // (same idiom as the approval gate just below).
      await requireCompensationPackageConfiguration(tx, orgId);
      await lockPayrollServiceConfiguration(tx, orgId);
      const { assertPayRunNotStale, staleCalculationMessage } = await import("./readiness.ts");
      await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
      // A retro run's own control set (payroll-retro-store.ts): a voided or
      // re-settled source period, a cross-year settlement, a retired component,
      // or another open retro run already holding the same cell. The pre-flight
      // shows these; the commit ENFORCES them on this transaction so a caller
      // that skips the wizard cannot pay the same difference twice.
      if (run.run_type === "retro") {
        const { retroRunFindings } = await import("./retro-store.ts");
        const blockers = (
          await retroRunFindings(orgId, documentId, tx, input.allowedSubsidiaryIds)
        ).filter((finding) => finding.severity === "blocker");
        if (blockers.length > 0) {
          throw new PayrollError(
            `retro run cannot be committed (${[...new Set(blockers.map((b) => b.code))].join(", ")})` +
              " — review the retro run's source periods before paying it",
          );
        }
      }
      // A calculated share is only committable while the period still sequences
      // around it: a run created or committed after the calculation can leave
      // its priors stale. Asked here as well as at calculate, on this
      // transaction, so the commit cannot land on a period that moved.
      if (PERIODIC_RUN_TYPES.has(run.run_type ?? "regular")) {
        await assertPeriodSequence(
          tx,
          orgId,
          periodRunIdentity(run, {
            documentId,
            documentNumber: run.document_number ?? documentId,
            runType: run.run_type ?? "regular",
          }),
          "commit",
        );
      }
      // Money must not move before the run is approved. Asked ON THIS
      // TRANSACTION, under the run row lock taken above: the old call ran on
      // the default executor OUTSIDE the commit, so an approval withdrawn
      // between the pre-check and the terminal write committed without a live
      // approval. Dynamic import keeps the module cycle out of the engine's
      // load order (same idiom as flows/documents-adapter.ts →
      // document-void.ts).
      const { assertPayRunApprovalReleased } = await import("./approval.ts");
      await assertPayRunApprovalReleased(orgId, documentId, tx);
      if (run.doc_status === "draft") {
        const { submitAndReleaseIfUngated } = await import("../flows/submit.ts");
        const submission = await submitAndReleaseIfUngated("pay_run", documentId, actorId);
        if (submission.gated || submission.flowError)
          throw new PayrollError(
            submission.flowError ??
              "Complete this pay run's configured Flow gates before committing.",
          );
        run.doc_status = "approved";
      }

      // Recompute and lock the canonical source population before producing a
      // single GL line. Legacy calculated rows have no evidence and therefore
      // require recalculation; a corrupt snapshot/digest pair fails the same
      // closed way. Category-specific reasons preserve the wizard/API contract.
      const storedSource = parsePayRunCalculationSource(run.calculation_source_snapshot);
      const storedDigest = run.calculation_source_digest ?? null;
      if (
        !storedSource ||
        !storedDigest ||
        payRunCalculationSourceDigest(storedSource) !== storedDigest
      ) {
        throw new PayrollError(staleCalculationMessage(["selection"], run.doc_status));
      }
      const currentSource = await payRunCalculationSource(
        orgId,
        documentId,
        tx,
        true,
        input.allowedSubsidiaryIds,
      );
      if (!currentSource) throw new PayrollError("pay run not found");
      if (PERIODIC_RUN_TYPES.has(run.run_type ?? "regular")) {
        const periodStart = typeof run.period_start === "string" ? run.period_start : null;
        const periodEnd = typeof run.period_end === "string" ? run.period_end : null;
        if (!periodStart || !periodEnd) {
          throw new PayrollError(
            "pay run period is incomplete — set its payroll period and recalculate before committing",
          );
        }
        const parties = (
          await tx.execute<{ employee_party_id: string }>(
            sql`
        select distinct employee_party_id::text as employee_party_id
          from pay_stubs
         where org_id = ${orgId} and pay_run_document_id = ${documentId}
      `,
            "objects",
          )
        ).map((row) => row.employee_party_id);
        const leaveProblem = await leavePayrollInputProblems(tx, {
          orgId,
          runDocumentId: documentId,
          periodStart,
          periodEnd,
          employeePartyIds: parties,
        });
        if (leaveProblem) throw new PayrollError(leaveProblem.message);
        const allowanceProblem = await allowancePayrollInputProblem(tx, {
          orgId,
          runDocumentId: documentId,
          periodStart,
          periodEnd,
          employeePartyIds: parties,
        });
        if (allowanceProblem) throw new PayrollError(allowanceProblem.message);
      }
      const changes = payRunCalculationSourceChanges(storedSource, currentSource);
      if (changes.holidayObligations)
        throw new PayrollError(
          "Approved holiday entitlements, their dated wages or payment claims changed since calculation; recalculate this editable pay run before committing.",
        );
      if (changes.compensationPackages)
        throw new PayrollError(
          "Approved compensation terms or their native component policy changed since calculation — recalculate this editable pay run before committing.",
        );
      const sourceReasons = [
        changes.time ? "time" : null,
        changes.timeTypes ? "timeTypes" : null,
        changes.wages ? "wages" : null,
        changes.items ? "items" : null,
        changes.incomeTaxOverrides ? "adjustments" : null,
        changes.bankCashInputs ? "adjustments" : null,
        changes.employerLevyAdjustments ? "adjustments" : null,
        changes.declaredVacationAccruals ? "adjustments" : null,
        changes.roster ? "roster" : null,
        changes.openingBalances ? "openingBalances" : null,
      ].filter((reason): reason is string => reason !== null);
      if (payRunCalculationSourceDigest(currentSource) !== storedDigest) {
        throw new PayrollError(
          staleCalculationMessage(
            sourceReasons.length > 0 ? sourceReasons : ["selection"],
            run.doc_status,
          ),
        );
      }

      await assertRecurringBenefitsRunFresh(tx, orgId, documentId, run.benefit_source_snapshot);

      // The refusal gate. A refusal does not shrink the payroll silently: while
      // an in-scope employee has no stub, commit is refused unless the operator
      // has explicitly acknowledged EXACTLY this refusal set. The
      // acknowledgement binds to the refusal digest, so acknowledging one set
      // and recalculating into another leaves a stale acknowledgement this gate
      // refuses. Runs calculated before refusal tracking (null, not empty)
      // recalculate first — absence of evidence is not evidence of absence.
      //
      // Placed after the source-digest check and before the first GL write, so
      // a refused commit writes nothing at all.
      const storedErrors = parsePayRunCalculationErrors(
        (run as Record<string, unknown>).calculation_errors,
      );
      if (!storedErrors) {
        throw new PayrollError(
          "recalculate the pay run before committing — its calculation predates refusal tracking",
        );
      }
      const refusals = payRunCalculationRefusals(storedErrors);
      if (refusals.length > 0) {
        const acknowledgement = parsePayRunRefusalAcknowledgement(
          (run as Record<string, unknown>).refusal_acknowledgement,
        );
        if (!acknowledgement || acknowledgement.errorsDigest !== payRunRefusalDigest(refusals)) {
          throw new PayrollError(refusedCommitMessage(refusals));
        }
      }

      const { legs, debitTotal, lineLiabilities, lineDestinations } = await payRunGlLegs(
        tx,
        orgId,
        documentId,
        input.allowedSubsidiaryIds,
      );
      // Freeze the credited liability account on every deduction/contribution
      // line (migration 0094): remittance reads the snapshot, so editing the
      // component's account afterwards can never restate a committed period.
      // The remittance destination freezes in the same write (migration 0296):
      // the vendor the line accrued to, so a vendor edited afterwards can
      // never re-point committed payroll at a new payee. The RETURNING count
      // is the write's own receipt — a stamp that matches zero rows is a
      // failure, not a success.
      if (lineLiabilities.length > 0) {
        const stamped = await tx.execute<{ id: string }>(
          sql`
        update pay_stub_lines l
           set liability_account_id = stamp.account_id, liability_account_source = 'commit',
               remittance_party_id = nullif(stamp.party_text, '')::uuid,
               updated_by = ${actorId}, updated_at = now()
          from unnest(${`{${lineLiabilities.map((x) => x.lineId).join(",")}}`}::uuid[],
                      ${`{${lineLiabilities.map((x) => x.accountId).join(",")}}`}::uuid[],
                      ${`{${lineDestinations.map((x) => `"${x.partyId ?? ""}"`).join(",")}}`}::text[])
               as stamp(line_id, account_id, party_text)
         where l.org_id = ${orgId} and l.id = stamp.line_id
        returning l.id::text as id
      `,
          "objects",
        );
        if (stamped.length !== lineLiabilities.length) {
          throw new PayrollError(
            "pay run commit could not stamp its liability history — recalculate and commit again",
          );
        }
      }

      // An approved pay run commits after its release (migration 0145): the
      // document-line freeze permits this transaction's own line replacement
      // while openbooks.payroll_commit names the committing document. Set only
      // here, only for approved runs, transaction-local so it dies with the
      // commit — draft commits keep the ordinary path bit for bit.
      if (run.doc_status === "approved") {
        await tx.execute(
          sql`select set_config('openbooks.payroll_commit', ${String(documentId)}, true)`,
        );
      }
      await tx.execute(
        sql`delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`,
      );
      let lineNumber = 1;
      for (const leg of legs) {
        await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, custom, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${JSON.stringify(payRunGlLegCustom(leg))}::jsonb,
                ${actorId}, ${actorId})
      `);
      }

      // Claim the calculation's exact IDs — never a rediscovered employee/group
      // population. The compare above proves these locked rows are unchanged;
      // the update's own predicates and returned-ID equality are defense in
      // depth against corruption or a future caller weakening that lock.
      const claimed = await tx.execute<{ id: string }>(
        sql`
      with selected as (
        select value::uuid as id
          from jsonb_array_elements_text(
            ${JSON.stringify(storedSource.claimEntryIds)}::jsonb
          ) entry(value)
      )
      update time_entries te
         set payroll_batch_ref = ${documentId}
        from selected
       where te.id = selected.id and te.org_id = ${orgId}
         and te.status = 'approved'
         and te.worked_on between ${run.period_start} and ${run.period_end}
         and te.payroll_batch_ref is null
      returning te.id::text as id
    `,
        "objects",
      );
      const expectedClaimIds = [...storedSource.claimEntryIds].sort();
      const actualClaimIds = claimed.map((row) => row.id).sort();
      if (canonicalJson(actualClaimIds) !== canonicalJson(expectedClaimIds)) {
        throw new PayrollError(staleCalculationMessage(["time"], run.doc_status));
      }
      // Rate writes use the same per-slot and per-point transaction advisory
      // locks. Take every slot used by this schedule (including slots with no
      // current row, so a new more-specific point cannot appear in the gap),
      // then lock its current points before the final READ COMMITTED freshness
      // snapshot. The fences stay held through the terminal commit below.
      const rateCountries = (
        await tx.execute<{ country: string }>(
          sql`
      select distinct country from employee_payroll_profiles
       where org_id = ${orgId} and pay_schedule_id = ${run.pay_schedule_id}
         and is_active and country is not null
       order by country
    `,
          "objects",
        )
      ).map((row) => row.country);
      const ratePacks = rateCountries.flatMap((country) => {
        const pack = PAYROLL_COUNTRY_PACKS[country];
        return pack ? [pack.statutoryRates] : [];
      });
      await lockStatutoryRatesForPayRun(tx, orgId, Number(run.tax_year), ratePacks);

      // Belt AND braces, deliberately — the same doctrine as the gate that
      // opened this transaction, now asked again at the LAST moment. The two
      // gates are separate statements and READ COMMITTED gives each its own
      // snapshot, so the first gate's answer cannot see what commits after it:
      // a wage row, a rate, a plan, org settings, or ANOTHER RUN'S COMMIT could
      // land in the gap between check and terminal write and ride under a
      // freshness answer that was true when it was taken. The fences above
      // order two racing COMMITS against each other; this second read closes
      // the remaining gap for every OTHER writer — anything committed before
      // this statement executes is SEEN by it (fresh snapshot), and the run is
      // refused and recalculated instead of posting figures edited past. Only
      // writes committing after this statement stay outside it, exactly as the
      // time claim above leaves them unclaimed for the next calculation.
      await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
      // The approval gate again, at the LAST moment beside the staleness
      // recheck: withdrawing the approval between the pre-check above and the
      // terminal write must refuse by name, not ride under a release answer
      // that was true when it was taken.
      await assertPayRunApprovalReleased(orgId, documentId, tx);
      await tx.execute(sql`
      update pay_runs set run_status = 'committed', updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and document_id = ${documentId}
    `);
      await tx.execute(sql`
      update documents set subtotal = ${debitTotal}, total = ${debitTotal},
             updated_by = ${actorId}, updated_at = now()
       where org_id = ${orgId} and id = ${documentId}
    `);
      // Committing authorizes pay: evidence who committed which run computed
      // from what. The `run` row above is the locked before-image (status +
      // pinned calculation digest); the stubs and lines it rewrote are
      // recalculable from that digest, so the run transition is the evidence.
      const afterRun = (
        await tx.execute<Record<string, unknown>>(
          sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `,
          "objects",
        )
      )[0];
      if (!afterRun) throw new PayrollError("pay run not found");
      await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_runs', ${documentId}, 'update',
              ${JSON.stringify({ operation: "commit", before: run, after: afterRun })}::jsonb, ${actorId})
    `);
      return { lines: legs.length };
    }),
  );
}

/**
 * Pre-commit GL preview: the exact legs commit would write, enriched with
 * account/party/project names for the wizard's review step. Read-only —
 * setup problems (missing accounts, imbalance) surface as PayrollError here
 * before anything is written.
 */
export async function previewPayRunGl(
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{
  legs: (PayRunGlLeg & {
    accountLabel: string;
    partyName: string | null;
    projectName: string | null;
  })[];
  debitTotal: string;
}> {
  const source = await db.execute<{ taxYear: number }>(
    sql`select r.tax_year as "taxYear" from pay_runs r
    join documents d on d.org_id=r.org_id and d.id=r.document_id
    where r.org_id=${orgId} and r.document_id=${documentId}
      ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}`,
    "objects",
  );
  if (source.length !== 1) throw new PayrollError("pay run not found");
  return withOpeningReportingSnapshot(orgId, source[0]!.taxYear, async (tx) => {
    await tx.execute(sql`select id from orgs where id=${orgId} for share`);
    const locked = await tx.execute<{ taxYear: number }>(
      sql`select r.tax_year as "taxYear" from pay_runs r
      join documents d on d.org_id=r.org_id and d.id=r.document_id
      where r.org_id=${orgId} and r.document_id=${documentId}
        ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)} for share of r,d`,
      "objects",
    );
    if (locked.length !== 1 || locked[0]!.taxYear !== source[0]!.taxYear)
      throw new PayrollError("The payroll source identity changed — reload the GL preview");
    await lockPayrollEmploymentRoster(tx, orgId, documentId);
    await lockAndCheckPayrollRunPopulation(tx, orgId, documentId, allowedSubsidiaryIds);
    return previewPayRunGlInSnapshot(tx, orgId, documentId, allowedSubsidiaryIds);
  });
}

async function previewPayRunGlInSnapshot(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{
  legs: (PayRunGlLeg & {
    accountLabel: string;
    partyName: string | null;
    projectName: string | null;
  })[];
  debitTotal: string;
}> {
  const runRows = await tx.execute<{ run_status: string; subsidiary_id: string | null }>(
    sql`
    select r.run_status, d.subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `,
    "objects",
  );
  if (!runRows[0]) throw new PayrollError("pay run not found");
  if (runRows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(tx, orgId, documentId, allowedSubsidiaryIds);
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = await Promise.all([
    tx.execute<{ id: string; number: string | null; name: string }>(
      sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`,
      "objects",
    ),
    partyIds.length
      ? tx.execute<{ id: string; display_name: string }>(
          sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`,
          "objects",
        )
      : [],
    projectIds.length
      ? tx.execute<{ id: string; name: string }>(
          sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`,
          "objects",
        )
      : [],
  ]);
  const accountById = new Map(
    accounts.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]),
  );
  const partyById = new Map(parties.map((p) => [p.id, p.display_name]));
  const projectById = new Map(projects.map((p) => [p.id, p.name]));
  return {
    debitTotal,
    legs: legs.map((leg) => ({
      ...leg,
      accountLabel: accountById.get(leg.accountId) ?? leg.accountId,
      partyName: leg.partyId ? (partyById.get(leg.partyId) ?? null) : null,
      projectName: leg.projectId ? (projectById.get(leg.projectId) ?? null) : null,
    })),
  };
}
