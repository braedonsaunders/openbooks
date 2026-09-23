import { sql } from "drizzle-orm";
import { PayrollError } from "../error.ts";
import { PayrollPackError } from "../payroll-error.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";

/**
 * The pay-run lifecycle states, as `pay_runs.run_status` spells them
 * (schema/src/payroll.ts): draft → calculated → committed, with voided as
 * the terminal reversal. This union is the exhaustive switch below — a new
 * lifecycle state breaks the compile, never silently inherits a side.
 */
export type CaExemptionRunStatus = "draft" | "calculated" | "committed" | "voided";

function assertNeverStatus(status: never): never {
  throw new PayrollPackError(
    `CA EHT exemption has no rule for pay-run status "${status}" — `
    + "name the new lifecycle state here before it consumes (or escapes) exemption room",
  );
}

/**
 * Whether stubs on a run in this lifecycle state consume the employer's
 * annual EHT exemption for OTHER runs. Only committed runs do: a draft or
 * calculated run may be abandoned or recalculated, and counting its
 * uncommitted remuneration lets two disjoint-roster drafts each claim the
 * full exemption — recalculating either one then sees the other as prior
 * and both commit over-taxed (the double count this switch exists to stop).
 * A voided run is reversed history and consumes nothing. The run being
 * calculated sequences its own employees through the separate own-document
 * arm in the query below, not through this switch.
 *
 * The SQL below spells the committed arm as a literal (`run_status =
 * 'committed'` — SQL cannot call this function); the unit test pins the two
 * together, so a change here without the query fails loudly.
 */
export function ehtExemptionConsumedByRunStatus(status: CaExemptionRunStatus): boolean {
  switch (status) {
    case "committed":
      return true;
    case "draft":
    case "calculated":
    case "voided":
      return false;
    default:
      return assertNeverStatus(status);
  }
}
import {
  add, cmp, mulPercent, mulRatio, neg, roundMoney, sum, toUnits,
} from "../../money/money.ts";
import { caPayrollConfig } from "./config.ts";
import type {
  PayrollEmployerLevyContext,
  PayrollEmployerLevyFactors,
  StatutoryAllocation,
} from "../statutory-context.ts";

/**
 * Phase 8 — CA pack earnings-assessed employer levies: WCB/WSIB, provincial
 * EHT, and the Québec health services fund (TP-1015.F-V s. 5).
 */
