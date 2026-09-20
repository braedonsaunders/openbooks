/**
 * Refusal acknowledgement, commit (GL projection write), and pre-commit preview.
 *
 * Extracted verbatim from engine/src/payroll/run.ts; bodies preserve exact
 * math, transaction/lock sequencing, and refusal identity.
 */
import { lockAndCheckPayrollRunPopulation, payrollSubsidiaryInScope, payrollSubsidiaryScopeFilter, type PayrollSubsidiaryScope } from "./scope.ts";
import { employeeTaxYearFenceKey, employerLevyFenceKey, takeEmployeeTaxYearFences, takeEmployerLevyFences } from "./fences.ts";
import { sql } from "drizzle-orm";
import { db, withTransactionSavepoint } from "../platform/db.ts";
import { PayrollError } from "./error.ts";
import { lockAndCheckOrgFeature } from "../organization/org-feature-lock.ts";
import { add, cmp, neg, sum } from "../money/money.ts";
import { legacyStatutoryLiabilityAccount, PAYROLL_COUNTRY_PACKS } from "./packs.ts";
import { laborCostingSettings } from "../projects/labor-costing.ts";
import { canonicalJson, payRunCalculationSourceDigest, parsePayRunCalculationSource, payRunCalculationSource, payRunCalculationSourceChanges, type PayRunCalculationError, type PayRunRefusalAcknowledgement, payRunCalculationRefusals, payRunRefusalDigest, parsePayRunCalculationErrors, parsePayRunRefusalAcknowledgement } from "./run-calculation-evidence.ts";
/**
 * The commit refusal: names every refused in-scope employee WITH the pack's
 * own words for why, so the operator sees at POST exactly what the exception
 * list showed at calculate — and how a posted partial run is completed.
 */
function refusedCommitMessage(refusals: PayRunCalculationError[]): string {
  const shown = refusals.slice(0, 10).map((entry) => `${entry.employee}: ${entry.message}`);
  const more = refusals.length > shown.length
    ? `, and ${refusals.length - shown.length} more`
    : "";
  const count = `${refusals.length} in-scope ${refusals.length === 1 ? "employee was" : "employees were"}`;
  return `pay run cannot be committed — ${count} refused at calculation `
    + `(${shown.join("; ")}${more}) — acknowledge the refused employees on the run `
    + `or fix the input and recalculate. A posted partial run can only be completed `
    + `with an off-cycle run once the missing input is supplied.`;
}

export interface PayRunGlLeg {
  accountId: string;
  amount: string;
  partyId: string | null;
  projectId: string | null;
  departmentId: string | null;
  description: string;
}

/**
 * Build the balanced GL projection for a calculated run — shared by commit
 * (which writes it into document_lines) and the wizard's pre-commit preview.
 * Throws PayrollError on missing accounts or an unbalanced projection, so the
 * preview surfaces setup problems before anything is written.
 */
