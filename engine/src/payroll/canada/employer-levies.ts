import { sql } from "drizzle-orm";
import { PayrollError } from "../../payroll-error.ts";
import { CA_OPENING_YTD_FIELDS } from "./opening-ytd.ts";
import {
  add, cmp, mulPercent, mulRatio, neg, roundMoney, sum, toUnits,
} from "../../money.ts";
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
  const config = await caPayrollConfig(orgId, taxYear);

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
      // Calculated runs count here, unlike the WCB accumulator above: the
      // exemption is employer-level per province, and the ytd staleness arm
      // only fires on a SHARED employee — two drafts on disjoint rosters
      // would otherwise each claim the full exemption and both commit cleanly
      // (payroll-multi-employee D6 pins this). The own-document arm sequences
      // the exemption across the employees of the run being calculated.
      const priorInProvince = ((await tx.execute<{ prior: string }>(sql`
        select coalesce(sum((s.factors->>'EHT_EARN')::numeric), 0) as prior
          from pay_stubs s
          join pay_runs r on r.document_id = s.pay_run_document_id and r.org_id = s.org_id
         where s.org_id = ${orgId} and s.tax_year = ${taxYear} and s.province = ${region}
           and (r.run_status in ('calculated', 'committed')
                or s.pay_run_document_id = ${documentId})
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