export async function applyCaEmployerLevies(
  ctx: PayrollEmployerLevyContext,
): Promise<PayrollEmployerLevyFactors> {
  const {
    tx, orgId, documentId, employeePartyId, employeeName, taxYear, region, lines, pushStatutory,
  } = ctx;
  const config = await caPayrollConfig(orgId, taxYear, ctx.payDate ?? null);

  const grossEarnings = () =>
    sum(lines.filter((l) => l.kind === "earning" && !l.accrualOnly).map((l) => l.amount));

  let wcbAmount = "0";
  let wcbAssessable = "0";
  let ehtAmount = "0";
  let ehtEarnings = "0";
  let hsfAmount = "0";
  let hsfEarnings = "0";

  const wcbGroup = (await tx.execute<{ rate_percent: string | null; max_assessable: string | null }>(sql`
    select g.rate_percent, g.max_assessable
      from employee_roles er
      join worker_comp_groups g on g.id = er.worker_comp_group_id and g.org_id = er.org_id and g.is_active
     where er.org_id = ${orgId} and er.party_id = ${employeePartyId} and er.is_active
     limit 1
  `));
  const wcb = wcbGroup.rows[0];
  if (wcb?.rate_percent && cmp(wcb.rate_percent, "0") > 0) {
    // Committed stubs only. A calculated run is a draft that may be abandoned
    // or recalculated, and counting its assessable earnings lets unpaid
    // figures consume the annual cap — the same doctrine `employeeYtd` states
    // for CPP/EI. (The run being calculated keeps its own-document arm below
    // so the exemption still sequences across its own employees.)
    // Pre-adoption assessable earnings ride the opening carry-in, like every
    // other annual ceiling: without it a mid-year adopter re-opens the full
    // group maximum on the first stub.
    const wcbAssessableColumn = CA_OPENING_YTD_FIELDS.find(
      (field) => field.key === "wcbAssessableYtd",
    )!.column;
    const priorAssessable = ((await tx.execute<{ prior: string }>(sql`
      select coalesce((select ${sql.raw(wcbAssessableColumn)} from payroll_opening_balances
                         where org_id = ${orgId} and employee_party_id = ${employeePartyId}
                           and tax_year = ${taxYear}), 0)
             + coalesce(sum((s.factors->>'WCB_EARN')::numeric), 0) as prior
        from pay_stubs s
        join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
       where s.org_id = ${orgId} and s.employee_party_id = ${employeePartyId}
         and s.tax_year = ${taxYear}
         and (r.run_status = 'committed'
              or s.pay_run_document_id = ${documentId})
    `))).rows[0]!.prior;
    const gross = grossEarnings();
    const room = wcb.max_assessable
      ? (cmp(wcb.max_assessable, priorAssessable) > 0 ? add(wcb.max_assessable, neg(priorAssessable)) : "0")
      : gross;
    wcbAssessable = cmp(gross, room) <= 0 ? gross : room;
    if (cmp(wcbAssessable, "0") > 0) {
      wcbAmount = mulPercent(wcbAssessable, wcb.rate_percent, 2);
      const splits = lines.filter((l) => l.kind === "earning" && !l.accrualOnly && l.projectId);
      const grossUnits = toUnits(gross);
      const allocations: StatutoryAllocation[] = [];
      let allocated = "0";
      const allTagged = cmp(sum(splits.map((s) => s.amount)), gross) === 0;
      for (const [index, split] of splits.entries()) {
        const share = index === splits.length - 1 && allTagged
          ? add(wcbAmount, neg(allocated))
          : roundMoney(mulRatio(wcbAmount, toUnits(split.amount), grossUnits), 2);
        if (cmp(share, "0") === 0) continue;
        allocated = add(allocated, share);
        allocations.push({
          amount: share, projectId: split.projectId, departmentId: split.departmentId,
        });
      }
      const remainder = add(wcbAmount, neg(allocated));
      if (cmp(remainder, "0") !== 0) {
        const last = allocations[allocations.length - 1];
        if (cmp(remainder, "0") < 0 && last) last.amount = add(last.amount, remainder);
        else allocations.push({ amount: remainder });
      }
      const allocatedTotal = sum(allocations.map((a) => a.amount));
      if (cmp(allocatedTotal, wcbAmount) !== 0) {
        throw new PayrollError(
          `WCB allocation ${allocatedTotal} does not equal the ${wcbAmount} premium `
          + `for ${employeeName}`,
        );
      }
      pushStatutory("wcb", "employer_contribution", "WCB/WSIB", wcbAmount, 260, { allocations });
    }
  }

  const eht = config.eht(region);
  if (eht) {
    ehtEarnings = grossEarnings();
    if (cmp(ehtEarnings, "0") > 0) {
      // Committed runs only (see `ehtExemptionConsumedByRunStatus`, which
      // this literal mirrors — SQL cannot call it): a calculated run is a
      // draft that may be abandoned or recalculated, and counting its
      // uncommitted remuneration lets two disjoint-roster drafts each claim
      // the full exemption, then double-count each other on recalc and both
      // commit over-taxed. The own-document arm sequences the exemption
      // across the employees of the run being calculated in roster order
      // (display_name, party_id — the deterministic order run-calculation
      // uses), so a recalc, which deletes this run's stubs before rewriting
      // them, cannot double count. Across runs the order is commit order:
      // whoever commits first consumes the room, and the commit-time
      // staleness arm (`employerLevyYtd` in readiness.ts) refuses a run
      // calculated before a concurrent commit until it recalculates — that
      // arm, not draft-counting, is what stops two overlapping drafts from
      // both committing with the full exemption.
      //
      // A voided run consumes nothing twice over: its run_status is
      // 'voided' (never 'committed'), and its document is excluded below.
      //
      // Pre-adoption remuneration rides the pack-declared opening carry-in
      // (`ehtRemunerationYtd`), summed across the employer's in-province
      // carry-ins: the exemption is employer-level, so one employee's
      // committed stubs cannot reconstruct what the prior provider paid.
      // Province is the employee's CURRENT payroll province — the best
      // proxy on file for where pre-adoption pay was earned.
      const ehtCarryInColumn = CA_OPENING_YTD_FIELDS.find(
        (field) => field.key === "ehtRemunerationYtd",
      )!.column;
      const priorInProvince = ((await tx.execute<{ prior: string }>(sql`
        select coalesce(sum((s.factors->>'EHT_EARN')::numeric), 0)
               + coalesce((
                   select sum(b.${sql.raw(ehtCarryInColumn)})
                     from payroll_opening_balances b
                    where b.org_id = ${orgId} and b.tax_year = ${taxYear}
                      and exists (
                        select 1 from employee_payroll_profiles prof
                         where prof.org_id = b.org_id
                           and prof.employee_party_id = b.employee_party_id
                           and prof.is_active and prof.province = ${region})
                 ), 0) as prior
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
          join documents d on d.id = r.document_id and d.org_id = r.org_id
         where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = ${region}
           and (s.pay_run_document_id = ${documentId} or r.run_status = 'committed')
           and d.status <> 'voided'
      `))).rows[0]!.prior;
      const exemption = eht.annualExemption ?? "0";
      const exemptionLeft = cmp(exemption, priorInProvince) > 0
        ? add(exemption, neg(priorInProvince))
        : "0";
      const taxableRemuneration = cmp(ehtEarnings, exemptionLeft) > 0
        ? add(ehtEarnings, neg(exemptionLeft))
        : "0";
      if (cmp(taxableRemuneration, "0") > 0) {
        ehtAmount = mulPercent(taxableRemuneration, eht.rate, 2);
        pushStatutory("eht", "employer_contribution", "Employer Health Tax", ehtAmount, 270);
      }
    }
  }

  // Québec health services fund (TP-1015.F-V s. 5): the tenant-entered
  // rate times the remuneration subject — employment income is generally
  // subject, so the stub's gross earnings, with no exemption and no cap.
  // QC-gated twice: the region check below, and the ca_hsf slot which
  // refuses a rate row for any other province at the write boundary.
  if (region === "QC") {
    const hsf = config.hsf(region);
    if (hsf) {
      hsfEarnings = grossEarnings();
      if (cmp(hsfEarnings, "0") > 0) {
        hsfAmount = mulPercent(hsfEarnings, hsf.rate, 2);
        pushStatutory("hsf", "employer_contribution", "Health Services Fund", hsfAmount, 280);
      }
    }
  }

  return { wcbAmount, wcbAssessable, ehtAmount, ehtEarnings, hsfAmount, hsfEarnings };
}