async function payRunGlLegs(
  tx: Pick<typeof db, "execute">,
  orgId: string,
  documentId: string,
  allowedSubsidiaryIds?: PayrollSubsidiaryScope,
): Promise<{ legs: PayRunGlLeg[]; debitTotal: string; lineLiabilities: { lineId: string; accountId: string }[] }> {
  {
    const settings = await payrollSettings(orgId, allowedSubsidiaryIds);
    const costing = await laborCostingSettings(orgId);
    const control = (await tx.execute<{ c: Record<string, string | null> | null; p: Record<string, unknown> | null }>(sql`
      select settings->'controlAccounts' as c, settings->'payroll' as p from orgs where id = ${orgId}
    `));
    const laborClearing = control.rows[0]?.c?.laborClearing ?? null;
    const rawPayrollSettings = control.rows[0]?.p ?? {};

    const requireAccount = (value: string | null, label: string): string => {
      if (!value) throw new PayrollError(`payroll setup incomplete: ${label} account is not configured`);
      return value;
    };
    const wageExpense = requireAccount(settings.wageExpenseAccountId, "wage expense");
    const netPayable = requireAccount(settings.netPayAccountId, "net pay payable");
    const burdenExpense = settings.burdenExpenseAccountId ?? wageExpense;
    // Statutory liabilities are pack-declared: each seeded component carries
    // its slot's account (Payroll setup → Accounts & posting). For pre-pack
    // tenants, the SLOT's own legacySettingsKey names the old org-level
    // settings key to fall back to — the pack declares which liabilities
    // share an account (CPP2 rides the CPP payable, QPIP the EI payable);
    // this projection no longer knows any jurisdiction's mapping itself, and
    // a third pack's slot with no legacy key simply resolves to the
    // component account or a named refusal.
    const statutoryLiability = (systemKey: string | null, country: string | null): string | null =>
      systemKey ? legacyStatutoryLiabilityAccount(systemKey, rawPayrollSettings, country) : null;
    const wagesToClearing = settings.wagesTo === "labor_clearing" && costing.mode === "post";
    if (settings.wagesTo === "labor_clearing" && !laborClearing) {
      throw new PayrollError("payroll setup incomplete: labor clearing account is not configured");
    }

    const stubLines = (await tx.execute<Record<string, string | null>>(sql`
      select l.id as line_id, s.employee_party_id, l.kind, l.description, l.amount, l.project_id, l.department_id,
             c.system_key, c.country, l.expense_account_id as line_expense_account_id,
             c.expense_account_id as component_expense_account_id,
             c.liability_account_id, s.net_pay
        from pay_stub_lines l
        join pay_stubs s on s.id = l.stub_id and s.org_id = l.org_id
        left join pay_components c on c.id = l.component_id and c.org_id = l.org_id
        left join parties p on p.id = s.employee_party_id and p.org_id = s.org_id
       where l.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
         ${payrollSubsidiaryScopeFilter(sql`p.subsidiary_id`, allowedSubsidiaryIds)}
       order by s.employee_party_id, l.sequence
    `));
    if (stubLines.rows.length === 0) throw new PayrollError("pay run has no calculated stubs");

    // Aggregate GL legs: key = account|project|department|party (party only on
    // net pay). Employer burden debits additionally split per component
    // description: several shares ride one expense account, and merging them
    // under the first share's name mislabels the aggregate.
    const legs = new Map<string, {
      accountId: string; amount: string; partyId: string | null;
      projectId: string | null; departmentId: string | null; description: string;
    }>();
    const accumulate = (
      accountId: string, amount: string, description: string,
      opts: { partyId?: string | null; projectId?: string | null; departmentId?: string | null; split?: string } = {},
    ) => {
      if (cmp(amount, "0") === 0) return;
      const key = [accountId, opts.partyId ?? "", opts.projectId ?? "", opts.departmentId ?? "", opts.split ?? ""].join("|");
      const existing = legs.get(key);
      if (existing) existing.amount = add(existing.amount, amount);
      else legs.set(key, {
        accountId, amount, description,
        partyId: opts.partyId ?? null, projectId: opts.projectId ?? null,
        departmentId: opts.departmentId ?? null,
      });
    };

    const netByEmployee = new Map<string, string>();
    // The account each liability line accrues to, resolved ONCE here and
    // stamped on the stub line at commit so a later remittance debits the
    // account that was credited, not the component's setup of the day.
    const lineLiabilities: { lineId: string; accountId: string }[] = [];
    for (const line of stubLines.rows) {
      netByEmployee.set(line.employee_party_id!, line.net_pay!);
      const amount = line.amount!;
      if (line.kind === "earning") {
        const isTimeDriven = line.system_key === "base_pay" || line.system_key === "overtime";
        if (isTimeDriven && wagesToClearing) {
          // Standard cost already posted to the job at approval; wash clearing.
          accumulate(laborClearing!, amount, "Wages (labor clearing)");
        } else {
          // The line's own stamp (migration 0180) wins: it froze the
          // item > component > org-default resolution at calculate, so a
          // mapping edited after Calculate cannot restate this run — the
          // staleness digest refuses the commit instead. Unstamped history
          // keeps the exact fallback it always had.
          accumulate(
            line.line_expense_account_id ?? line.component_expense_account_id ?? wageExpense,
            amount, line.description ?? "Wages", {
              projectId: line.project_id, departmentId: line.department_id,
            });
        }
      } else if (line.kind === "deduction") {
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null, line.country ?? null);
        if (!liability) {
          throw new PayrollError(
            `deduction "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        accumulate(liability, neg(amount), line.description ?? "Deduction");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
      } else if (line.kind === "credit") {
        // A refundable credit is reclaimed from the tax authority by paying
        // it less (F24 compensation for IT): debit the same liability the
        // withholdings credited, so the projection balances and the frozen
        // account below is the one the reclaim lands on. No burden expense —
        // the P&L cost is nil (see the net math above).
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null, line.country ?? null);
        if (!liability) {
          throw new PayrollError(
            `credit "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        accumulate(liability, amount, line.description ?? "Credit");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
      } else {
        const liability = line.liability_account_id ?? statutoryLiability(line.system_key ?? null, line.country ?? null);
        if (!liability) {
          throw new PayrollError(
            `employer contribution "${line.description}" has no liability account — set it in Payroll setup → Accounts & posting`,
          );
        }
        // Job-costed burdens (union fringes) carry the line's project split.
        // Each component keeps its own debit: the shares ride one expense
        // account, so without the split the whole aggregate wears the first
        // share's name.
        // Burden is deliberately NOT item-routed (owner decision pending):
        // the component-then-default fallback stands exactly as before.
        accumulate(line.component_expense_account_id ?? burdenExpense, amount, line.description ?? "Employer burden", {
          projectId: line.project_id, departmentId: line.department_id,
          split: line.description ?? "Employer burden",
        });
        accumulate(liability, neg(amount), line.description ?? "Employer burden");
        lineLiabilities.push({ lineId: line.line_id!, accountId: liability });
      }
    }
    for (const [employeePartyId, net] of netByEmployee) {
      accumulate(netPayable, neg(net), "Net pay", { partyId: employeePartyId });
    }

    const total = sum([...legs.values()].map((l) => l.amount));
    if (cmp(total, "0") !== 0) throw new PayrollError(`pay run GL projection is unbalanced (${total})`);
    const debitTotal = sum([...legs.values()].filter((l) => cmp(l.amount, "0") > 0).map((l) => l.amount));
    return { legs: [...legs.values()], debitTotal, lineLiabilities };
  }
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
  return await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<Record<string, unknown>>(sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id as string | null)) {
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
    const afterRun = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `)).rows[0];
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
  }));
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
  return await db.transaction(async (tx) => withTransactionSavepoint(tx, async () => {
    if (!(await lockAndCheckOrgFeature(tx, orgId, "payroll"))) throw new PayrollError("Payroll feature is disabled");
    const runRows = (await tx.execute<Record<string, string>>(sql`
      select r.*, d.status as doc_status, d.subsidiary_id as subsidiary_id from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
      where r.org_id = ${orgId} and r.document_id = ${documentId} for update
    `));
    const run = runRows.rows[0];
    if (!run) throw new PayrollError("pay run not found");
    if (!payrollSubsidiaryInScope(input.allowedSubsidiaryIds, run.subsidiary_id)) {
      throw new PayrollError("pay run not found");
    }
    if (run.run_status !== "calculated") throw new PayrollError("calculate the pay run before committing");
    // Approval moves the document from draft to approved, so both are
    // committable; anything else (posted, voided) is not.
    if (run.doc_status !== "draft" && run.doc_status !== "approved") {
      throw new PayrollError("pay run document is not editable");
    }
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
    const fencedEmployees = (await tx.execute<{ employee_party_id: string }>(sql`
      select distinct s.employee_party_id
        from pay_stubs s
       where s.org_id = ${orgId} and s.pay_run_document_id = ${documentId}
    `));
    await takeEmployeeTaxYearFences(
      tx,
      fencedEmployees.rows.map((e) =>
        employeeTaxYearFenceKey(orgId, e.employee_party_id, run.tax_year),
      ),
    );
    // Employer-aggregate room is shared across rosters, so the employee
    // fence above cannot serialize it: two runs on disjoint rosters hold no
    // common employee key. Every commit takes each declared per-run levy's
    // employer key too — AFTER the employee keys, always in that order —
    // so the freshness gate below sees competing commits in fence order and
    // refuses the run whose room is gone. Declarations are read off every
    // pack (the key carries its country, so packs never contend); packs
    // that declare none add no keys and behave exactly as before.
    const levyFenceKeys: string[] = [];
    for (const [packCountry, pack] of Object.entries(PAYROLL_COUNTRY_PACKS)) {
      for (const levy of pack.employerAggregateLevies?.(Number(run.tax_year)) ?? []) {
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
    const { assertPayRunNotStale, staleCalculationMessage } =
      await import("./readiness.ts");
    await assertPayRunNotStale(orgId, documentId, tx, input.allowedSubsidiaryIds);
    // A retro run's own control set (payroll-retro-store.ts): a voided or
    // re-settled source period, a cross-year settlement, a retired component,
    // or another open retro run already holding the same cell. The pre-flight
    // shows these; the commit ENFORCES them on this transaction so a caller
    // that skips the wizard cannot pay the same difference twice.
    if (run.run_type === "retro") {
      const { retroRunFindings } = await import("./retro-store.ts");
      const blockers = (await retroRunFindings(orgId, documentId, tx, input.allowedSubsidiaryIds))
        .filter((finding) => finding.severity === "blocker");
      if (blockers.length > 0) {
        throw new PayrollError(
          `retro run cannot be committed (${[...new Set(blockers.map((b) => b.code))].join(", ")})`
          + " — review the retro run's source periods before paying it",
        );
      }
    }
    // Money must not move before the run is approved. Dynamic import keeps the
    // module cycle out of the engine's load order (same idiom as
    // flows/documents-adapter.ts → document-void.ts).
    const { assertPayRunApprovalReleased } = await import("./approval.ts");
    await assertPayRunApprovalReleased(orgId, documentId);

    // Recompute and lock the canonical source population before producing a
    // single GL line. Legacy calculated rows have no evidence and therefore
    // require recalculation; a corrupt snapshot/digest pair fails the same
    // closed way. Category-specific reasons preserve the wizard/API contract.
    const storedSource = parsePayRunCalculationSource(run.calculation_source_snapshot);
    const storedDigest = run.calculation_source_digest ?? null;
    if (!storedSource || !storedDigest
        || payRunCalculationSourceDigest(storedSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(["selection"]));
    }
    const currentSource = await payRunCalculationSource(
      orgId,
      documentId,
      tx,
      true,
      input.allowedSubsidiaryIds,
    );
    if (!currentSource) throw new PayrollError("pay run not found");
    const changes = payRunCalculationSourceChanges(storedSource, currentSource);
    const sourceReasons = [
      changes.time ? "time" : null,
      changes.timeTypes ? "timeTypes" : null,
      changes.wages ? "wages" : null,
      changes.items ? "items" : null,
    ].filter((reason): reason is string => reason !== null);
    if (payRunCalculationSourceDigest(currentSource) !== storedDigest) {
      throw new PayrollError(staleCalculationMessage(
        sourceReasons.length > 0 ? sourceReasons : ["selection"],
      ));
    }

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
      if (!acknowledgement
          || acknowledgement.errorsDigest !== payRunRefusalDigest(refusals)) {
        throw new PayrollError(refusedCommitMessage(refusals));
      }
    }

    const { legs, debitTotal, lineLiabilities } = await payRunGlLegs(
      tx,
      orgId,
      documentId,
      input.allowedSubsidiaryIds,
    );
    // Freeze the credited liability account on every deduction/contribution
    // line (migration 0094): remittance reads the snapshot, so editing the
    // component's account afterwards can never restate a committed period.
    if (lineLiabilities.length > 0) {
      await tx.execute(sql`
        update pay_stub_lines l
           set liability_account_id = stamp.account_id, liability_account_source = 'commit',
               updated_by = ${actorId}, updated_at = now()
          from unnest(${`{${lineLiabilities.map((x) => x.lineId).join(",")}}`}::uuid[],
                      ${`{${lineLiabilities.map((x) => x.accountId).join(",")}}`}::uuid[])
               as stamp(line_id, account_id)
         where l.org_id = ${orgId} and l.id = stamp.line_id
      `);
    }

    // An approved pay run commits after its release (migration 0145): the
    // document-line freeze permits this transaction's own line replacement
    // while openbooks.payroll_commit names the committing document. Set only
    // here, only for approved runs, transaction-local so it dies with the
    // commit — draft commits keep the ordinary path bit for bit.
    if (run.doc_status === "approved") {
      await tx.execute(sql`select set_config('openbooks.payroll_commit', ${String(documentId)}, true)`);
    }
    await tx.execute(sql`delete from document_lines where org_id = ${orgId} and document_id = ${documentId}`);
    let lineNumber = 1;
    for (const leg of legs) {
      await tx.execute(sql`
        insert into document_lines (org_id, document_id, line_number, account_id, description,
                                    amount, party_id, project_id, department_id, created_by, updated_by)
        values (${orgId}, ${documentId}, ${lineNumber++}, ${leg.accountId}, ${leg.description},
                ${leg.amount}, ${leg.partyId}, ${leg.projectId}, ${leg.departmentId},
                ${actorId}, ${actorId})
      `);
    }

    // Claim the calculation's exact IDs — never a rediscovered employee/group
    // population. The compare above proves these locked rows are unchanged;
    // the update's own predicates and returned-ID equality are defense in
    // depth against corruption or a future caller weakening that lock.
    const claimed = (await tx.execute<{ id: string }>(sql`
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
    `));
    const expectedClaimIds = [...storedSource.claimEntryIds].sort();
    const actualClaimIds = claimed.rows.map((row) => row.id).sort();
    if (canonicalJson(actualClaimIds) !== canonicalJson(expectedClaimIds)) {
      throw new PayrollError(staleCalculationMessage(["time"]));
    }
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
    const afterRun = (await tx.execute<Record<string, unknown>>(sql`
      select * from pay_runs where org_id = ${orgId} and document_id = ${documentId}
    `)).rows[0];
    if (!afterRun) throw new PayrollError("pay run not found");
    await tx.execute(sql`
      insert into audit_log (org_id, table_name, row_id, action, changes, actor_id)
      values (${orgId}, 'pay_runs', ${documentId}, 'update',
              ${JSON.stringify({ operation: 'commit', before: run, after: afterRun })}::jsonb, ${actorId})
    `);
    return { lines: legs.length };
  }));
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
): Promise<{ legs: (PayRunGlLeg & {
  accountLabel: string; partyName: string | null; projectName: string | null;
})[]; debitTotal: string }> {
  const runRows = (await db.execute<{ run_status: string; subsidiary_id: string | null }>(sql`
    select r.run_status, d.subsidiary_id
      from pay_runs r
      join documents d on d.id = r.document_id and d.org_id = r.org_id
     where r.org_id = ${orgId} and r.document_id = ${documentId}
       ${payrollSubsidiaryScopeFilter(sql`d.subsidiary_id`, allowedSubsidiaryIds)}
  `));
  if (!runRows.rows[0]) throw new PayrollError("pay run not found");
  if (runRows.rows[0].run_status === "draft") {
    throw new PayrollError("calculate the pay run to preview its GL impact");
  }
  const { legs, debitTotal } = await payRunGlLegs(
    db,
    orgId,
    documentId,
    allowedSubsidiaryIds,
  );
  const accountIds = [...new Set(legs.map((l) => l.accountId))];
  const partyIds = [...new Set(legs.map((l) => l.partyId).filter(Boolean))] as string[];
  const projectIds = [...new Set(legs.map((l) => l.projectId).filter(Boolean))] as string[];
  const [accounts, parties, projects] = (await Promise.all([
    db.execute<{ id: string; number: string | null; name: string }>(sql`select id, number, name from accounts
                    where org_id = ${orgId} and id = any(${`{${accountIds.join(",")}}`}::uuid[])`),
    partyIds.length
      ? db.execute<{ id: string; display_name: string }>(sql`select id, display_name from parties
                        where org_id = ${orgId} and id = any(${`{${partyIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
    projectIds.length
      ? db.execute<{ id: string; name: string }>(sql`select id, name from projects
                        where org_id = ${orgId} and id = any(${`{${projectIds.join(",")}}`}::uuid[])`)
      : { rows: [] },
  ]));
  const accountById = new Map(accounts.rows.map((a) => [a.id, a.number ? `${a.number} · ${a.name}` : a.name]));
  const partyById = new Map(parties.rows.map((p) => [p.id, p.display_name]));
  const projectById = new Map(projects.rows.map((p) => [p.id, p.name]));
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
